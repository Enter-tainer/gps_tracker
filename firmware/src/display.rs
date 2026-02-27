use core::fmt::Write;

use chrono::{Datelike, Timelike};
use embassy_embedded_hal::shared_bus::blocking::i2c::I2cDevice;
use embassy_executor::task;
use embassy_futures::select::{select, Either};
use embassy_nrf::twim;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::blocking_mutex::raw::NoopRawMutex;
use embassy_sync::channel::Channel;
use embassy_time::{Instant, Timer};
use embedded_graphics::image::{Image, ImageRaw};
use embedded_graphics::mono_font::ascii::FONT_6X9;
use embedded_graphics::mono_font::MonoTextStyle;
use embedded_graphics::pixelcolor::BinaryColor;
use embedded_graphics::prelude::*;
use embedded_graphics::text::{Baseline, Text, TextStyleBuilder};
use embedded_graphics::text::renderer::TextRenderer;
use heapless::String;
use ssd1306::mode::BufferedGraphicsMode;
use ssd1306::prelude::{DisplayConfig, DisplayRotation, DisplaySize128x64, I2CInterface};
use ssd1306::{I2CDisplayInterface, Ssd1306};

use crate::battery::estimate_battery_level;
use crate::gps;
use crate::system_info::{GpsState, SystemInfo, SYSTEM_INFO};
use crate::timezone::TzCache;

// Ferris logo bitmap: 64x42 pixels, 1-bit per pixel (MSB first)
// Each row is 8 bytes (64 bits), 42 rows total = 336 bytes
const FERRIS_WIDTH: u32 = 64;
#[allow(dead_code)] // kept for documentation alongside FERRIS_WIDTH
const FERRIS_HEIGHT: u32 = 42;
const FERRIS_LOGO: [u8; 336] = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Row 0
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Row 1
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Row 2
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Row 3
    0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, // Row 4
    0x00, 0x00, 0x00, 0x19, 0xCC, 0x00, 0x00, 0x00, // Row 5
    0x00, 0x00, 0x03, 0x3F, 0xDC, 0xC0, 0x00, 0x00, // Row 6
    0x00, 0x00, 0x03, 0xFF, 0xFF, 0xE0, 0x00, 0x00, // Row 7
    0x00, 0x00, 0x13, 0xFF, 0xFF, 0xE4, 0x00, 0x00, // Row 8
    0x00, 0x00, 0x3F, 0xFF, 0xFF, 0xFE, 0x00, 0x00, // Row 9
    0x00, 0x00, 0x3F, 0xFF, 0xFF, 0xFE, 0x00, 0x30, // Row 10
    0x04, 0x01, 0xBF, 0xFF, 0xFF, 0xFC, 0xC0, 0xE2, // Row 11
    0x06, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xC1, 0xE6, // Row 12
    0x67, 0x81, 0xFF, 0xFF, 0xFF, 0xFF, 0xC3, 0xE7, // Row 13
    0x77, 0x81, 0xFF, 0xFF, 0xFF, 0xFF, 0xC3, 0xEF, // Row 14
    0xF7, 0xCF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFB, 0xEF, // Row 15
    0xFF, 0xCF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFB, 0xFE, // Row 16
    0xFF, 0xCF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFB, 0xFE, // Row 17
    0x7F, 0xC7, 0xFF, 0xFF, 0xFF, 0xFF, 0xF3, 0xFC, // Row 18
    0x3F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xF8, // Row 19
    0x1F, 0xBF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xF0, // Row 20
    0x0F, 0xBF, 0xFF, 0xEF, 0xFF, 0xFF, 0xFF, 0xE0, // Row 21
    0x03, 0xDF, 0xFF, 0xE7, 0xFB, 0xFF, 0xFF, 0xC0, // Row 22
    0x03, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x80, // Row 23
    0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, // Row 24
    0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x80, // Row 25
    0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xC0, // Row 26
    0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xC0, // Row 27
    0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xDB, 0xC0, // Row 28
    0x00, 0xF7, 0x7F, 0xFF, 0xFF, 0xFF, 0x3F, 0x80, // Row 29
    0x00, 0x7B, 0x0F, 0xFF, 0xFF, 0xF8, 0x37, 0x00, // Row 30
    0x00, 0x3D, 0x80, 0x3F, 0xFF, 0x00, 0x67, 0x00, // Row 31
    0x00, 0x1D, 0xC0, 0x00, 0x00, 0x00, 0x6E, 0x00, // Row 32
    0x00, 0x0E, 0xC0, 0x00, 0x00, 0x00, 0x4C, 0x00, // Row 33
    0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x18, 0x00, // Row 34
    0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x18, 0x00, // Row 35
    0x00, 0x01, 0x80, 0x00, 0x00, 0x00, 0x10, 0x00, // Row 36
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Row 37
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Row 38
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Row 39
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Row 40
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Row 41
];

