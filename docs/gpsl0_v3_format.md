# GPSL0 格式规范 v3（`version = 2`, `model_id = 22`，**冻结版**）

> **状态**：v3 冻结（2026-11-27）。本文件是 GPSL0 v3 的**逐位契约**，任何兼容实现（Rust / JS / Python）必须逐比特一致。历史参考格式 v1（`version = 1, model_id = 1..10`）契约保留在 [`docs/gpsl0_format.md`](./gpsl0_format.md)，工程设计与全量实测见 [`docs/gpsl0_v3_report.md`](./gpsl0_v3_report.md)。
>
> **参考实现**：
> - 纯 Rust `#![no_std]` 核心库：`gpsl0/gpsl0-core/src/`（`container.rs`、`pred.rs`、`rangecoder.rs`、`stream.rs`、`v2.rs`、`v1.rs`、`error.rs`、`lib.rs`）
> - WebAssembly 导出与前端/Node 包装：`gpsl0/gpsl0-wasm/src/lib.rs`、`frontend/src/services/gpsl0/`（`wasmLoader.ts`、`index.ts`、`gpsl0_wasm.wasm`）

---

## 0. 目标与精度政策

- GPSL0 v3 在继承 v1 分块随机访问、双层 CRC-32 与自然格点政策的基础上，升级容器与概率编码为 `version = 2, model_id = 22`，面向浏览器 WASM、桌面 CLI、Cloudflare D1/R2 归档与嵌入式 MCU 全量轨迹压缩统一实现。
- **唯一默认写入档位**：`version = 2`、`model_id = 22`、`block_points = 32768`、`coordQuantum = "auto"`、`altQuantum = 10`。解码器统一支持 **v1**（`version = 1, model_id = 1..10`，参考/历史兼容）与 **v3**（`version = 2, model_id = 22`）。
- **单编码实现（`#![no_std]` 流式 + 打包 `u16` 状态）**：主机、WASM 与嵌入式无堆编码器（`StreamingEncoderV3` / `StreamV3Options`）执行完全同一套码流生成逻辑，每槽将 12-bit 概率与自适应计数打包进单个 `u16`：
  - `coord_quantum <= 10` 时仅使用 `3,219` 槽精简上下文表（`6,438 B`）；
  - `coord_quantum > 10` 时使用 `30,805` 槽格点扩展上下文表（`61,610 B`）。
  - MCU 侧固定结构体 `StreamingEncoderV3`（`size_of = 61,888 B ≈ 60.4 KiB`）可通过 `const fn new_unconfigured()` 零栈开销放入 `.bss` / `StaticCell`；主机 / WASM 按当前轨 `active_slots` 动态堆分配切片。
- **坐标政策**：
  - `coordQuantum = "auto"`：`gcd(所有 lat 绝对值与 lon 绝对值的最大公约数, 10_000_000)`，全零序列时回退 `10_000_000`。在自然格点（例如本语料 111/123 轨的 `100` ≈ `1.11 m`，或原始精度轨 `1`）上**逐点无损**。
  - 显式 `coordQuantum = q`：仅允许 `1 <= q <= 10_000_000` 且 `10_000_000 % q == 0`；默认 `auto` 为精确整除，显式固定 `q` 时按向 $+\infty$ 舍入的整数公式 `floor((2 * v + q) / (2 * q))` 量化（与 JS `Math.round` 对半入正一致）。
- **高程政策**：
  - 默认 `altQuantum = 10`（`0.1 m` 单位的 10 倍，即 `1 m` 格点），最大偏差 `<= 5`（`0.5 m`）；`altQuantum = 1` 或 `"auto"` 时为 Tier-0 四通道完全无损（允许 `alt_quantum ∈ {1, 2, 5, 10}`，即 `10 % alt_quantum == 0`）。
- **时间戳**：永远逐点无损（以 `i32` 差值编码，`u32` / Unix 秒语义返回）。

---

## 1. 容器布局（小端）

v3 文件使用 `version = 2` 紧凑容器，由 **36 B 固定头** + **变长差分 Varint 块索引** + **连续载荷块** 三部分组成：

