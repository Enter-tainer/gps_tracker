# GPSL0 格式规范 v1（model_id = 7，**冻结版**）

> **状态**：v1 冻结（2026-11-14）。本文件是编解码器的**规范级契约**：跨实现（JS / Rust / Python）
> 必须逐位一致，任何偏差都视为 bug。设计动机见 `docs/gpsl0_design.md`，实测与消融见
> `docs/gpsl0_impl_report.md`。
>
> **v3 升级说明（2026-11-27）**：面向更高压缩率、紧凑容器与 Rust/WASM/`#![no_std]` 统一实现的 **GPSL0 v3**
> （`version = 2`, `model_id = 22`）已在 [`docs/gpsl0_v3_format.md`](./gpsl0_v3_format.md)
> 冻结发布（实测与消融见 [`docs/gpsl0_v3_report.md`](./gpsl0_v3_report.md)）。
> 编解码器已全量切换写入 v3，并保留向后兼容解码 v1 全系（`model_id = 1..10`）码流；下方 v1 冻结契约正文保持不变。
>
> 参考实现：`frontend/src/services/gpsl0/`（`container.ts` 容器、`rangecoder.ts` 算术编码、
> `model.ts` 预测器/上下文/二值化、`index.ts` 公开 API）。
>
> **v1 相对设计文档（gpsl0_design.md）的四处实质偏离，均为实测决定**：
> 1. 预测器用 **naive_d2**（`2x[i-1]-x[i-2]`），不用时间归一化外推 —— 后者实测差 0.037 bits/pt；
> 2. 量化用**数据自然格点**（`quantum="auto"` = 全部经纬度的 gcd）：本语料 111/123 轨是 1e5 格点
>    （1.11 m），对它**完全无损**，且比硬取 1e6 少 ~2 bits/pt；
> 3. mantissa 改为**低位优先前缀树**（bit0 = 符号先编），flat 逐位独立实测多花 1.79 bits/pt；
> 4. 上下文只留 **87 个**（1 个 speed regime × 17 个 q1 桶 × dt_changed 2 档 + dt/alt 各一套），
>    更细的上下文实测**越细越差**（冷启动成本反噬）。

---

## 0. 目标与精度政策

- GPSL0 面向浏览器 / 桌面端 / Cloudflare R2 归档：残差 + 运动学上下文 + 二值 range coder + 块索引
  随机访问。**不面向 MCU**（那是 GPZ V2 的职责）。
- **坐标默认完全无损**：`quantum = gcd(所有 lat, lon)`，即"能表示这些点的最粗格点"。
  - 本语料 111/123 轨的自然格点是 100（1e-5 deg ≈ 1.11 m）→ 1.11 m 网格上**逐点严格相等**；
  - 12 轨是真 1e7 数据 → quantum = 1，也严格相等。
- **高程默认 1 m 格点**（`altQuantum = 10`，即 0.1 m 单位的 10 倍）：GNSS 垂直误差是米级，
  1 m 量化远低于噪声底，且省 1.8 bits/pt。要严格无损用 `altQuantum: 1` 或 `"auto"`。
- 时间戳**永远精确无损**。
- 解码输出统一回 GPZ 单位：经纬度 `1e-7 deg`（Int32），高程 `0.1 m`（Int32）。

---

## 1. 容器布局（小端）

```
+--------------------------------------------------------------------+
| HEADER 48 B                                                        |
+--------------------------------------------------------------------+
| BLOCK INDEX  n_blocks * 24 B                                       |
+--------------------------------------------------------------------+
| BLOCK PAYLOADS[0..n_blocks-1]（变长，sync 块以 32 B seed 开头）      |
+--------------------------------------------------------------------+
```

### 1.1 HEADER（48 B）

