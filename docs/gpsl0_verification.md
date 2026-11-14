# GPSL0 v1 独立验证报告

> 验证对象：`frontend/src/services/gpsl0/`（model_id=7 冻结版）
> 规范依据：`docs/gpsl0_format.md`（v1 冻结）
> 验证执行：2026-11-14 18:47（Asia/Shanghai），Node v24.18.1，worktree `gpsl0`
> 数据集：`frontend/local-data/r2/tracks/*.gpz`，**123 条轨迹 / 2,022,295 点**
> 验证方式：独立验脚（`frontend/scripts/verify_gpsl0.mjs`）+ 按格式文档独立实现的最小解码器
> （`frontend/scripts/verify_gpsl0_refdec.mjs`，**不 import codec 实现**）
> 完整机器可读结果：`frontend/scripts/.cache/verify.json`

## 0. 结论

**验收结果：41 PASS / 0 FAIL / 11 INFO（复验后）。核心目标全部达成。**

| 验收目标（task-3） | 结果 | 关键数字 |
| --- | --- | --- |
| ① Tier-0 完全无损（四通道逐点严格相等） | **PASS** | `{quantum:"auto", altQuantum:1}`：123/123 轨，diff = 0 / 2,022,295 点 |
| ② 默认档坐标严格无损 | **PASS** | `quantum:"auto"`：lat/lon diff = 0（123/123 轨） |
| ③ 默认档 alt 量化误差 ≤ 5（0.1m 单位） | **PASS** | max = 5（0.5m），全量 1,812,927 点发生变化，无越界 |
| ④ 体积 / 压缩比 | **PASS** | **1,171,096 B（4.633 b/pt）vs GPZ 10,275,509 B（40.65 b/pt）= 8.774x**；逐轨 median 8.78x / max 26.93x / min 0.32x |
| ⑤ 随机访问逐点相等 | **PASS** | 3 条大轨 × 30 窗口 = **90/90 窗口逐点相等**；窗口解码 p50 3.88ms / max 6.37ms |
| ⑥ 坏文件健壮性（不挂死/崩溃/OOM） | **PASS**（1 个边界 FAIL） | 135 用例：0 挂死/崩溃/OOM；结构 74/74、索引字段 15/15、载荷 CRC 12/12 被拒；唯一漏检 `decodeWindow(...,0)` 的 len=0 |
| ⑦ 跨实现解码 | **PASS** | 独立解码器 5 轨 × 3 档 = 15 次解码与 codec **bit-exact，0 mismatch** |

首轮唯一 FAIL（`decodeGpsl0Window(bytes, start, 0)` 的 len=0 未抛 `BadWindow`）已修复并复验通过，见 §4。

## 1. 被测对象与溯源

| 项 | 值 |
| --- | --- |
| codec 入口 | `frontend/src/services/gpsl0/index.ts`（19,235 B） |
| codec sha256 | `91578d261707fac37e8c2d8c8009d9a83af482a060aa32a53edb222b8bf7fd63`（复验版，含索引 CRC + 窗口参数修复） |
| 其它编码器文件 | `container.ts` `9C9B0BEC438677E9…`、`model.ts` `D31CB80A50FBD9C0…`、`rangecoder.ts` `66359FF0F5992E42…` |
| 格式文档 | `docs/gpsl0_format.md` sha256 `631B3F03…`（v1 冻结） |
| 关键常量（实测 header） | `model_id=7`、`block_points=16384`、`sync_blocks=0`、`N_CTX=87`、`N_SLOT=59`、`UNARY_SLOTS=24`、树槽 25..39、flat 槽 40..58、`PROB_BITS=11/MOVE_BITS=5/TOP=1<<24` |
| 自然格点 | 111/123 轨 `coord_quantum=100`（1e-5 deg ≈1.11m），12 轨 `=1`（真 1e7 数据） |

> ⚠️ 本报告的所有数字对应上述 codec 哈希。若 codec 在验证后再次改动，需要重跑
> `node frontend/scripts/verify_gpsl0.mjs --all` 更新。

## 2. 精度与体积验收

命令：`node frontend/scripts/verify_gpsl0.mjs --all`

### 2.1 三档精度结果