```text
+-------------------------------+------------------------------------+------------------------+
| FileHeaderV2 (36 B)           | BlockIndexV2 (delta-varint, 变长)  | BlockPayload[0..n-1]   |
+-------------------------------+------------------------------------+------------------------+
  ^ 0..27 covered by header_crc32  ^ 36..index_end covered by index_crc32
```

### 1.1 FileHeaderV2（36 字节，小端）

| 字节偏移 | 大小 | 类型 | 字段 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `0..8` | 8 | `[u8; 8]` | `magic` | 固定 ASCII `"GPSL0\0\0\0"`（`47 50 53 4c 30 00 00 00`） |
| `8..10` | 2 | `u16` | `version` | `2`（若为 `1` 按 v1 48 B 格式解码；其它值返回 `UnsupportedVersion`） |
| `10..12` | 2 | `u16` | `flags` | `bit0`: `tier0`（`coord_quantum == 1`）<br>`bit1`: `has_alt`（编码器置 `1`）<br>`bit2`: `alt_damped`（`0` = 高程一阶 `D1`，`1` = Q8 定点 `AlphaBeta(230, 77)`）<br>`bits3..4`: `coord_mode`（`0=Tn`, `1=Naive`, `2=Q1SpikeDamped`, `3=D1`）<br>`bits5..15`: 保留位，**必须为 `0`**（非 0 返回 `CorruptHeader`） |
| `12..16` | 4 | `u32` | `coord_quantum` | `1 <= q <= 10_000_000` 且 `10_000_000 % q == 0` |
| `16..20` | 4 | `u32` | `n_points` | 轨迹总点数，`<= 2^30` |
| `20..24` | 4 | `u32` | `block_points` | 每块目标点数，`2 <= block_points <= 2^20`（默认 `32768`） |
| `24..26` | 2 | `u16` | `sync_blocks` | 同步周期（`0` = 仅 block 0 复位状态；`> 0` 时每隔 `sync_blocks` 块复位） |
| `26` | 1 | `u8` | `alt_quantum` | `1 <= aq <= 10` 且 `10 % aq == 0`（默认 `10`） |
| `27` | 1 | `u8` | `model_id` | 固定为 `22`（`0x16`；其它值返回 `UnsupportedModel`） |
| `28..32` | 4 | `u32` | `header_crc32` | `CRC32(bytes[0..28])`（IEEE 802.3 多项式 `0xEDB88320`） |
| `32..36` | 4 | `u32` | `index_crc32` | `CRC32(bytes[36..index_end])`（`n_blocks == 0` 时为空切片 CRC `0x00000000`） |

- 派生块数：`n_blocks = (n_points == 0) ? 0 : ceil(n_points / block_points)`，上限 `n_blocks <= 2^22`。
- 若 `n_blocks > 0`：合法文件长度至少满足 `36 + 10 + (n_blocks - 1) * 7 <= bytes.len()`（反 OOM 预检），且 `sync_blocks == 0 || sync_blocks <= n_blocks`。

### 1.2 Varint 编码定义

- **`uvarint(u64)`**：标准小端 7-bit Base-128 编码；每字节低 7 位有效，`bit7 = 1` 表示继续，`bit7 = 0` 为末字节。解码禁止溢出 `u64`（`shift >= 64` 或 `shift >= 63 && byte > 1` 返回 `BadIndex`）。
- **`svarint(i64)`**：ZigZag + `uvarint`：
  - 编码：`zz = ((v << 1) ^ (v >> 63)) as u64`（算术右移）；
  - 解码：`((zz >> 1) as i64) ^ (-((zz & 1) as i64))`。

### 1.3 BlockIndexV2（`n_blocks` 项，从字节 `36` 起紧凑顺序编码）

索引省去每块固定 `point_count` 与 `byte_offset`（分别由 `n_points / block_points` 与前序 `byte_length` 累计推导），并受头字段 `index_crc32` 整体校验。对 `b = 0 .. n_blocks - 1`：

1. `start_ts`：
   - `b == 0`：`u32` 小端 4 字节；
   - `b > 0`：`svarint(start_ts[b] - end_ts[b - 1])`（校验还原结果在 `[0, u32::MAX]`）。
