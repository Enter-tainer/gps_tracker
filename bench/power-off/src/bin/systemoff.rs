//! 测**真正的 System OFF** 电流（对比 `main.rs` 的 System ON + WFI）。
//!
//! 流程与 `main.rs` 相同（引脚高阻 → 拉低 P0.13 → 停时钟 → 清中断），
//! 但最后进的是 `POWER.systemoff()`，而不是 `wfi()`。
//!
//! ## 用法
//! ```bash
//! cd bench/power-off
//! cargo run --release --bin systemoff
//! ```
//! 烧完会立刻掉进 System OFF（SWD 会断），之后拔掉调试器再读电流。
//!
//! ## 怎么救回来
//! System OFF 下这三种方式都能唤醒并重新烧写：
//!   1. **双击 RESET**（进 UF2 引导，最省事，不用工具）；
//!   2. **SWD connect-under-reset**（probe-rs 按住复位连）；
//!   3. 断电重上电（但会再次睡死，只用于确认供电）。
//!
//! 参考：nRF52840 手册 System OFF（高压模式、无 RAM 保留、DETECT 唤醒）= 0.95 µA。
//! 若实测远高于这个数，说明模块板上有常耗项（充电 IC / 肖特基反漏 / DC-DC 静态 / 灯）。

#![no_std]
#![no_main]

use cortex_m::peripheral::{NVIC, SYST};
use cortex_m_rt::entry;
use nrf_pac::gpio::vals::{Dir, Drive, Input, Pull, Sense};
use nrf_pac::{CLOCK, P0, P1, POWER};

/// 需要主动拉低的 P0 引脚：13 = 3V3 外设轨使能
const PIN_LOW_P0: &[usize] = &[13];

#[entry]
fn main() -> ! {
    // 1. 所有引脚 → 输入 / 断开缓冲 / 无上下拉 / 无 sense
    for port in [P0, P1] {
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

    // 2. 拉低 3V3 轨使能（先写 OUT 再切 DIR，避免切换瞬间弹高）
    for &n in PIN_LOW_P0 {
        P0.outclr().write(|w| w.set_pin(n, true));
        P0.dirset().write(|w| w.set_pin(n, true));
    }

    // 3. 停时钟
    CLOCK.tasks_hfclkstop().write(|w| *w = 1);
    CLOCK.tasks_lfclkstop().write(|w| *w = 1);

    // 4. 清中断状态
    cortex_m::interrupt::disable();
    unsafe {
        let nvic = &*NVIC::PTR;
        let syst = &*SYST::PTR;
        syst.csr.write(0);
        for reg in nvic.icer.iter() {
            reg.write(0xFFFF_FFFF);
        }
        for reg in nvic.icpr.iter() {
            reg.write(0xFFFF_FFFF);
        }
    }
    cortex_m::asm::dsb();

    // 5. 进 System OFF（无 RAM 保留）。此后再也不返回。
    POWER.systemoff().write(|w| w.set_systemoff(true));

    // 保险：万一没进去，就在 System ON 里睡死（可与 main.rs 对比读数）
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