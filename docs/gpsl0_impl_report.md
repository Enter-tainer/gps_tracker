# GPSL0 实现报告（v1，model_id = 7）

> 日期：2026-11-14 · 分支/工作树：`feat/gpsl0` @ `.worktrees/gpsl0`
> 设计文档：`docs/gpsl0_design.md` · 格式规范：`docs/gpsl0_format.md` · 验证报告：`docs/gpsl0_verification.md`
> 参考实现：`frontend/src/services/gpsl0/`（`container.ts` / `rangecoder.ts` / `model.ts` / `index.ts`）
>
> **一句话结论**：在全部 123 条真实轨迹（2,022,295 点）上，GPSL0 把 GPZ V2 的
> **10.28 MB 压到 1.17 MB（4.63 bits/pt，8.77×）**，且**经纬度逐点完全无损**（高程按 1 m 量化，
> 偏差 ≤0.5 m）。设计文档的 Tier-1 目标区间是 1.8–2.4 MB，实际比目标好 35–51%。

---

## 0. 交付物

| 文件 | 说明 |
|---|---|
| `frontend/src/services/gpsl0/container.ts` | 48 B 头 / 24 B 块索引 / CRC-32 |
| `frontend/src/services/gpsl0/rangecoder.ts` | 11-bit 概率、LZMA 风格二值 range coder |
| `frontend/src/services/gpsl0/model.ts` | 预测器（3 档）、上下文、zigzag+unary+低位树二值化、block 编解码 |
| `frontend/src/services/gpsl0/index.ts` | 公开 API（encode/decode/window/inspect + 量化推断） |
| `docs/gpsl0_format.md` | **规范级契约**（跨实现逐位一致） |
| `docs/gpsl0_impl_report.md` | 本文件：实测、消融、负结果 |
| `frontend/scripts/lib/dataset.mjs` | 基准数据加载（123 轨迹 GPZ → Int32 数组，带缓存） |
| `frontend/scripts/lib/metrics.mjs` | bits/pt、字节格式、表格、计时等公共度量 |
| `frontend/scripts/lib/entropy.mjs` | 经验熵、直方图、roundDiv 等熵分析工具 |
| `frontend/scripts/bench_gpsl0.mjs` | **主 bench**：全量编码/解码 + 逐轨表 + JSON |
| `frontend/scripts/ablation_codec.mjs` | 真实码流消融矩阵（模型/量化/块大小/同步/预测器） |
| `frontend/scripts/ablation_entropy.mjs` | 离线经验熵消融（预测器/上下文/幅度分布） |
| `frontend/scripts/bench_baseline.mjs` | Step-0 基线（GPZ ± gzip/brotli/zstd、裸流） |
| `frontend/scripts/selftest_gpsl0.mjs` | Lead 自测：range coder + 抽样 roundtrip + 窗口 |
| `frontend/scripts/verify_gpsl0.mjs` + `verify_gpsl0_refdec.mjs` | 独立验证 + 跨实现解码器（verifier 交付） |
| `frontend/scripts/pack_gpsl0.mjs` | 把本地语料打包成 `*.gpsl0` 对象 + `index.gpsl0.json`（含逐对象校验） |

一键复跑：

```powershell
cd C:\Users\mgt\Desktop\proj\gps_tracker\.worktrees\gpsl0
node frontend/scripts/selftest_gpsl0.mjs                      # ~1 s
node frontend/scripts/bench_gpsl0.mjs --verify --stats --json # ~2 s，全量 + 逐点校验
node frontend/scripts/ablation_codec.mjs --matrix=core        # 消融矩阵
node frontend/scripts/ablation_entropy.mjs                    # 离线熵（7.7 s）
node frontend/scripts/bench_baseline.mjs                      # Step-0 基线
node frontend/scripts/pack_gpsl0.mjs --verify                  # 产出真实 .gpsl0 对象
node frontend/scripts/verify_gpsl0.mjs --all                   # 独立验收（verifier）
```

---

## 1. 最终实测（冻结口径）

数据：`frontend/local-data/r2/tracks/*.gpz`，123 条轨迹，**2,022,295 点**（与 `local-data/index.json`
的 `stats.totalPoints` 及逐条 `point_count` 之和完全一致，无解码丢点）。