2. `dur`：`uvarint((end_ts[b] as u64).saturating_sub(start_ts[b] as u64))`，还原 `end_ts[b] = start_ts[b] + dur`（需不溢出 `u32`）。
3. `byte_length`：`uvarint(payload_len[b])`（必须满足 `1 <= byte_length <= bytes.len()`）。
4. `crc32_payload`：`u32` 小端 4 字节，等于对应块载荷 `CRC32(payload[b])`。
5. 每块点数由消费序隐式推导：从 `rem = n_points` 开始，依次取 `point_count[b] = min(rem, block_points)`，`rem -= point_count[b]`；索引解析完毕后必须 `rem == 0`。

全索引结束后位于 `index_end`，校验 `CRC32(bytes[36..index_end]) == header.index_crc32`。随后第 `b` 块载荷精确位于连续区间 `[byte_offset[b], byte_offset[b] + byte_length[b])`，其中 `byte_offset[0] = index_end`、`byte_offset[b] = byte_offset[b - 1] + byte_length[b - 1]`，并要求全部落在文件长度内。

### 1.4 块载荷与 Sync Seed

`sync(b) = (b == 0) || (sync_blocks > 0 && b % sync_blocks == 0)`。

- **同步块（`sync(b) == true`）**：
  - 复位激活概率表至初始中值 `2048`、自适应计数至 `0`、预测/残差状态为新块初始值（`b > 0` 时重新写入/读取新 seed）。
  - 载荷前部紧跟紧凑 **Sync Seed**：
    - `t0`：`i32` LE（4 B）；
    - `lat0`：`i32` LE（4 B，已除以 `coord_quantum`）；
    - `lon0`：`i32` LE（4 B，已除以 `coord_quantum`）；
    - `alt0`：`svarint(alt0 as i64)`（已除以 `alt_quantum`）；
    - 若本块 `point_count >= 2`，继续写入第 2 点的差分：`svarint(dt0)`、`svarint(vlat0)`、`svarint(vlon0)`、`svarint(valt0)`，其中 `dt0 = t1 - t0`、`v*0 = x1 - x0`。
  - 种子建立后的状态：
    - `t_prev = t0 + dt0`，`dt_prev = dt_prev2 = dt_prev3 = dt_base = dt0`，`e_dt_prev = 0`，`zero_run = 0`；
    - 每个轴的状态：`x_prev2 = x0`，`x_prev = x1`，`v_prev = v_prev2 = v*0`，`x_hat_q8 = (x1 as i64) << 8`，`v_hat_q8 = (dt0 > 0) ? ((v*0 as i64) << 8) / (dt0 as i64) : 0`，`e_prev = 0`，`last_nz_sign = 0`，`last_nz_is1 = false`，`zero_gap = 2`。
  - 若 `point_count <= 2`，范围编码器仅执行 `RangeEncoderV2::finish()`（写入 5 B 结尾字节，解码器初始化 `RangeDecoderV2` 验证长度 `>= 5` 后不解码任何循环点）。若 `point_count >= 3`，范围编码器依次编码块内局部索引 `j = 2 .. point_count - 1`。
- **连续块（`sync(b) == false`）**：
  - 沿用上一块的概率表、自适应计数与状态机（**不重新写入 seed**），载荷完全由独立 `RangeEncoderV2` 字节流构成，编码局部索引 `j = 0 .. point_count - 1`。

---

## 2. 预测器与编码器自动选择策略

记量化后当前点为 `(t[i], lat[i], lon[i], alt[i])`，当前时间步长 `dt_cur = t[i].wrapping_sub(t_prev)`（在 `i32` 回环语义下计算）。除 `AlphaBeta` 内外插使用 `i64` 外，所有残差均以 `((actual as i64) - pred) as i32` 计算并以 `wrapping_add` 还原。

### 2.1 时间戳预测器（`SteadyBase`）

- 预测值：`pred_dt = dt_base`。
- 残差：`e_dt = dt_cur.wrapping_sub(pred_dt)`。
- 编码该点之后的状态更新：仅当 `dt_cur == dt_prev && dt_cur > 0` 时更新 `dt_base = dt_cur`（锁住稳态采样间隔，跳过单点停顿或抖动后的短暂瞬变）。

### 2.2 坐标预测器（由 header `coord_mode ∈ {0, 1, 2, 3}` 指定）

令 `xp2 = x_prev2 as i64`、`xp = x_prev as i64`、`dp = dt_prev as i64`、`dc = dt_cur as i64`，四舍五入整除定义为：

