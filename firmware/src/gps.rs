use chrono::{Datelike, Timelike};
use embassy_nrf::buffered_uarte::{Baudrate, BufferedUarteRx, BufferedUarteTx};
use embassy_nrf::gpio::Output;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;
use embassy_time::{Instant, Timer};
use nmea::Nmea;

use crate::casic::{CasicPacket, CasicParser, CasicParserState, CASIC_MAX_PAYLOAD_SIZE};
use crate::storage;
use crate::system_info::{GpsState, SystemInfo, SYSTEM_INFO};

const MIN_HDOP_FOR_VALID_FIX: f32 = 2.0;
const GPS_HIGH_SPEED_THRESHOLD_KMPH: f32 = 20.0;
const GPS_SPEED_VEHICLE_THRESHOLD_KMPH: f32 = 5.0;
const KMPH_PER_KNOT: f32 = 1.852;
const NMEA_MAX_LEN: usize = 96;

const T_ACTIVE_SAMPLING_INTERVAL_MS: u64 = 1_000;
const T_STILLNESS_CONFIRM_DURATION_MS: u64 = 60_000;
const T_GPS_QUERY_TIMEOUT_FOR_STILLNESS_MS: u64 = 5_000;
const T_GPS_COLD_START_FIX_TIMEOUT_MS: u64 = 90_000;
const T_GPS_REACQUIRE_FIX_TIMEOUT_MS: u64 = 30_000;
const T_GPS_SLEEP_PERIODIC_WAKE_INTERVAL_MS: u64 = 15 * 60_000;
const MAX_CONSECUTIVE_FIX_FAILURES: u8 = 16;
const STATE_TICK_INTERVAL_MS: u64 = 200;
const AGNSS_TRIGGER_DELAY_MS: u64 = 10_000;
const T_AGNSS_MESSAGE_SEND_TIMEOUT_MS: u64 = 1;
const T_AGNSS_TOTAL_TIMEOUT_MS: u64 = 600_000;
const MAX_AGNSS_MESSAGE_RETRY: u8 = 3;
const MAX_AGNSS_MESSAGES: usize = 64;
const MAX_AGNSS_MESSAGE_SIZE: usize = 568;

const EMPTY_CASIC_PACKET: CasicPacket = CasicPacket {
    class_id: 0,
    msg_id: 0,
    payload_length: 0,
    payload: [0; CASIC_MAX_PAYLOAD_SIZE],
    checksum: 0,
    calculated_checksum: 0,
    valid: false,
    timestamp_ms: 0,
};

#[derive(Clone, Copy)]
struct GpsEvents {
    last_packet: CasicPacket,
    new_casic: bool,
    ack: bool,
    nack: bool,
    ephemeris: bool,
    reset_parser: bool,
}

impl GpsEvents {
    const fn new() -> Self {
        Self {
            last_packet: EMPTY_CASIC_PACKET,
            new_casic: false,
            ack: false,
            nack: false,
            ephemeris: false,
            reset_parser: false,
        }
    }
}

static GPS_EVENTS: Mutex<CriticalSectionRawMutex, GpsEvents> = Mutex::new(GpsEvents::new());
static GPS_WAKEUP: Mutex<CriticalSectionRawMutex, bool> = Mutex::new(false);

#[derive(Clone, Copy)]
struct AgnssMessage {
    len: usize,
    data: [u8; MAX_AGNSS_MESSAGE_SIZE],
}

impl AgnssMessage {
    const fn empty() -> Self {
        Self {
            len: 0,
            data: [0; MAX_AGNSS_MESSAGE_SIZE],
        }
    }

    fn from_slice(data: &[u8]) -> Option<Self> {
        if data.len() > MAX_AGNSS_MESSAGE_SIZE {
            return None;
        }
        let mut msg = Self::empty();
        msg.len = data.len();
        msg.data[..data.len()].copy_from_slice(data);
        Some(msg)
    }

    fn as_slice(&self) -> &[u8] {
        &self.data[..self.len]
    }
}

struct AgnssQueue {
    messages: [AgnssMessage; MAX_AGNSS_MESSAGES],
    len: usize,
}

impl AgnssQueue {
    const fn new() -> Self {
        Self {
            messages: [AgnssMessage::empty(); MAX_AGNSS_MESSAGES],
            len: 0,
        }
    }

    fn clear(&mut self) {
        self.len = 0;
    }

    fn is_empty(&self) -> bool {
        self.len == 0
    }

    fn len(&self) -> usize {
        self.len
    }

    fn push(&mut self, data: &[u8]) -> Result<(), AgnssQueueError> {
        if self.len >= MAX_AGNSS_MESSAGES {
            return Err(AgnssQueueError::TooManyMessages);
        }
        let msg = AgnssMessage::from_slice(data).ok_or(AgnssQueueError::MessageTooLarge)?;
        self.messages[self.len] = msg;
        self.len += 1;
        Ok(())
    }

