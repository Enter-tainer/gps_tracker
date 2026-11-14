# GPS Tracker · nRF52840 低功耗 GPS 轨迹记录器

[![License: Apache-2.0](https://img.shields.io/badge/code-Apache--2.0-blue.svg)](LICENSE)
[![Hardware: CERN-OHL-S-2.0](https://img.shields.io/badge/hardware-CERN--OHL--S--2.0-brightgreen.svg)](hardware/LICENSE-CERN-OHL-S-2.0.txt)
[![MCU: nRF52840](https://img.shields.io/badge/MCU-nRF52840-orange.svg)](hardware/README.md)
[![Firmware: Rust + Embassy](https://img.shields.io/badge/firmware-Rust%20%2B%20Embassy-red.svg)](firmware/)

一个可以自己焊、自己刷、自己改的 GPS 轨迹记录器：**nRF52840 + L76K GNSS + 21700 电池**。
核心设计是「用加速度计判断你动没动，没动就把 GPS 整段断电」的功耗策略 —— 这也是整机续航能到周级别的原因。

> **一句话**：把它扔在车上/包里，它会自己判断你在不在动，动就记轨迹、不动就彻底关掉 GPS 省电；
> 回家用浏览器（Web Bluetooth）连上，把轨迹导成 GPX。
> 全部硬件源文件、固件、前端、工具都在这个仓库里，没有半成品二进制。

---

## 目录

- [特性](#特性)
- [硬件](#硬件)
- [软件架构](#软件架构)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
- [使用流程](#使用流程)
- [隐私与安全](#隐私与安全)
- [文档](#文档)
- [项目状态](#项目状态)
- [贡献](#贡献)
- [许可](#许可)
- [English](#english)

---

## 特性

**记录**
- 智能功耗状态机：加速度计判断静止/运动，静止时 GPS 整段断电（S2），运动时 10 s 一个点（S3，HDOP < 2.0）
- A-GNSS 星历注入：网页端拉取星历 → BLE 灌进设备，室内外冷启动都能明显加速（S5）
- 自定义 **GPZ** 二进制格式：ZigZag + LEB128 增量压缩，每 64 个增量点插一个全量块，支持 1e-5 / 1e-7 两种精度
- microSD 存储，FAT 文件系统；插 USB 还能直接当 U 盘读卡（USB Mass Storage）
- IANA 时区库：GPS 的 UTC 时间直接换算本地时间，OLED 显示的是你所在时区（时区表预生成在 `firmware/data/`）

**取数**
- BLE NUS 文件传输协议（分块、可断点续传式读写、目录列表、删除）
- 网页端实时状态：GPS 状态、卫星数、HDOP、电量、传感器、SD 卡状态
- 轨迹可视化（MapLibre）、一键导出 GPX、海拔/速度剖面

**周边**
- 0.96" OLED 多页 UI（状态页、GPS 页、Find My 页）
- 短按 / 长按 / 超长按三级按键逻辑
- Apple Find My 离线查找（`findmy` feature，默认开启）：P-224 滚动密钥，每 15 分钟轮换，设备丢了也能被附近 iPhone 找到

## 硬件

![PCB preview](hardware/pcb/preview.webp)
![Enclosure preview](hardware/enclosure/preview.png)

| 项目 | 参数 |
| --- | --- |
| 主控 | ProMicro nRF52840 核心板（Cortex-M4F，1 MB Flash / 256 KB RAM） |
| 定位 | Quectel L76K（GPS/BDS，CASIC 协议，支持 A-GNSS 注入） |
| 天线 | 25×25×4 mm 陶瓷贴片天线（板载） |
| 传感器 | LIS3DHTR 加速度计 · BMP280 气压/温度 |
| 显示 | 0.96" 128×64 OLED（I2C） |
| 存储 | microSD（SPI） |
| 电池 | 单节 21700（3.6/3.7 V），USB-C 充电 |
| PCB | 2 层，**95 × 30 mm**，13 个元件 |
| 外壳 | 3D 打印（slim v1，STL + 3MF） |

完整规格、BOM、打样参数、装配步骤：

- [hardware/README.md](hardware/README.md) —— 硬件总览
- [hardware/pcb/BOM.csv](hardware/pcb/BOM.csv) —— 13 项物料清单
- [docs/hardware/pinout.md](docs/hardware/pinout.md) —— 引脚/网络对照表
- [docs/hardware/assembly.md](docs/hardware/assembly.md) —— 从裸板到成品的装配指南

## 软件架构

```
┌────────────── 浏览器（React + Web Bluetooth）──────────────┐
│  连接 / 状态监控 · 文件浏览下载 · GPX 可视化 · A-GNSS 注入  │
│  Find My 密钥生成与下发                                     │
└───────────────────────────┬────────────────────────────────┘
                            │ BLE NUS，244 B 分包
┌───────────────────────────┴────────────────────────────────┐
│  nRF52840 固件（Rust + Embassy + SoftDevice S140）          │
│  ble.rs / protocol.rs ─ 命令分发                            │
│  gps/ ─ 6 态状态机（S0–S5）+ NMEA 解析 + CASIC 命令          │
│  storage.rs ─ SD 卡 + GPZ 编码（ZigZag/LEB128）             │
│  accel.rs ─ 运动检测 → 触发 GPS 上下电                      │
│  display.rs / button.rs / battery.rs / usb_msc.rs / findmy  │
└─────────────────────────────────────────────────────────────┘
```

- **固件**：`no_std`、无堆，`StaticCell`/栈分配；SoftDevice 占用 RTC0，时间驱动用 RTC1/TIMER1
- **协议**：`[CMD:1B][LEN:2B LE][payload]`，命令 0x01–0x0B（文件/系统/AGNSS/GPS 唤醒），0x0C–0x0E 为 Find My
- **格式**：GPZ V1（1e-5 ≈ 1.1 m）/ V2（1e-7 ≈ 1.1 cm）混合块，详见 [docs/delta_compress_gpx.md](docs/delta_compress_gpx.md)

## 仓库结构

```
gps_tracker/
├── firmware/          # Rust 固件（Embassy + nrf-softdevice），主开发分支
│   ├── src/
│   ├── data/          # 预生成的时区表（供 timezone.rs 使用）
│   └── Cargo.toml
├── frontend/          # React + TypeScript + Vite PWA，Web Bluetooth 上位机
├── tools/             # uv 管理的 Python 工具包（CLI 名 gt）
│   └── src/gps_tracker_tools/   # findmy / casic / gps_format / uf2 / gpx
├── hardware/          # ★ 硬件：PCB 源工程、BOM、3D 外壳、STL
├── docs/              # 协议、格式、状态机、硬件文档
├── scripts/           # 时区表/logo 生成脚本
├── src/               # ⚠ 已废弃的 Arduino C++ 固件，仅存档，勿改
├── boards/            # ⚠ PlatformIO 板级定义（同上，历史遗留）
└── platformio.ini     # ⚠ 旧 C++ 构建配置，勿用
```

> 新开发请只用 `firmware/`（Rust）。`src/` 与 `platformio.ini` 是项目早期的 C++ 版本，保留是为了存档。

## 快速开始

### 1. 固件

```bash
# 工具链（一次性）
rustup target add thumbv7em-none-eabihf
cargo install flip-link probe-rs-tools

cd firmware
cargo build --release          # 产物在 target/thumbv7em-none-eabihf/release/
cargo run --release            # 用 probe-rs 经 SWD 烧录
DEFMT_LOG=info cargo run --release   # 顺便看 RTT 日志
```

生成可以直接拖进 U 盘（bootloader）的 UF2，包含 SoftDevice 合并：

```bash
cd tools
uv run gt uf2 build
# → firmware/target/thumbv7em-none-eabihf/release/gps-tracker-combined.uf2
```

> 仓库**不附带** Nordic S140 SoftDevice 的 hex（许可证限制），构建脚本会自动下载。
> CI 每次推送都会构建 UF2，也可以直接从 Actions 的 artifact 里取。

### 2. 网页上位机

```bash
cd frontend
npm install
npm run dev      # http://localhost:3000
npm run build    # 产物 dist/
```

推送到 `master` 会自动部署到 GitHub Pages（`.github/workflows/deploy-frontend.yml`）。
需要 Chrome / Edge 等支持 **Web Bluetooth** 的浏览器（Safari、Firefox 不支持）。

### 3. 命令行工具

```bash
cd tools
uv run gt --help
uv run gt findmy --help        # Apple Find My 位置报告查询 / GPX 导出
uv run gt casic --help         # CASIC 协议解析
uv run gt gps --help           # GPZ 编解码
uv run gt uf2 build            # 构建合并 UF2
```

## 使用流程

1. **连上设备**：网页端点「连接设备」→ 选择 `GPS Tracker`。
2. **看状态**：GPS 状态机（S0–S5）、卫星数、HDOP、电池电压、SD 卡、传感器都会实时刷新。
3. **灌星历（可选，强烈建议）**：AGNSS 页面拉取星历 → 写入设备，下次冷启动快很多。
4. **记录**：带着走就行。静止 60 s 后自动进 S2（GPS 断电），有运动再唤醒。
5. **导出**：文件管理页浏览 `/` 下的 `.gpz` → 下载 → 网页端解码成 GPX（也可用 `gt gps`）。
6. **USB 模式**：网页端触发后设备重启成 U 盘，直接读 TF 卡（大文件更快）。

## 隐私与安全

这个项目有两处**必须注意**的隐私问题：

- **轨迹就是你的行踪**。分享 `.gpz` / GPX 前先裁剪或用工具做偏移，别把住址、公司发出去。
- **Find My 密钥 = 设备的私钥**。`keys.json`（68 字节主密钥材料）泄露后别人可以解出设备所有历史位置；
  `tools/src/gps_tracker_tools/auth.json` 是你的 Apple 账号令牌。这两类文件**已在 `.gitignore` 中排除**，
  实测也从未进入过提交历史，但**永远不要** `git add -f`。
- 设备端的 Find My 广告密钥每 15 分钟轮换一次，对旁观者匿名；但拿到主密钥的人可以完整回溯。

硬件安全：21700 锂电请用正规电芯 + 保护板，首次上电串限流；详见 [装配指南](docs/hardware/assembly.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/state_spec.md](docs/state_spec.md) | GPS 功耗状态机 S0–S5 的完整转移条件与阈值 |
| [docs/uart_file_proto.md](docs/uart_file_proto.md) | BLE NUS 文件传输协议（命令/响应格式） |
| [docs/protocol_parity_spec.md](docs/protocol_parity_spec.md) | BLE 协议命令参考与前后端一致性 |
| [docs/casic_agnss.md](docs/casic_agnss.md) | CASIC 二进制协议与 A-GNSS 注入流程 |
| [docs/delta_compress_gpx.md](docs/delta_compress_gpx.md) | GPZ V1/V2 格式与增量压缩算法 |
| [docs/protocol_test_vectors.md](docs/protocol_test_vectors.md) | 协议测试向量 |
| [docs/hardware/pinout.md](docs/hardware/pinout.md) | 引脚 / 网络 / I2C 地址对照 |
| [docs/hardware/assembly.md](docs/hardware/assembly.md) | 装配与自检 |
| [docs/open-source-release.md](docs/open-source-release.md) | 本仓库开源发布清单（还差什么、怎么补） |

## 项目状态

能用的部分（作者自己在用，记录了多条真实轨迹）：

- ✅ 硬件 v1.0（PCB + 外壳）可复现
- ✅ 固件：状态机、存储、BLE、USB MSC、OLED、按键、电量、（可选）Find My
- ✅ 网页上位机 + 自动部署
- ✅ Python 工具链（`gt`）

还差的、欢迎 PR 的部分：

- ⬜ **Gerber / 贴片坐标 / 原理图 PDF 尚未入库**（导出方法已写在 [hardware/pcb/README.md](hardware/pcb/README.md)）
- ⬜ 实拍照片、装配过程图
- ⬜ 更多外壳版本（v0 / v1 / v2 / v4 未发布）
- ⬜ 电池续航实测数据（不同采样间隔/运动模式）
- ⬜ 固件单元测试（目前硬件相关代码只能上机验证）

## FAQ

**续航多久？**
作者自用的经验是 1–2 周，具体取决于运动频率和唤醒间隔。静止时 GPS 完全断电，所以「放着不动」几乎不耗电；
连续记录（一直在走/开车）会明显缩短。

**冷启动多久能定位？**
室外冷启动最长 90 s（S1 状态超时），热启动 30 s。灌了 A-GNSS 星历后通常几十秒内出点，有历史位置时更快。

**为什么固件从 C++ 迁移到了 Rust？**
仓库里的 `src/` 是早期的 Arduino/PlatformIO 版本，已废弃。Rust + Embassy 版本（`firmware/`）在功耗管理、
类型安全和可维护性上都更好，功能已完全覆盖旧版。新开发请只用 `firmware/`。

**网页端需要装软件吗？**
不需要。任何支持 **Web Bluetooth** 的浏览器都可以（Chrome / Edge / 安卓 Chrome），打开网页即可。
iOS 的 Safari 不支持 Web Bluetooth，暂时用不了网页端。

**能换别的 GPS 模块吗？**
可以，但必须是支持 **CASIC 私有协议**的模块（L76K / ATGM336H 系列）。换成纯 NMEA 模块能定位，
但会失去 A-GNSS 注入和 `PCAS` 配置能力。

**能换成 18650 或别的电池吗？**
能，注意外壳和电池座尺寸要一起改；分压电阻是 200k/300k，换电池化学体系后电量曲线需要重新标定
（`firmware/src/battery.rs` 的 `VOLTAGE_POINTS`）。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请走 [SECURITY.md](SECURITY.md)，**不要**开 public issue。

## 许可

| 内容 | 许可 |
| --- | --- |
| 固件 / 前端 / 工具代码 | [Apache-2.0](LICENSE) |
| 硬件设计（PCB 工程、外壳、BOM） | [CERN-OHL-S-2.0](hardware/LICENSE-CERN-OHL-S-2.0.txt) |
| 文档、图片 | [CC BY 4.0](hardware/LICENSE-CC-BY-4.0.txt) |

第三方组件（Embassy、nrf-softdevice、nmea、embedded-sdmmc、MapLibre 等）遵循各自许可；
Nordic SoftDevice 的二进制不在仓库内，使用需接受 Nordic 的许可协议。

---

## English

A DIY, fully open GPS track logger built around **nRF52840 + Quectel L76K + a single 21700 cell**.

- **Firmware** (Rust, `no_std`, Embassy + SoftDevice S140): 6-state power-management state
  machine, motion-triggered GPS power gating, A-GNSS injection over CASIC, custom **GPZ**
  delta-compressed track format on microSD, BLE NUS file transfer, USB mass storage,
  SSD1306 UI, and optional Apple Find My offline finding (P-224 rolling keys).
- **Web app** (React + TypeScript + Vite PWA): connects over Web Bluetooth, live status,
  file browser, GPX export, MapLibre track view, A-GNSS provisioning, Find My key management.
- **Hardware**: 2-layer 95 × 30 mm board (EasyEDA Pro source project + BOM) and a 3D-printed
  slim enclosure (3MF + STL). See [hardware/](hardware/README.md).
- **Tools**: `gt` CLI (uv-managed) for Find My report fetching, CASIC/NMEA parsing, GPZ
  decode/encode, and UF2 packaging.

Build: `cd firmware && cargo build --release`, `cd frontend && npm run dev`,
`cd tools && uv run gt uf2 build`. Full instructions above (Chinese) and in
[docs/](docs/).

**License**: code Apache-2.0 · hardware CERN-OHL-S-2.0 · docs CC BY 4.0.

**Privacy warning**: track files reveal your whereabouts, and the Find My master key can
decrypt every location report of your device. Never commit `keys.json` or `auth.json`.