```text
round_div(a, b) = (a >= 0) ? (a + (b >> 1)) / b : -((-a + (b >> 1)) / b)   (b > 0)
```

| `coord_mode` | 名称 | 公式 |
| --- | --- | --- |
| `0` | `Tn` | 当 `dp > 0 && dc > 0` 时 `xp + round_div((xp - xp2) * dc, dp)`，否则 `xp` |
| `1` | `Naive` | `2 * xp - xp2` |
| `2` | `Q1SpikeDamped` | 若 `coord_quantum <= 10`，令 `v1 = x_prev.wrapping_sub(x_prev2) as i64`、`v2 = v_prev2 as i64`、`phys_v1 = |v1| * coord_quantum`：<br>若 `(v2 == 0 && phys_v1 <= 120)` 或 `(v1 * v2 < 0 && phys_v1 <= 150)`，直接退回一阶预测 `xp`；<br>否则执行限幅时间归一化外推 `TnClamped`：当 `dp > 0 && dc > 0` 时取 `d = min(dc, 2 * dp)`，预测 `xp + round_div((xp - xp2) * d, dp)`，否则 `xp` |
| `3` | `D1` | `xp`（纯一阶保持） |

- **默认自动选择策略（编码器侧，当未显式指定 `coordPredictor` 时）**：
  - 始终先以 `coord_mode = 2`（`Q1SpikeDamped`）编码；
  - 若 `n >= 3` 且满足稀疏/短轨条件 `n <= 4096 || (t[n - 1] - t[0]) >= 3 * n`，额外试编 `coord_mode = 3`（`D1`），若字节数严格更小（`d1_bytes < tn_bytes`）则选用 `D1`。

### 2.3 高程预测器（由 header `alt_damped` 指定）

- `alt_damped == false`（`D1`）：`pred_alt = alt.x_prev as i64`。
- `alt_damped == true`（Q8 定点 $\alpha$-$\beta$ 滤波，固定参数 $\alpha = 230/256$、$\beta = 77/256$）：
  - **预测**：若 `dt_cur > 0`，取 `dt_eff = min(dt_cur as i64, max(dt_prev, 1) as i64 * 2)`，否则 `dt_eff = 0`；
    `xp_q8 = alt.x_hat_q8 + alt.v_hat_q8 * dt_eff`，`pred_alt = round_div(xp_q8, 256)`。
  - **状态更新**：
    - 若 `dt_cur <= 0 || dt_cur > max(dt_prev, 1) * 4`（间隔过大或时间回退），重置滤波器：`x_hat_q8 = (alt_cur as i64) << 8`，`v_hat_q8 = 0`；
    - 否则令 `dt_real = max(dt_cur, 1) as i64`，`r_q8 = ((alt_cur as i64) << 8) - xp_q8`：
      `x_hat_q8 = xp_q8 + round_div(230 * r_q8, 256)`，
      `v_hat_q8 += (dt_real == 1) ? round_div(77 * r_q8, 256) : round_div(77 * r_q8, 256 * dt_real)`。
- **默认自动选择策略**：当 `alt_quantum >= 5`（如默认 `10` = `1 m` 格点）时选 `D1`（`alt_damped = false`）；当 `alt_quantum <= 2`（如 Tier-0 `alt_quantum = 1`）时选 `AlphaBeta(230, 77)`（`alt_damped = true`）。

---

## 3. 联合零标记、因果编码序与量子门控双布局

### 3.1 每点逐比特编码流程（`DtThenAllZero3`）

先编时间戳 `e_dt`（得到精确 `dt_cur` 后才预测坐标与高程），再通过 1-bit 联合全零标志 `allZero3` 一次性跳过静止/匀速无误差点的全部三轴符号：

1. **编码 `e_dt`**（`force_nonzero = false`）。解码端随后重构 `dt_cur = pred_dt.wrapping_add(e_dt)` 并算得 `pred_lat`、`pred_lon`、`pred_alt`。
2. **编码 `allZero3`**：`az3 = (e_lat == 0 && e_lon == 0 && e_alt == 0) ? 1 : 0`：
   - 上下文索引：`all_zero_base + (run_bucket4(zero_run) * 2 + stationary) * 2 + dchg`（共 16 个槽位，`0..16`），其中：
     - `run_bucket4(r)`：`0->0, 1->1, 2..3->2, >=4->3`；
     - `stationary = ((x_lat_prev == x_lat_prev2) && (x_lon_prev == x_lon_prev2)) ? 1 : 0`；
     - `dchg = (e_dt != 0) ? 1 : 0`。
   - 若 `az3 == 1`：`zero_run = zero_run.saturating_add(1)`，本点直接结束（`e_lat = e_lon = e_alt = 0`）。
   - 若 `az3 == 0`：`zero_run = 0`，继续步骤 3–5。