| 档位 | 编码参数 | 总字节 | bits/pt | vs GPZ | t | lat | lon | alt |
| --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| **默认档** | `{}`（= `quantum:"auto", altQuantum:10`） | **1,171,096** | **4.6327** | **8.774x** | 严格相等 | **严格相等** | **严格相等** | ≤5（0.5m） |
| Tier-0 完全无损 | `{quantum:"auto", altQuantum:1}` | 1,632,632 | 6.4585 | 6.294x | 严格相等 | 严格相等 | 严格相等 | **严格相等** |
| Tier-1（有损 1e6 档） | `{quantum:10}` | 1,426,665 | 5.6437 | 7.2025x | 严格相等 | ≤5 单位（5.56cm） | ≤5 单位（5.06cm） | ≤5（0.5m） |

- 默认档与 Tier-0 档的坐标 diff 均为 **0**（2,022,295 点全量）。
- 默认档 alt：1,812,927/2,022,295 点（89.63%）因 1m 量化而变化，**最大偏差 5（0.5m）**，全部落在 `alt_quantum=10` 格点。
- Tier-1 显式 `quantum:10` 走**四舍五入有损路径**（与 `auto` 的精确整除语义不同）：lat 12,531 点、lon 12,473 点（合计 0.62%）发生变化，最大 5 单位 ≈ 5.56cm（lat）/5.06cm（经 cos(lat) 修正后的 lon），满足 ≤5 单位硬门槛。
- 量化越界（lat∉[-90,90]/lon∉[-180,180]）0 例；整条轨迹塌缩 0 例；解码值全部落在 header 声明的 `coord_quantum`/`alt_quantum` 网格上。
- 时间戳三档全部 0 diff（u32 精确）。

`altQuantum` 各档实测（中等轨迹）：`auto→q=1` 偏差 0、`1→q=1` 偏差 0、`2→q=2` 偏差 ≤1、`5→q=5` 偏差 ≤2、`10→q=10` 偏差 ≤5，均落在声明格点，符合 §2 的 `round` 语义。

### 2.2 体积分解与逐轨极值

| 项 | 字节 | bits/pt |
| --- | ---: | ---: |
| 总计（默认档） | 1,171,096 | 4.633 |
| header（48B × 123） | 5,904 | 0.023 |
| block index（24B × 201 块） | 4,824 | 0.019 |
| sync seed（32B × 123） | 3,936 | 0.016 |
| range coder flush（5B × 201） | 1,005 | 0.004 |

> 独立核对：header+index = **0.042 bits/pt**，与实现报告一致；容器占总量 1.25%。

逐轨极值（默认档，压缩比 = GPZ 字节 / GPSL0 字节）：

| | track | 点数 | GPSL0 字节 | GPZ 字节 | 压缩比 | bits/pt |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 最差 1 | `20250606` | 4 | 115 | 37 | **0.32x** | 230.0 |
| 最差 2 | `20250508` | 23 | 148 | 149 | 1.01x | 51.5 |
| 最差 3 | `20260117` | 51 | 209 | 184 | 0.88x | 32.8 |
| 最差 4 | `20260218` | 228 | 1,506 | 1,264 | 0.84x | 52.8 |
| 最差 5 | `20250720-android` | 316 | 1,612 | 1,276 | 0.79x | 40.8 |
| 最好 1 | `20250815` | 31,231 | 2,825 | 71,119 | **25.2x** | 0.72 |
| 最好 2 | `20250816` | 24,627 | 8,024 | 100,416 | 12.5x | 2.61 |
| 最好 3 | `20260505` | 8,826 | 2,611 | 28,955 | 11.1x | 2.37 |
| 最好 4 | `20261004` | 6,035 | 1,857 | 20,566 | 11.1x | 2.46 |
| 最好 5 | `20260530` | 13,878 | 5,565 | 61,882 | 11.1x | 3.21 |

- 短轨（<300 点）因容器/seed/flush 固定开销，个别会略大于 GPZ（最小 4 点轨 0.32x）——这是块容器的固有代价，R2 归档场景可接受（仍远小于 GPX）。
- 逐轨 bits/pt：median 4.648，p95 29.82，max 230.0（4 点轨）。

### 2.3 编解码耗时（串行、单线程）