| 指标 | 值 |
|---|---|
| GPZ V2 合计（线上现状） | **10,275,509 B = 10.28 MB = 40.65 bits/pt** |
| **GPSL0 合计（默认参数）** | **1,171,096 B = 1.17 MB = 4.63 bits/pt** |
| 压缩倍数 | **8.77×** |
| 坐标是否无损 | **是**，123/123 轨 `lat/lon` 逐点严格相等（quantum=auto） |
| 高程偏差 | 默认 1 m 量化，0.1 m 单位下 ≤5（即 ≤0.5 m）；`altQuantum:1` 时也严格无损 |
| 编码耗时（全量 2M 点，Node 24 单线程） | **406 ms** |
| 解码耗时（全量） | **234 ms** |
| 逐轨倍数 | min 0.32×（4 点轨）· **median 8.78×** · max 26.93× |

通道分项（bits/pt，含自适应学习成本）：

| dt | lat | lon | alt | 容器（头+索引） | 合计 |
|---:|---:|---:|---:|---:|---:|
| 0.358 | 1.573 | 1.669 | 0.970 | 0.042 | **4.63** |

> 与设计文档 §1 的目标对照：Tier-1 目标「0.9–1.2 B/pt、1.8–2.4 MB」→ 实测 **0.58 B/pt、1.17 MB**，
> 优于目标下限 35%（面积）。Tier-0（完全无损 1e7）实测 1.68 MB（6.64 bits/pt，6.12×）。

---

## 2. 与基线的对照（Step-0）

per-object（= R2 线上口径，每条轨迹单独压）：

| 方案 | 总字节 | bits/pt | 相对 GPZ | 相对 GPSL0 |
|---|---:|---:|---:|---:|
| GPZ V2 原始 | 10,275,509 | 40.65 | 1.00× | — |
| GPZ + gzip -9 | 3,753,270 | 14.85 | 2.74× | 3.20× 差 |
| GPZ + brotli q11 | 3,290,367 | 13.02 | 3.12× | 2.81× 差 |
| GPZ + zstd -3 | 4,175,014 | 16.52 | 2.46× | 3.57× 差 |
| 裸 i32×4 交错（16 B/pt）+ brotli q11 | 8,276,762 | 32.74 | — | — |
| delta-i32 + gzip -9 | 3,697,093 | 14.63 | 2.78× | — |
| **GPSL0 v1（默认）** | **1,171,096** | **4.63** | **8.77×** | — |

- 最好的通用压缩（GPZ+brotli-11）也只能到 13.02 bits/pt，**GPSL0 仍是它的 2.81 倍**，
  「为什么不直接用 xz/brotli」这个质疑在本格式上不成立。
- 逐轨看，**GPSL0 赢过 GPZ+brotli 的比例是 123/123**（除 4 点极轨等小对象容器开销外，均大幅领先）。

---

## 3. 模型定型的依据（全部为真实码流实测）

所有"发哪个配置"的决定都由实际字节数给出（ECGL0 的教训：oracle 熵不能当目标）。
下表都是全量 123 轨、2,022,295 点的总 bits/pt。

### 3.1 精度/量化：**最大的单点收益不是预测器，而是"按数据自然格点量化"**

| 配置 | 总字节 | bits/pt | 倍数 | lat+lon |
|---|---:|---:|---:|---:|
| `quantum="auto"`（= gcd(全部经纬度)，默认） | **1.17 MB** | **4.633** | **8.77×** | 3.24 |
| `quantum=100`（显式 1.1 m，四舍五入） | 1.14 MB | 4.519 | 9.00× | 3.13 |
| `quantum=10`（显式 11 cm，四舍五入） | 1.43 MB | 5.644 | 7.20× | 4.25 |
| `quantum=1`（1e7 完全无损） | 1.68 MB | 6.639 | 6.12× | 5.25 |

注意 `quantum=100` 显式档比 auto 还小一点（4.52 vs 4.63）：显式档把 12 条 1e7 轨迹也四舍五入到
1.1 m（有损），而 auto 对它们保 1e7。**auto 的价值是"无损"，不是"最小"**。