3. **编码 `e_lat`**（`force_nonzero = false`）。
4. **编码 `e_lon`**（`force_nonzero = false`，上下文可因果使用本点已编/解出的 `e_lat`）。
5. **编码 `e_alt`**（**精确排他优化** `force_nonzero = (e_lat == 0 && e_lon == 0)`）：由于前面 `az3 == 0` 保证三轴不全为 0，若 `e_lat == 0 && e_lon == 0` 则必有 `e_alt != 0`，此时跳过 `is_zero(e_alt)` 判定比特。

### 3.2 分桶与特征函数

- `dt_bucket(dt, 5)`：`dt<=0 -> 0`, `1 -> 1`, `2 -> 2`, `3..=5 -> 3`, `6..=15 -> 4`, `>15 -> 4`。
- `mag3(e)`：`0 -> 0`, `1 -> 1`, `>=2 -> 2`（基于 `|e|`）。
- `mag4(e)`：`0 -> 0`, `1 -> 1`, `2..=3 -> 2`, `>=4 -> 3`。
- `mag6(e)`：`0 -> 0`, `1 -> 1`, `2..=3 -> 2`, `4..=7 -> 3`, `8..=31 -> 4`, `>=32 -> 5`。
- `vmag_bucket(v)`（5 档）：`|v| == 0 -> 0`，`<= 2 -> 1`，`<= 8 -> 2`，`<= 32 -> 3`，`> 32 -> 4`。
- `vel_step_bucket(v, dt_prev, pred_dt)`（5 档预测位移速度分桶）：
  - 若 `dt_prev > 0 && pred_dt > 0 && dt_prev != pred_dt`，取 `s = round_div(v * min(pred_dt, 2 * dt_prev), dt_prev)`；否则（稳态节拍或 `dt_prev == pred_dt`）直接取 `s = v`。
  - 对 `|s|` 套用 `0 -> 0`，`<= 2 -> 1`，`<= 8 -> 2`，`<= 32 -> 3`，`> 32 -> 4`。
- `accel_bucket3(v_prev, v_prev2)`（3 档）：`|v_prev| < |v_prev2| -> 0`，`== -> 1`，`> -> 2`。
- `accel_growing(v_prev, v_prev2)`（2 档）：`(|v_prev| > |v_prev2|) ? 1 : 0`。
- `agree_bit(e_prev, v_prev)`（2 档）：`(e_prev != 0 && v_prev != 0 && signum(e_prev) == signum(v_prev)) ? 1 : 0`。

### 3.3 量子门控表布局

由头字段 `coord_quantum` 唯一决定上下文布局（`vlat_prev = lat.x_prev.wrapping_sub(lat.x_prev2)`，`vlon_prev = lon.x_prev.wrapping_sub(lon.x_prev2)`，与各轴 `v_prev` 在每块 `sync` 时按 §1.4 复位为 `v*0 = x1 - x0`）：

#### 布局 A：`coord_quantum <= 10`（全精度/低量子轨，总计 `3,219` 槽）

