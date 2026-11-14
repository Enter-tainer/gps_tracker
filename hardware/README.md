# 硬件设计 / Hardware

nRF52840 GPS 轨迹记录器的完整硬件资料：PCB（EasyEDA Pro 源工程）、物料清单、3D 打印外壳。

固件与上位机见仓库根目录的 [README](../README.md)。

---

## 板卡规格

| 项目 | 参数 |
| --- | --- |
| 主控 | ProMicro nRF52840 核心板模块（nRF52840，Cortex-M4F，1 MB Flash / 256 KB RAM，板载 USB-C） |
| 定位 | Quectel L76K GNSS 模块（GPS/BDS，CASIC 私有协议，支持 A-GNSS 星历注入加速定位） |
| 天线 | 25 × 25 × 4 mm 陶瓷贴片天线，直接焊在 PCB 上（无 SMA 座） |
| 运动检测 | LIS3DHTR 三轴加速度计（I2C `0x18`） |
| 气压 / 温度 | BMP280（I2C `0x76`，SDO 接地） |
| 显示 | 0.96" 128×64 OLED，4P I2C 模块（I2C `0x3C`） |
| 存储 | microSD / TF 卡座（SPI），轨迹以 GPZ 二进制格式保存 |
| 电池 | 单节 21700 锂电（3.6 / 3.7 V），板载电池座 + 1.25 mm 2P 外接座 |
| 电量检测 | 200 kΩ / 300 kΩ 分压到 ADC：`Vbat = Vadc × 5/3` |
| 按键 | 复位键 `URST`（接模块 RST）、用户键 `UUSR`（接 `P1.00`，短/长/超长按） |
| 烧录 / 调试 | USB（UF2 bootloader）或 SWD（`probe-rs`） |
| PCB | 2 层，95.0 × 30.0 mm，四角 R2 圆角，工程版本 REV 1.0 |

> 工程设计文件内的 Board / Schematic 名称仍为早期模板名 `meshtastic nrf52840 prototype`，
> 属于历史遗留命名，与本项目硬件功能无关，也不包含 LoRa 模块。

## 目录结构

```
hardware/
├── pcb/
│   ├── gps-tracker-nrf52840-v1.epro2   # EasyEDA Pro 源工程（可编辑，含原理图 + PCB + 库）
│   ├── BOM.csv                         # 物料清单（13 项）
│   ├── preview.webp                    # 工程自带预览图
│   └── README.md                       # 打样 / 导出 Gerber / 下单说明
├── enclosure/
│   ├── case-slim-v1.3mf                # 原始打印工程（3 个实体）
│   ├── case-slim-v1-part-{1,2,3}.stl   # 从 3MF 转出的二进制 STL（mm）
│   ├── preview.png                     # 3MF 缩略图
│   └── README.md                       # 打印参数与装配顺序
├── LICENSE-CERN-OHL-S-2.0.txt          # 硬件设计许可
└── LICENSE-CC-BY-4.0.txt               # 文档与图片许可
```

## 系统框图

```
                    ┌──────────────────────────────┐
   21700 锂电 ──────┤ U8 电池座 / CN2 外接座       │
        │           └──────────────┬───────────────┘
        │ BAT                      │
        ├──── 200k/300k 分压 ── ADC ──┐
        │                             │
        │           ┌─────────────────┴────────────────┐
        └───────────┤  C2  ProMicro nRF52840 核心板    │
                    │  USB-C（充电 / UF2 / USB MSC）   │
                    └──┬────────┬────────┬────────┬────┘
             UART      │        │ I2C    │ SPI    │ GPIO
        ┌──────────────┴──┐  ┌──┴─────┐  │   ┌────┴─────┐
        │ U7 L76K GNSS    │  │ OLED1  │  │   │ URST     │
        │ + ANT 陶瓷天线   │  │ U4     │  │   │ UUSR     │
        │ GPSEN 可整段断电 │  │ U11    │  │   └──────────┘
        └─────────────────┘  └────────┘  │
                              ┌──────────┴───────┐
                              │ U10 microSD      │
                              └──────────────────┘
```

- **GPS 断电省电**：`GPSEN`（`P0.24`）直接控制 L76K 的电源使能，S2 空闲态整段断电。
- **I2C 总线共用**：OLED、BMP280、LIS3DHTR 挂在同一组 `SDA`/`SCL` 上，固件用 `BlockingMutex` 串行化访问。
- **无 RTC 备用电池**：设备每次上电靠 GPS 授时，Find My 滚动密钥也需要 GPS 时间才能推进。

## 与固件 / 文档的对应关系

| 内容 | 位置 |
| --- | --- |
| 引脚映射（MCU 侧权威定义） | [`firmware/src/board.rs`](../firmware/src/board.rs)，整理版见 [docs/hardware/pinout.md](../docs/hardware/pinout.md) |
| 电池电压换算与电量曲线 | [`firmware/src/battery.rs`](../firmware/src/battery.rs) |
| GPS 功耗状态机 | [docs/state_spec.md](../docs/state_spec.md) |
| 轨迹存储格式 GPZ | [docs/delta_compress_gpx.md](../docs/delta_compress_gpx.md) |
| 装配步骤 | [docs/hardware/assembly.md](../docs/hardware/assembly.md) |

## 制造说明

- **PCB 源工程**：`pcb/gps-tracker-nrf52840-v1.epro2`，用 EasyEDA Pro（嘉立创 EDA 专业版，≥ 4.1.100）打开即可编辑。工程内嵌了用到的符号 / 封装 / 器件，不依赖外部库。
- **Gerber / 坐标文件 / 原理图 PDF 未随仓库发布**：导出方法见 [pcb/README.md](pcb/README.md)。欢迎提 PR 把这些制造文件补进来。
- **物料**：见 [pcb/BOM.csv](pcb/BOM.csv)。只有 4 项能确定立创商城编号（`C15134`、`C9900040040`），其余请按型号检索同规格件，允许替换。

## 许可 / License

| 内容 | 许可 |
| --- | --- |
| 硬件设计文件（PCB 工程、外壳模型、BOM） | [CERN-OHL-S-2.0](LICENSE-CERN-OHL-S-2.0.txt) |
| 文档、渲染图、README | [CC BY 4.0](LICENSE-CC-BY-4.0.txt) |
| 固件与上位机代码 | [Apache-2.0](../LICENSE) |

采用 CERN-OHL-S（强互惠）是为了保证改动过的硬件设计同样回流到社区；如果你希望更宽松的条款，可以在 fork 中自行调整并注明。

## 安全提示

- 21700 锂电请使用正规品牌电芯，焊接前确认电池座极性与电芯极性一致；首次上电建议用限流电源。
- 陶瓷天线对净空敏感：天线正下方与四周不要铺铜、不要放高元件，外壳对应位置不要覆盖金属。
- 设备会记录精确位置。若要分享轨迹文件，请先做轨迹裁剪 / 偏移，避免泄露住址等敏感地点。
