# 贡献指南 / Contributing

感谢你愿意帮忙。这个项目是「硬件 + 固件 + 前端 + 工具链」四块的组合，任何一块的 PR 都欢迎。

## 最容易上手的贡献

不一定非要写代码：

| 类型 | 说明 |
| --- | --- |
| 🌟 **Gerber / 坐标文件 / 原理图 PDF** | 用 EasyEDA Pro 打开 `hardware/pcb/*.epro2` 导出后放进 `hardware/pcb/fabrication/`，是最缺的一块，见 [docs/open-source-release.md](docs/open-source-release.md) |
| 📷 实拍照片 / 装配过程图 | 放到 `docs/images/`，README 和装配文档都很需要 |
| 📝 文档纠错 | 引脚、参数、命令写错了直接改，不需要讨论 |
| 🌍 翻译 | 英文 README / 文档随时欢迎 |
| 🐛 复现问题 | 带上硬件版本、固件 commit、操作步骤、日志（`DEFMT_LOG=info cargo run`） |

## 开发环境

```bash
git clone <your-fork>
cd gps_tracker

# 固件
rustup target add thumbv7em-none-eabihf
cargo install flip-link probe-rs-tools
cd firmware && cargo build --release

# 前端
cd frontend && npm install && npm run dev

# Python 工具
cd tools && uv sync && uv run gt --help
```

CI 会做两件事：固件 `cargo build --release` + 应用 UF2 打包，和 `tools/ble_sim` 的 host 侧双广播测试，PR 必须绿。

## 代码约定

- **固件**：`no_std`、无堆。新代码优先用 `StaticCell` / 栈分配；DMA 缓冲区必须是 `'static`。
  - 时间驱动用 RTC1 / TIMER1 —— **不要动 RTC0 / TIMER0**（MPSL / SDC 占用了）。
  - BLE 相关改动跑一下 `cargo test --manifest-path tools/ble_sim/Cargo.toml`（host 侧双广播模拟器）。
  - 引脚只从 `board::Board` 取，不要在驱动里硬编码 `P0_xx`，这样换板子只改一个文件。
  - 改协议要同步改前端 `bleService.ts` 和 `docs/uart_file_proto.md`。
  - `cargo fmt` + `cargo clippy` 请先跑一遍。
- **前端**：TypeScript 严格模式，组件放 `src/components/`，服务放 `src/services/`。
  `gpsDecoder.ts` 必须与固件 `storage.rs` 的 GPZ 实现保持逐字节一致。
- **提交信息**：沿用现有风格（Conventional Commits 简写）：
  `feat: ...` / `fix: ...` / `docs: ...` / `refactor: ...` / `chore: ...`
- **不要提交**：
  - 任何密钥、令牌（`findmy-keys-*.json`、`auth.json`、`fmdn-eik-*.json`）—— `.gitignore` 已覆盖；
  - 未经脱敏的个人轨迹（`.gpz` / GPX 里是你的真实住址）；
  - `firmware/target/`、`node_modules/`、`.venv/` 等构建产物；
  - Nordic 的 SoftDevice `.hex`（现已不用；许可证也不允许分发，`.gitignore` 已排除）。

## 硬件改动的 PR

1. 在 `hardware/pcb/README.md` 的版本表里加一行，写清改了什么、为什么；
2. 如果是引脚变化，同步更新 `firmware/src/board.rs` 和 `docs/hardware/pinout.md`；
3. 附上打样后的实测结论（能用 / 有什么坑），哪怕只是「已验证 3 块板都工作」。

## PR 流程

1. Fork → 建分支 → 改；
2. 本地跑一遍构建（固件 + 前端）；
3. PR 描述里写清：**动机、改了什么、怎么验证的**（有硬件请在真机验证并说明板子版本）；
4. 维护者 review 后合并。不需要 CLA，提交即视为同意以本仓库的许可证（代码 Apache-2.0 / 硬件 CERN-OHL-S-2.0）发布。

## 行为准则

只要求一件事：讨论对事不对人。技术分歧用数据和复现步骤说话。

## 安全问题

**不要**在 issue 里公开安全漏洞，请按 [SECURITY.md](SECURITY.md) 私下报告。