| 区块 | 槽位范围 | 槽位数 | 上下文公式 | `SlotKind`（稳态移位） |
| --- | --- | --- | --- | --- |
| `allZero3` | `0..16` | `16` | `(run_bucket4(zero_run) * 2 + stationary) * 2 + dchg` | `SlowZero` (`7`) |
| `zero_dt` | `16..26` | `10` | `dt_bucket(pred_dt, 5) * 2 + (e_dt_prev != 0)` | `SlowZero` (`7`) |
| `zero_lat` | `26..58` | `32` | `((mag4(lat.e_prev) * 2 + (lon.e_prev != 0)) * 2 + dchg) * 2 + stationary` | `FastZero` (`5`) |
| `zero_lon` | `58..90` | `32` | `(mag4(lon.e_prev) * 4 + mag4(e_lat)) * 2 + dchg` | `FastZero` (`5`) |
| `zero_alt` | `90..108` | `18` | `(mag3(alt.e_prev) * 3 + h_m3) * 2 + dchg`<br>其中 `horiz = max(\|e_lat\|, \|e_lon\|)`，`h_m3 = mag3(horiz)` | `FastZero` (`5`) |
| `mag_dt` | `108..698` | `10 × 59` | 块内上下文：`dt_bucket(pred_dt, 5) * 2 + (e_dt_prev != 0)` | `MagSign` (`5`) |
| `mag_lat` | `698..1406` | `12 × 59` | 块内上下文：`mag6(lat.e_prev) * 2 + dchg` | `MagSign` (`5`) |
| `mag_lon` | `1406..2822` | `24 × 59` | 块内上下文：`(mag6(lon.e_prev) * 2 + dchg) * 2 + (e_lat != 0)` | `MagSign` (`5`) |
| `mag_alt` | `2822..3176` | `6 × 59` | 块内上下文：`mag3(alt.e_prev) * 2 + (horiz != 0)` | `MagSign` (`5`) |
| `sign_dt` | `3176..3180` | `4` | `(pred_dt <= 1) * 2 + (e_dt_prev > 0)` | `MagSign` (`5`) |
| `sign_lat` | `3180..3193` | `13` | `LastNzGap` 13 槽（见 §4） | `MagSign` (`5`) |
| `sign_lon` | `3193..3206` | `13` | `LastNzGap` 13 槽（见 §4） | `MagSign` (`5`) |
| `sign_alt` | `3206..3219` | `13` | `LastNzGap` 13 槽（见 §4） | `MagSign` (`5`) |

#### 布局 B：`coord_quantum > 10`（格点量化轨，总计 `30,805` 槽）

| 区块 | 槽位范围 | 槽位数 | 上下文公式 | `SlotKind`（稳态移位） |
| --- | --- | --- | --- | --- |
| `allZero3` | `0..16` | `16` | 同布局 A | `SlowZero` (`7`) |
| `zero_dt` | `16..26` | `10` | 同布局 A | `SlowZero` (`7`) |
| `zero_lat` | `26..506` | `480` | `((((mag4(lat.e_prev) * 2 + (lon.e_prev != 0)) * 2 + dchg) * 2 + stationary) * 5 + vel_step_bucket(vlat_prev, dt_prev, pred_dt)) * 3 + accel_bucket3(lat.v_prev, lat.v_prev2)` | `FastZero` (`5`) |
| `zero_lon` | `506..986` | `480` | `(((mag4(lon.e_prev) * 4 + mag4(e_lat)) * 2 + dchg) * 5 + vel_step_bucket(vlon_prev, dt_prev, pred_dt)) * 3 + accel_bucket3(lon.v_prev, lon.v_prev2)` | `FastZero` (`5`) |
| `zero_alt` | `986..1004` | `18` | 同布局 A | `FastZero` (`5`) |
| `mag_dt` | `1004..1594` | `10 × 59` | 同布局 A | `MagSign` (`5`) |
| `mag_lat` | `1594..15754` | `240 × 59` | 块内上下文：`((((mag6(lat.e_prev) * 2 + dchg) * 5 + vel_step_bucket(vlat_prev, dt_prev, pred_dt)) * 2 + agree_bit(lat.e_prev, lat.v_prev)) * 2 + accel_growing(lat.v_prev, lat.v_prev2))` | `MagSign` (`5`) |
| `mag_lon` | `15754..29914` | `240 × 59` | 块内上下文：`((mag6(lon.e_prev) * 4 + mag4(e_lat)) * 2 + dchg) * 5 + vel_step_bucket(vlon_prev, dt_prev, pred_dt)` | `MagSign` (`5`) |
| `mag_alt` | `29914..30268` | `6 × 59` | 同布局 A | `MagSign` (`5`) |
| `sign_dt` | `30268..30272` | `4` | 同布局 A | `MagSign` (`5`) |
| `sign_lat` | `30272..30532` | `260` | `(base13 * 4 + mag4(lat.e_prev)) * 5 + vmag_bucket(vlat_prev)`，其中 `base13 ∈ 0..12` 为 §4 `LastNzGap` 相对槽位 | `MagSign` (`5`) |
| `sign_lon` | `30532..30792` | `260` | `(base13 * 4 + mag4(lon.e_prev)) * 5 + vmag_bucket(vlon_prev)` | `MagSign` (`5`) |
| `sign_alt` | `30792..30805` | `13` | 同布局 A `LastNzGap` 13 槽 | `MagSign` (`5`) |

