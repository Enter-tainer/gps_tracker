use embassy_nrf::buffered_uarte::BufferedUarte;
use embassy_nrf::gpio::Output;
use embassy_time::{Instant, Timer};
use nmea::Nmea;
use chrono::{Datelike, Timelike};

use crate::casic::{CasicParser, CasicParserState};
use crate::system_info::SystemInfo;
use crate::system_info::{GpsState, SYSTEM_INFO};

const MIN_HDOP_FOR_VALID_FIX: f32 = 2.0;
const GPS_HIGH_SPEED_THRESHOLD_KMPH: f32 = 20.0;
const KMPH_PER_KNOT: f32 = 1.852;
const NMEA_MAX_LEN: usize = 96;

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

#[embassy_executor::task]
pub async fn gps_task(mut uart: BufferedUarte<'static>, mut gps_en: Output<'static>) {
    gps_en.set_high();
    defmt::info!("GPS power enabled");

    {
        let mut info = SYSTEM_INFO.lock().await;
        info.gps_state = GpsState::S1GpsSearchingFix;
        info.location_valid = false;
        info.date_time_valid = false;
    }

    let mut parser = CasicParser::new();
    let mut nmea = Nmea::default();
    let mut nmea_buf = NmeaBuffer::new();
    let mut speed_avg = SpeedAverage::new();
    let mut buf = [0u8; 128];
    loop {
        match uart.read(&mut buf).await {
            Ok(n) => {
                if n > 0 {
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
                        parser.clear_casic_data();
                    }
                }
            }
            Err(_) => {
                defmt::warn!("GPS UART read error");
                Timer::after_millis(50).await;
            }
        }
    }
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
        info.location_valid =
            location_valid && date_time_valid && hdop_valid && satellites_valid;
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