**语料事实（决定了整个设计取向）**：111/123 条轨迹的**所有**经纬度都是 100 的倍数
（= GPZ **V1** 的 1e-5 deg / 1.11 m 格点），只有 12 条（36,881 点，1.82%）是真 1e7。
所以：

- `quantum="auto"` 对这 111 条取 quantum=100 → **编码的是 1/100 的动态范围，且完全无损**；
  对另外 12 条取 quantum=1 → 也无损。**"准无损"在这里实际等于"完全无损"。**
- 反过来，**强行量化到 1e6（11 cm）反而更差**（5.71 vs 4.63 bits/pt，+23%）：
  把 1.11 m 格点数据除以 10 会引入非格点噪声，破坏"残差落在格点上"的可预测性。
  **粗格点本身是信息，不是浪费。**

> ⚠️ 设计文档 §1 的「Tier-0 比 Tier-1 多 3.3 bits/轴热噪声」在本语料**完全不成立**：
> 真实代价只有 2.0 bits/pt（4.63→6.64），因为数据本来没有 1e7 精度。用未来 1e7 固件的
> 数据才能验证那句话；对**现有归档**，Tier-0 几乎免费。

### 3.2 预测器：三档实测，tn-clamped 略胜

| 预测器 | bits/pt | 倍数 | lat | lon |
|---|---:|---:|---:|---:|
| **tn-clamped（默认）** | **4.63** | **8.77×** | 1.573 | 1.669 |
| tn（时间归一化 d2） | 4.70 | 8.65× | 1.57 | 1.67 |
| naive d2 `2x[i-1]-x[i-2]` | 4.73 | 8.60× | 1.59 | 1.69 |
| d1（一阶差分） | 7.86（离线熵） | — | — | — |

- 三档差距很小（≤0.1 bits/pt），但 **d1 明显差**（离线 H0 7.86 vs 4.17）：二阶预测是必需的。
- 离线熵测算（`ablation_entropy.mjs`，1e6 档）曾得出 naive_d2 优于 tn 的结论（4.172 vs 4.356）；
  但在**真实自适应码流 + 自然格点量化**下 tn-clamped 反超。原因：dt 只有 8.6% 的点变化，
  其中多数是 1s↔2s 抖动，而无约束的比例外推在长空档（10–60 s）会过冲到极端值。
  **加一个 2× 上限（tn-clamped）后，两种情形都兼顾。** 这也再次印证"以真实码流为准"。

### 3.3 熵编码：mantissa 必须"低位先编 + 低位前缀树"

设计文档 §3.3 的 flat 逐位独立编码在**格点数据**上是主要浪费（offline 测算：H(e)=4.18 但
flat 表示=5.97 bits/pt，+1.79）。原因：zigzag 后 `u` 的 LSB 就是残差**符号**，而格点数据的
低几位基本由符号与格点结构确定（如 m=4 时 83% 的 u 是 19/20）。

**干净 A/B（同一 model，只换二值化，`m10` vs `m7`）**：

| 二值化 | N_SLOT | bs/pt（真实码流） |
|---|---:|---:|
| flat 逐位独立（`model_id=10`） | 48 | 4.687 |
| **低位优先 + 4 位树（`model_id=7`，发布）** | **59** | **4.673** |

- 在**本语料**（1e5 格点已被 `quantum=auto` 因子化）这一项只值 **−0.014 bits/pt**：格点已被除掉的
  情况下，mantissa 低位趋于均匀，树的收益自然回落。
- 但它是**未来真 1e7 数据**的必要条件：offline 测算在那类数据上 flat 表示损失是 **+1.79 bits/pt**
  （H(e)=4.18 vs flat 5.97），低位树能收回其中 ~82%。**高位先编实测零收益**。

### 3.4 上下文规模：**越细越差**（ECGL0 教训复现）

| 上下文方案 | N_CTX | bits/pt |
|---|---:|---:|
| 6 speed regime × 17 q1（无 dchg，`m5`） | 442 | 4.748 |
| 2 regime × 17 q1（无 dchg，`m3`） | 174 | 4.723 |
| 1 regime × 17 q1（无 dchg，`m6`） | 65 | 4.723 |
| **1 regime × 17 q1 × dt_changed（发布，`m7`）** | **87** | **4.673** |
| 2 regime × 17 q1 × dt_changed（`m8`） | 174 | 4.673（无增益） |
| + lon 条件化于本点 lat 残差（早前版本） | ~3,500 | 7.02（崩） |