---

## 4. 符号-幅值分离与 MSB-first 尾数前缀树二值化

每个通道残差 `e` 按 `is_zero` → `unary(m)` → `mantissa(u)` → `sign` 顺序编解码：

1. **`is_zero`**（若 `force_nonzero == true` 则**不发送**该 bit）：
   - `e == 0`：在 `zero_idx` 编码 bit `0` 并返回。
   - `e != 0`：在 `zero_idx` 编码 bit `1`。
2. **一元码编码最高有效位 `m = floor(log2(u))`**（其中 `u = |e| as u32 >= 1`；每个 `mag` 上下文占 `59` 槽，`0..24` 为一元槽）：
   - 若 `m >= 24`：连续编码 24 个 `1`（在 `base + 0..24`），随后用 `encode_direct` 直接按 MSB→LSB 写入 `u` 的全部 32 位，跳过第 3 步直达第 4 步符号。
   - 若 `m < 24`：在 `base + 0..m` 编 `m` 个 `1`，再在 `base + m` 编终止 `0`。
3. **幅值尾数（`m == 1` 专用槽 + `MSB-first` 4-bit 前缀树，槽偏移 `24..59`）**：
   - `m == 0`（`|e| = 1`）：无尾数比特。
   - `m == 1`（`u ∈ {2, 3}`）：使用**专用独立槽** `base + 24` 编码 `(u & 1) as u8`（不污染高阶树节点）。
   - `2 <= m <= 23`：按 `step = 0 .. m - 1` 从**次高位到最低位**顺序编码 `bit = (u >> (m - 1 - step)) & 1`：
     - `step < 4`：使用 4 层二叉树（`15` 个节点，基址 `tree_base = base + 25`），节点索引 `node = 25 + ((1 << step) - 1) + prefix`，编码后更新 `prefix = (prefix << 1) | bit`。
     - `step >= 4`：使用平坦尾数槽（`19` 个槽位，基址 `flat_base = base + 40`），索引 `flat_base + (step - 4)`。
4. **符号编码**：
   - **时间通道（`is_dt == true`）**：使用 `sign_dt` 中对应槽位，编码原始符号位 `is_neg = (e < 0) ? 1 : 0`。
   - **高程与非格点坐标（`alt` 或 `coord_quantum <= 10` 的 `lat`/`lon`）**（`LastNzGap` 13 槽）：令 `cur_is_1 = (u == 1) ? 1 : 0`：
     - 若本轴此前已有非零残差（`last_nz_sign != 0`）：
       `base13 = (min(zero_gap, 2) * 2 + last_nz_is1) * 2 + cur_is_1`（共 `12` 槽，`0..12`），编码**符号是否翻转** `rel = ((e < 0) != (last_nz_sign < 0)) ? 1 : 0`。
     - 若尚无历史非零残差（`last_nz_sign == 0`）：取 `base13 = 12`，编码原始 `is_neg = (e < 0) ? 1 : 0`。
   - **格点坐标（`coord_quantum > 10` 的 `lat`/`lon`）**（`260` 槽）：按上式算出 `base13` 与待编码符号位后，映射到 `sign_base + (base13 * 4 + mag4(e_prev)) * 5 + vmag_bucket(v_prev)`。
   - **状态更新**：本点编码/解码后，若 `e != 0`，置 `last_nz_sign = (e < 0) ? -1 : 1`、`last_nz_is1 = (|e| == 1)`、`zero_gap = 0`；若 `e == 0`，置 `zero_gap = min(zero_gap + 1, 2)`。每块若 `sync` 则复位于初始 `last_nz_sign = 0, last_nz_is1 = false, zero_gap = 2`。

---

## 5. 12-bit 精确乘法 Range Coder 与双速概率适应