const LOGO_DISPLAY_MS: u64 = 2000;

// USB_ICON bitmap: 32x32 pixels, 1-bit per pixel (MSB first)
// Each row is 4 bytes (32 bits), 32 rows total = 128 bytes
const USB_ICON_WIDTH: u32 = 32;
#[allow(dead_code)] // kept for documentation alongside USB_ICON_WIDTH
const USB_ICON_HEIGHT: u32 = 32;
const USB_ICON: [u8; 128] = [
    0xFF, 0xFF, 0xFF, 0xFF, // Row 0
    0xFF, 0xFF, 0xFF, 0xFF, // Row 1
    0xFF, 0xFF, 0xFF, 0xFF, // Row 2
    0xFF, 0xFF, 0xFF, 0xFF, // Row 3
    0xFF, 0xFF, 0xFF, 0xFF, // Row 4
    0xFF, 0xFF, 0xFF, 0xFF, // Row 5
    0xFF, 0x80, 0x00, 0x0F, // Row 6
    0xFE, 0x00, 0x00, 0x0F, // Row 7
    0xF8, 0x00, 0x00, 0x1F, // Row 8
    0xF0, 0x00, 0x00, 0x01, // Row 9
    0xE0, 0x00, 0x00, 0x00, // Row 10
    0xE0, 0x00, 0x60, 0x00, // Row 11
    0xE3, 0x09, 0x99, 0xFC, // Row 12
    0x83, 0x09, 0x81, 0x0C, // Row 13
    0x03, 0x19, 0x81, 0x18, // Row 14
    0x03, 0x18, 0x71, 0xF8, // Row 15
    0x02, 0x18, 0x19, 0x18, // Row 16
    0x03, 0x33, 0x1B, 0x18, // Row 17
    0xC3, 0xF1, 0xF3, 0xF8, // Row 18
    0xC0, 0x00, 0x00, 0x01, // Row 19
    0xE0, 0x00, 0x00, 0x01, // Row 20
    0xE0, 0x00, 0x00, 0x07, // Row 21
    0xF0, 0x00, 0x00, 0x7F, // Row 22
    0xF8, 0x00, 0x00, 0x7F, // Row 23
    0xFF, 0x80, 0x00, 0xFF, // Row 24
    0xFF, 0xFF, 0xFF, 0xFF, // Row 25
    0xFF, 0xFF, 0xFF, 0xFF, // Row 26
    0xFF, 0xFF, 0xFF, 0xFF, // Row 27
    0xFF, 0xFF, 0xFF, 0xFF, // Row 28
    0xFF, 0xFF, 0xFF, 0xFF, // Row 29
    0xFF, 0xFF, 0xFF, 0xFF, // Row 30
    0xFF, 0xFF, 0xFF, 0xFF, // Row 31
];

const DISPLAY_UPDATE_INTERVAL_MS: u64 = 100;
const DISPLAY_TIMEOUT_MS: u64 = 30_000;
const SCREEN_WIDTH: i32 = 128;
const LINE_HEIGHT: i32 = 9;

type SharedI2c = I2cDevice<'static, NoopRawMutex, twim::Twim<'static>>;
type Display = Ssd1306<I2CInterface<SharedI2c>, DisplaySize128x64, BufferedGraphicsMode<DisplaySize128x64>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DisplayPage {
    Main,
    FindMy,
    GoogleFmdn,
}

#[derive(Clone, Copy)]
struct DisplayTimeAnchor {
    unix_ts: u64,
    monotonic_ms: u64,
}

