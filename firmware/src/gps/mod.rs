mod agnss;
mod nmea_parser;
mod state_machine;

use embassy_nrf::buffered_uarte::{Baudrate, BufferedUarteRx, BufferedUarteTx};
use embassy_nrf::gpio::Output;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;
use embassy_time::{Instant, Timer};
use nmea::Nmea;

use crate::casic::{CasicPacket, CasicParser, CasicParserState, CASIC_MAX_PAYLOAD_SIZE};
use crate::system_info::{GpsState, SYSTEM_INFO};

pub use agnss::{set_agnss_message_queue, AgnssMessage, AgnssQueueError, MAX_AGNSS_MESSAGE_SIZE};
use agnss::AgnssAck;
use nmea_parser::{update_system_info_from_nmea, NmeaBuffer, SpeedAverage};
use state_machine::GpsStateMachine;

const GPS_SPEED_VEHICLE_THRESHOLD_KMPH: f32 = 5.0;

const T_ACTIVE_SAMPLING_INTERVAL_MS: u64 = 1_000;
const T_STILLNESS_CONFIRM_DURATION_MS: u64 = 60_000;
const T_GPS_QUERY_TIMEOUT_FOR_STILLNESS_MS: u64 = 5_000;
const T_GPS_COLD_START_FIX_TIMEOUT_MS: u64 = 90_000;
const T_GPS_REACQUIRE_FIX_TIMEOUT_MS: u64 = 30_000;
const MAX_CONSECUTIVE_FIX_FAILURES: u8 = 16;
const STATE_TICK_INTERVAL_MS: u64 = 200;

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
static GPS_KEEP_ALIVE_DEADLINE: Mutex<CriticalSectionRawMutex, Option<u64>> = Mutex::new(None);

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

pub async fn trigger_gps_wakeup() {
    let mut wake = GPS_WAKEUP.lock().await;
    *wake = true;
    let mut info = SYSTEM_INFO.lock().await;
    info.is_stationary = false;
}

pub async fn set_gps_keep_alive(duration_minutes: u16) {
    let mut ka = GPS_KEEP_ALIVE_DEADLINE.lock().await;
    if duration_minutes == 0 {
        *ka = None;
        defmt::info!("GPS keep-alive cancelled");
    } else {
        let now_ms = Instant::now().as_millis();
        let deadline = now_ms + (duration_minutes as u64) * 60_000;
        *ka = Some(deadline);
        defmt::info!("GPS keep-alive set for {} minutes", duration_minutes);
    }
    drop(ka);
    if duration_minutes > 0 {
        trigger_gps_wakeup().await;
    }
}

pub async fn get_keep_alive_remaining_s() -> u16 {
    let ka = GPS_KEEP_ALIVE_DEADLINE.lock().await;
    match *ka {
        Some(deadline) => {
            let now_ms = Instant::now().as_millis();
            if now_ms >= deadline {
                0
            } else {
                ((deadline - now_ms) / 1000) as u16
            }
        }
        None => 0,
    }
}

async fn is_keep_alive_active(now_ms: u64) -> bool {
    let mut ka = GPS_KEEP_ALIVE_DEADLINE.lock().await;
    match *ka {
        Some(deadline) => {
            if now_ms >= deadline {
                *ka = None;
                defmt::info!("GPS keep-alive expired");
                false
            } else {
                true
            }
        }
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

fn has_elapsed(start: Option<u64>, now_ms: u64, timeout_ms: u64) -> bool {
    match start {
        Some(start_ms) => now_ms.wrapping_sub(start_ms) >= timeout_ms,
        None => false,
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
