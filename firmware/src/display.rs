use core::fmt::Write;

use embassy_embedded_hal::shared_bus::blocking::i2c::I2cDevice;
use embassy_executor::task;
use embassy_futures::select::{select, Either};
use embassy_nrf::twim;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::blocking_mutex::raw::NoopRawMutex;
use embassy_sync::channel::Channel;
use embassy_time::{Instant, Timer};
use embedded_graphics::mono_font::ascii::FONT_5X7;
use embedded_graphics::mono_font::MonoTextStyle;
use embedded_graphics::pixelcolor::BinaryColor;
use embedded_graphics::prelude::*;
use embedded_graphics::text::{Baseline, Text, TextStyleBuilder};
use embedded_graphics::text::renderer::TextRenderer;
use heapless::String;
use ssd1306::{I2CDisplayInterface, Ssd1306};
use ssd1306::mode::BufferedGraphicsMode;
use ssd1306::prelude::{DisplayConfig, DisplayRotation, DisplaySize128x64, I2CInterface};

use crate::battery::estimate_battery_level;
use crate::system_info::{GpsState, SystemInfo, SYSTEM_INFO};

const DISPLAY_UPDATE_INTERVAL_MS: u64 = 100;
const DISPLAY_TIMEOUT_MS: u64 = 30_000;
const SCREEN_WIDTH: i32 = 128;
const LINE_HEIGHT: i32 = 8;

type SharedI2c = I2cDevice<'static, NoopRawMutex, twim::Twim<'static>>;
type Display = Ssd1306<I2CInterface<SharedI2c>, DisplaySize128x64, BufferedGraphicsMode<DisplaySize128x64>>;

#[derive(Clone, Copy, Debug)]
pub enum DisplayCommand {
    Toggle,
    TurnOn,
    TurnOff,
    ResetTimeout,
    UsbMode,
}

static DISPLAY_COMMANDS: Channel<CriticalSectionRawMutex, DisplayCommand, 8> = Channel::new();

pub fn send_command(cmd: DisplayCommand) {
    let _ = DISPLAY_COMMANDS.try_send(cmd);
}

#[task]
pub async fn display_task(i2c: SharedI2c) {
    let interface = I2CDisplayInterface::new(i2c);
    let mut display: Display = Ssd1306::new(interface, DisplaySize128x64, DisplayRotation::Rotate0)
        .into_buffered_graphics_mode();

    if display.init().is_err() {
        defmt::warn!("Display init failed");
        return;
    }

    let mut display_on = false;
    let mut last_activity = Instant::now();
    let mut usb_mode = false;

    let text_style = MonoTextStyle::new(&FONT_5X7, BinaryColor::On);
    let text_settings = TextStyleBuilder::new().baseline(Baseline::Top).build();

    handle_command(
        DisplayCommand::TurnOn,
        &mut display,
        &mut display_on,
        &mut last_activity,
        &mut usb_mode,
        &text_style,
        text_settings,
    )
    .await;

    loop {
        if display_on {
            match select(
                DISPLAY_COMMANDS.receive(),
                Timer::after_millis(DISPLAY_UPDATE_INTERVAL_MS),
            )
            .await
            {
                Either::First(cmd) => {
                    handle_command(
                        cmd,
                        &mut display,
                        &mut display_on,
                        &mut last_activity,
                        &mut usb_mode,
                        &text_style,
                        text_settings,
                    )
                    .await;
                }
                Either::Second(()) => {
                    let now_ms = Instant::now().as_millis();
                    if now_ms.wrapping_sub(last_activity.as_millis()) > DISPLAY_TIMEOUT_MS {
                        handle_command(
                            DisplayCommand::TurnOff,
                            &mut display,
                            &mut display_on,
                            &mut last_activity,
                            &mut usb_mode,
                            &text_style,
                            text_settings,
                        )
                        .await;
                        continue;
                    }
                    if usb_mode {
                        render_usb_mode(&mut display, &text_style, text_settings);
                    } else {
                        let info = *SYSTEM_INFO.lock().await;
                        render_frame(&mut display, &text_style, text_settings, &info);
                    }
                }
            }
        } else {
            let cmd = DISPLAY_COMMANDS.receive().await;
            handle_command(
                cmd,
                &mut display,
                &mut display_on,
                &mut last_activity,
                &mut usb_mode,
                &text_style,
                text_settings,
            )
            .await;
        }

        while let Ok(cmd) = DISPLAY_COMMANDS.try_receive() {
            handle_command(
                cmd,
                &mut display,
                &mut display_on,
                &mut last_activity,
                &mut usb_mode,
                &text_style,
                text_settings,
            )
            .await;
        }
    }
}

