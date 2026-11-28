# 引脚映射 / Pinout

三份来源，互相印证：

1. **固件**（权威）：[`firmware/src/board.rs`](../../firmware/src/board.rs) 里写死了 MCU 侧引脚；
2. **PCB 网表**：从 `hardware/pcb/nrf52840 gps tracker/pcb/PCB_meshtastic nrf52840 prototype.epcb2` 的 PCB 数据中读出「焊盘 → 网络」；
3. **原理图**：工程内 `Sheet_1` 页。

## 1. MCU 侧（nRF52840）

| 功能 | `board.rs` 字段 | nRF52 引脚 | 网络名 | 连接对象 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 状态 LED | `led` | `P0.15` | — | ProMicro 模块板载 LED | 固件只做了 `Output`，未主动闪烁 |
| 用户按键 | `button` | `P1.00` | `USR` | 轻触键 `UUSR` | `Input` + `Pull::Up`，低电平有效；短/长/超长按见 `button.rs` |
| GPS RX | `gps_uart_rx` | `P0.22` | `GPSTX` | L76K 模块 TX | 115200 8N1（初始化阶段先用 9600） |
| GPS TX | `gps_uart_tx` | `P0.20` | `GPSRX` | L76K 模块 RX | 固件用 CASIC 指令把模块切到 115200 / 5 Hz |
| GPS 电源使能 | `gps_en` | `P0.24` | `GPSEN` | L76K 电源使能脚 | 高 = 上电；S2 空闲态整段断电 |
| I2C SDA | `i2c_sda` | `P1.04` | `SDA` | OLED / BMP280 / LIS3DHTR | 三者共用一条总线，固件加锁串行访问 |
| I2C SCL | `i2c_scl` | `P0.11` | `SCL` | 同上 | — |
| SPI MISO | `spi_miso` | `P0.02` | `MISO` | microSD `U10` | 共用 SPI3 |
| SPI MOSI | `spi_mosi` | `P1.15` | `MOSI` | microSD `U10` | — |
| SPI SCK | `spi_sck` | `P1.11` | `SCK` | microSD `U10` | — |
| SPI CS | `spi_cs` | `P1.13` | `CS` | microSD `U10` | 软件片选 |
| 电池采样 | `battery_adc` | `P0.31` | `ADC` | 200k/300k 分压 | SAADC，12 bit，`0.6V/GAIN1_6` |
| 3V3 轨使能 | `v3v3_en` | `P0.13` | `3V3` | 3.3V 轨 | 固件启动即拉高保持供电 |
| 预留串口 RX | `serial2_rx` | `P0.06` | — | 未连接 | 固件 `drop()`，预留 |
| 预留串口 TX | `serial2_tx` | `P0.08` | — | 未连接 | 同上 |

> `BUSY` 与 `IRQ` 两个网络接到了 ProMicro 模块的焊盘上，但 **v1.0 固件没有使用**：
> 加速度计 `INT1/INT2` 在 PCB 上是悬空的，运动检测靠固件轮询；OLED 走 I2C，不需要 BUSY。

## 2. ProMicro nRF52840 模块焊盘 → 网络

PCB 网表中 `C2`（模块）的 26 个焊盘对应关系（1 脚位置以 PCB 丝印为准）：

| 焊盘 | 网络 | 焊盘 | 网络 |
| --- | --- | --- | --- |
| 1 | `BAT` | 14 | 未连接（自动网络名 `$1N7062`） |
| 2 | `BAT` | 15 | `SDA` |
| 3 | `GND` | 16 | `SCL` |
| 4 | `RSTPORT` | 17 | `USR` |
| 5 | `3V3` | 18 | `GPSEN` |
| 6 | `ADC` | 19 | `GPSTX` |
| 7 | `BUSY` | 20 | `GPSRX` |
| 8 | `MISO` | 21 | `RXEN`（预留，仅接模块） |
| 9 | `MOSI` | 22 | `GND` |
| 10 | `CS` | 23 | `GND` |
| 11 | `SCK` | 24 | 未连接 |
| 12 | `IRQ` | 25 | 未连接（自动网络名 `$1N427`） |
| 13 | `RST` | 26 | `GND` |

## 3. I2C 地址

| 器件 | 地址 | 说明 |
| --- | --- | --- |
| `U11` LIS3DHTR | `0x18` | SA0 接 GND |
| `U4` BMP280 | `0x76` | SDO 接 GND（`I2CAddress::SdoGrounded`） |
| `OLED1` SSD1306 | `0x3C` | 4P 模块默认地址 |

三个地址不冲突，可挂在同一组 `SDA`/`SCL` 上。

## 4. 平台外设资源占用（固件角度）

| 资源 | 用途 |
| --- | --- |
| `UARTE0` | GPS 串口（115200，`BufferedUarte`） |
| `TWISPI0` | I2C（OLED / BMP280 / LIS3DHTR） |
| `SPI3` | microSD |
| `SAADC` | 电池电压 |
| `TIMER1` + `PPI_CH8/CH9` + `PPI_GROUP1` | Embassy 时间驱动（MPSL / SDC 占用了 RTC0、TIMER0，故用 RTC1 / TIMER1） |
| `USBD` | USB MSC（直读 TF 卡）+ UF2 bootloader |

## 5. 自己核对的方法

- 看固件：`firmware/src/board.rs` 的 `Board::new()`，字段名即功能。
- 看硬件：用 EasyEDA Pro 打开 `hardware/pcb/nrf52840 gps tracker/nrf52840 gps tracker.eprj3` 里的 v1 PCB，点焊盘高亮网络；
  或者直接用文本编辑器搜 `pcb/PCB_meshtastic nrf52840 prototype.epcb2` 里的 `PAD` 记录，`netName` 字段就是网络名。
- 改板：如果换了模块或改了引脚，**只改 `board.rs` 的 `Board` 结构体**即可，其余驱动都从 `Board` 取引脚。