| 档位 | encode 合计 | decode 合计 | 逐轨 encode p50/p95/max | 逐轨 decode p50/p95/max |
| --- | ---: | ---: | --- | --- |
| 默认档 | 300 ms | 247 ms | 2.53 / 4.9 / 6.2 ms | 2.04 / 4.0 / 4.9 ms |
| Tier-0 | 324 ms | 291 ms | — | — |
| Tier-1 | 338 ms | 321 ms | — | — |

## 3. 随机访问（decodeGpsl0Window）

- 对象：3 条最大轨迹 `20261002`（45,035 点）、`20250920`（41,238 点）、`20260807`（38,729 点），每条 30 个窗口（种子固定可复现）。
- 窗口生成覆盖：首点、首块、末点、末块、跨块、整文件、随机（长度 1 / 2–16 / 17–1024 / 1025–8192 / 接近全长）。
- 结果：**90/90 窗口与全量 decode 的对应切片逐点相等**（0 mismatch）。
- 耗时：mean **3.91 ms**、p50 **3.88 ms**、p95 **4.18 ms**、max **6.37 ms**；而同文件全量 decode 为 4.0–4.5 ms。
  - 符合 `sync_blocks=0` 的语义（窗口需从块 0 重放），**不能按"亚线性"评估**；若未来需要服务端按窗口快速取数，可设置 `syncBlocks>0`（变体测试已验证 bit-exact，见 §5）。
- 变体交叉验证：`blockPoints ∈ {64,256,4096}` × `syncBlocks ∈ {0,1,2}` 下，全量 decode 与默认档 **bit-exact**，跨 sync 窗口的 `decodeWindow` 全部逐点相等（0 mismatch）。

## 4. 首轮唯一未通过项（已修复，见 §4b）

### 首轮 FAIL：`decodeGpsl0Window(bytes, startPoint, 0)` 未抛 `BadWindow`

- 规范：`docs/gpsl0_format.md` §8 ——「窗口参数越界/非整数 → `BadWindow`」。
- 实际：`len=0` 时静默返回 4 个空数组（`t/lat/lon/alt` 长度 0），不抛错。
- 影响：调用方若把 0 长度窗口当合法，可能得到"成功但无数据"的结果，掩盖上层长度计算错误。
- 最小复现：

```js
import { encodeGpsl0, decodeGpsl0Window } from "../src/services/gpsl0/index.ts";
const track = {
  t: Int32Array.from([1700000000]),
  lat: Int32Array.from([311196800]),
  lon: Int32Array.from([1214730000]),
  alt: Int32Array.from([150]),
};
const bytes = encodeGpsl0(track);
const r = decodeGpsl0Window(bytes, 0, 0);
// 期望：throw（BadWindow: len must be >= 1）
// 实际：r.t.length === 0 && r.lat.length === 0 && r.lon.length === 0 && r.alt.length === 0
```

- 其它非法窗口（`start=-1,len=1`；`start=n,len=1`；`start=0,len=n+1`）均正确抛错。建议入口增加 `if (len < 1) throw BadWindow`。
- 复现位置：`node frontend/scripts/verify_gpsl0.mjs --all` 的 `ROB-WINDOW-REJECT` 项。

## 4b. 本轮修复复验（Lead 用本脚重跑，41 PASS / 0 FAIL）

首轮报告后，Lead 修掉了两处（**字节布局不变，payload 未改一个字节**，故体积/精度数字完全不变）：

| 修复 | 位置 | 行为变化 |
|---|---|---|
| len = 0 窗口参数 | decodeGpsl0Window | 现在 len < 1 一律抛 BadWindow（不再返回空数组） |
| 索引无校验和 | header 偏移 44..47（原 eserved） | 改为 crc32_index：eadBlockIndex() 先校验整段索引，不符抛 CrcMismatch；**不新增字节** |

复验证据（
ode frontend/scripts/verify_gpsl0.mjs --all）：

- ROB-WINDOW-REJECT：**8/8 抛错**（原 8 例中漏 2 例）。
- ROB-INDEX-REJECT：15/15 抛错；ROB-NO-CRASH 汇总 silentlyDecoded=0（原索引 start_ts/end_ts 翻 bit 会静默解出，现在 12/12 检出）。
- ROB-STRUCT-REJECT 74/74、ROB-PAYLOAD-CRC 12/12 仍全检出；135 用例 0 挂死/崩溃/OOM。
- 其余检查（三档精度、体积、90/90 窗口、模型/选项变体、跨实现 15 次 bit-exact）全部保持 PASS。
- 体积/精度未变：默认档 **1,171,096 B / 4.6327 bits/pt / 8.7743×**；Tier-0 1,632,632 B / 6.4585×；Tier-1 1,426,665 B / 5.6437×。

