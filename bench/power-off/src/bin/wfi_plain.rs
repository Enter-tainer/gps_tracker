//! 极简对照固件：**不碰时钟**，只做「引脚高阻 + 拉低 P0.13」，然后 WFI。
//!
//! 用途：把 `main.rs` 里的 `TASKS_HFCLKSTOP` / `TASKS_LFCLKSTOP` 摘掉做对照。
//!
//! 为什么怀疑那两行：CPU 自己就跑在 HFCLK 上，发 `HFCLKSTOP` 之后 CPU 可能在
//! 执行到下一句之前就失去时钟，导致后面的 `LFCLKSTOP`、清 NVIC、`wfi()` 都没执行完，
//! 芯片停在半配置状态。正常做法是只 `wfi()`——没有事件时硬件会自己停时钟。
//!
//! 对比三个 bin 的读数：
//!   `main`      —— 引脚 + P0.13 低 + 停 HFCLK/LFCLK + WFI
//!   `wfi_plain` —— 引脚 + P0.13 低 + WFI            （本文件）
//!   `systemoff` —— 引脚 + P0.13 低 + POWER.systemoff()
//!
//! 若 `wfi_plain` 明显低于 `main`，说明问题在「停时钟」那段代码，而不是硬件。

#![no_std]
#![no_main]

use cortex_m_rt::entry;
use nrf_pac::gpio::vals::{Dir, Drive, Input, Pull, Sense};
use nrf_pac::P0;

const PIN_LOW_P0: &[usize] = &[13];

#[entry]
fn main() -> ! {
    // 1. 引脚 → 输入 / 断开缓冲 / 无上下拉 / 无 sense
    for port in [P0, nrf_pac::P1] {
        for n in 0..32 {
            port.pin_cnf(n).write(|w| {
                w.set_dir(Dir::Input);
                w.set_input(Input::Disconnect);
                w.set_pull(Pull::Disabled);
                w.set_drive(Drive::S0s1);
                w.set_sense(Sense::Disabled);
            });
        }
    }

    // 2. P0.13 → 输出低
    for &n in PIN_LOW_P0 {
        P0.outclr().write(|w| w.set_pin(n, true));
        P0.dirset().write(|w| w.set_pin(n, true));
    }
    P0.dirset().write(|w| w.set_pin(13, true));

    // 3. 直接睡。不动 CLOCK，也不清 NVIC —— 看 WFI 自己能压到多少。
    loop {
        cortex_m::asm::wfi();
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {
        cortex_m::asm::wfi();
    }
}