| off | 类型 | 字段 | 说明 |
|---:|---|---|---|
| 0 | u8[8] | `magic` | `"GPSL0\0\0\0"` |
| 8 | u16 | `version` | = 1 |
| 10 | u16 | `flags` | bit0 `tier0`；bit1 `has_alt`；bit2 `alt_damped`；bit3..4 `coord_mode`（0=tn、1=naive、2=tn-clamped）；其余位必须 0 |
| 12 | u32 | `coord_quantum` | 存储单位等于多少 1e-7 deg；必须 ≥1、≤1e7 且整除 1e7 |
| 16 | u32 | `alt_quantum` | 存储单位等于多少 0.1 m；必须 ∈ {1,2,5,10} |
| 20 | u32 | `n_points` | 总点数（≤ 2^30） |
| 24 | u32 | `block_points` | 块大小（默认 **16384**，范围 2..2^20） |
| 28 | u32 | `sync_blocks` | 每 N 块重置概率表并写新 seed；`0` = 整文件一个 sync 窗口 |
| 32 | u32 | `n_blocks` | 块数 = `ceil(n_points / block_points)`，空文件为 0 |
| 36 | u32 | `model_id` | = 7；**不认识必须报错**，不得"尽力解" |
| 40 | u32 | `crc32_header` | `crc32(bytes[0:40])`，不覆盖自身 |
| 44 | u32 | `crc32_index` | `crc32(bytes[48 : 48 + n_blocks*24])`，索引区校验和（测出索引被篡改） |

`flags.bit0 (tier0)`：`coord_quantum == 1` 时为 1（纯信息标志，解码不依赖）。
`flags.bit2 (alt_damped)`：1 = 高程用衰减二阶预测，0 = 一阶差分。
`flags.bit3..4 (coord_mode)`：0 = 时间归一化 d2，1 = naive d2，2 = **tn-clamped**（默认，编码器实测最优）。

### 1.2 BLOCK INDEX（每块 24 B）

| 偏移 | 类型 | 字段 |
|---:|---|---|
| 0 | u32 | `start_ts`（该块首点时间戳，解码后的值） |
| 4 | u32 | `end_ts`（该块末点时间戳） |
| 8 | u32 | `point_count`（1..block_points；各块之和必须等于 `n_points`） |
| 12 | u32 | `byte_offset`（payload 绝对文件偏移） |
| 16 | u32 | `byte_length`（payload 长度） |
| 20 | u32 | `crc32_payload`（该块 payload 全部字节的 CRC-32/IEEE） |

> 整段索引另有一个 CRC-32，存于 header 偏移 44（`crc32_index`）。因此索引里 `start_ts/end_ts`
> 被翻转也会被检出，而不是只靠"越界/求和"这类结构性检查。

### 1.3 BLOCK PAYLOAD

```
[ seed 32 B ]？      // 仅 sync 块
range-coded stream   // 以 shift_low flush 的 5 字节收尾
```

`seed`（i32 LE × 8，**均为 §2 量化后的整数**）：

| off | 字段 | 含义 |
|---:|---|---|
| 0 | `t0` | 首点时间戳（unix 秒） |
| 4 | `lat0` | 首点纬度（quantum 单位） |
| 8 | `lon0` | 首点经度 |
| 12 | `alt0` | 首点高程（alt_quantum 单位） |
| 16 | `dt0` | `t1 - t0` |
| 20 | `vlat0` | `lat1 - lat0` |
| 24 | `vlon0` | `lon1 - lon0` |
| 28 | `valt0` | `alt1 - alt0` |

`point_count == 1` 时后 6 个字段写 0，解码器忽略。

### 1.4 Sync 窗口语义

- **sync 块**：`b == 0`，或 `sync_blocks > 0` 且 `b % sync_blocks == 0`。
  - payload 以 32 B seed 开头；概率表重置为中性 1024；残差上下文记忆（`e*Prev`）清零；
  - 编码从块内第 **2** 个点开始（前两点由 seed 给出）。
- **续接块**：payload 无 seed；概率表与**全部预测器状态继承上一块**；块内每个点都编码。
- 随机访问粒度 = sync 窗口；`sync_blocks = 0` 时 = 整文件（`decodeWindow` 从块 0 重放）。
- 编码器若 `sync_blocks > n_blocks` 则钳到 `n_blocks`。