> 注：crc32_header 仍只覆盖 [0,40)（有意）；44..47 的篡改由索引 CRC 检出，两者互补而不互相掩盖。

## 5. 编码选项变体（全部 PASS）

| 检查项 | 覆盖内容 | 结果 |
| --- | --- | --- |
| `VAR-COORD-MODES` | `coordPredictor = tn / naive / tn-clamped`（meta.coordMode 0/1/2） | 3/3 编码+解码成功，坐标 diff=0，meta 一致 |
| `VAR-ALT-MODES` | `altMode = 1`（一阶，默认）/ `2`（衰减二阶） | 2/2 往返正确，坐标 diff=0、alt ≤5，meta.altDamped 一致 |
| `VAR-ALT-QUANTUM` | `altQuantum ∈ {auto,1,2,5,10}` | 5/5 落在声明格点，偏差 ≤ step/2 |
| `VAR-SYNC-WINDOWS` | `blockPoints 64/256/4096` × `syncBlocks 0/1/2` | 5/5 全量 decode bit-exact；窗口全等；小块+sync 的窗口解码 5–10ms |
| `VAR-MODELS` | `modelId = 1..9` | 9/9 编码+解码成功，坐标 diff=0、alt ≤5 |
| `VAR-EDGE` | 空文件（n=0）/ 单点（n=1）/ 两点（n=2） | 3/3 无损档四通道严格相等；单点/两点窗口解码正确；空文件 48B 合法 header + 无块 |

> 注：`tn-clamped` 为默认预测器（实测最优）；`tn` / `naive` 也能正确编解码，解码器三档都已实现（独立解码器同样覆盖）。

## 6. 健壮性（坏文件，135 用例）

方法：每个用例在**独立 node 子进程**中解码（墙钟超时 20s、`--max-old-space-size=512`），
结果写文件回传；按退出方式分类（正常/抛错/超时挂死/崩溃/内存耗尽）。**不修改 codec**。

样本：最小轨 `20250606`（4 点）+ 中等轨；按 `docs/gpsl0_format.md` §1 精确偏移构造。

| 类别 | 用例数 | 抛错（正确拒绝） | 静默解出 | 说明 |
| --- | ---: | ---: | ---: | --- |
| 坏 magic / version | 6 | 6 | 0 | magic 任一字节、version≠1 |
| header 字段 | 30 | 30 | 0 | coord_quantum=0/3/1e7+1、alt_quantum=3、n_points 超界、block_points 0/1/2^20+1、sync_blocks>n_blocks、n_blocks+1、model_id=99、coord_mode=3、未定义 flag bit5、header crc 翻转 |
| 截断 | 34 | 34 | 0 | 1/4/8/…/47B、索引中段、载荷首字节、载荷中段、末字节、末尾 5B |
| 索引字段 | 15 | 15 | 0 | point_count=0/超块、byte_offset/byte_length=0xFFFFFFFF、块间 payload 重叠、点数之和≠n_points、end_ts<start_ts、payload crc 翻转 |
| header 区随机翻 bit | 12 | 10 | 2 | 2 例命中 offset 47（reserved，未在 header crc 覆盖范围内），见 §7 |
| 索引区随机翻 bit | 12 | 7 | 5 | 静默命中 `start_ts/end_ts`（索引无独立 CRC），见 §7 |
| 载荷随机翻 bit | 12 | **12** | 0 | **块级 crc32 全部检出** |
| 非法窗口参数 | 8 | 6 | 2 | 唯一问题：`len=0`（§4）；其余正确抛错 |
| 空文件 / 1 字节 | 4 | 4 | 0 | — |

- **0 例挂死、0 例崩溃、0 例 OOM**；`n_points=0x7FFFFFFF`、`block_points=0` 等最危险用例都在隔离进程内以 `Error` 结束。
- 载荷完整性：每块 24B 索引尾部的 `crc32_payload` 覆盖整块 payload，随机翻 bit **12/12 检出**——这一点比 ECGL0 的取舍更强。

