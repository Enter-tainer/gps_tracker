# power-off — 裸板功耗测量固件

一次性调试固件，和主固件（`firmware/`）完全无关，独立 Cargo 工程，删掉不影响任何东西。

做的事只有一件：上电 → 把 **3V3 外设轨关掉**（P0.13 拉低）→ 其余引脚全部高阻 →
停 HFCLK/LFCLK → 清中断 → `wfi()` 睡死。不初始化时钟、USB、BLE，不打日志。

```
src/main.rs          ~80 行，全部逻辑
memory.x             起始 0x27000，避开 MBR + Adafruit UF2 bootloader
.cargo/config.toml   target = thumbv7em-none-eabihf，runner = probe-rs
```

## 烧写

```bash
cd bench/power-off
cargo run --release            # probe-rs 烧完自动复位运行；Ctrl-C 退出
cargo run --release --offline  # 没网/取不到 index 时用这个（依赖已在本地缓存）
```

改引脚：`src/main.rs` 顶部的 `PIN_LOW_P0`（13 = 3V3 轨使能，24 = GPS 电源使能，用不上就删掉 24）。

## 测电流

1. **拔掉 SWD 再读数。** 调试接口本身要吃电，而且只要 debugger 连着就进不了 System OFF。
   想让它一直在线，就只能接受读数偏高（用"插着 / 拔掉"两次读数做对比也行）。
2. **别插 USB。** 用电池或稳压电源从 `BAT` 进，万用表 / 功耗仪串在回路里。
3. 先确认 3V3 焊盘是 **0 V**，再看读数。
4. 读数偏高时按这个顺序怀疑：电源指示灯（拆掉）→ 充电 IC 静态电流 → 模块自带 LDO 静态电流 →
   某个引脚还有电流通路（外接上拉/下拉、分压电阻）。
5. 预期量级：nRF52840 本体 System ON idle ≈ 2 µA @3 V；模块的 LDO / 充电 IC / 电源灯另算。

## 想测 System OFF（~0.4 µA）

把 `src/main.rs` 末尾的 WFI 循环换成：

```rust
nrf_pac::POWER.systemoff().write(|w| w.set_systemoff(true));
```

代价：SWD 会掉线，只能按 RESET 脚或断电才能重新烧。

## 万一板子烧完直接掉电 / 反复重启

说明 P0.13 不是"外设轨使能"，而是 MCU 自己的供电开关（或者带了会在低电平时拉掉整板的电路）。
恢复：双击复位进 UF2 bootloader（BOOT/RESET 两次）用 UF2 刷回去，或者 SWD 按住复位烧写。