- 沿用 v1 同款 32-bit 进位归一化区间编码器（`TOP = 1 << 24`，`finish()` 输出 5 字节；解码初始前瞻 `code = bytes[1..5]` 并检查 `bytes.len() >= 5`，越界抛出 `Truncated`）。
- **核心参数**：
  - 概率精度 `PROB_BITS = 12`（`PROB_SCALE = 4096`，初始值 `PROB_INIT = 2048`，全部槽位零先验 `2048` 起步）；
  - **64 位精确乘界**（`exact_bound = true`）：`bound = (((range as u64) * (p as u64)) >> 12) as u32`；
  - **概率地板**：`min_prob = 4`、`max_prob = 4092`（极高频上下文可收敛至 `4092 / 4096 ≈ 99.90%`）；
  - **双速冷启动 + 四舍五入更新**（`count` 在打包实现中饱和截断于 `14` 并存于 `u16` 高 4 位：`(count.min(14) << 12) | prob`，与无限递增 `u8` 逐位数学等价）：
    - `count < 2 -> shift = 2`
    - `2 <= count < 6 -> shift = 3`
    - `6 <= count < 14 -> shift = 4`
    - `count >= 14 -> shift = steady`（`SlowZero = 7`, `FastZero = 5`, `MagSign = 5`）
  - 带舍入偏移 `round = 1 << (shift - 1)`，且最小步长为 `1`：
    - 当 `bit == 0`：`delta = max(((4096 - p + round) >> shift), 1)`，`p' = min(p + delta, 4092)`；
    - 当 `bit == 1`：`delta = max(((p + round) >> shift), 1)`，`p' = max(p.saturating_sub(delta), 4)`。

---

## 6. 错误分类契约

| `Gpsl0Error` | 触发条件 |
| --- | --- |
| `Truncated` | 文件 `< 36 B`、varint / index / seed 截断、块载荷截断或 range decoder `pos >= payload.len()` |
| `BadMagic` | `bytes[0..8] != "GPSL0\0\0\0"` |
| `UnsupportedVersion` | `version` 不在 `{1, 2}` |
| `CrcMismatch` | `header_crc32`（`0..28`）、`index_crc32`（`36..index_end`）或任一块 `crc32_payload` 不匹配 |
| `CorruptHeader` | `flags` 未定义位非 0、`coord_quantum` / `alt_quantum` 不整除约束、非法 `coord_mode` |
| `BadIndex` | varint 溢出、`block_points` 越界、`n_blocks` 越界或超过最小索引长度、点数和不等于 `n_points`、偏移溢出 |
| `UnsupportedModel` | `version = 2` 中 `model_id != 22`（`version = 1` 中 `model_id ∉ 1..=10`） |
| `BadWindow` | `len < 1` 或 `[start_point, start_point + len)` 超出 `0..n_points` |
| `InvalidInput` | 编码端四数组长度不等、量子参数非法、定量子模式下坐标不整除 |

---

## 7. 规范测试向量（Rust `gpsl0_bench --report-stats` 实测生成）

输入 6 点轨道（原始未量化单位：时间戳 Unix 秒，经纬度 `1e-7 deg`，高程 `0.1 m`，默认选项 `quantum = "auto"`, `altQuantum = 10`）：

```text
t   = [1700000000, 1700000001, 1700000002, 1700000003, 1700000004, 1700000006]
lat = [311196800, 311196900, 311197000, 311197000, 311197100, 311197300]
lon = [1214730000, 1214730100, 1214730200, 1214730200, 1214730300, 1214730500]
alt = [150, 150, 150, 150, 160, 170]
```

头部解析元数据：`bytes = 71`，`version = 2`，`model_id = 22`，`coord_mode = 2`（`Q1SpikeDamped`），`coord_quantum = 100`，`alt_quantum = 10`，`alt_damped = false`，`block_points = 32768`，`n_blocks = 1`，`header_crc32 = 0x01f14335`，`index_crc32 = 0x385fe14e`，`payload_crc32 = 0xf4ae6197`；解码还原与输入逐点完全一致。

完整 71 字节小写十六进制码流（Header 36 B + BlockIndex 10 B + Payload 25 B）：

```text
4750534c300000000200120064000000060000000080000000000a163543f1014ee15f38
00f1536506199761aef4
00f15365207c2f00645ab9001e02020200004e1a437f640000
```