async fn handle_command(
    cmd: DisplayCommand,
    display: &mut Display,
    display_on: &mut bool,
    last_activity: &mut Instant,
    usb_mode: &mut bool,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
) {
    match cmd {
        DisplayCommand::Toggle => {
            if *display_on {
                turn_display_off(display, display_on);
            } else {
                turn_display_on(display, display_on, last_activity);
                if *usb_mode {
                    render_usb_mode(display, text_style, text_settings);
                } else {
                    let info = *SYSTEM_INFO.lock().await;
                    render_frame(display, text_style, text_settings, &info);
                }
            }
        }
        DisplayCommand::TurnOn => {
            turn_display_on(display, display_on, last_activity);
            if *usb_mode {
                render_usb_mode(display, text_style, text_settings);
            } else {
                let info = *SYSTEM_INFO.lock().await;
                render_frame(display, text_style, text_settings, &info);
            }
        }
        DisplayCommand::TurnOff => {
            turn_display_off(display, display_on);
        }
        DisplayCommand::ResetTimeout => {
            *last_activity = Instant::now();
        }
        DisplayCommand::UsbMode => {
            *usb_mode = true;
            turn_display_on(display, display_on, last_activity);
            render_usb_mode(display, text_style, text_settings);
        }
    }
}

fn turn_display_on(
    display: &mut Display,
    display_on: &mut bool,
    last_activity: &mut Instant,
) {
    if *display_on {
        *last_activity = Instant::now();
        return;
    }
    let _ = display.set_display_on(true);
    *display_on = true;
    *last_activity = Instant::now();
}

fn turn_display_off(display: &mut Display, display_on: &mut bool) {
    if !*display_on {
        return;
    }
    let _ = display.clear(BinaryColor::Off);
    let _ = display.flush();
    let _ = display.set_display_on(false);
    *display_on = false;
}

fn render_frame(
    display: &mut Display,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
    info: &SystemInfo,
) {
    let _ = display.clear(BinaryColor::Off);

    let mut line = String::<32>::new();
    line.push_str("Spd:").ok();
    if info.speed >= 0.0 {
        let _ = write!(line, "{:.1}", info.speed);
    } else {
        line.push_str("N/A").ok();
    }
    if info.is_stationary {
        line.push_str(" S").ok();
    }
    Text::with_text_style(&line, Point::new(0, 0), *text_style, text_settings)
        .draw(display)
        .ok();

    let mut course = String::<16>::new();
    course.push_str("Crs:").ok();
    if info.course >= 0.0 {
        let _ = write!(course, "{:.0}", info.course);
    } else {
        course.push_str("N/A").ok();
    }
    let speed_width = text_width(text_style, &line);
    let course_width = text_width(text_style, &course);
    let mut course_x = SCREEN_WIDTH - 1 - course_width;
    let min_x = speed_width + 5;
    if course_x < min_x {
        course_x = min_x;
    }
    if course_x < 0 {
        course_x = 0;
    }
    Text::with_text_style(&course, Point::new(course_x, 0), *text_style, text_settings)
        .draw(display)
        .ok();

    draw_line(
        display,
        text_style,
        text_settings,
        1,
        "Date: ",
        format_date(info),
    );
    draw_line(
        display,
        text_style,
        text_settings,
        2,
        "Time: ",
        format_time(info),
    );
    draw_line(
        display,
        text_style,
        text_settings,
        3,
        "Lat:",
        format_lat(info),
    );
    draw_line(
        display,
        text_style,
        text_settings,
        4,
        "Lng:",
        format_lng(info),
    );

    let mut line6 = String::<32>::new();
    line6.push_str("A:").ok();
    if info.location_valid {
        let _ = write!(line6, "{:.1}m", info.altitude);
    } else {
        line6.push_str("N/A").ok();
    }
    let _ = write!(line6, " S:{}", info.satellites);
    line6.push_str(" H:").ok();
    if info.hdop < 99.0 {
        let _ = write!(line6, "{:.1}", info.hdop);
    } else {
        line6.push_str("N/A").ok();
    }
    Text::with_text_style(
        &line6,
        Point::new(0, LINE_HEIGHT * 5),
        *text_style,
        text_settings,
    )
    .draw(display)
    .ok();

    let gps_state = gps_state_label(info.gps_state);
    let mut line7 = String::<32>::new();
    line7.push_str("GPS: ").ok();
    line7.push_str(gps_state).ok();
    Text::with_text_style(
        &line7,
        Point::new(0, LINE_HEIGHT * 6),
        *text_style,
        text_settings,
    )
    .draw(display)
    .ok();

    let mut battery = String::<32>::new();
    battery.push_str("Bat:").ok();
    if info.battery_voltage >= 0.0 {
        let _ = write!(battery, "{:.2}V/", info.battery_voltage);
        let percent = estimate_battery_level(info.battery_voltage * 1000.0);
        let _ = write!(battery, "{:.0}%", percent);
    } else {
        battery.push_str("N/A").ok();
    }
    let battery_width = text_width(text_style, &battery);
    let mut battery_x = SCREEN_WIDTH - 1 - battery_width;
    if battery_x < 0 {
        battery_x = 0;
    }
    Text::with_text_style(
        &battery,
        Point::new(battery_x, LINE_HEIGHT * 7),
        *text_style,
        text_settings,
    )
    .draw(display)
    .ok();

    let _ = display.flush();
}

