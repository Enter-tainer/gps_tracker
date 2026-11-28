# PCB / EasyEDA Pro 源工程

| 文件 | 说明 |
| --- | --- |
| `nrf52840 gps tracker/` | **EasyEDA Pro 工程（`.eprj3` 文件夹格式）**，含 v1 原理图与 PCB（`sch/v1-meshtastic-nrf52840/` + `pcb/PCB_meshtastic nrf52840 prototype.epcb2`）以及 v2.1 四页原理图。用 EDA 直接打开这个目录 |
| `gps-tracker-nrf52840-v1.step` | v1 的 3D PCB 模型（AP214 STEP，含板体、铜皮/焊盘、各器件 3D 装配，用于 CAD 外壳设计与干涉检查） |
| `BOM.csv` | **v1 的** 13 项物料清单（v2.1 见 `docs/design-v2.1-final.md` §2） |
| `preview.webp` | v1 的 2D PCB 布局预览图 |
| `preview-3d.png` | 由 `gps-tracker-nrf52840-v1.step` 渲染的 3D 装配预览图 |

## 打开工程

1. 安装 [嘉立创 EDA 专业版 / EasyEDA Pro](https://pro.lceda.cn/)（最新导出由 4.1.105 版本保存，建议 ≥ 4.1.100 版本）。
2. 「文件 → 打开 → EasyEDA Pro 工程」，选择 `nrf52840 gps tracker/nrf52840 gps tracker.eprj3`（文件夹工程）。
   - v1 工程（原 `.epro2` 单文件包）已完整并入该文件夹工程：原理图见 `sch/v1-meshtastic-nrf52840/Sheet_1.esch2`，PCB 见 `pcb/PCB_meshtastic nrf52840 prototype.epcb2`，**内容一致，不再单独维护 `.epro2`**。
3. 工程内嵌了全部用到的符号、封装与 3D 模型，**不需要额外安装库**。

## 需要用到的导出（仓库暂未附带，欢迎 PR 补充）

在 EasyEDA Pro 里依次导出，建议放到 `hardware/pcb/fabrication/`：

- **Gerber + 钻孔文件**（打样用）：菜单里的「制造 / 导出 → Gerber」，输出 ZIP。
- **BOM（CSV）**：可导出后与本目录 `BOM.csv` 对照，注意补全立创编号。
- **贴片坐标文件（Pick & Place）**：如需 SMT 贴片。
- **原理图 PDF**：原理图编辑器 → 导出 PDF，建议附一份方便不看 EDA 的人阅读。

> 菜单名称随 EDA 版本变化，上述为通用路径；只要导出 Gerber/BOM/坐标这三样，别人就能复现打样。

## 打样参数

以下是从工程里能直接读到的确定信息：

| 项目 | 值 | 来源 |
| --- | --- | --- |
| 层数 | **2 层**（Top / Bottom，无内层） | 工程内只有 L1/L2 走线 |
| 尺寸 | **95.0 × 30.0 mm**，四角 **R2** 圆角 | 板框 `polyType: BOARD_OUTLINE`（3740.16 × 1181.10 mil，圆角 78.74 mil） |
| 走线宽度 | 常规 **10 mil（0.254 mm）** | 布线记录 |
| 过孔 | **24 / 12 mil（0.61 / 0.30 mm）**，共 73 个 | 过孔记录 |
| 板厚 / 表面处理 | 工程未锁定 | 常规下单即可：1.6 mm 板厚，沉金或喷锡 |

下单时**不要勾选「阻抗控制」**（无用信号的阻抗要求），并注意：

- 陶瓷天线区域（`ANT`，25×25 mm）正下方与四周需要净空，不要铺铜、不要放过孔；打样厂如果默认全局铺铜，请在工程里确认该区域已挖空后再导出。
- 21700 电池座的焊盘面积较大，建议回流焊或热风 + 烙铁补焊。

## 装配注意（PCB 侧）

1. **ProMicro nRF52840 模块**是竖贴的方形焊盘（26 pad），务必确认模块版本是 **3.3V / nRF52840**，且 USB-C 朝外壳开孔方向。
2. **L76K 模块**为 18 pin LGA，注意 1 脚方向；模块与陶瓷天线之间的射频走线尽量短。
3. **TF 卡座**注意插入方向与外壳卡槽对齐（卡槽位于板卡一端）。
4. **电池选型（二选一）**：
   - 装 **21700 续航版外壳（`case-21700-v1`）** 时，焊接 `U8` 21700 电池座（焊盘面积较大，建议热风 + 烙铁补焊）；
   - 装 **Slim 轻薄版外壳（`case-slim-v1`）** 时，**不要焊接 `U8`**，将背面软包薄锂电池接入 `CN2`（1.25 mm 2P 座），插电前务必核对正负极。
5. **按键**为 4 脚贴片（`URST` / `UUSR`），高度约 2 mm 级别，装壳后需能从外壳按键位按到。
6. **分压电阻** `R5=200k` 在 BAT 侧、`R6=300k` 在 GND 侧，接反会导致电量显示偏高，见 `firmware/src/battery.rs` 注释。

详细步骤见 [docs/hardware/assembly.md](../../docs/hardware/assembly.md)。

## 网络（Net）一览

工程里用到的网络名，便于对照原理图 / 飞线调试：

```
电源：BAT  3V3  GND  ADC(电池分压)
GPS ：GPSTX  GPSRX  GPSEN  GPSANT
I2C ：SDA  SCL
SPI ：SCK  MOSI  MISO  CS
显示：BUSY  IRQ        (v1.0 固件未使用)
按键：USR  RST  RSTPORT RXEN (RXEN 为预留)
```

> 引脚级映射（哪个网络接到 nRF52 的哪个 P 口）见 [docs/hardware/pinout.md](../../docs/hardware/pinout.md)。

## BOM 说明

- 共 **13 项**，其中 `U10`、`U7`、`ANT` 等型号可在立创商城 / 淘宝按名称检索。
- CSV 里 `LCSC` 列为 `—` 的表示源工程未记录立创编号，请按型号与封装自选等效件。
- 替换建议：
  - `U11 LIS3DHTR` 可用 LIS3DH 系列同封装件，固件寄存器兼容；
  - `U4 BMP280` 不要换成 BME280（地址相同但寄存器/校准不同，固件不兼容）；
  - `U7` 必须支持 **CASIC 协议**（L76K / ATGM336H 系列），换成纯 NMEA 模块会丢掉 A-GNSS 注入功能。

## v2.1 硬件改版（当前工作区）

**设计依据：[`docs/design-v2.1-final.md`](../../docs/design-v2.1-final.md)** —— 架构、BOM、逐器件连接、
网络清单、固件约束、PCB 叠层与天线处理全部在那份文档里，本文件不重复。

v1（已打样验证）保留作对照，**不再修改**：其原理图与 PCB 就在本 `.eprj3` 工程内（`v1-meshtastic-nrf52840` / `PCB_meshtastic nrf52840 prototype`）。

### 与 v1 的主要差异

| 项 | v1 | v2.1 |
| --- | --- | --- |
| 主控 | ProMicro nRF52840 | 同（沿用 26 pad 符号） |
| 存储 | microSD（TF 卡座） | **W25Q128 NOR**（SPI，深度休眠 1µA） |
| 加速度计 | LIS3DHTR | **LIS2DW12**（I²C，地址 0x19） |
| 气压计 | BMP280 | 取消 |
| 供电 | 单轨 3V3 | **双域**：3.3V_AON（RT9080 常开）+ 3.3V_SW（P0.13 门控） |
| GPS 省电 | GPSEN 控模块 ON/OFF 脚 | **GPS_EN 控 L76K.WAKEUP**（standby 20µA） |
| 电池 | 21700 / 软包 | 1500mAh 软包 |
| PCB | 2 层 | **4 层**（JLC04161H-7628） |

### 可编辑工程（`.eprj3` 文件夹格式）

```text
hardware/pcb/nrf52840 gps tracker/
├── nrf52840 gps tracker.eprj3   # 工程索引（boards / schematics / pcbs / sheets）
├── sch/
│   ├── v1-meshtastic-nrf52840/  # v1 原理图（对照用）
│   │   └── Sheet_1.esch2
│   └── TraceveilV2/             # v2.1 原理图（4 页）
│       ├── PWR.esch2            # 电源 / 电量采样
│       ├── AON.esch2            # 常开域（加速度计）
│       ├── SW.esch2             # 开关域（Flash / GPS）
│       └── MCU.esch2            # 主控 / OLED / 按键
├── pcb/
│   ├── PCB_meshtastic nrf52840 prototype.epcb2   # v1 PCB
│   └── PCB1.epcb2                                # v2.1 PCB（待布局）
└── eprj3-intro.md
```

`.eprj3` 是逐行 JSON 的**文件夹**格式（不是 SQLite 单文件），可与编辑器双向同步、能被 git diff 审阅。
**注意：内置 CLI 的 `open --path` 只认 `.eprj/.eprj2/.eprj3/.elib`**，传旧版 `.epro2` 单文件包只会静默开出一个空白编辑器——这也是本工程改用 `.eprj3` 文件夹格式的原因之一。

打开方式（客户端 v4.1.70+，桌面版运行中）：

```powershell
& 'C:\Program Files\lceda-pro\lceda-pro.exe' open --path 'C:/Users/mgt/Desktop/proj/gps_tracker/hardware/pcb/nrf52840 gps tracker/nrf52840 gps tracker.eprj3'
```

### v2.1 原理图进度

按 `docs/design-v2.1-final.md` 分 4 页重画：

| 页 | 内容 | 状态 |
| --- | --- | --- |
| PWR | J1、U1 RT9080N（SNS→VOUT）、C1/C2（10µF 0805）、R5/R6 **1MΩ 常接分压**、C9 | ✅ 已画并网表验证 |
| AON | U2A LIS2DW12 + U2B LIS3DHTR 双焊盘（U2A 为 DNP 备选）、R2/R3、C5/C10/C13 | ✅ 已画并网表验证 |
| SW | U3 W25Q128 + R10-R12、U4 L76K + R1/C3/C4/C6-C8/C11-C13、**R14 1kΩ（UART 跨域串阻）**、ANT1 | ✅ 已画并网表验证 |
| MCU | M1（真实 ProMicro 器件）、J2 OLED、SW2/SW3（**4 焊盘**）、R8/R9 | ✅ 已画并网表验证 |

全工程 **35 器件 / 26 网络 / 零匿名网络**，DNP 仅 `U2A`。已知取舍与首板实测清单见 `docs/design-v2.1-final.md` §9。

`PCB1.epcb2` 已从原理图导入全部 35 个元件（封装 / 网络与原理图逐 pad 校验一致，0 不一致），
`ANT1` 天线孔已由 1.5mm 改为 **0.9mm（焊盘 1.8mm）**，与 v1 实测孔径一致；下一步是按 v1 锚点布局与布线。

画图用 [`scripts/eda-step.js`](scripts/eda-step.js) 单步驱动（见该目录 README），
每画完一块跑一次网表自检（无匿名网络、无单脚网络）。

### 注意

- 工程目录里若出现 `*_backup/`（EDA 自动备份的快照包），**不要提交**，已在 `.gitignore` 忽略，可随时删除。
- `BOM.csv` **只覆盖 v1**（含 BMP280、TF 卡座、ATGM336H 符号），**不要拿它给 v2.1 下料**；
  v2.1 的 BOM 见 [docs/design-v2.1-final.md](../../docs/design-v2.1-final.md) §2。
