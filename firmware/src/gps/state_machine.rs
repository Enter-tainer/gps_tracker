use embassy_nrf::buffered_uarte::BufferedUarteTx;
use embassy_nrf::gpio::Output;
use embassy_time::Timer;

use super::agnss::{
    agnss_ack_next, agnss_finish_processing, agnss_mark_message_sent, agnss_message_timeout,
    agnss_note_motion, agnss_retry_or_fail, agnss_should_trigger, agnss_start_processing,
    agnss_total_timeout, AgnssAck, AgnssOutcome,
};
use super::{
    drain_non_agnss_events, has_elapsed, set_gps_state, snapshot_system_info, take_agnss_ack,
    take_gps_wakeup, write_all, GPS_EVENTS, GPS_SPEED_VEHICLE_THRESHOLD_KMPH,
    MAX_CONSECUTIVE_FIX_FAILURES, T_ACTIVE_SAMPLING_INTERVAL_MS, T_GPS_COLD_START_FIX_TIMEOUT_MS,
    T_GPS_QUERY_TIMEOUT_FOR_STILLNESS_MS, T_GPS_REACQUIRE_FIX_TIMEOUT_MS,
    T_STILLNESS_CONFIRM_DURATION_MS,
};
use crate::storage;
use crate::system_info::{GpsState, SYSTEM_INFO};
use crate::timezone;

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

pub(super) struct GpsStateMachine {
    stillness_confirm_start: Option<u64>,
    active_sampling_start: Option<u64>,
    fix_attempt_start: Option<u64>,
    gps_query_timeout_start: Option<u64>,
    consecutive_fix_failures: u8,
    is_gps_powered_on: bool,
    is_first_fix_attempt_cycle: bool,
    last_successful_position: PositionResult,
}

impl GpsStateMachine {
    pub(super) fn new() -> Self {
        Self {
            stillness_confirm_start: None,
            active_sampling_start: None,
            fix_attempt_start: None,
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
        self.gps_query_timeout_start = None;
    }

    pub(super) async fn initialize(&mut self, gps_en: &mut Output<'static>) {
        self.power_off_gps(gps_en).await;
        self.reset_state_timers();
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
                set_gps_state(GpsState::S2IdleGpsOff).await;
                defmt::info!("GPS State: S5 -> S2_IDLE_GPS_OFF (AGNSS fallback)");
            }
        }
    }

    pub(super) async fn step(
        &mut self,
        now_ms: u64,
        tx: &mut BufferedUarteTx<'static>,
        gps_en: &mut Output<'static>,
    ) {
        let (state, location_valid, mut is_stationary, speed) = snapshot_system_info().await;
        if take_gps_wakeup().await {
            is_stationary = false;
        }
        let keep_alive = super::is_keep_alive_active(now_ms).await;

        if state != GpsState::S5AgnssProcessing {
            drain_non_agnss_events().await;
        }

        match state {
            GpsState::S0Initializing => {
                defmt::warn!("GPS State: S0 initializing in loop, forcing S2");
                self.power_off_gps(gps_en).await;
                self.reset_state_timers();
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
                    if keep_alive {
                        self.fix_attempt_start = Some(now_ms);
                        defmt::info!("GPS State: S1 fix timeout, keep-alive active, retrying");
                        return;
                    }
                    self.power_off_gps(gps_en).await;
                    self.reset_state_timers();
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
                if self.is_gps_powered_on {
                    self.power_off_gps(gps_en).await;
                }

                if !is_stationary || keep_alive {
                    self.power_on_gps(gps_en).await;
                    self.reset_state_timers();
                    self.fix_attempt_start = Some(now_ms);
                    set_gps_state(GpsState::S1GpsSearchingFix).await;
                    if keep_alive {
                        defmt::info!("GPS State: S2 -> S1_GPS_SEARCHING_FIX (keep-alive)");
                    } else {
                        defmt::info!("GPS State: S2 -> S1_GPS_SEARCHING_FIX (motion)");
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

                if !is_stationary || keep_alive {
                    if self.stillness_confirm_start.is_some() {
                        self.stillness_confirm_start = None;
                    }
                } else if self.stillness_confirm_start.is_none() {
                    self.stillness_confirm_start = Some(now_ms);
                }

                if is_stationary
                    && !keep_alive
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

                if keep_alive {
                    self.reset_state_timers();
                    self.active_sampling_start = Some(now_ms);
                    set_gps_state(GpsState::S3TrackingFixed).await;
                    defmt::info!("GPS State: S4 -> S3_TRACKING_FIXED (keep-alive)");
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
    timezone::date_time_to_unix_timestamp(year, month, day, hour, minute, second).unwrap_or(0)
}