**结论：唯一有效的上下文维度是 `dt_changed`（−0.05 bits/pt）；speed regime 零增益**
（1/2/6 档都是 4.673），因此发布档只留 87 个上下文。

离线 oracle 熵显示 `spd6×q1×dchg`（204 ctx）比 `q1`（17 ctx）低 0.4 bits/pt，**但自适应编码器
达不到**：每轨冷启动要重学概率表，细上下文的收益被学习成本吃光。实测最终定在 87 个上下文
（`dt 10 + lat 34 + lon 34 + alt 9`），**总概率表 87×59×2 B = 10.3 KB**（L1 常驻）。

### 3.5 块大小与同步点

| block_points | 容器开销 | bits/pt | 备注 |
|---:|---:|---:|---|
| 1024 | 0.217 | 4.86 | 索引税明显 |
| 4096 | 0.077 | 4.70 | |
| **16384（默认）** | **0.042** | **4.63** | |
| 32768 | 0.036 | 4.62 | 收益趋平 |

`syncBlocks > 0`（周期性重置概率表）在本口径下**只有负收益**（8 块一次：4.70 → 4.73），
因为一次重置就要重学 10 KB 概率表。默认 `syncBlocks = 0`：整文件一个 sync 窗口，
换取最好的压缩比；随机访问语义相应是"从头重放"（见 §4）。

### 3.6 高程通道：1 m 量化省 1.86 bits/pt

| alt 量化（`altQuantum`） | alt bits/pt | 总字节 | 倍数 |
|---|---:|---:|---:|
| 1（0.1 m，严格无损） | 2.80 | 1.63 MB | 6.29× |
| 5（0.2 m） | 1.37 | 1.27 MB | 8.08× |
| 2（0.5 m） | 2.09 | 1.45 MB | 7.07× |
| **10（1 m，默认）** | **0.97** | **1.17 MB** | **8.77×** |

（0.5 m 档反而比 0.2 m 差：0.1 m 整数除以 2 会把高程打散成奇偶两族，破坏残差可预测性。）

GNSS 垂直误差是米级，1 m 量化（≤0.5 m 偏差）远低于噪声底；要严格无损用 `altQuantum:1`。
高程预测器实测一阶差分（0.970）略优于衰减二阶（0.994）。

---

## 4. 随机访问

- 容器有 24 B/块的索引（`start_ts / end_ts / point_count / byte_offset / byte_len / crc32`），
  支持按时间戳二分定位到块。
- **算术编码的概率状态不能从块中间进入**：`syncBlocks = 0` 时随机访问粒度 = 整文件
  （`decodeGpsl0Window` 从块 0 重放后切片）。这是"压缩比优先"的显式取舍。
- 需要亚线性随机访问时把 `syncBlocks` 设成 8/32（代价 +0.04~0.07 bits/pt ≈ +1%），
  窗口粒度 = `syncBlocks × blockPoints` 点（默认 `8 × 16384 = 131,072` 点 ≈ 36 小时 1 Hz 轨迹）。
- 单块解码 = 解析 32 B seed + 解码该块残差，可用 `decodeGpsl0Window` 的块级路径外推实现。

---

## 5. 逐轨画像（谁贵、谁便宜）

**便宜的**（大轨迹、稳定采样、有真实运动）：

| 轨迹 | 点数 | GPZ | GPSL0 | bits/pt | 倍数 |
|---|---:|---:|---:|---:|---:|
| `20250815` | 31,231 | 76,080 | 2,825 | 0.72 | **26.9×** |
| `20250816` | 24,627 | 98,003 | 8,024 | 2.61 | 12.2× |
| `20261004` | 6,035 | 20,441 | 1,857 | 2.46 | 11.0× |
| `20260505` | 8,826 | 28,844 | 2,611 | 2.37 | 11.1× |

**贵的**（小对象 + 稀疏/不规则采样）：