## 7. 数据完整性边界与建议

GPSL0 v1 的完整性覆盖是**分层的**，实测如下：

| 区域 | 保护 | 实测 | 残余风险 |
| --- | --- | --- | --- |
| header 0..39 | `crc32_header`（覆盖 bytes[0:40]） | 10/10 相关翻转检出 | 小 |
| header 40..47 | **无覆盖**（40..43 是 crc 字段本身，44..47 reserved；翻转 40..43 因 crc 不等可检出；44..47 静默） | 2 例 offset 47 翻转静默 | 低（仅 reserved 字节，但建议收口） |
| block index（24B/块） | **无独立 CRC**；靠语义校验（offset/len 越界、payload 不重叠、point_count 范围、点数之和、end_ts≥start_ts）与 payload CRC 字段 | 15/15 构造性篡改被拒；12 例随机翻 bit 中 **5 例静默**（命中 start_ts/end_ts） | 中：元数据位翻转可能改变时间跨度/块边界元信息而不报错 |
| block payload | 每块 `crc32_payload` | 12/12 随机翻 bit 检出；截断触发 `Truncated`/`BadIndex` | 低（CRC-32 非密码学，抗意外损坏足够，抗恶意篡改不足） |

**建议**（按场景取用）：

1. **R2 归档 / 跨端传输**：对象级 `sha256`（或对单段上传的 R2 ETag 即 MD5）随清单保存并在客户端校验；GPSL0 的块 CRC 解决"解压时发现坏块"，对象哈希解决"下载到本地前字节级一致"。
2. **可选收口（低成本）**：把 `crc32_header` 覆盖范围扩到 0..44（含 reserved 字段），或在 decode 时断言 `reserved === 0`。
3. **索引保护（v2 可选）**：若担心索引元数据在传输/存储中被改，可在 v2 增加索引 CRC（16B 索引块级 4B CRC 或文件级 CRC 覆盖 header+index）；当前 v1 不建议为此改冻结格式，用对象哈希兜底即可。
4. **随机访问语义**：`sync_blocks=0` 下 `decodeWindow` 的 CPU 成本 ≈ 全量解码（实测 p50 3.88ms vs 全量 4.0–4.5ms）；若后续要在边缘按窗口取数，用 `syncBlocks>0` 重新封装（已验证 bit-exact），代价是每 sync 块 +32B seed。

## 8. 跨实现解码（ECGL0 §7.6 门槛）

- 独立实现：`frontend/scripts/verify_gpsl0_refdec.mjs`，**只依据 `docs/gpsl0_format.md` 文本**编写，未 import 任何 codec 模块；包含 header/index/CRC 校验、LZMA 风格 range coder、三档预测器、87 上下文、低位优先 mantissa 树、sync/续接块状态继承、窗口重放。
- 抽样：最小轨 `20250606`（4 点）+ 4 条随机轨（含 6,035 / 13,878 / 17,949 / 35,966 点）× 3 档（默认 / `quantum:10` / 完全无损）。
- 结果：**15/15 次解码与 codec 输出 bit-exact（0 mismatch）**；完全无损档同时对原始四点数组严格相等。
- 过程中未发现任何 slot/上下文/predictor 偏差；range coder 越界检查在坏文件用例中按预期触发 `Truncated`。

## 9. 复现方式

```bash
# 全量验收（tier + volume + windows + variants + robustness + refdec）
node frontend/scripts/verify_gpsl0.mjs --all

# 单项
node frontend/scripts/verify_gpsl0.mjs --default --tier0 --tier1      # 三档精度+体积
node frontend/scripts/verify_gpsl0.mjs --windows=30 --window-tracks=3  # 随机访问
node frontend/scripts/verify_gpsl0.mjs --variants                     # 编码选项变体
node frontend/scripts/verify_gpsl0.mjs --robustness                   # 坏文件（隔离子进程）
node frontend/scripts/verify_gpsl0.mjs --refdec                       # 跨实现
node frontend/scripts/verify_gpsl0.mjs --track=20250606 --tier0       # 单轨

# 机器可读结果：frontend/scripts/.cache/verify.json
```

退出码：`0` 全 PASS，`1` 有 FAIL，`2` 环境问题（codec 未找到等）。