---

## 2. 量化

```
coordQuantum = (quantum == "auto") ? gcd(所有 lat 值, 所有 lon 值) : quantum      // 1..1e7, 整除 1e7
altQuantum   = (altQuantum == "auto") ? gcd(所有 alt 值, 10) : altQuantum         // ∈ {1,2,5,10}

latQ[i] = auto ? lat_1e7[i] / coordQuantum : round(lat_1e7[i] / coordQuantum)  // auto 必须整除（否则报错）；显式档位四舍五入（有损）
lonQ[i] = lon_1e7[i] / coordQuantum
altQ[i] = auto ? alt_1e1[i] / altQuantum : round(alt_1e1[i] / altQuantum)   // alt 默认 quantum=10（1m）
tQ[i]   = t[i]                                                   // u32 精确

解码：lat_out = latQ * coordQuantum;  lon_out = lonQ * coordQuantum;  alt_out = altQ * altQuantum
```

`round` 为四舍五入到最近整数（.5 向上，JS `Math.round` 语义）。
显式指定 `quantum`/`altQuantum`（非 auto）时同样要求整除，否则编码器报错（不静默降级）。

---

## 3. 预测器（全部纯整数）

块内第 `i` 点（sync 块从 `i ≥ 2` 起；续接块每个点）：

### 3.1 时间通道

```
dt[i]   = t[i] - t[i-1]
e_dt[i] = dt[i] - dt[i-1]
```

### 3.2 经纬度（三档，由 `coord_mode` 选）

```
d0 = dt[i-1], d1 = dt[i]

mode 1（naive d2）:       pred = 2*x[i-1] - x[i-2]
mode 0（tn）:             pred = d0 > 0 && d1 > 0 ? x[i-1] + roundDiv((x[i-1]-x[i-2])*d1, d0) : x[i-1]
mode 2（tn-clamped，默认）: 同 tn，但 d1 换成 min(d1, 2*d0)   // 长空档不按比例外推

roundDiv(a,b)（b>0）= a>=0 ? trunc((a + (b>>1))/b) : -trunc((-a + (b>>1))/b)
e_x[i] = x[i] - pred
```
经度同式。三档必须都实现（v1 编码器只写 mode 2）。

### 3.3 高程

- `altMode = 1`（`flags.bit2 = 0`，默认）：`pred = alt[i-1]`
- `altMode = 2`（`flags.bit2 = 1`）：`pred = alt[i-1] + ((alt[i-1] - alt[i-2]) >> 1)`（算术右移）

`e_alt[i] = alt[i] - pred`。

---

## 4. 上下文（87 个，全部只用已解码状态）

```
q1(e, levels=8):        // 17 个有符号桶
    e == 0 -> 0
    a = |e|; b = min(7, floor(log2 a))
    -> 1 + 2*b + (e < 0 ? 1 : 0)          // 1..16

altQ(e) = q1(e, 4)                        // 9 个有符号桶

dtBucket(dt):
    dt <= 0 -> 0;  dt == 1 -> 1;  dt == 2 -> 2;  3..5 -> 3;  其余 -> 4

下表 v1 模型用 1 个 speed regime（不切分），speedRegime 常数保留但 v1 不使用：
speedRegime(vlat, vlon, dtPrev, thresholds) =
    mmps = floor((|vlat| + |vlon|) * 111 / max(1, dtPrev))
    返回第一个 mmps < thresholds[k] 的 k，否则 thresholds.length
```

上下文索引（`base = ctx * N_SLOT`）：

```
ctxDt  = 0  + dtBucket(dtPrev) * 2 + (eDtPrev != 0 ? 1 : 0)              // 0..9
ctxLat = 10 + (0 * 17 + q1(eLatPrev)) * 2 + (eDt != 0 ? 1 : 0)           // 10..43
ctxLon = 44 + (0 * 17 + q1(eLonPrev)) * 2 + (eDt != 0 ? 1 : 0)           // 44..77
ctxAlt = 78 + q1(eAltPrev, 4)                                            // 78..86
N_CTX  = 87
```