| 轨迹 | 点数 | GPZ | GPSL0 | bits/pt | 倍数 | 原因 |
|---|---:|---:|---:|---:|---:|---|
| `20250606` | 4 | 37 | 115 | 230.0 | 0.32× | 容器开销（48 B 头）主导 |
| `20250508` | 23 | 146 | 148 | 51.5 | 0.99× | 同上 |
| `20260218` | 228 | 1,783 | 1,506 | 52.8 | 1.18× | 稀疏采样（10–60 s）+ 冷启动 |
| `20250720-android` | 316 | 2,039 | 1,612 | 40.8 | 1.26× | android 日志，~10–13 s 采样 |
| `20250628-android` | 559 | 3,532 | 2,503 | 35.8 | 1.41× | 同上 |

- 17 条 <1000 点的轨迹合计只有 7,287 点、20.7 KB，**只占总字节 1.8%**。
- 稀疏时间戳轨是真正的相对劣势（d2 在 10 s 以上采样几乎无意义），但**绝对量很小**。
  若要进一步优化：按文件选预测器（已支持 `coordPredictor`）或对小文件跳过容器开销。
- 最差 8 条中 5 条是 android 导出轨——**它们的 GPZ 本身也很膨胀**（40–70 bits/pt），
  说明源数据噪声大，不是格式问题。

---

## 6. 负结果（别重走）

1. **不要用时间归一化外推当默认**：无约束的比例外推在长空档过冲；加 2× clamp 后才有正收益。
2. **不要把 1e5 格点数据量化到 1e6**：+23% 体积（4.63 → 5.71 bits/pt）。格点是信息。
3. **不要加细上下文**：6 speed regime（442 ctx）比 87 ctx 差 0.03 bits/pt；
   lon 条件化于 lat 残差（~3,500 ctx）直接把压缩比打崩（7.02 bits/pt）。
   根因是每轨冷启动，不是建模能力不够。
4. **不要周期性重置概率表**（`syncBlocks > 0`），除非确实要用随机访问：每次重置都重学 10 KB 表。
5. **不要用 flat 逐位独立编 mantissa**：格点数据上多花 1.79 bits/pt 的表示损失。
6. **不要用 oracle 熵绝对值预测最终体积**：离线最优 4.364 bits/pt，实测 4.63（92% 达成）；
   但方向性结论（d1 差、naive 好过 tn）在加入真实量化/自适应后**可能反转**，必须用码流验证。

---

## 7. 已知边界与后续工作

- **载荷完整性**：块 payload 有 CRC-32（24 B/块，已计入开销），但**块索引本身没有独立校验和**；
  索引字段被篡改时靠越界/求和一致性检查拒绝（见格式规范 §8）。跨对象完整性建议仍用
  R2 ETag / sha256 兜底。
- **随机访问**当前是"整文件重放"语义；若前端要做"只拉一天"的局部解码，需开启
  `syncBlocks` 或实现块级起始状态外推（需要把概率表初始态也落盘，属于 v2 范畴）。
- **多轨迹"合包"是个陷阱**：把 123 条轨迹直接拼成一个 2,022,295 点的大文件实测 **6.23 bits/pt
  （1.58 MB）**，比逐轨 4.63 差 35%——因为轨迹之间的时间和位置都不连续，预测器在每个接缝
  都会产生巨大残差。设计文档 §4 的 `all-tracks.gpsl0` 若要做，**必须按轨迹分段并各自 reset
  预测器状态**（等价于现在的"一文件一轨迹"），只是把多个段装进一个容器省 HTTP 请求数。
  因此"逐对象容器开销"确实很小（48 B 头 + 24 B/块），不值得为压缩而合包。
- **未来 1e7 固件数据**：Tier-0（`quantum=1`）实测 6.64 bits/pt / 1.68 MB，仍是 GPZ 的 1.9× 以上；
  低位树在真 1e7 数据上的收益会比本语料更明显。
- **WASM/Rust 移植**：所有运算都是 32/53 位整数，无浮点（除 bench 统计），
  `PROB_BITS=11 / MOVE_BITS=5 / TOP=1<<24` 常量与参考实现一致即可逐位对齐。

---

## 8. 落地与接入建议

### 8.1 已经能产出的真实对象

```powershell
cd frontend
npm run gpsl0:pack          # = node scripts/pack_gpsl0.mjs --verify
```

