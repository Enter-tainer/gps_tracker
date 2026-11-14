# 开源发布清单 / Open-source release checklist

这份文档是给维护者看的：把「硬件 + 固件 + 前端 + 工具」四块拼成一个**别人能复现**的开源项目，
还差哪些东西、怎么补。软件部分仓库里已经齐了，主要缺口在**制造文件**和**素材**。

---

## 1. 现状核对（2026-11-14 实测）

| 检查项 | 结论 |
| --- | --- |
| GitHub 仓库可见性 | ✅ `https://github.com/Enter-tainer/gps_tracker` 公开可访问（HTTP 200，无需登录） |
| 提交历史里是否混入密钥 | ✅ `findmy-keys-*.json`、`fmdn-eik-*.json`、`tools/.../auth.json` 均**不在** HEAD，历史中也查不到 |
| 仓库体积 | ✅ 约 1.8 MiB（pack），干净，没有误提交的 `node_modules` / `target` |
| `.gitignore` 覆盖 | ⚠️ 原先没有覆盖密钥、`.venv/`、SoftDevice hex —— **已补** |
| README 与实现是否一致 | ❌ 原 README 写的还是已废弃的 C++ / PlatformIO / LittleFS，**已重写** |
| LICENSE | ⚠️ 文件是 Apache-2.0，README 却写 MIT —— **已统一为 Apache-2.0**，硬件/文档另加许可 |
| 硬件资料 | ❌ 仓库里完全没有 PCB 和外壳 —— **已新增 `hardware/`** |
| Gerber / 坐标 / 原理图 PDF | ❌ 仍缺，需要你在 EasyEDA Pro 里导出（见 §3） |
| 实拍照片 | ❌ 仍缺，需要你拍照（见 §3） |

## 2. 本次已经补上的东西

```
hardware/
├── README.md                        # 硬件总览：规格、框图、制造、许可
├── pcb/
│   ├── gps-tracker-nrf52840-v1.epro2   # EasyEDA Pro 源工程（428 KB）
│   ├── BOM.csv                      # 从工程网表 + 原理图整理的 13 项物料
│   ├── preview.webp                 # 工程内嵌预览图
│   └── README.md                    # 打开方式、导出 Gerber、打样参数、网络表
├── enclosure/
│   ├── case-slim-v1.3mf             # 原始打印工程
│   ├── case-slim-v1-part-{1,2,3}.stl# 由 3MF 转出的二进制 STL（mm）
│   ├── preview.png                  # 3MF 缩略图
│   └── README.md                    # 模型尺寸、打印参数、装壳注意
├── LICENSE-CERN-OHL-S-2.0.txt
└── LICENSE-CC-BY-4.0.txt

docs/hardware/pinout.md              # MCU 引脚 / 模块焊盘 / I2C 地址 / 外设资源
docs/hardware/assembly.md            # 从裸板到成品的装配与自检
README.md                            # 重写（中文主 + English 摘要 + 首图）
CONTRIBUTING.md  SECURITY.md         # 贡献指南 / 安全策略
.github/ISSUE_TEMPLATE/              # bug / 硬件求助 两个表单 + config
.gitignore                           # 密钥、venv、SoftDevice、个人轨迹
```

## 3. 还需要你手动做的 5 件事

### ① 导出制造文件（最重要，决定别人能不能打样）

用 EasyEDA Pro 打开 `hardware/pcb/gps-tracker-nrf52840-v1.epro2`，导出到 `hardware/pcb/fabrication/`：

| 文件 | 用途 |
| --- | --- |
| `gerber.zip`（Gerber + 钻孔） | 打样 |
| `bom.csv`（EDA 原生导出） | 贴片 / 备料对照 |
| `pick-and-place.csv`（坐标） | SMT 贴片 |
| `schematic.pdf` | 不看 EDA 也能读原理图 |

导出后记得**检查天线区域是否已挖空铺铜**（见 `hardware/pcb/README.md` 的说明）。
这一步做完，硬件就真正「可复现」了，价值远大于再加十页文档。

### ② 拍照（README 的门面）

至少这 5 张，放到 `docs/images/`：

- `board-front.jpg` / `board-back.jpg`：裸板正反面
- `device-assembled.jpg`：装壳成品（放一张硬币/手做参照）
- `oled-screen.jpg`：OLED 状态页
- `webui.png`：网页端连上设备后的截图（状态 + 轨迹地图）

然后在 `README.md` 的「特性」下面加一个 `<img>` 表格即可（作者已留好位置：替换掉现有的
`hardware/*/preview.*` 两行，或在其后追加）。

