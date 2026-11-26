//! 诊断固件：只闪模块板载 LED（P0.15），其它什么都不做。
//!
//! 目的：确认「那颗神秘的蓝灯是不是 P0.15」。
//! 节奏是**两下快闪 + 2 秒黑**（100 亮 / 150 灭 / 100 亮 / 1650 灭），
//! 和任何「规律闪」「呼吸」都不一样，一眼就能认出来。
//!
//! 这个 bin **不碰 P0.13**，所以不会动 3V3 轨。

#![no_std]
#![no_main]

use cortex_m_rt::entry;
use nrf_pac::gpio::vals::{Dir, Drive, Input, Pull, Sense};
use nrf_pac::P0;

const LED_PIN: usize = 15;

#[entry]
fn main() -> ! {
    // 其余引脚高阻，避免顺手给别的东西供电。
    for n in 0..32 {
        if n == LED_PIN {
            continue;
        }
        P0.pin_cnf(n).write(|w| {
            w.set_dir(Dir::Input);
            w.set_input(Input::Disconnect);
            w.set_pull(Pull::Disabled);
            w.set_drive(Drive::S0s1);
            w.set_sense(Sense::Disabled);
        });
    }

    // LED 脚：输出低（灭）再切方向，然后开始闪。
    P0.outclr().write(|w| w.set_pin(LED_PIN, true));
    P0.pin_cnf(LED_PIN).write(|w| {
        w.set_dir(Dir::Output);
        w.set_input(Input::Disconnect);
        w.set_pull(Pull::Disabled);
        w.set_drive(Drive::S0s1);
        w.set_sense(Sense::Disabled);
    });

    loop {
        // 两下快闪
        for _ in 0..2 {
            P0.outset().write(|w| w.set_pin(LED_PIN, true));
            cortex_m::asm::delay(6_400_000); // ~100 ms @ 64 MHz
            P0.outclr().write(|w| w.set_pin(LED_PIN, true));
            cortex_m::asm::delay(9_600_000); // ~150 ms
        }
        // 黑 1.65 s
        cortex_m::asm::delay(105_600_000);
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {
        cortex_m::asm::wfi();
    }
}
