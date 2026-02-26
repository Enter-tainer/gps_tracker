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
const VERY_LONG_PRESS_MS: u64 = 5000;
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

        // Tier 1: wait for short press threshold
        match select(button.wait_for_rising_edge(), Timer::after_millis(LONG_PRESS_MS)).await {
            Either::First(_) => {
                defmt::info!("Button short press");
                handle_short_press();
                Timer::after_millis(1).await;
                continue;
            }
            Either::Second(_) => {
                // Held past LONG_PRESS_MS — execute long press action
                defmt::info!("Button long press");
                handle_long_press().await;
            }
        }

        // Tier 2: wait for very long press threshold (USB MSC)
        let remaining = VERY_LONG_PRESS_MS - LONG_PRESS_MS;
        match select(button.wait_for_rising_edge(), Timer::after_millis(remaining)).await {
            Either::First(_) => {
                // Released between 2s–5s: long press only (already handled above)
            }
            Either::Second(_) => {
                // Held past VERY_LONG_PRESS_MS — enter USB MSC mode
                defmt::info!("Button very long press");
                handle_very_long_press();
                button.wait_for_rising_edge().await;
            }
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

/// Short press: toggle display only
fn handle_short_press() {
    send_command(DisplayCommand::ResetTimeout);
    send_command(DisplayCommand::Toggle);
}

/// Long press (~2s): BLE broadcast + flush SD cache
async fn handle_long_press() {
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
}

/// Very long press (~5s): enter USB MSC mode
fn handle_very_long_press() {
    if usb_connected() {
        defmt::info!("Very long press -> request USB mode");
        request_usb_mode_transition();
    } else {
        defmt::warn!("Very long press but USB not connected");
    }
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