### ③ 打 tag + 发 Release

```bash
git add hardware docs README.md CONTRIBUTING.md SECURITY.md .gitignore .github
git commit -m "docs: open-source hardware design, rewrite README, add licenses and policies"
git tag -a v0.1.0 -m "First open-source release: firmware + frontend + tools + hardware v1.0"
git push origin master --tags
```

Release 页面（`gh release create v0.1.0` 或网页操作）附加：

- `gps-tracker-combined.uf2`（Actions 里下载，或本地 `cd tools && uv run gt uf2 build`）
- `gps-tracker-nrf52840-v1.epro2`
- `case-slim-v1.zip`（3MF + 3 个 STL）
- `gerber.zip`（① 导出的）
- `schematic.pdf`
- 源码 zip 由 GitHub 自动生成，不用管

Release 说明里写清：**刷 UF2 不需要另装 SoftDevice**、电池规格、以及「轨迹含个人位置，注意分享风险」。

### ④ 配好仓库的「门面」

- **About → Description**：
  `Open-source nRF52840 GPS track logger — Rust firmware, EasyEDA Pro PCB, 3D-printed case, Web Bluetooth app`
- **Topics**（建议全选）：
  `gps` `gps-tracker` `nrf52840` `rust` `embedded` `no-std` `embassy` `ble` `bluetooth` `web-bluetooth`
  `open-hardware` `easyeda` `3d-printing` `findmy` `gnss` `l76k`
- **Social preview**：上传 `hardware/enclosure/preview.png` 或实拍图（1280×640 裁一下）
- **Pages**：确认 `gh-pages` 分支 / Actions 部署正常，网页端要能被别人直接用（Web Bluetooth 需要 HTTPS）

### ⑤ 可选但很加分

- **脱敏示例轨迹**：选一段不含住处/公司的轨迹，用工具做时间+位置偏移后放 `docs/samples/demo.gpz` + `.gpx`，
  网页端就能「不连设备也能看效果」。注意：`*.gpz` 已被 `.gitignore` 排除，需要 `git add -f` 并确认已脱敏。
- **续航实测表**：不同采样间隔/S2 阈值的实测天数，是这类项目最被关心的数据。
- **BOM 立创编号补全**：现在只有 2 项确定编号，补全后别人可以一键配单。

## 4. 许可与第三方合规

| 内容 | 许可 | 说明 |
| --- | --- | --- |
| 固件 / 前端 / 工具 | Apache-2.0 | 仓库根 `LICENSE`，与原来一致 |
| PCB 工程、外壳模型、BOM | CERN-OHL-S-2.0 | 强互惠：改过的硬件设计要回流。想更宽松可自己换成 CERN-OHL-P 或 CC BY-SA |
| 文档 / 图片 | CC BY 4.0 | 允许转载，署名即可 |

需要留意的第三方：

- **Nordic S140 SoftDevice**：仓库**不分发** `s140_*.hex`（`.gitignore` 已排除），CI 构建时从
  embassy-rs / tinygo 的镜像下载。使用者需自行接受 Nordic 的许可。
- **`uf2conv.py` / `uf2families.json`**：来自 Microsoft 的 [UF2](https://github.com/microsoft/uf2) 工具（MIT），
  入仓库时没有版权头。建议在两个文件头补一段来源说明 + MIT 声明，避免被人当作本项目原创。
- **`src/`、`platformio.ini`、`boards/`、`extra_script.py`**：早期 Arduino/PlatformIO 版本，保留为存档。
  如果里面混有第三方库代码，建议单独加 `src/README.md` 说明「已废弃，可能含第三方代码」。
- **工程内 Board 名称** `meshtastic nrf52840 prototype`：只是模板命名，已在新文档里注明，避免误解为
  Meshtastic 衍生设计（本板没有 LoRa 模块）。

## 5. 发布之后

- 在 V2EX / 少数派 / Hackaday.io / r/embedded / r/rust 各发一帖时，**首图用装壳实拍 + 一句话定位**，
  链接直接指到 README 的「硬件」段落。
- 把 `docs/hardware/pinout.md` 和 `BOM.csv` 放进帖子正文，会显著提高「这项目能复现」的可信度。
- 开一个 issue 模板已经就绪的仓库，收到的问题会自带版本/硬件信息，省很多来回。
- 如果之后改板，记得**同时**更新：`hardware/pcb/README.md` 版本表、`docs/hardware/pinout.md`、
  `firmware/src/board.rs`（引脚变更时）。