`eXPrev` 是**同通道上一个已编码残差**；sync 块起点全部为 0。
`eDt` 是本点刚解出的时间残差（用于坐标上下文的 `dchg` 维）。
（通用式：`ctxLat = latCtx0 + (speed * nQ1 + q1(eLatPrev)) * dchgCount + dchg`，
v1 的 `speed` 恒 0、`dchgCount = 2`；`lonUsesLatResidual = false`。）

**数值断言（实现必须自检）**：`q1(0)=0, q1(1)=1, q1(-1)=2, q1(2)=3, q1(3)=3, q1(4)=5, q1(7)=5,
q1(8)=7, q1(-8)=8, q1(127)=15, q1(128)=15, q1(-129)=16`；`altQ(0)=0, altQ(1)=1, altQ(-1)=2,
altQ(2)=3, altQ(4)=5, altQ(16)=7`；`dtBucket(0)=0, dtBucket(1)=1, dtBucket(2)=2, dtBucket(4)=3,
dtBucket(9)=4, dtBucket(-1)=0`。

---

## 5. 熵编码

### 5.1 概率表

- `N_CTX = 87`、`N_SLOT = 59`、`probs: u16[87 * 59]`，单位 `P(bit=0) × 2048`。
- 每个 sync 块初始化全部为 `1024`；块间 warm start（继承）。
- 常量：`PROB_BITS = 11`、`PROB_SCALE = 2048`、`PROB_INIT = 1024`、`MOVE_BITS = 5`、`TOP = 1 << 24`。
- 更新：`bit=0` → `p += (2048 - p) >> 5`；`bit=1` → `p -= p >> 5`。

槽位布局（`N_SLOT = 1 + 24 + 15 + 19 = 59`）：

| 槽 | 用途 |
|---|---|
| 0 | zero 标志 |
| 1..24 | unary 阶数 `t = 0..23`（`m` 个 1 然后 1 个 0；`m = 24` 即 escape） |
| 25 + (2^k - 1) + prefix | 低位树，`k = 0..3`（`mantTreeBits = 4`），共 15 个节点 |
| 40 + (k - 4) | 高位 flat 槽，`k = 4..m-1`，共 19 个 |

即 `treeBase = 25`、`treeNodes = 15`、`flatBase = 40`。

### 5.2 残差二值化（zigzag + unary 阶数 + **低位优先** mantissa）

```
u = zigzag(e) = e >= 0 ? 2*e : -2*e - 1            // u32
编码 bit(槽 ctx*59 + 0) = (u != 0)；u == 0 结束。
m = floor(log2 u) = 31 - clz32(u)
若 m >= 24（escape）：槽 1..24 全写 1（24 个 1，无终止 0），再写 u 的 32 个直接位（MSB→LSB）。
否则：
    槽 1..m 写 1；槽 1+m 写 0。
    for k = 0 .. m-1:                     // **低位先编**，k=0 是 LSB（zigzag 后 LSB = 符号位）
        bit = (u >> k) & 1
        若 k < 4:  槽 25 + (2^k - 1) + (u & ((1 << k) - 1))   // 低位树节点由已编的低 k 位选定
        否则:      槽 40 + (k - 4)                            // 高位 flat 自适应
```

解码严格镜像：读槽 0；读 unary 得 `m`（24 个连续 1 ⇒ escape ⇒ 读 32 直接位）；
`u = 0`，再 `for k = 0..m-1` 按上述槽解出 `bit` 并 `u |= bit << k`；最后 `u |= 1 << m`；
`e = unzigzag(u) = (u >> 1) ^ -(u & 1)`。

> 关键点：**必须低位先编**。高位先编实测零收益——格点数据的 mantissa 低位强相关
> （如 `u` 的低位基本由符号＋格点结构决定），flat 逐位独立要多花 1.79 bits/pt。

### 5.3 Range Coder（LZMA 风格，规范级）