fn render_usb_mode(
    display: &mut Display,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
) {
    let _ = display.clear(BinaryColor::Off);

    Text::with_text_style(
        "USB MODE",
        Point::new(0, LINE_HEIGHT * 2),
        *text_style,
        text_settings,
    )
    .draw(display)
    .ok();
    Text::with_text_style(
        "Transferring...",
        Point::new(0, LINE_HEIGHT * 4),
        *text_style,
        text_settings,
    )
    .draw(display)
    .ok();

    let _ = display.flush();
}

fn draw_line<D>(
    display: &mut D,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
    line_index: i32,
    prefix: &str,
    value: String<32>,
) where
    D: DrawTarget<Color = BinaryColor>,
{
    let mut line = String::<32>::new();
    line.push_str(prefix).ok();
    line.push_str(&value).ok();
    Text::with_text_style(
        &line,
        Point::new(0, LINE_HEIGHT * line_index),
        *text_style,
        text_settings,
    )
    .draw(display)
    .ok();
}

fn format_date(info: &SystemInfo) -> String<32> {
    let mut out = String::<32>::new();
    if info.date_time_valid {
        let _ = write!(out, "{:04}-{:02}-{:02}", info.year, info.month, info.day);
    } else {
        out.push_str("N/A").ok();
    }
    out
}

fn format_time(info: &SystemInfo) -> String<32> {
    let mut out = String::<32>::new();
    if info.date_time_valid {
        let _ = write!(out, "{:02}:{:02}:{:02}", info.hour, info.minute, info.second);
    } else {
        out.push_str("N/A").ok();
    }
    out
}

fn format_lat(info: &SystemInfo) -> String<32> {
    let mut out = String::<32>::new();
    if info.location_valid {
        let _ = write!(out, "{:.6}", info.latitude);
    } else {
        out.push_str("N/A").ok();
    }
    out
}

fn format_lng(info: &SystemInfo) -> String<32> {
    let mut out = String::<32>::new();
    if info.location_valid {
        let _ = write!(out, "{:.6}", info.longitude);
    } else {
        out.push_str("N/A").ok();
    }
    out
}

fn gps_state_label(state: GpsState) -> &'static str {
    match state {
        GpsState::S0Initializing => "Initializing",
        GpsState::S1GpsSearchingFix => "Searching",
        GpsState::S2IdleGpsOff => "Idle (GPS Off)",
        GpsState::S3TrackingFixed => "Fixed",
        GpsState::S4AnalyzingStillness => "Analyze-Still",
        GpsState::S5AgnssProcessing => "AGNSS Proc",
    }
}

fn text_width(style: &MonoTextStyle<'_, BinaryColor>, text: &str) -> i32 {
    let metrics = style.measure_string(text, Point::zero(), Baseline::Top);
    metrics.bounding_box.size.width as i32
}