    fn get_copy(&self, index: usize) -> Option<AgnssMessage> {
        if index < self.len {
            Some(self.messages[index])
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgnssQueueError {
    TooManyMessages,
    MessageTooLarge,
}

#[derive(Clone, Copy)]
enum AgnssOutcome {
    Send(AgnssMessage),
    Complete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgnssAck {
    None,
    Ack,
    Nack,
}

struct AgnssState {
    queue: AgnssQueue,
    request_pending: bool,
    force_trigger: bool,
    current_index: usize,
    current_retry: u8,
    message_timer_start: Option<u64>,
    total_timer_start: Option<u64>,
    previous_state: GpsState,
}

impl AgnssState {
    const fn new() -> Self {
        Self {
            queue: AgnssQueue::new(),
            request_pending: true,
            force_trigger: false,
            current_index: 0,
            current_retry: 0,
            message_timer_start: None,
            total_timer_start: None,
            previous_state: GpsState::S2IdleGpsOff,
        }
    }

    fn clear_processing(&mut self) {
        self.current_index = 0;
        self.current_retry = 0;
        self.message_timer_start = None;
        self.total_timer_start = None;
    }

    fn clear_all(&mut self) {
        self.queue.clear();
        self.request_pending = false;
        self.force_trigger = false;
        self.clear_processing();
    }

    fn should_trigger(&self, now_ms: u64, state: GpsState) -> bool {
        now_ms >= AGNSS_TRIGGER_DELAY_MS
            && (self.request_pending || self.force_trigger)
            && !self.queue.is_empty()
            && state != GpsState::S5AgnssProcessing
    }

    fn start_processing(&mut self, now_ms: u64, previous_state: GpsState) -> Option<AgnssMessage> {
        if self.queue.is_empty() {
            return None;
        }
        self.previous_state = previous_state;
        self.request_pending = false;
        self.force_trigger = false;
        self.current_index = 0;
        self.current_retry = 0;
        self.message_timer_start = None;
        self.total_timer_start = Some(now_ms);
        self.queue.get_copy(self.current_index)
    }

    fn mark_message_sent(&mut self, now_ms: u64) {
        self.message_timer_start = Some(now_ms);
    }

    fn ack_next(&mut self) -> AgnssOutcome {
        self.message_timer_start = None;
        self.current_index = self.current_index.saturating_add(1);
        self.current_retry = 0;
        if self.current_index >= self.queue.len() {
            AgnssOutcome::Complete
        } else {
            self.queue
                .get_copy(self.current_index)
                .map(AgnssOutcome::Send)
                .unwrap_or(AgnssOutcome::Complete)
        }
    }

    fn retry_or_fail(&mut self) -> AgnssOutcome {
        self.current_retry = self.current_retry.saturating_add(1);
        if self.current_retry >= MAX_AGNSS_MESSAGE_RETRY {
            return AgnssOutcome::Complete;
        }
        self.queue
            .get_copy(self.current_index)
            .map(AgnssOutcome::Send)
            .unwrap_or(AgnssOutcome::Complete)
    }

    fn message_timeout(&self, now_ms: u64) -> bool {
        match self.message_timer_start {
            Some(start) => now_ms.wrapping_sub(start) >= T_AGNSS_MESSAGE_SEND_TIMEOUT_MS,
            None => false,
        }
    }

    fn total_timeout(&self, now_ms: u64) -> bool {
        match self.total_timer_start {
            Some(start) => now_ms.wrapping_sub(start) >= T_AGNSS_TOTAL_TIMEOUT_MS,
            None => false,
        }
    }
}

static AGNSS_STATE: Mutex<CriticalSectionRawMutex, AgnssState> = Mutex::new(AgnssState::new());

struct NmeaBuffer {
    buf: [u8; NMEA_MAX_LEN],
    len: usize,
    in_sentence: bool,
}

impl NmeaBuffer {
    fn new() -> Self {
        Self {
            buf: [0; NMEA_MAX_LEN],
            len: 0,
            in_sentence: false,
        }
    }

    fn reset(&mut self) {
        self.len = 0;
        self.in_sentence = false;
    }

    fn push(&mut self, byte: u8) -> Option<usize> {
        if byte == b'$' {
            self.len = 0;
            self.in_sentence = true;
            if !self.buf.is_empty() {
                self.buf[0] = byte;
                self.len = 1;
            }
            return None;
        }

        if !self.in_sentence {
            return None;
        }

        if byte == b'\n' {
            let mut len = self.len;
            if len > 0 && self.buf[len - 1] == b'\r' {
                len -= 1;
            }
            self.in_sentence = false;
            return Some(len);
        }

        if self.len < self.buf.len() {
            self.buf[self.len] = byte;
            self.len += 1;
        } else {
            self.in_sentence = false;
            self.len = 0;
        }

        None
    }

    fn as_str(&self, len: usize) -> Option<&str> {
        core::str::from_utf8(&self.buf[..len]).ok()
    }
}

struct SpeedAverage {
    samples: [f32; 10],
    sample_index: usize,
    call_counter: u32,
}

impl SpeedAverage {
    fn new() -> Self {
        Self {
            samples: [0.0; 10],
            sample_index: 0,
            call_counter: 0,
        }
    }

    fn reset(&mut self) {
        self.samples = [0.0; 10];
        self.sample_index = 0;
        self.call_counter = 0;
    }

    fn add_sample(&mut self, speed: f32) {
        const SAMPLE_INTERVAL: u32 = 20;
        self.call_counter = self.call_counter.wrapping_add(1);
        if self.call_counter % SAMPLE_INTERVAL == 0 {
            self.samples[self.sample_index] = speed;
            self.sample_index = (self.sample_index + 1) % self.samples.len();
        }
    }

    fn get_average(&self) -> f32 {
        let mut sum = 0.0;
        let mut count = 0;
        for &v in &self.samples {
            if v > 0.0 {
                sum += v;
                count += 1;
            }
        }
        if count > 0 {
            sum / count as f32
        } else {
            0.0
        }
    }
}

#[derive(Clone, Copy)]
struct PositionResult {
    timestamp: u32,
    latitude: f64,
    longitude: f64,
    altitude_m: f32,
    hdop: f32,
}

impl Default for PositionResult {
    fn default() -> Self {
        Self {
            timestamp: 0,
            latitude: 0.0,
            longitude: 0.0,
            altitude_m: 0.0,
            hdop: 1.0e9_f32,
        }
    }
}

struct GpsStateMachine {
    stillness_confirm_start: Option<u64>,
    active_sampling_start: Option<u64>,
    fix_attempt_start: Option<u64>,
    periodic_wake_start: Option<u64>,
    gps_query_timeout_start: Option<u64>,
    consecutive_fix_failures: u8,
    is_gps_powered_on: bool,
    is_first_fix_attempt_cycle: bool,
    last_successful_position: PositionResult,
}

impl GpsStateMachine {
    fn new() -> Self {
        Self {
            stillness_confirm_start: None,
            active_sampling_start: None,
            fix_attempt_start: None,
            periodic_wake_start: None,
            gps_query_timeout_start: None,
            consecutive_fix_failures: 0,
            is_gps_powered_on: false,
            is_first_fix_attempt_cycle: true,
            last_successful_position: PositionResult::default(),
        }
    }

    fn reset_state_timers(&mut self) {
        self.stillness_confirm_start = None;
        self.active_sampling_start = None;
        self.fix_attempt_start = None;
        self.periodic_wake_start = None;
        self.gps_query_timeout_start = None;
    }

    async fn initialize(&mut self, gps_en: &mut Output<'static>) {
        self.power_off_gps(gps_en).await;
        self.reset_state_timers();
        self.periodic_wake_start = Some(Instant::now().as_millis());
        self.is_first_fix_attempt_cycle = true;
        set_gps_state(GpsState::S2IdleGpsOff).await;
        defmt::info!("GPS State: S0 -> S2_IDLE_GPS_OFF (init)");
    }

    async fn power_on_gps(&mut self, gps_en: &mut Output<'static>) {
        if self.is_gps_powered_on {
            return;
        }
        gps_en.set_high();
        self.is_gps_powered_on = true;
        defmt::info!("GPS power on");
        Timer::after_millis(100).await;
    }

    async fn power_off_gps(&mut self, gps_en: &mut Output<'static>) {
        gps_en.set_low();
        if self.is_gps_powered_on {
            defmt::info!("GPS power off");
        }
        self.is_gps_powered_on = false;

        let mut info = SYSTEM_INFO.lock().await;
        info.location_valid = false;
        info.date_time_valid = false;
        info.latitude = 0.0;
        info.longitude = 0.0;
        info.altitude = 0.0;
        info.satellites = 0;
        info.hdop = 99.9;
        info.speed = -1.0;
        info.course = -1.0;
        info.year = 0;
        info.month = 0;
        info.day = 0;
        info.hour = 0;
        info.minute = 0;
        info.second = 0;

        let mut events = GPS_EVENTS.lock().await;
        events.reset_parser = true;
        events.new_casic = false;
        events.ack = false;
        events.nack = false;
        events.ephemeris = false;
    }

    async fn maybe_trigger_agnss(
        &mut self,
        state: GpsState,
        now_ms: u64,
        tx: &mut BufferedUarteTx<'static>,
        gps_en: &mut Output<'static>,
    ) -> bool {
        if !agnss_should_trigger(now_ms, state).await {
            return false;
        }
        let message = agnss_start_processing(state, now_ms).await;
        let Some(message) = message else {
            return false;
        };
        self.reset_state_timers();
        if !self.is_gps_powered_on {
            self.power_on_gps(gps_en).await;
        }
        write_all(tx, message.as_slice()).await;
        agnss_mark_message_sent(now_ms).await;
        set_gps_state(GpsState::S5AgnssProcessing).await;
        defmt::info!("GPS State: -> S5_AGNSS_PROCESSING");
        true
    }

    async fn transition_back_from_agnss(&mut self, now_ms: u64, gps_en: &mut Output<'static>) {
        let previous_state = agnss_finish_processing().await;
        self.reset_state_timers();
        match previous_state {
            GpsState::S1GpsSearchingFix => {
                self.fix_attempt_start = Some(now_ms);
                if !self.is_gps_powered_on {
                    self.power_on_gps(gps_en).await;
                }
                set_gps_state(GpsState::S1GpsSearchingFix).await;
                defmt::info!("GPS State: S5 -> S1_GPS_SEARCHING_FIX (AGNSS)");
            }
            GpsState::S2IdleGpsOff => {
                self.power_off_gps(gps_en).await;
                self.periodic_wake_start = Some(now_ms);
                set_gps_state(GpsState::S2IdleGpsOff).await;
                defmt::info!("GPS State: S5 -> S2_IDLE_GPS_OFF (AGNSS)");
            }
            GpsState::S3TrackingFixed => {
                self.active_sampling_start = Some(now_ms);
                set_gps_state(GpsState::S3TrackingFixed).await;
                defmt::info!("GPS State: S5 -> S3_TRACKING_FIXED (AGNSS)");
            }
            GpsState::S4AnalyzingStillness => {
                self.gps_query_timeout_start = Some(now_ms);
                set_gps_state(GpsState::S4AnalyzingStillness).await;
                defmt::info!("GPS State: S5 -> S4_ANALYZING_STILLNESS (AGNSS)");
            }
            GpsState::S5AgnssProcessing | GpsState::S0Initializing => {
                self.power_off_gps(gps_en).await;
                self.periodic_wake_start = Some(now_ms);
                set_gps_state(GpsState::S2IdleGpsOff).await;
                defmt::info!("GPS State: S5 -> S2_IDLE_GPS_OFF (AGNSS fallback)");
            }
        }
    }

    async fn step(
        &mut self,
        now_ms: u64,
        tx: &mut BufferedUarteTx<'static>,
        gps_en: &mut Output<'static>,
    ) {
        let (state, location_valid, mut is_stationary, speed) = snapshot_system_info().await;
        if take_gps_wakeup().await {
            is_stationary = false;
        }

        if state != GpsState::S5AgnssProcessing {
            drain_non_agnss_events().await;
        }

        match state {
            GpsState::S0Initializing => {
                defmt::warn!("GPS State: S0 initializing in loop, forcing S2");
                self.power_off_gps(gps_en).await;
                self.reset_state_timers();
                self.periodic_wake_start = Some(now_ms);
                self.is_first_fix_attempt_cycle = true;
                set_gps_state(GpsState::S2IdleGpsOff).await;
            }
            GpsState::S1GpsSearchingFix => {
                if self.fix_attempt_start.is_none() {
                    self.fix_attempt_start = Some(now_ms);
                }
                if !self.is_gps_powered_on {
                    self.power_on_gps(gps_en).await;
                }

                if location_valid {
                    self.reset_state_timers();
                    self.active_sampling_start = Some(now_ms);
                    self.consecutive_fix_failures = 0;
                    self.is_first_fix_attempt_cycle = false;
                    update_last_position(&mut self.last_successful_position).await;
                    set_gps_state(GpsState::S3TrackingFixed).await;
                    defmt::info!("GPS State: S1 -> S3_TRACKING_FIXED (fix)");
                    return;
                }

                let fix_timeout = if self.is_first_fix_attempt_cycle {
                    T_GPS_COLD_START_FIX_TIMEOUT_MS
                } else {
                    T_GPS_REACQUIRE_FIX_TIMEOUT_MS
                };
                if has_elapsed(self.fix_attempt_start, now_ms, fix_timeout) {
                    self.consecutive_fix_failures = self.consecutive_fix_failures.saturating_add(1);
                    if self.consecutive_fix_failures >= MAX_CONSECUTIVE_FIX_FAILURES {
                        defmt::info!("GPS warm restart after fix failures");
                        write_all(tx, b"$PCAS10,1*1D\r\n").await;
                        self.consecutive_fix_failures = 0;
                    }
                    self.power_off_gps(gps_en).await;
                    self.reset_state_timers();
                    self.periodic_wake_start = Some(now_ms);
                    self.is_first_fix_attempt_cycle = true;
                    set_gps_state(GpsState::S2IdleGpsOff).await;
                    defmt::info!("GPS State: S1 -> S2_IDLE_GPS_OFF (timeout)");
                    return;
                }

                if self
                    .maybe_trigger_agnss(state, now_ms, tx, gps_en)
                    .await
                {
                    return;
                }
            }
            GpsState::S2IdleGpsOff => {
                if self.periodic_wake_start.is_none() {
                    self.periodic_wake_start = Some(now_ms);
                }
                if self.is_gps_powered_on {
                    self.power_off_gps(gps_en).await;
                }

                if !is_stationary {
                    self.power_on_gps(gps_en).await;
                    self.reset_state_timers();
                    self.fix_attempt_start = Some(now_ms);
                    set_gps_state(GpsState::S1GpsSearchingFix).await;
                    defmt::info!("GPS State: S2 -> S1_GPS_SEARCHING_FIX (motion)");
                    return;
                }

                if has_elapsed(
                    self.periodic_wake_start,
                    now_ms,
                    T_GPS_SLEEP_PERIODIC_WAKE_INTERVAL_MS,
                ) {
                    self.power_on_gps(gps_en).await;
                    self.reset_state_timers();
                    self.fix_attempt_start = Some(now_ms);
                    self.is_first_fix_attempt_cycle = true;
                    set_gps_state(GpsState::S1GpsSearchingFix).await;
                    defmt::info!("GPS State: S2 -> S1_GPS_SEARCHING_FIX (periodic)");
                    return;
                }

                if self
                    .maybe_trigger_agnss(state, now_ms, tx, gps_en)
                    .await
                {
                    return;
                }
            }
            GpsState::S3TrackingFixed => {
                if self.active_sampling_start.is_none() {
                    self.active_sampling_start = Some(now_ms);
                }
                if !self.is_gps_powered_on {
                    self.power_on_gps(gps_en).await;
                }

                if !location_valid {
                    self.reset_state_timers();
                    self.fix_attempt_start = Some(now_ms);
                    set_gps_state(GpsState::S1GpsSearchingFix).await;
                    defmt::info!("GPS State: S3 -> S1_GPS_SEARCHING_FIX (lost)");
                    return;
                }

                if has_elapsed(
                    self.active_sampling_start,
                    now_ms,
                    T_ACTIVE_SAMPLING_INTERVAL_MS,
                ) {
                    if location_valid {
                        update_last_position(&mut self.last_successful_position).await;
                        let _ = storage::append_gpx_point(
                            self.last_successful_position.timestamp,
                            self.last_successful_position.latitude,
                            self.last_successful_position.longitude,
                            self.last_successful_position.altitude_m,
                        )
                        .await;
                    }
                    self.active_sampling_start = Some(now_ms);
                }

                if !is_stationary {
                    if self.stillness_confirm_start.is_some() {
                        self.stillness_confirm_start = None;
                    }
                } else if self.stillness_confirm_start.is_none() {
                    self.stillness_confirm_start = Some(now_ms);
                }

                if is_stationary
                    && has_elapsed(
                        self.stillness_confirm_start,
                        now_ms,
                        T_STILLNESS_CONFIRM_DURATION_MS,
                    )
                {
                    self.reset_state_timers();
                    self.gps_query_timeout_start = Some(now_ms);
                    set_gps_state(GpsState::S4AnalyzingStillness).await;
                    defmt::info!("GPS State: S3 -> S4_ANALYZING_STILLNESS");
                    return;
                }

                if self
                    .maybe_trigger_agnss(state, now_ms, tx, gps_en)
                    .await
                {
                    return;
                }
            }
            GpsState::S4AnalyzingStillness => {
                if self.gps_query_timeout_start.is_none() {
                    self.gps_query_timeout_start = Some(now_ms);
                }
                if !self.is_gps_powered_on {
                    self.power_on_gps(gps_en).await;
                }

                if !is_stationary {
                    self.reset_state_timers();
                    self.active_sampling_start = Some(now_ms);
                    set_gps_state(GpsState::S3TrackingFixed).await;
                    defmt::info!("GPS State: S4 -> S3_TRACKING_FIXED (motion)");
                    return;
                }

                let s4_timeout = has_elapsed(
                    self.gps_query_timeout_start,
                    now_ms,
                    T_GPS_QUERY_TIMEOUT_FOR_STILLNESS_MS,
                );
                if s4_timeout || location_valid {
                    if !s4_timeout && location_valid && speed > GPS_SPEED_VEHICLE_THRESHOLD_KMPH {
                        self.reset_state_timers();
                        self.active_sampling_start = Some(now_ms);
                        set_gps_state(GpsState::S3TrackingFixed).await;
                        defmt::info!("GPS State: S4 -> S3_TRACKING_FIXED (speed)");
                    } else {
                        self.power_off_gps(gps_en).await;
                        self.reset_state_timers();
                        self.periodic_wake_start = Some(now_ms);
                        self.is_first_fix_attempt_cycle = true;
                        set_gps_state(GpsState::S2IdleGpsOff).await;
                        defmt::info!("GPS State: S4 -> S2_IDLE_GPS_OFF");
                    }
                    return;
                }

                if self
                    .maybe_trigger_agnss(state, now_ms, tx, gps_en)
                    .await
                {
                    return;
                }
            }
            GpsState::S5AgnssProcessing => {
                if !self.is_gps_powered_on {
                    self.power_on_gps(gps_en).await;
                }

                match take_agnss_ack().await {
                    AgnssAck::Ack => {
                        defmt::info!("S5: ACK received for AGNSS message");
                        match agnss_ack_next().await {
                            AgnssOutcome::Send(message) => {
                                write_all(tx, message.as_slice()).await;
                                agnss_mark_message_sent(now_ms).await;
                            }
                            AgnssOutcome::Complete => {
                                self.transition_back_from_agnss(now_ms, gps_en).await;
                            }
                        }
                        return;
                    }
                    AgnssAck::Nack => {
                        defmt::info!("S5: NACK received (treating as ACK)");
                        match agnss_ack_next().await {
                            AgnssOutcome::Send(message) => {
                                write_all(tx, message.as_slice()).await;
                                agnss_mark_message_sent(now_ms).await;
                            }
                            AgnssOutcome::Complete => {
                                self.transition_back_from_agnss(now_ms, gps_en).await;
                            }
                        }
                        return;
                    }
                    AgnssAck::None => {}
                }

                if agnss_message_timeout(now_ms).await {
                    defmt::info!("S5: AGNSS message timeout");
                    match agnss_retry_or_fail().await {
                        AgnssOutcome::Send(message) => {
                            defmt::info!("S5: Retrying AGNSS message");
                            write_all(tx, message.as_slice()).await;
                            agnss_mark_message_sent(now_ms).await;
                        }
                        AgnssOutcome::Complete => {
                            defmt::info!("S5: AGNSS retries exhausted");
                            self.transition_back_from_agnss(now_ms, gps_en).await;
                        }
                    }
                    return;
                }

                if agnss_total_timeout(now_ms).await {
                    defmt::info!("S5: AGNSS total timeout");
                    self.transition_back_from_agnss(now_ms, gps_en).await;
                    return;
                }

                if !is_stationary {
                    agnss_note_motion().await;
                }
            }
        }
    }
}

#[embassy_executor::task]
pub async fn gps_rx_task(mut rx: BufferedUarteRx<'static>) {
    let mut parser = CasicParser::new();
    let mut nmea = Nmea::default();
    let mut nmea_buf = NmeaBuffer::new();
    let mut speed_avg = SpeedAverage::new();
    let mut buf = [0u8; 128];

    loop {
        let reset = {
            let mut events = GPS_EVENTS.lock().await;
            if events.reset_parser {
                events.reset_parser = false;
                true
            } else {
                false
            }
        };

        if reset {
            let now_ms = Instant::now().as_millis();
            parser.reset(now_ms);
            nmea = Nmea::default();
            nmea_buf.reset();
            speed_avg.reset();
        }

        match rx.read(&mut buf).await {
            Ok(n) => {
                if n == 0 {
                    continue;
                }
                let now_ms = Instant::now().as_millis();
                for &byte in &buf[..n] {
                    parser.encode(byte, now_ms);

                    if parser.parser_state() == CasicParserState::Idle {
                        if let Some(line_len) = nmea_buf.push(byte) {
                            if let Some(sentence) = nmea_buf.as_str(line_len) {
                                if nmea.parse(sentence).is_ok() {
                                    let mut info = SYSTEM_INFO.lock().await;
                                    update_system_info_from_nmea(
                                        &mut *info,
                                        &nmea,
                                        &mut speed_avg,
                                    );
                                }
                            }
                        }
                    }
                }

                if parser.is_new_casic_data() {
                    let pkt = parser.last_casic_packet();
                    defmt::debug!(
                        "CASIC class={} id={} len={} valid={}",
                        pkt.class_id,
                        pkt.msg_id,
                        pkt.payload_length,
                        pkt.valid
                    );
                    let mut events = GPS_EVENTS.lock().await;
                    events.last_packet = pkt;
                    events.new_casic = true;
                    if parser.has_new_ack() {
                        events.ack = true;
                    }
                    if parser.has_new_nack() {
                        events.nack = true;
                    }
                    if parser.has_new_ephemeris() {
                        events.ephemeris = true;
                    }
                    parser.clear_casic_data();
                }
            }
            Err(_) => {
                defmt::warn!("GPS UART read error");
                Timer::after_millis(50).await;
            }
        }
    }
}

#[embassy_executor::task]
pub async fn gps_state_task(
    mut tx: BufferedUarteTx<'static>,
    mut gps_en: Output<'static>,
) {
    set_gps_state(GpsState::S0Initializing).await;
    configure_gps_uart(&mut tx, &mut gps_en).await;
    let mut sm = GpsStateMachine::new();
    sm.initialize(&mut gps_en).await;

    loop {
        let now_ms = Instant::now().as_millis();
        sm.step(now_ms, &mut tx, &mut gps_en).await;
        Timer::after_millis(STATE_TICK_INTERVAL_MS).await;
    }
}

pub async fn set_agnss_message_queue(messages: &[&[u8]]) -> Result<(), AgnssQueueError> {
    let mut agnss = AGNSS_STATE.lock().await;
    agnss.queue.clear();
    for message in messages {
        if let Err(err) = agnss.queue.push(message) {
            agnss.queue.clear();
            agnss.request_pending = false;
            agnss.force_trigger = false;
            return Err(err);
        }
    }
    agnss.request_pending = !agnss.queue.is_empty();
    agnss.force_trigger = false;
    Ok(())
}

pub async fn trigger_gps_wakeup() {
    let mut wake = GPS_WAKEUP.lock().await;
    *wake = true;
    let mut info = SYSTEM_INFO.lock().await;
    info.is_stationary = false;
}

fn update_system_info_from_nmea(info: &mut SystemInfo, nmea: &Nmea, speed_avg: &mut SpeedAverage) {
    let location_valid = nmea
        .fix_type
        .map(|f| f.is_valid())
        .unwrap_or(false)
        && nmea.latitude.is_some()
        && nmea.longitude.is_some();

    let date_time_valid = match (nmea.fix_date, nmea.fix_time) {
        (Some(date), Some(time)) => {
            let year = date.year() as u16;
            if year >= 2025 {
                info.year = year;
                info.month = date.month() as u8;
                info.day = date.day() as u8;
                info.hour = time.hour() as u8;
                info.minute = time.minute() as u8;
                info.second = time.second() as u8;
                true
            } else {
                false
            }
        }
        _ => false,
    };

    if !date_time_valid {
        info.year = 0;
        info.month = 0;
        info.day = 0;
        info.hour = 0;
        info.minute = 0;
        info.second = 0;
    }
    info.date_time_valid = date_time_valid;

    let hdop_valid = nmea.hdop.map(|h| h <= MIN_HDOP_FOR_VALID_FIX).unwrap_or(false);
    let satellites = nmea.fix_satellites().unwrap_or(0);
    let satellites_valid = satellites >= 4;

    let is_high_speed = speed_avg.get_average() > GPS_HIGH_SPEED_THRESHOLD_KMPH;
    if is_high_speed && satellites_valid {
        info.location_valid = location_valid && date_time_valid && satellites_valid;
    } else {
        info.location_valid = location_valid && date_time_valid && hdop_valid && satellites_valid;
    }

    if info.location_valid {
        info.latitude = nmea.latitude.unwrap_or(0.0);
        info.longitude = nmea.longitude.unwrap_or(0.0);
        info.satellites = satellites;
        info.altitude = nmea.altitude.unwrap_or(0.0);
    } else {
        info.latitude = 0.0;
        info.longitude = 0.0;
        info.satellites = satellites;
        info.altitude = 0.0;
    }

    info.hdop = nmea.hdop.unwrap_or(99.9);

    if let Some(knots) = nmea.speed_over_ground {
        let kmh = knots * KMPH_PER_KNOT;
        info.speed = kmh;
        speed_avg.add_sample(kmh);
    } else {
        info.speed = -1.0;
    }

    if let Some(course) = nmea.true_course {
        info.course = course;
    } else {
        info.course = -1.0;
    }
}

async fn configure_gps_uart(tx: &mut BufferedUarteTx<'static>, gps_en: &mut Output<'static>) {
    gps_en.set_high();
    Timer::after_millis(100).await;

    tx.set_baudrate(Baudrate::BAUD9600);
    write_all(tx, b"$PCAS04,7*1E\r\n").await;
    write_all(tx, b"$PCAS03,1,0,0,0,1,0,0,0,0,0,,,0,0*02\r\n").await;
    Timer::after_millis(1500).await;
    write_all(tx, b"$PCAS01,5*19\r\n").await;
    Timer::after_millis(1500).await;

    tx.set_baudrate(Baudrate::BAUD115200);
    for _ in 0..4 {
        write_all(tx, b"$PCAS02,500*1A\r\n").await;
        Timer::after_millis(100).await;
    }

    request_gps_parser_reset().await;
    defmt::info!("GPS UART configured");
}

async fn request_gps_parser_reset() {
    let mut events = GPS_EVENTS.lock().await;
    events.reset_parser = true;
    events.new_casic = false;
    events.ack = false;
    events.nack = false;
    events.ephemeris = false;
}

async fn update_last_position(last: &mut PositionResult) {
    let info = SYSTEM_INFO.lock().await;
    last.timestamp = date_time_to_unix_timestamp(
        info.year,
        info.month,
        info.day,
        info.hour,
        info.minute,
        info.second,
    );
    last.latitude = info.latitude;
    last.longitude = info.longitude;
    last.altitude_m = info.altitude;
    last.hdop = info.hdop;
}

fn date_time_to_unix_timestamp(
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
) -> u32 {
    if year < 1970 || year > 2038 {
        return 0;
    }
    let mut days = (year as u32 - 1970) * 365;
    let mut y = 1972;
    while y < year {
        days += 1;
        y += 4;
    }
    let is_leap = year % 4 == 0;
    if is_leap && month > 2 {
        days += 1;
    }
    let days_in_month = [0u8, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 1..month {
        days += days_in_month[m as usize] as u32;
    }
    days += (day as u32).saturating_sub(1);
    let mut seconds_val = days * 86_400;
    seconds_val += hour as u32 * 3_600;
    seconds_val += minute as u32 * 60;
    seconds_val += second as u32;
    seconds_val
}

fn has_elapsed(start: Option<u64>, now_ms: u64, timeout_ms: u64) -> bool {
    match start {
        Some(start_ms) => now_ms.wrapping_sub(start_ms) >= timeout_ms,
        None => false,
    }
}

async fn set_gps_state(state: GpsState) {
    let mut info = SYSTEM_INFO.lock().await;
    info.gps_state = state;
}

async fn snapshot_system_info() -> (GpsState, bool, bool, f32) {
    let info = SYSTEM_INFO.lock().await;
    (info.gps_state, info.location_valid, info.is_stationary, info.speed)
}

async fn drain_non_agnss_events() {
    let mut events = GPS_EVENTS.lock().await;
    if events.ack {
        defmt::info!("GPS ACK received");
        events.ack = false;
    }
    if events.nack {
        defmt::info!("GPS NACK received (treating as ACK)");
        events.nack = false;
    }
    if events.ephemeris {
        defmt::info!("GPS Ephemeris data received");
        events.ephemeris = false;
    }
    events.new_casic = false;
}

async fn agnss_should_trigger(now_ms: u64, state: GpsState) -> bool {
    let agnss = AGNSS_STATE.lock().await;
    agnss.should_trigger(now_ms, state)
}

async fn agnss_start_processing(state: GpsState, now_ms: u64) -> Option<AgnssMessage> {
    let mut agnss = AGNSS_STATE.lock().await;
    agnss.start_processing(now_ms, state)
}

async fn agnss_mark_message_sent(now_ms: u64) {
    let mut agnss = AGNSS_STATE.lock().await;
    agnss.mark_message_sent(now_ms);
}

async fn agnss_ack_next() -> AgnssOutcome {
    let mut agnss = AGNSS_STATE.lock().await;
    agnss.ack_next()
}

async fn agnss_retry_or_fail() -> AgnssOutcome {
    let mut agnss = AGNSS_STATE.lock().await;
    agnss.retry_or_fail()
}

async fn agnss_message_timeout(now_ms: u64) -> bool {
    let agnss = AGNSS_STATE.lock().await;
    agnss.message_timeout(now_ms)
}

async fn agnss_total_timeout(now_ms: u64) -> bool {
    let agnss = AGNSS_STATE.lock().await;
    agnss.total_timeout(now_ms)
}

async fn agnss_finish_processing() -> GpsState {
    let mut agnss = AGNSS_STATE.lock().await;
    let previous_state = agnss.previous_state;
    agnss.clear_all();
    previous_state
}

async fn agnss_note_motion() {
    let mut agnss = AGNSS_STATE.lock().await;
    match agnss.previous_state {
        GpsState::S2IdleGpsOff | GpsState::S4AnalyzingStillness => {
            agnss.previous_state = GpsState::S3TrackingFixed;
        }
        _ => {}
    }
}

async fn take_agnss_ack() -> AgnssAck {
    let mut events = GPS_EVENTS.lock().await;
    if events.ack {
        events.ack = false;
        events.new_casic = false;
        return AgnssAck::Ack;
    }
    if events.nack {
        events.nack = false;
        events.new_casic = false;
        return AgnssAck::Nack;
    }
    AgnssAck::None
}

async fn take_gps_wakeup() -> bool {
    let mut wake = GPS_WAKEUP.lock().await;
    if *wake {
        *wake = false;
        true
    } else {
        false
    }
}

async fn write_all(tx: &mut BufferedUarteTx<'static>, data: &[u8]) {
    let mut offset = 0;
    while offset < data.len() {
        match tx.write(&data[offset..]).await {
            Ok(0) => {
                Timer::after_millis(10).await;
            }
            Ok(n) => offset += n,
            Err(_) => {
                defmt::warn!("GPS UART write error");
                Timer::after_millis(10).await;
            }
        }
    }
    let _ = tx.flush().await;
}