```
常量：PROB_BITS=11, TOP=1<<24, low/range 均为 32 位无符号，carry 由 33 位再生。

Encoder:
  low = 0; range = 0xFFFFFFFF; cache = 0; cacheSize = 1; out = []

  shiftLow():
      low32 = low mod 2^32; carry = floor(low / 2^32)          // carry ∈ {0,1}
      if (low32 < 0xFF000000 || carry != 0):
          temp = cache
          do { out.push((temp + carry) & 0xFF); temp = 0xFF } while (--cacheSize != 0)
          cache = (low32 >> 24) & 0xFF
      cacheSize++
      low = (low32 << 8) mod 2^32

  encodeBit(probs, idx, bit):
      p = probs[idx];  bound = (range >> 11) * p
      bit == 0: range = bound;                       probs[idx] = p + ((2048 - p) >> 5)
      bit == 1: low += bound; range = range - bound;  probs[idx] = p - (p >> 5)
      while (range < (1<<24)): shiftLow(); range = (range << 8) mod 2^32

  encodeDirect(bit):
      range >>= 1;  if (bit) low += range
      while (range < (1<<24)): shiftLow(); range = (range << 8) mod 2^32

  finish(): shiftLow() 调用 5 次

Decoder:
  读 5 字节，跳过第 1 字节（恒 0x00），code = 后 4 字节（大端拼接）；range = 0xFFFFFFFF
  decodeBit: p = probs[idx]; bound = (range >> 11) * p
      code < bound:  range = bound; p += (2048-p)>>5; bit = 0
      else:          code -= bound; range -= bound; p -= p>>5; bit = 1
      while (range < (1<<24)): code = ((code<<8) | nextByte()) mod 2^32; range = (range<<8) mod 2^32
  decodeDirect: range >>= 1; bit = code >= range; if (bit) code -= range
      while (range < (1<<24)): code = ((code<<8) | nextByte()) mod 2^32; range = (range<<8) mod 2^32
```

`nextByte()` 越过块 payload 末尾 ⇒ 抛 `Truncated`（不得静默补 0）。
`probs` 索引越界 ⇒ 抛错（v1 实现会先检查，防止 NaN 概率导致 range 归零/死循环）。

---

## 6. 每点编码顺序

对每个待编码点 `i`，严格按 `dt → lat → lon → alt`；每解出一个通道**立即更新状态**，
供后续通道（`dchg` 用本点 `eDt`、`q1` 用上一拍残差）与下一点使用。状态更新：

```
tPrev2 = tPrev;  tPrev = tCur;  dtPrev = dtCur
latPrev2 = latPrev;  latPrev = latCur        // 同理 lon / alt
eDtPrev = eDt;  eLatPrev = eLat;  eLonPrev = eLon;  eAltPrev = eAlt
```

---

## 7. 固定常量（model_id = 7，改动必须 bump model_id）

| 常量 | 值 |
|---|---|
| `UNARY_SLOTS` | 24 |
| `MANT_TREE_BITS` | 4（树节点 15） |
| `TREE_SLOT0` / `FLAT_SLOT0` | 25 / 40 |
| `N_SLOT` | 59 |
| `N_CTX` | 87 |
| `N_Q1` / `N_ALTQ` / `N_SPEED` / `DT_LEVELS` | 17 / 9 / 1 / 5 |
| `PROB_BITS` / `MOVE_BITS` / `TOP` | 11 / 5 / 1<<24 |

`model_id` 表（编码器默认 7；解码器必须支持列出的全部）：

| id | 说明 |
|---|---|
| 1 | flat mantissa、6 speed regime（消融对照，**有编码路径**） |
| 2..6, 8, 9 | 消融变体（tree3/tree5/6spd/1spd…），仅用于复现消融矩阵 |
| **7** | **发布档**：tree4 + 1 speed regime + dt_changed 维 |
| 其它 | `UnsupportedModel(id)` |

---

## 8. 错误语义（解码器必须抛错，不得崩溃/静默解出）