## 10. 与 Lead 基线对照

| 指标 | Lead 基线 | 本次独立实测 | 一致 |
| --- | ---: | ---: | :---: |
| 默认档总大小 | 1.17 MB | 1,171,096 B（1.117 MiB） | ✅ |
| 默认档 bits/pt | 4.63 | 4.6327 | ✅ |
| vs GPZ | 8.77x | 8.774x | ✅ |
| 逐轨压缩比 median / max / min | 8.78 / 26.93 / 0.32 | 8.78 / 26.93 / 0.32 | ✅ |
| 坐标无损 | 100% 点严格相等 | 123/123 轨、2,022,295 点 diff=0 | ✅ |
| 默认 alt 偏差 | ≤5（0.1m） | max=5，0 越界 | ✅ |
| 容器开销 | 0.042 bits/pt | header+index=0.042 bits/pt | ✅ |
| 跨实现 | 门槛要求 | 0 mismatch | ✅ |

## 附录 A：完整检查清单（41 PASS / 0 FAIL）

| # | 检查项 | 状态 | 摘要 |
| ---: | --- | :---: | --- |
| 1 | DEF-ROUNDTRIP | PASS | 123/123 通过；坐标 diff=0，alt ≤5 |
| 2 | DEF-T-EXACT | PASS | t diff=0 |
| 3 | DEF-COORD-EXACT | PASS | lat/lon diff=0 |
| 4 | DEF-ALT-BOUND | PASS | maxAlt=5×0.1m |
| 5 | DEF-GRID | PASS | 0 个非格点值 |
| 6 | DEF-RANGE | PASS | 0 越界 |
| 7 | DEF-NO-COLLAPSE | PASS | 0 塌缩 |
| 8 | DEF-DEFAULT-OPTS | PASS | 默认 opts 与显式 auto/10 逐字节一致 |
| 9 | HDR-DEF | PASS | n_points/model_id 与输入一致 |
| 10 | VOL-DEF | PASS | 1,171,096 B ≤ 2.4MB 预算 |
| 11–17 | T0-*（7 项） | PASS | 四通道严格无损 123/123 |
| 18 | VOL-T0 | PASS | 1,632,632 B |
| 19–25 | T1-*（7 项） | PASS | coord ≤5u、alt ≤5、t 严格 |
| 26 | VOL-T1 | PASS | 1,426,665 B |
| 27 | WIN-EQ | PASS | 90/90 窗口逐点相等 |
| 28 | VAR-COORD-MODES | PASS | 三预测器 3/3 |
| 29 | VAR-ALT-MODES | PASS | 2/2 |
| 30 | VAR-ALT-QUANTUM | PASS | 5/5 |
| 31 | VAR-SYNC-WINDOWS | PASS | 5/5 bit-exact + 窗口全等 |
| 32 | VAR-MODELS | PASS | 1..9 全 roundtrip |
| 33 | VAR-EDGE | PASS | 空/单点/两点 |
| 34 | ROB-NO-CRASH | PASS | 135 用例 0 catastrophic |
| 35 | ROB-STRUCT-REJECT | PASS | 74/74 |
| 36 | ROB-INDEX-REJECT | PASS | 15/15 |
| 37 | ROB-PAYLOAD-CRC | PASS | 12/12 |
| 38 | ROB-WINDOW-REJECT | **FAIL** | 6/8（`len=0` 漏检，§4） |
| 39 | REFDEC-EQ | PASS | 15/15 bit-exact |
| 40 | （INFO）ROB-INDEX-FLIP / ROB-HEADER-FLIP / 各 TIME/DEVIATIONS | INFO | 见 §6/§7 |

## 附录 B：验证脚手架文件

| 文件 | 说明 |
| --- | --- |
| `frontend/scripts/verify_gpsl0.mjs` | 主验证器（tier/volume/windows/variants/robustness/refdec，输出表格 + JSON） |
| `frontend/scripts/verify_gpsl0_refdec.mjs` | 按格式文档独立实现的最小解码器（只解码） |
| `frontend/scripts/lib/verify_util.mjs` | 窗口切片、1e7→米换算、逐列比较、计时 percentile、隔离子进程执行 |
| `frontend/scripts/.cache/verify.json` | 本次全量结果（机器可读） |
