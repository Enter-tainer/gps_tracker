use cortex_m::peripheral::SCB;
use embassy_executor::task;
use embassy_futures::select::{select, Either};
use embassy_nrf::gpio::Input;
use embassy_time::{Instant, Timer};

use crate::ble;
use crate::display::{send_command, DisplayCommand};
use crate::storage::{self, ListDirOutcome};
use crate::{request_usb_mode_transition, usb_connected};

const DEBOUNCE_DELAY_MS: u64 = 50;
const LONG_PRESS_MS: u64 = 2000;
const LIST_SD_ON_BUTTON: bool = false;

#[task]
pub async fn button_task(mut button: Input<'static>) {
    let mut last_valid = Instant::now().as_millis();

    loop {
        button.wait_for_falling_edge().await;
        let now = Instant::now().as_millis();
        if now.wrapping_sub(last_valid) < DEBOUNCE_DELAY_MS {
            continue;
        }
        last_valid = now;

        if usb_connected() {
            match select(button.wait_for_rising_edge(), Timer::after_millis(LONG_PRESS_MS)).await {
                Either::First(_) => {
                    defmt::info!("Button short press");
                    handle_button_press().await;
                }
                Either::Second(_) => {
                    defmt::info!("Button long press");
                    handle_usb_long_press();
                    button.wait_for_rising_edge().await;
                }
            }
        } else {
            defmt::info!("Button press (no USB)");
            handle_button_press().await;
        }
        Timer::after_millis(1).await;
    }
}

#[task]
pub async fn usb_only_button_task(mut button: Input<'static>) {
    let mut last_valid = Instant::now().as_millis();

    loop {
        button.wait_for_falling_edge().await;
        let now = Instant::now().as_millis();
        if now.wrapping_sub(last_valid) < DEBOUNCE_DELAY_MS {
            continue;
        }
        last_valid = now;

        match select(button.wait_for_rising_edge(), Timer::after_millis(LONG_PRESS_MS)).await {
            Either::First(_) => {
                defmt::info!("USB mode short press ignored");
            }
            Either::Second(_) => {
                defmt::info!("USB mode long press -> reboot normal");
                button.wait_for_rising_edge().await;
                SCB::sys_reset();
            }
        }
        Timer::after_millis(1).await;
    }
}

fn handle_usb_long_press() {
    if usb_connected() {
        defmt::info!("USB long press -> request USB mode");
        request_usb_mode_transition();
    } else {
        defmt::warn!("USB long press but USB not connected");
    }
}

async fn handle_button_press() {
    ble::request_fast_advertising();

    if storage::flush_sd_cache().await {
        defmt::info!("SD cache flushed");
    } else {
        defmt::warn!("SD cache flush failed");
    }

    if LIST_SD_ON_BUTTON {
        list_sd_root().await;
    }

    send_command(DisplayCommand::ResetTimeout);
    send_command(DisplayCommand::Toggle);
}

async fn list_sd_root() {
    loop {
        match storage::list_dir_next(b"/").await {
            ListDirOutcome::Entry {
                is_dir,
                name,
                name_len,
                size,
            } => {
                let name_str = core::str::from_utf8(&name[..name_len]).unwrap_or("?");
                defmt::info!(
                    "SD entry: {=str} dir={} size={}",
                    name_str,
                    is_dir,
                    size
                );
            }
            ListDirOutcome::Done => {
                defmt::info!("SD list done");
                break;
            }
            ListDirOutcome::Error => {
                defmt::warn!("SD list error");
                break;
            }
        }
        Timer::after_millis(0).await;
    }
}