| 条件 | 错误 |
|---|---|
| 长度 < 48、magic 不符、version ≠ 1 | `BadMagic` / `UnsupportedVersion` |
| flags 有未定义位 | `Corrupt(header)` |
| `coord_quantum` 非 1..1e7 或不能整除 1e7；`alt_quantum` ∉ {1,2,5,10} | `Corrupt(header)` |
| `crc32_header` 不符 | `CrcMismatch` |
| `block_points` 为 0 或 > 2^20；`n_blocks` 过大；`sync_blocks > n_blocks` | `BadIndex` |
| 索引越界；`point_count` 为 0 或 > block_points；各块点数之和 ≠ `n_points`；`end_ts < start_ts` | `BadIndex` |
| `model_id` 不认识 | `UnsupportedModel(id)` |
| 块 `crc32_payload` 不符 | `CrcMismatch` |
| payload 短于 seed+5（sync）或 5（续接）；range coder 读越界 | `Truncated` |
| 窗口参数越界/非整数/**`len < 1`** | `BadWindow`（`len = 0` 也抛错，不返回空数组） |
| 索引区 `crc32_index` 不符 | `CrcMismatch`（v1 起索引也有校验和） |

---

## 9. API（参考实现）

```ts
encodeGpsl0(track: { t, lat, lon, alt }, opts?: {
  quantum?: "auto" | number,     // 默认 "auto"（= 数据自然格点，坐标完全无损）
  altQuantum?: "auto" | 1|2|5|10,// 默认 10（1 m，有损 ≤0.5 m）
  blockPoints?: number,          // 默认 16384
  syncBlocks?: number,           // 默认 0（整文件一个窗口）
  altMode?: 1 | 2,               // 默认 1（一阶差分）
  coordPredictor?: "naive"|"tn"|"tn-clamped", // 默认 "tn-clamped"
  modelId?: number,              // 默认 7
  stats?: boolean,               // 只用于 bench：累计各通道自信息
}): Uint8Array

decodeGpsl0(bytes): { t, lat, lon, alt, meta }        // 回 GPZ 单位：lat/lon ×1e-7 deg、alt ×0.1 m
decodeGpsl0Window(bytes, startPoint, len): 同上（切片）
inspectGpsl0Header(bytes): meta
encodeGpsl0Points(GpsPoint[]) / decodeGpsl0ToPoints(bytes)   // 便利封装
```

`meta` 关键字段：`coordQuantum`、`altQuantum`、`precisionDeg = coordQuantum/1e7`、`indexCrc32`、
`blockIndex[]`（含每块 crc32）、`byteLength`、`modelId`、`nBlocks`。

---

## 10. 参考数值例子（跨实现对齐用）

1. 量化：`lat_1e7 = 311196800`（31.11968）, `coordQuantum = 100` ⇒ `latQ = 3111968`，解码回 `311196800`。
2. `q1`：`0→0, 1→1, -1→2, 2→3, 3→3, 4→5, 7→5, 8→7, -8→8, 128→15, -129→16`。
3. `zigzag`：`0→0, -1→1, 1→2, -2→3, 2→4`；`unzigzag(3) = -2`。
4. 二值化：`e = -10` ⇒ `u = 19` ⇒ `m = 4`；槽序列 = 槽0=1、槽1..4=1、槽5=0，
   然后 mantissa 低位在先：k=0 bit=1（槽 25+0+0=25）、k=1 bit=1（槽 26+1=27）、
   k=2 bit=0（槽 29+3=32）、k=3 bit=0（槽 33+3=36）。
   （核对：`u = 0b10011 = 19`，低 4 位从 LSB 起是 1,1,0,0 ✓）
5. `speedRegime(0,0,0)=0`（v1 不用于 ctx，仅保证函数语义）。
6. 空文件（`n_points = 0`）：header 合法 + `n_blocks = 0` + 无索引、无 payload；解码返回空数组。
7. 单点文件：`n_blocks = 1`、`point_count = 1`、payload = 32 B seed + 5 B flush 尾部
   （无任何残差比特），解码回该点。