把 `local-data/r2/tracks/*.gpz` 全量转成 `local-data/r2/tracks-gpsl0/<id>.gpsl0`，
并写 `index.gpsl0.json`（每对象字节、bits/pt、倍数、codec 指纹），实测：

```
packed 123 tracks | GPZ 10.28 MB -> GPSL0 1.17 MB (4.63 b/pt, 8.77x) in 626 ms
verify: PASS (123/123, coords exact, alt<=5)
largest objects: 20250829=22.14 kB, 20260807=21.37 kB, 20260926=20.57 kB
```

最大的单对象只有 **22 kB**（GPZ 同类是 184 kB），对 R2/HTTP 都更友好。

### 8.2 接入前端的最小改动

1. **上传侧**：在 `scripts/sync_cloudflare.mjs` 的 tracks 循环里，把 `.gpz` 换成
   `encodeGpsl0(track)` 的产物，key 用 `tracks/<id>.gpsl0` + 一份 `index.json` 记录
   `{id, bytes, pointCount, startTs, endTs, quantum}`（体积降 8.8×，上传带宽同比下降）。
2. **下载侧**：优先请求 `/api/tracks/<id>.gpsl0`，`decodeGpsl0()` 返回的四条 Int32Array
   与现有 `GpsPoint[]` 形状一一对应（`decodeGpsl0ToPoints()` 直接给 `GpsPoint[]`），
   `gpsCodec.ts` 的调用点只需增加"按 Content-Type / 文件后缀分流"。
3. **回退**：老对象仍在桶里，`.gpz` 分支保留即可平滑灰度；两种格式不能互相解码，
   靠对象后缀区分，不需要版本协商。
4. **随机访问**：如果只想拉某一天/某段，可用索引里的 `start_ts/end_ts` 找到块，
   但 `syncBlocks = 0` 时必须从文件头重放（见 §4）；要真正省带宽，应按日切片存储，
   或在 v2 里把概率表初始态也落盘。

### 8.3 不建议做的事

- 不要把 123 条轨迹拼成一个 `all-tracks.gpsl0` 来"省请求"：跨轨不连续，实测 4.63 → 6.23 bits/pt（+35%）。
- 不要为了"更好压缩"去量化到 1e6：本语料会变差 22%（见 §3.1）。
- 不要在没有 `syncBlocks` 的情况下承诺"按块随机读"：那需要概率状态持久化，属于 v2。

---

## 9. 团队分工与产出

| 成员 | 作用域 | 产出 |
|---|---|---|
| **lead** | `frontend/src/services/gpsl0/**`、`docs/gpsl0_format.md`、`docs/gpsl0_impl_report.md`、`bench_gpsl0.mjs`、`ablation_codec.mjs`、`selftest_gpsl0.mjs`、`lib/dataset.mjs` | 容器/range coder/模型/API、格式契约、主 bench、消融矩阵、本报告 |
| **entropy-lab** | `ablation_entropy.mjs`、`lib/entropy.mjs` | 预测器/上下文/幅度分布的经验熵消融；发现 **1e5 格点语料事实**（直接决定 quantum=auto 与 2 bits/pt 收益）、flat mantissa 的 1.79 bits/pt 表示损失、m 分布与 escape 阈值、冷启动税 0.175 bits/pt |
| **baseline-bench** | `bench_baseline.mjs`、`lib/metrics.mjs`、`.cache/baseline.*` | Step-0 基线矩阵（GPZ±gzip/brotli/zstd、裸流、concat 口径）、数据 QC（点数与 index.json 完全一致）、公共度量库 |
| **verifier** | `verify_gpsl0.mjs`、`verify_gpsl0_refdec.mjs`、`lib/verify_util.mjs`、`docs/gpsl0_verification.md` | 全量 roundtrip / 误差界 / 随机访问 / 健壮性 / 跨实现解码（详见证报告） |

**关键交叉验证**：entropy-lab 的离线熵给出下界 4.364 bits/pt（1.05 MB），实测 4.63 bits/pt（1.17 MB）
→ 达成率 **92%**；baseline-bench 证明最好的通用压缩（13.02 bits/pt）仍差 2.8×；
verifier 独立实现（不复用 codec 代码）验证了契约的可实现性。
