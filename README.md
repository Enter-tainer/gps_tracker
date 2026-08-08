# GPS 智能追踪器

一个基于 nRF52840 的低功耗 GPS 追踪设备，配备智能功耗管理系统和 Web 前端可视化界面。

## 项目概述

本项目是一个集成了多种传感器的智能 GPS 追踪器，具备以下特性：

- 🔋 **智能功耗管理** - 基于加速度传感器的运动检测，自动调节 GPS 功耗
- 📍 **高精度定位** - 支持 A-GNSS 辅助定位，提升室内外定位精度
- 🌐 **Web 可视化界面** - 基于 Vite 构建的现代化 Web 前端
- 📱 **蓝牙连接** - 通过 Web Bluetooth API 与设备通信
- 💾 **数据记录** - 支持 GPZ 二进制轨迹格式，可导出为 GPX
- 📊 **多传感器融合** - 集成加速度计、气压计等多种传感器
- 🔍 **Apple Find My 离线查找** - 兼容 Apple Find My 网络，设备离线时可通过附近 Apple 设备定位
- 💻 **USB 直连存储** - 通过 USB 以 U 盘方式直接访问 SD 卡中的轨迹文件

## 硬件平台

- **主控芯片**: nRF52840 (Pro Micro 兼容)
- **GPS 模块**: 支持 CASIC 协议的 GPS 模块(L76k)
- **传感器**:
  - LIS3DHTR 三轴加速度计
  - BMP280 气压温度传感器
- **显示**: SSD1306 OLED 显示屏
- **存储**: SD 卡（SPI 接口，FAT 文件系统）

## 功能特性

### 固件功能
固件基于 **Rust + Embassy** 异步框架开发（`#![no_std]`，无堆分配）：

- 智能 GPS 功耗管理状态机（S0-S5 六状态，见 `docs/state_spec.md`）
- 运动检测和静止状态分析
- A-GNSS 数据注入和处理
- 蓝牙低功耗通信（NUS UART 服务）
- GPZ 二进制轨迹记录（ZigZag + LEB128 增量压缩，V1/V2 精度可混用）
- 实时传感器数据采集
- 电池电量监控
- Apple Find My 离线查找（P-224 滚动密钥，15 分钟自动轮换，`findmy` feature 开关）
- USB 大容量存储模式（直接访问 SD 卡）
- IANA 时区数据库支持（GPS 时间转本地时间）

### Web 前端功能
- 设备连接和状态监控
- 实时 GPS 数据显示
- 文件浏览和管理
- GPZ/GPX 轨迹可视化和导出
- A-GNSS 数据获取和注入
- Find My 密钥生成、写入设备和状态管理
- 日志查看和分析

## 目录结构

```
gps_tracker/
├── firmware/              # Rust 固件（当前主力，Embassy 异步框架）
│   ├── src/               # 固件源代码
│   ├── Cargo.toml
│   └── memory.x           # 链接脚本（SoftDevice 保留区）
├── frontend/              # Web 前端（Vite + React + TypeScript）
│   └── src/
├── tools/                 # Python 工具（uv 管理，`gt` CLI）
│   └── src/gps_tracker_tools/   # UF2 构建、Find My、CASIC、GPZ 等
├── docs/                  # 技术文档
├── scripts/               # 辅助脚本
├── src/                   # ⚠️ 已废弃的 C++ Arduino 固件（请勿修改）
└── platformio.ini         # 仅用于已废弃的 C++ 构建
```

> **注意**：早期版本使用 C++/Arduino 编写固件（`src/` 目录），现已完全迁移到 Rust 固件（`firmware/` 目录）。请勿修改 `src/` 下的旧代码，所有开发均在 `firmware/` 中进行。

## 快速开始

### 固件开发

前置依赖：
- Rust 工具链（`thumbv7em-none-eabihf` target）
- `cargo install flip-link`（链接器）
- `cargo install probe-rs-tools`（可选，SWD 调试/烧录）
- `uv`（Python 包管理器，用于构建工具）

