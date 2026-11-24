# PCB / EasyEDA Pro 源工程

| 文件 | 说明 |
| --- | --- |
| `gps-tracker-nrf52840-v1.epro2` | EasyEDA Pro 工程包（ZIP，内含 `.epru` 工程数据 + 预览图），**唯一的可编辑 EDA 源文件** |
| `gps-tracker-nrf52840-v1.step` | 3D PCB 模型（AP214 STEP，含板体、铜皮/焊盘、各器件 3D 装配，用于 CAD 外壳设计与干涉检查） |
| `BOM.csv` | 13 项物料清单，含型号、封装、备注、已知立创编号 |
| `preview.webp` | 工程内嵌 2D PCB 布局预览图 |
| `preview-3d.png` | 由 `gps-tracker-nrf52840-v1.step` 渲染的 3D 装配预览图 |

## 打开工程

1. 安装 [嘉立创 EDA 专业版 / EasyEDA Pro](https://pro.lceda.cn/)（最新导出由 4.1.105 版本保存，建议 ≥ 4.1.100 版本）。
2. 「文件 → 打开 → EasyEDA Pro 工程」，选择 `gps-tracker-nrf52840-v1.epro2`。
   - 该格式是 ZIP 包，也可以自行解压查看其中的 `nrf52840 gps tracker.epru`（逐行 JSON 文本）。
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

## 版本记录

| 版本 | 说明 |
| --- | --- |
| v1.0 (REV 1.0, 2024-10) | 首个可工作的完整版本：nRF52840 + L76K + LIS3DHTR + BMP280 + OLED + microSD + 21700 |
