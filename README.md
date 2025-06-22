# GPS 智能追踪器

一个基于 nRF52840 的低功耗 GPS 追踪设备，配备智能功耗管理系统和 Web 前端可视化界面。

## 项目概述

本项目是一个集成了多种传感器的智能 GPS 追踪器，具备以下特性：

- 🔋 **智能功耗管理** - 基于加速度传感器的运动检测，自动调节 GPS 功耗
- 📍 **高精度定位** - 支持 A-GNSS 辅助定位，提升室内外定位精度
- 🌐 **Web 可视化界面** - 基于 Vite 构建的现代化 Web 前端
- 📱 **蓝牙连接** - 通过 Web Bluetooth API 与设备通信
- 💾 **数据记录** - 支持 GPX 格式轨迹导出和文件管理
- 📊 **多传感器融合** - 集成加速度计、气压计等多种传感器

## 硬件平台

- **主控芯片**: nRF52840 (Pro Micro 兼容)
- **GPS 模块**: 支持 CASIC 协议的 GPS 模块
- **传感器**: 
  - LIS3DHTR 三轴加速度计
  - BMP280 气压温度传感器
- **显示**: SSD1306 OLED 显示屏
- **存储**: 内置 LittleFS 文件系统

## 功能特性

### 固件功能
- 智能 GPS 功耗管理状态机
- 运动检测和静止状态分析
- A-GNSS 数据注入和处理
- 蓝牙低功耗通信
- GPX 轨迹记录和存储
- 实时传感器数据采集
- 电池电量监控

### Web 前端功能
- 设备连接和状态监控
- 实时 GPS 数据显示
- 文件浏览和管理
- GPX 轨迹可视化
- A-GNSS 数据获取和注入
- 日志查看和分析

## 目录结构

```
gps_tracker/
├── src/                    # 固件源代码
│   ├── main.cpp           # 主程序
│   ├── gps_handler.cpp    # GPS 处理模块
│   ├── ble_handler.cpp    # 蓝牙通信模块
│   ├── accel_handler.cpp  # 加速度传感器处理
│   └── ...
├── frontend/              # Web 前端
│   ├── src/
│   │   ├── services/      # 蓝牙、GPS 等服务
│   │   ├── components/    # UI 组件
│   │   └── modules/       # A-GNSS 等功能模块
│   └── ...
├── boards/                # 自定义板型定义
├── docs/                  # 技术文档
├── patches/               # 必要的补丁文件
└── platformio.ini         # PlatformIO 配置
```

## 快速开始

### 固件开发

1. **环境准备**
   ```bash
   # 安装 PlatformIO
   pip install platformio
   ```

2. **编译固件**
   ```bash
   # 编译项目
   pio run
   
   # 生成 UF2 文件
   pio run -t upload
   ```

3. **烧录固件**
   - 将设备进入 bootloader 模式
   - 复制生成的 `.uf2` 文件到设备磁盘

### Web 前端开发

1. **安装依赖**
   ```bash
   cd frontend
   npm install
   ```

2. **开发模式**
   ```bash
   npm run dev
   ```

3. **构建发布**
   ```bash
   npm run build
   ```

### 使用说明

1. **设备连接**
   - 打开 Web 前端界面
   - 点击"连接设备"按钮
   - 选择对应的 GPS Tracker 设备

2. **功能使用**
   - **轨迹记录**: 设备会自动记录 GPS 轨迹
   - **文件管理**: 通过 Web 界面浏览和下载轨迹文件
   - **A-GNSS 更新**: 定期更新 A-GNSS 数据以提升定位性能
   - **状态监控**: 实时查看设备状态和传感器数据

## 部署

### GitHub Pages 自动部署

项目配置了 GitHub Actions 工作流，当代码推送到主分支时会自动部署到 GitHub Pages。

手动触发部署：
1. 访问 GitHub 仓库的 "Actions" 页面
2. 选择 "Deploy Frontend to GitHub Pages" 工作流
3. 点击 "Run workflow" 按钮

## 技术文档

- [状态机设计规范](docs/state_spec.md)
- [UART 文件传输协议](docs/uart_file_proto.md)
- [A-GNSS 数据处理](docs/casic_agnss.md)
- [GPX 增量压缩算法](docs/delta_compress_gpx.md)

## 开发贡献

欢迎提交 Issue 和 Pull Request 来改进项目。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE) 文件。