#[derive(Clone, Copy)]
struct FindMyDisplayTime {
    unix_ts: Option<u64>,
    estimated: bool,
}

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
pub enum DisplayCommand {
    Toggle,
    TurnOn,
    TurnOff,
    ResetTimeout,
    UsbMode,
    SetFindMyAddress([u8; 6]),
    ClearFindMyAddress,
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

    // Show startup logo
    let _ = display.set_display_on(true);
    render_logo(&mut display);
    Timer::after_millis(LOGO_DISPLAY_MS).await;

    let mut display_on = true;
    let mut last_activity = Instant::now();
    let mut usb_mode = false;
    let mut findmy_addr: Option<[u8; 6]> = None;
    let mut current_page = DisplayPage::Main;
    let mut findmy_time_anchor: Option<DisplayTimeAnchor> = None;
    let mut tz_cache = TzCache::new();

    let text_style = MonoTextStyle::new(&FONT_6X9, BinaryColor::On);
    let text_settings = TextStyleBuilder::new().baseline(Baseline::Top).build();

    // Render first frame after logo
    refresh_display(
        &mut display,
        &text_style,
        text_settings,
        &mut tz_cache,
        current_page,
        findmy_addr,
        &mut findmy_time_anchor,
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
                        &mut findmy_addr,
                        &mut current_page,
                        &mut findmy_time_anchor,
                        &mut tz_cache,
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
                            &mut findmy_addr,
                            &mut current_page,
                            &mut findmy_time_anchor,
                            &mut tz_cache,
                            &text_style,
                            text_settings,
                        )
                        .await;
                        continue;
                    }
                    if usb_mode {
                        render_usb_mode(&mut display, &text_style, text_settings);
                    } else {
                        refresh_display(
                            &mut display,
                            &text_style,
                            text_settings,
                            &mut tz_cache,
                            current_page,
                            findmy_addr,
                            &mut findmy_time_anchor,
                        )
                        .await;
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
                &mut findmy_addr,
                &mut current_page,
                &mut findmy_time_anchor,
                &mut tz_cache,
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
                &mut findmy_addr,
                &mut current_page,
                &mut findmy_time_anchor,
                &mut tz_cache,
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
    findmy_addr: &mut Option<[u8; 6]>,
    current_page: &mut DisplayPage,
    findmy_time_anchor: &mut Option<DisplayTimeAnchor>,
    tz_cache: &mut TzCache,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
) {
    match cmd {
        DisplayCommand::Toggle => {
            if !*display_on {
                *current_page = DisplayPage::Main;
                turn_display_on(display, display_on, last_activity);
                if *usb_mode {
                    render_usb_mode(display, text_style, text_settings);
                } else {
                    refresh_display(
                        display, text_style, text_settings, tz_cache,
                        *current_page, *findmy_addr, findmy_time_anchor,
                    )
                    .await;
                }
                return;
            }

            if *usb_mode {
                *current_page = DisplayPage::Main;
                turn_display_off(display, display_on);
                return;
            }

            match *current_page {
                DisplayPage::Main => {
                    *current_page = DisplayPage::FindMy;
                    refresh_display(
                        display, text_style, text_settings, tz_cache,
                        *current_page, *findmy_addr, findmy_time_anchor,
                    )
                    .await;
                    *last_activity = Instant::now();
                }
                DisplayPage::FindMy => {
                    *current_page = DisplayPage::GoogleFmdn;
                    let mut info = *SYSTEM_INFO.lock().await;
                    info.keep_alive_remaining_s = gps::get_keep_alive_remaining_s().await;
                    render_current_page(
                        display,
                        text_style,
                        text_settings,
                        &info,
                        tz_cache,
                        *current_page,
                        *findmy_addr,
                        findmy_time_anchor,
                    )
                    .await;
                    *last_activity = Instant::now();
                }
                DisplayPage::GoogleFmdn => {
                    *current_page = DisplayPage::Main;
                    turn_display_off(display, display_on);
                }
            }
        }
        DisplayCommand::TurnOn => {
            *current_page = DisplayPage::Main;
            turn_display_on(display, display_on, last_activity);
            if *usb_mode {
                render_usb_mode(display, text_style, text_settings);
            } else {
                refresh_display(
                    display, text_style, text_settings, tz_cache,
                    *current_page, *findmy_addr, findmy_time_anchor,
                )
                .await;
            }
        }
        DisplayCommand::TurnOff => {
            *current_page = DisplayPage::Main;
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
        DisplayCommand::SetFindMyAddress(addr) => {
            *findmy_addr = Some(addr);
            if *display_on && !*usb_mode && *current_page == DisplayPage::FindMy {
                refresh_display(
                    display, text_style, text_settings, tz_cache,
                    *current_page, *findmy_addr, findmy_time_anchor,
                )
                .await;
            }
        }
        DisplayCommand::ClearFindMyAddress => {
            *findmy_addr = None;
            if *display_on && !*usb_mode && *current_page == DisplayPage::FindMy {
                refresh_display(
                    display, text_style, text_settings, tz_cache,
                    *current_page, *findmy_addr, findmy_time_anchor,
                )
                .await;
            }
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

fn render_logo(display: &mut Display) {
    let _ = display.clear(BinaryColor::Off);

    let text_style = MonoTextStyle::new(&FONT_6X9, BinaryColor::On);
    let text_settings = TextStyleBuilder::new().baseline(Baseline::Top).build();

    // Top text: "MGT GPS Tracker"
    let title = "MGT GPS Tracker";
    let title_width = title.len() as i32 * 6; // FONT_6X9 is 6 pixels wide
    let title_x = (128 - title_width) / 2;
    Text::with_text_style(title, Point::new(title_x, 0), text_style, text_settings)
        .draw(display)
        .ok();

    // Create raw image from bitmap data (MSB first format)
    let raw_image: ImageRaw<BinaryColor> = ImageRaw::new(&FERRIS_LOGO, FERRIS_WIDTH);

    // Center the logo vertically (offset down a bit for title)
    let x = (128 - FERRIS_WIDTH as i32) / 2;
    let y = 10; // Start below title

    let image = Image::new(&raw_image, Point::new(x, y));
    let _ = image.draw(display);

    // Bottom text: "Powered by Rust"
    let bottom = "Powered by Rust";
    let bottom_width = bottom.len() as i32 * 6;
    let bottom_x = (128 - bottom_width) / 2;
    Text::with_text_style(bottom, Point::new(bottom_x, 55), text_style, text_settings)
        .draw(display)
        .ok();

    let _ = display.flush();
}

async fn render_current_page(
    display: &mut Display,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
    info: &SystemInfo,
    tz_cache: &mut TzCache,
    page: DisplayPage,
    findmy_addr: Option<[u8; 6]>,
    findmy_time_anchor: &mut Option<DisplayTimeAnchor>,
) {
    match page {
        DisplayPage::Main => render_main_page(display, text_style, text_settings, info, tz_cache),
        DisplayPage::FindMy => {
            let findmy_time = resolve_findmy_display_time(info, findmy_time_anchor);
            render_findmy_page(display, text_style, text_settings, info, findmy_addr, findmy_time)
        }
        DisplayPage::GoogleFmdn => {
            render_fmdn_page(display, text_style, text_settings, info)
        }
    }
}

/// Fetch current system info + keep-alive and render the active page.
async fn refresh_display(
    display: &mut Display,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
    tz_cache: &mut TzCache,
    current_page: DisplayPage,
    findmy_addr: Option<[u8; 6]>,
    findmy_time_anchor: &mut Option<DisplayTimeAnchor>,
) {
    let mut info = *SYSTEM_INFO.lock().await;
    info.keep_alive_remaining_s = gps::get_keep_alive_remaining_s().await;
    render_current_page(
        display,
        text_style,
        text_settings,
        &info,
        tz_cache,
        current_page,
        findmy_addr,
        findmy_time_anchor,
    )
    .await;
}

fn render_main_page(
    display: &mut Display,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
    info: &SystemInfo,
    tz_cache: &mut TzCache,
) {
    let _ = display.clear(BinaryColor::Off);

    // Line 0: Speed (left) + Battery (right)
    let mut speed_str = String::<32>::new();
    speed_str.push_str("Spd: ").ok();
    if info.speed >= 0.0 {
        let _ = write!(speed_str, "{:.1}", info.speed);
    } else {
        speed_str.push_str("N/A").ok();
    }
    if info.is_stationary {
        speed_str.push_str(" S").ok();
    }
    if info.keep_alive_remaining_s > 0 {
        speed_str.push_str(" K").ok();
    }
    Text::with_text_style(&speed_str, Point::new(0, 0), *text_style, text_settings)
        .draw(display)
        .ok();

    // Battery on right side of line 0
    let mut battery = String::<16>::new();
    if info.battery_voltage >= 0.0 {
        let percent = estimate_battery_level(info.battery_voltage * 1000.0);
        let _ = write!(battery, "{:.0}%", percent);
    } else {
        battery.push_str("N/A").ok();
    }
    let battery_width = text_width(text_style, &battery);
    let battery_x = SCREEN_WIDTH - 1 - battery_width;
    Text::with_text_style(&battery, Point::new(battery_x, 0), *text_style, text_settings)
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

    // Time line with local time and UTC offset
    let time_str = format_local_time(info, tz_cache);
    draw_line(
        display,
        text_style,
        text_settings,
        2,
        "",
        time_str,
    );
    draw_line(
        display,
        text_style,
        text_settings,
        3,
        "Lat: ",
        format_lat(info),
    );
    draw_line(
        display,
        text_style,
        text_settings,
        4,
        "Lng: ",
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

    let _ = display.flush();
}

fn render_findmy_page(
    display: &mut Display,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
    info: &SystemInfo,
    findmy_addr: Option<[u8; 6]>,
    findmy_time: FindMyDisplayTime,
) {
    let _ = display.clear(BinaryColor::Off);

    let status = findmy_status_text(info, findmy_addr);

    // Keep line-0 right-side battery style consistent with page 1.
    let mut battery = String::<16>::new();
    if info.battery_voltage >= 0.0 {
        let percent = estimate_battery_level(info.battery_voltage * 1000.0);
        let _ = write!(battery, "{:.0}%", percent);
    } else {
        battery.push_str("N/A").ok();
    }
    let battery_width = text_width(text_style, &battery);
    let battery_x = SCREEN_WIDTH - 1 - battery_width;
    Text::with_text_style(&battery, Point::new(battery_x, 0), *text_style, text_settings)
        .draw(display)
        .ok();

    let mac = format_findmy_mac(findmy_addr);
    draw_line(display, text_style, text_settings, 1, "FM:", status);
    draw_line(display, text_style, text_settings, 2, "MAC:", mac);

    let mut gps_state = String::<32>::new();
    gps_state.push_str(gps_state_label(info.gps_state)).ok();
    draw_line(display, text_style, text_settings, 3, "GPS: ", gps_state);

    let (date_text, time_text, estimated_time) = if info.date_time_valid {
        (format_date(info), format_time(info), false)
    } else if let Some(unix_ts) = findmy_time.unix_ts {
        (
            format_date_from_unix(unix_ts),
            format_time_from_unix(unix_ts),
            findmy_time.estimated,
        )
    } else {
        let mut na_date = String::<32>::new();
        na_date.push_str("N/A").ok();
        let mut na_time = String::<32>::new();
        na_time.push_str("N/A").ok();
        (na_date, na_time, false)
    };

    draw_line(display, text_style, text_settings, 4, "Date: ", date_text);
    draw_line(
        display,
        text_style,
        text_settings,
        5,
        if estimated_time { "Time*: " } else { "Time: " },
        time_text,
    );

    let _ = display.flush();
}

fn render_fmdn_page(
    display: &mut Display,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
    info: &SystemInfo,
) {
    let _ = display.clear(BinaryColor::Off);

    // Battery on right side of line 0 (consistent with other pages).
    let mut battery = String::<16>::new();
    if info.battery_voltage >= 0.0 {
        let percent = estimate_battery_level(info.battery_voltage * 1000.0);
        let _ = write!(battery, "{:.0}%", percent);
    } else {
        battery.push_str("N/A").ok();
    }
    let battery_width = text_width(text_style, &battery);
    let battery_x = SCREEN_WIDTH - 1 - battery_width;
    Text::with_text_style(&battery, Point::new(battery_x, 0), *text_style, text_settings)
        .draw(display)
        .ok();

    let status = fmdn_status_text();
    draw_line(display, text_style, text_settings, 1, "FMDN:", status);

    let diag = fmdn_diag_text();
    draw_line(display, text_style, text_settings, 2, "Diag:", diag);

    let rotation = fmdn_rotation_text(info);
    draw_line(display, text_style, text_settings, 3, "EID: ", rotation);

    let mut gps_state = String::<32>::new();
    gps_state.push_str(gps_state_label(info.gps_state)).ok();
    draw_line(display, text_style, text_settings, 4, "GPS: ", gps_state);

    let date_text = format_date(info);
    draw_line(display, text_style, text_settings, 5, "Date: ", date_text);

    let time_text = if info.date_time_valid {
        format_time(info)
    } else {
        let mut na = String::<32>::new();
        na.push_str("N/A").ok();
        na
    };
    draw_line(display, text_style, text_settings, 6, "Time: ", time_text);

    let _ = display.flush();
}

#[cfg(feature = "google-fmdn")]
fn fmdn_status_text() -> String<32> {
    let mut out = String::<32>::new();
    if crate::google_fmdn::is_enabled() {
        out.push_str("Enabled").ok();
    } else {
        out.push_str("Disabled").ok();
    }
    out
}

#[cfg(not(feature = "google-fmdn"))]
fn fmdn_status_text() -> String<32> {
    let mut out = String::<32>::new();
    out.push_str("Disabled").ok();
    out
}

#[cfg(feature = "google-fmdn")]
fn fmdn_diag_text() -> String<32> {
    let mut out = String::<32>::new();
    match crate::google_fmdn::diag_state() {
        crate::google_fmdn::FmdnDiagState::Disabled => {
            out.push_str("Disabled").ok();
        }
        crate::google_fmdn::FmdnDiagState::WaitingGpsTime => {
            out.push_str("Wait GPS time").ok();
        }
        crate::google_fmdn::FmdnDiagState::WaitingBleIdle => {
            out.push_str("Wait BLE idle").ok();
        }
        crate::google_fmdn::FmdnDiagState::EidReady => {
            out.push_str("EID ready").ok();
        }
        crate::google_fmdn::FmdnDiagState::Advertising => {
            out.push_str("Broadcasting").ok();
        }
        crate::google_fmdn::FmdnDiagState::SetAddrFailed => {
            out.push_str("Set addr fail").ok();
        }
        crate::google_fmdn::FmdnDiagState::AdvConfigureFailed => {
            out.push_str("Adv cfg fail").ok();
        }
        crate::google_fmdn::FmdnDiagState::AdvStartFailed => {
            out.push_str("Adv start fail").ok();
        }
    }
    out
}

#[cfg(not(feature = "google-fmdn"))]
fn fmdn_diag_text() -> String<32> {
    let mut out = String::<32>::new();
    out.push_str("N/A").ok();
    out
}

#[cfg(feature = "google-fmdn")]
fn fmdn_rotation_text(info: &SystemInfo) -> String<32> {
    let mut out = String::<32>::new();
    if !crate::google_fmdn::is_enabled() {
        out.push_str("N/A").ok();
        return out;
    }
    if let Some(unix_ts) = info_unix_ts(info) {
        // EID rotation every 1024 seconds.
        let period = 1024u64;
        let remaining = period - (unix_ts % period);
        let _ = write!(out, "rot {}s", remaining);
    } else {
        out.push_str("no time").ok();
    }
    out
}

#[cfg(not(feature = "google-fmdn"))]
fn fmdn_rotation_text(_info: &SystemInfo) -> String<32> {
    let mut out = String::<32>::new();
    out.push_str("N/A").ok();
    out
}

fn render_usb_mode(
    display: &mut Display,
    text_style: &MonoTextStyle<'_, BinaryColor>,
    text_settings: embedded_graphics::text::TextStyle,
) {
    let _ = display.clear(BinaryColor::Off);

    // Top text: "USB Mass Storage"
    let title = "USB Mass Storage";
    let title_width = title.len() as i32 * 6;
    let title_x = (128 - title_width) / 2;
    Text::with_text_style(title, Point::new(title_x, 2), *text_style, text_settings)
        .draw(display)
        .ok();

    // Draw USB icon from bitmap (centered)
    let raw_image: ImageRaw<BinaryColor> = ImageRaw::new(&USB_ICON, USB_ICON_WIDTH);
    let icon_x = (128 - USB_ICON_WIDTH as i32) / 2;
    let icon_y = 14;
    let image = Image::new(&raw_image, Point::new(icon_x, icon_y));
    let _ = image.draw(display);

    // Status text
    let status = "Connected";
    let status_width = status.len() as i32 * 6;
    let status_x = (128 - status_width) / 2;
    Text::with_text_style(status, Point::new(status_x, 48), *text_style, text_settings)
        .draw(display)
        .ok();

    // Bottom hint
    let hint = "Safe to transfer";
    let hint_width = hint.len() as i32 * 6;
    let hint_x = (128 - hint_width) / 2;
    Text::with_text_style(hint, Point::new(hint_x, 57), *text_style, text_settings)
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

fn resolve_findmy_display_time(
    info: &SystemInfo,
    anchor: &mut Option<DisplayTimeAnchor>,
) -> FindMyDisplayTime {
    if let Some(unix_ts) = info_unix_ts(info) {
        *anchor = Some(DisplayTimeAnchor {
            unix_ts,
            monotonic_ms: Instant::now().as_millis(),
        });
        return FindMyDisplayTime {
            unix_ts: Some(unix_ts),
            estimated: false,
        };
    }

    if let Some(base) = *anchor {
        let now_ms = Instant::now().as_millis();
        let elapsed_secs = now_ms.saturating_sub(base.monotonic_ms) / 1000;
        return FindMyDisplayTime {
            unix_ts: Some(base.unix_ts.saturating_add(elapsed_secs)),
            estimated: true,
        };
    }

    FindMyDisplayTime {
        unix_ts: None,
        estimated: false,
    }
}

fn format_date_from_unix(unix_ts: u64) -> String<32> {
    let mut out = String::<32>::new();
    if let Some(dt) = chrono::DateTime::from_timestamp(unix_ts as i64, 0) {
        let _ = write!(out, "{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day());
    } else {
        out.push_str("N/A").ok();
    }
    out
}

fn format_time_from_unix(unix_ts: u64) -> String<32> {
    let mut out = String::<32>::new();
    if let Some(dt) = chrono::DateTime::from_timestamp(unix_ts as i64, 0) {
        let _ = write!(out, "{:02}:{:02}:{:02}", dt.hour(), dt.minute(), dt.second());
    } else {
        out.push_str("N/A").ok();
    }
    out
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

#[allow(dead_code)]
fn format_time(info: &SystemInfo) -> String<32> {
    let mut out = String::<32>::new();
    if info.date_time_valid {
        let _ = write!(out, "{:02}:{:02}:{:02}", info.hour, info.minute, info.second);
    } else {
        out.push_str("N/A").ok();
    }
    out
}

/// Format local time with UTC offset, e.g. "Time: 14:30:00 +8"
fn format_local_time(info: &SystemInfo, tz_cache: &mut TzCache) -> String<32> {
    let mut out = String::<32>::new();
    out.push_str("Time: ").ok();
    
    if !info.date_time_valid {
        out.push_str("N/A").ok();
        return out;
    }
    
    // Get UTC offset if we have valid location
    let offset = if info.location_valid {
        tz_cache.get_offset(
            info.latitude as f32,
            info.longitude as f32,
            info.year,
            info.month,
            info.day,
            info.hour,
            info.minute,
            info.second,
        )
    } else {
        crate::timezone::UtcOffset::from_minutes(0)
    };
    
    // Convert UTC time to local time
    let utc_minutes = info.hour as i32 * 60 + info.minute as i32;
    let local_minutes = utc_minutes + offset.total_minutes as i32;
    
    // Handle day wraparound
    let (local_hour, local_minute) = if local_minutes < 0 {
        let adjusted = local_minutes + 24 * 60;
        ((adjusted / 60) as u8, (adjusted % 60) as u8)
    } else if local_minutes >= 24 * 60 {
        let adjusted = local_minutes - 24 * 60;
        ((adjusted / 60) as u8, (adjusted % 60) as u8)
    } else {
        ((local_minutes / 60) as u8, (local_minutes % 60) as u8)
    };
    
    // Format time
    let _ = write!(out, "{:02}:{:02}:{:02}", local_hour, local_minute, info.second);
    
    // Add UTC offset
    if info.location_valid {
        let sign = if offset.is_positive() { '+' } else { '-' };
        let hours = offset.hours().unsigned_abs();
        let mins = offset.minutes();
        
        if mins == 0 {
            let _ = write!(out, " {}{}", sign, hours);
        } else {
            let _ = write!(out, " {}{}:{:02}", sign, hours, mins);
        }
    } else {
        out.push_str(" UTC").ok();
    }
    
    out
}

fn format_lat(info: &SystemInfo) -> String<32> {
    let mut out = String::<32>::new();
    if info.location_valid {
        let _ = write!(out, "{:.7}", info.latitude);
    } else {
        out.push_str("N/A").ok();
    }
    out
}

fn format_lng(info: &SystemInfo) -> String<32> {
    let mut out = String::<32>::new();
    if info.location_valid {
        let _ = write!(out, "{:.7}", info.longitude);
    } else {
        out.push_str("N/A").ok();
    }
    out
}

fn format_findmy_mac(addr: Option<[u8; 6]>) -> String<32> {
    let mut out = String::<32>::new();
    if let Some(a) = addr {
        let _ = write!(
            out,
            "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
            a[5], a[4], a[3], a[2], a[1], a[0]
        );
    } else {
        out.push_str("N/A").ok();
    }
    out
}

#[cfg(feature = "findmy")]
fn findmy_status_text(info: &SystemInfo, _findmy_addr: Option<[u8; 6]>) -> String<32> {
    let mut out = String::<32>::new();
    match crate::findmy::diag_state() {
        crate::findmy::FindMyDiagState::Disabled => {
            out.push_str("Disabled").ok();
        }
        crate::findmy::FindMyDiagState::WaitingGpsTime => {
            if findmy_waiting_epoch(info) {
                out.push_str("Waiting epoch").ok();
            } else {
                out.push_str("Waiting GPS time").ok();
            }
        }
        crate::findmy::FindMyDiagState::WaitingBleIdle => {
            out.push_str("Waiting BLE idle").ok();
        }
        crate::findmy::FindMyDiagState::AddressReady => {
            out.push_str("Address ready").ok();
        }
        crate::findmy::FindMyDiagState::Advertising => {
            out.push_str("Broadcasting").ok();
        }
        crate::findmy::FindMyDiagState::SetAddrFailed => {
            out.push_str("Set addr failed").ok();
        }
        crate::findmy::FindMyDiagState::AdvConfigureFailed => {
            out.push_str("Adv cfg failed").ok();
        }
        crate::findmy::FindMyDiagState::AdvStartFailed => {
            out.push_str("Adv start failed").ok();
        }
    }
    out
}

#[cfg(not(feature = "findmy"))]
fn findmy_status_text(_info: &SystemInfo, _findmy_addr: Option<[u8; 6]>) -> String<32> {
    let mut out = String::<32>::new();
    out.push_str("Disabled").ok();
    out
}

#[cfg(feature = "findmy")]
fn findmy_waiting_epoch(info: &SystemInfo) -> bool {
    let Some(unix_ts) = info_unix_ts(info) else {
        return false;
    };
    unix_ts < crate::findmy::epoch_secs()
}

#[cfg(not(feature = "findmy"))]
fn findmy_waiting_epoch(_info: &SystemInfo) -> bool {
    false
}

fn info_unix_ts(info: &SystemInfo) -> Option<u64> {
    if !info.date_time_valid {
        return None;
    }
    let dt = chrono::NaiveDate::from_ymd_opt(info.year as i32, info.month as u32, info.day as u32)?
        .and_hms_opt(info.hour as u32, info.minute as u32, info.second as u32)?;
    Some(dt.and_utc().timestamp() as u64)
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