```bash
# 构建 Rust 固件（默认 RTT 日志，需调试探针）
cd firmware
cargo build --release

# 生成带 SoftDevice 的合并 UF2（拖拽烧录用，无需探针）
cd ../tools
uv run gt uf2 build
# 产物：firmware/target/thumbv7em-none-eabihf/release/gps-tracker-combined.uf2

# 通过 SWD 探针编译并烧录运行
cd ../firmware
cargo run --release
```

调整日志级别：
```bash
DEFMT_LOG=info cargo run --release
```

### 烧录固件

有两种方式：
1. **拖拽 UF2**（无需探针）：设备进入 bootloader 模式后，将 `gps-tracker-combined.uf2` 复制到设备磁盘（已包含 SoftDevice 蓝牙协议栈）
2. **SWD 探针**：`cargo run --release`，通过 probe-rs 烧录（需先刷入 SoftDevice）

### Web 前端开发

```bash
cd frontend
npm install
npm run dev          # 开发模式（localhost:3000）
npm run build        # 构建发布
```

### 使用说明

1. **设备连接**
   - 打开 Web 前端界面
   - 点击"连接设备"按钮
   - 选择对应的 GPS Tracker 设备

2. **功能使用**
   - **轨迹记录**: 设备会自动记录 GPS 轨迹（GPZ 格式）
   - **文件管理**: 通过 Web 界面浏览和下载轨迹文件，或通过 USB 直连以 U 盘方式访问
   - **A-GNSS 更新**: 定期更新 A-GNSS 数据以提升定位性能
   - **状态监控**: 实时查看设备状态和传感器数据
   - **Find My 离线查找**: 在 Web 界面生成密钥并写入设备，启用 Apple Find My 网络定位

## 部署

### GitHub Pages 自动部署

项目配置了 GitHub Actions 工作流，当代码推送到主分支时会自动部署到 GitHub Pages。我们使用了官方的 GitHub Pages 部署 action，确保部署过程稳定可靠。

手动触发部署：
1. 访问 GitHub 仓库的 "Actions" 页面
2. 选择 "Deploy Frontend to GitHub Pages" 工作流
3. 点击 "Run workflow" 按钮

部署完成后可通过以下地址访问：
```
https://[username].github.io/gps_tracker/
```

请将[username]替换为你的GitHub用户名。

注意：要使用 GitHub Pages 功能，你需要：
1. 在仓库设置中启用 GitHub Pages
2. 在「Settings > Pages」页面选择"Deploy from a branch"并选择"gh-pages"分支

### 固件 CI 构建

每次推送 `firmware/` 相关改动时，GitHub Actions 会自动构建合并 UF2 固件，可在 Actions 页面的 "Build Firmware UF2" 工作流中下载构建产物。

## 技术文档

- [状态机设计规范](docs/state_spec.md)
- [UART 文件传输协议](docs/uart_file_proto.md)
- [A-GNSS 数据处理](docs/casic_agnss.md)
- [GPZ 增量压缩算法](docs/delta_compress_gpx.md)
- [BLE 协议命令参考](docs/protocol_parity_spec.md)
- [固件迁移计划](docs/firmware_migration_plan.md)

## 开发贡献

欢迎提交 Issue 和 Pull Request 来改进项目。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE) 文件。

## 贡献者

- [您的名字/组织] - 项目设计与开发

## FAQ

### 电池续航能力如何？
- 凭借智能功耗管理系统，设备在正常使用下可持续工作 1-2 周，具体取决于移动频率和GPS唤醒间隔。

### 定位效果如何？
- 结合A-GNSS技术，本设备在室外环境下定位速度和准确性都有明显提升

### 如何提高定位精度？
- 定期更新A-GNSS数据
- 确保设备天线朝向天空

### Web前端是否需要安装额外软件？
- 不需要，前端基于Web技术开发，任何支持Web Bluetooth API的现代浏览器即可使用（推荐Chrome、Edge等）。

### 为什么固件从 C++ 迁移到了 Rust？
- 原 C++/Arduino 固件（`src/`）已废弃，新固件基于 Embassy 异步框架，提供更好的功耗管理、类型安全和可维护性。`firmware/` 目录下的所有功能已完全替代旧固件。
