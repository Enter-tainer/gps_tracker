use embassy_executor::task;
use embassy_nrf::gpio::Input;
use embassy_time::{Instant, Timer};

use crate::ble;
use crate::display::{send_command, DisplayCommand};
use crate::storage::{self, ListDirOutcome};

const DEBOUNCE_DELAY_MS: u64 = 50;
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

        handle_button_press().await;
        Timer::after_millis(1).await;
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
