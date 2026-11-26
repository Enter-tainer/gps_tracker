//! 一次性功耗测量固件：上电把 3V3 外设轨关掉，然后 MCU 睡死。
//!
//! 上电后按顺序只做这几件事，然后 WFI 到底：
//!   1. 两颗 GPIO 口的所有引脚 → 输入 / 断开输入缓冲 / 无上下拉 / 无 sense
//!      （复位默认值是「输入 + 输入缓冲连接」，悬空脚会被判成 0/1 来回翻转而多耗电）
//!   2. 3V3 轨使能脚（以及 GPS 电源脚）→ 输出低
//!   3. 停掉 HFCLK / LFCLK（UF2 bootloader 跑 USB 时开过）
//!   4. 清空 NVIC 使能位、挂起位和 SysTick（同上，别让 WFI 被立刻叫醒变成满速空转）
//!
//! 没有时钟初始化、没有 USB/BLE、没有中断、没有日志。预期读数：芯片本体 ~2 µA @3 V
//! 量级，再加上模块自带的 LDO / 充电 IC / 电源灯的静态电流。
//!
//! 注意：**读数要在拔掉 SWD 调试器之后测**。调试接口本身会拉高电流，而且只要
//! debugger 连着，芯片也进不了 System OFF。

#![no_std]
#![no_main]

use cortex_m::peripheral::{NVIC, SYST};
use cortex_m_rt::entry;
use nrf_pac::gpio::vals::{Dir, Drive, Input, Pull, Sense};
use nrf_pac::{CLOCK, P0, P1};

/// 需要主动拉低的 P0 引脚（其余引脚全部高阻）。
///   13 = 3V3 输出轨使能，高 = 供电（Pro Micro nRF52840 模块 / 本项目载板都用 P0.13）
///   24 = GPS 电源使能（本项目载板；裸模块上没这路，多拉一个低电平也无害）
///
/// 如果你的板子 3V3 使能不在 P0.13，改这里就行。
const PIN_LOW_P0: &[usize] = &[13, 24];

#[entry]
fn main() -> ! {
    // 1. 所有引脚先回到最低漏电态。
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

    // 2. 拉低使能脚。先写 OUT 再切 DIR：切换方向的那一刻不会先弹一下高电平。
    for &n in PIN_LOW_P0 {
        P0.outclr().write(|w| w.set_pin(n, true));
        P0.dirset().write(|w| w.set_pin(n, true));
    }

    // 3. 关时钟。
    CLOCK.tasks_hfclkstop().write(|w| *w = 1);
    CLOCK.tasks_lfclkstop().write(|w| *w = 1);

    // 4. 清掉 bootloader 可能留下的中断状态。
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

    // 5. 睡觉。没有任何中断被使能，WFI 一睡到底。
    loop {
        cortex_m::asm::wfi();
    }
}

/// 想改测 System OFF（~0.4 µA）时，把上面第 5 步的循环换成：
///   nrf_pac::POWER.systemoff().write(|w| w.set_systemoff(true));
/// 代价是 SWD 会掉线，只能按 RESET 脚或断电才能重新烧。
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {
        cortex_m::asm::wfi();
    }
}
