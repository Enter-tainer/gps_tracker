# GPSL0 格式设计与调优指南（面向算力管饱环境的极致 GPS 轨迹编码）

> **定位**：`GPZ V2` 是为 MCU / 蓝牙串口 / SPI Flash 设计的流式嵌入式格式（无堆内存、1 点状态、字节对齐 varint）；而 **`GPSL0`** 则是面向浏览器（JS/WASM）、桌面端与 Cloudflare R2 归档设计的**信息论极限级压缩 + 块级随机访问**格式，核心架构直接借鉴自 `lepu/ecgfmt` 中的 `ECGL0 (v2, model_id=3)`。

---

## 1. 基准对照与优化目标

在现有 123 条真实轨迹（`2,022,295` 个 GPS 点，`frontend/local-data/r2/tracks/*.gpz`）上：

| 格式 | 总大小 | 平均每点字节数 | 平均每点比特数 | 说明 |
| :--- | :---: | :---: | :---: | :--- |
| 原始 GPX XML | `257.50 MB` | `~127.3 B/pt` | `~1018 bits/pt` | 文本标签 + 浮点字符串 |
| 紧凑裸二进制 (`u32, i32, i32, i16`) | `28.31 MB` | `14.00 B/pt` | `112.0 bits/pt` | 4 字段定长结构 |
| **`GPZ V2`（当前线上）** | `9.80 MB` | `4.85 B/pt` | `38.8 bits/pt` | 一阶差分 + 字节对齐 ZigZag LEB128 + 64 点全量帧 |
| **`GPSL0` Tier-0 目标（完全无损 $10^{-7}\text{ deg}$）** | `~3.2–4.0 MB` | **`~1.6–2.0 B/pt`** | **`~12.8–16.0 bits/pt`** | 时间归一化 $\Delta_2$ + 运动学上下文 + 二值 Range Coder |
| **`GPSL0` Tier-1 目标（准无损 $10^{-6}\text{ deg}$, $11\text{ cm}$）** | `~1.8–2.4 MB` | **`~0.9–1.2 B/pt`** | **`~7.2–9.6 bits/pt`** | 剥离民用 GNSS 底部热噪声（$1\text{ cm}\sim 10\text{ cm}$） |

### 为什么 `GPZ V2` 停在 `38.8 bits/pt`？
1. **一阶差分 $\Delta_1$ 违背牛顿惯性**：匀速直线运动时，$\Delta_1\text{lat}, \Delta_1\text{lon}$ 仍为速度量（$\sim 10^2\text{--}10^3$ 单位），在 LEB128 下恒占 2 Bytes/轴（32 bits）。
2. **字节对齐与 Tag 税**：每点 1 Byte Tag（高 4 bit 恒为 `0001`）+ LEB128 每字节 1 bit 续位税 + 字节取整惩罚（95% 概率出现的 $\Delta t=1\text{ s}$ 信息量仅 `0.074 bit`，却固定消耗 `9 bits`）。
3. **64 点 `0xFE` 同步帧固定税**：`17 B / 64 = 0.266 B/pt`（`2.1 bits/pt`），且行式交错存储破坏流内相关性。
4. **$10^{-7}\text{ deg}$ 传感器底噪**：$1.11\text{ cm}$ 分辨率远高于民用 GNSS 的 $1.5\text{--}3\text{ m}$ CEP，最低 $3\text{--}4\text{ bits}$ 接近不可压缩白噪声。

---

## 2. 从 `ECGL0` 继承的三条核心架构铁律

参考实现：`C:\Users\mgt\Desktop\proj\lepu\ecgfmt\SPEC.md` 与 `REPORT.md`。

1. **铁律一：预测器必须服从底层物理生成机制**
   - `ECGL0` 证明了 125 Hz 心电 `d1` 属于异方差脉冲信号，AR(p)/LPC 线性预测反而推高香农熵。
   - **GPS 恰恰相反**：宏观交通工具具有强惯性，一阶差分很大但**二阶差分（加速度/转向残差）高度集中在 0 附近**。在 GPS 上用**时间归一化二阶预测器**，相当于直接把速度矢量从残差流中消去。
2. **铁律二：用“离散状态上下文 + 二值化 Range Coder”统治异方差分布**
   - GPS 轨迹同样是**异方差混合分布**：静止漂移、步行、骑行、城市驾车、高速/高铁各 regimes 的残差方差相差几个数量级。
   - 复用 `ECGL0` 的 **11-bit 纯整数 LZMA Binary Range Coder** + **阶数 $m$ 条件化尾数拆解（`N_SLOT`）**，可以同时消除 Tag 税、LEB128 字节税，并捕获连续转弯/加减速中的**低位符号自相关性**。
3. **铁律三：索引粒度（Seek）与概率表重置（Sync）解耦 + Warm-Start**
   - 如果每个小块都把概率表重置为均匀分布（50/50），冷启动学习税会完全吞噬细粒度上下文的收益。
   - 正确做法：**小块切分字节流以支持区间随机读取（Seek），跨块继承概率状态（Warm Start），仅在大同步周期（Sync）重置回离线训练的全局先验表 `T_GPS`**。

---

## 3. `GPSL0` 核心算法设计

### 3.1 数据抽象与精度档位（Precision Tiers）

每条轨迹输入点序列 $P_i = (t_i, \text{lat}_i, \text{lon}_i, \text{alt}_i)$：
- $t_i$：Unix 秒整数（`i64` / `u32`）
- $\text{lat}_i, \text{lon}_i$：
  - **Tier 0（完全无损）**：`round(deg * 1e7)`（`i32`，约 $1.11\text{ cm}$）
  - **Tier 1（高精准无损）**：`round(deg * 1e6)`（`i32`，约 $11.1\text{ cm}$，仍比消费级 GPS 精度高 $10\times$，可消去约 $3.3\text{ bits/轴}$ 纯热噪声）
- $\text{alt}_i$：`round(ele_m * 10)`（`i32`，精度 $0.1\text{ m}$）

### 3.2 四通道预测器（Predictor）

在块内第 $i \ge 2$ 个点，所有预测值 $\hat{\cdot}_i$ **必须仅使用已解码整数状态通过纯整数运算求得**，以保证编解码跨平台（JS / Rust / C）比特级严格一致。

#### 1. 时间通道（`dt`）
令 $\Delta t_i = t_i - t_{i-1}$，预测器为恒定采样间隔：
$$\hat{\Delta t}_i = \Delta t_{i-1}, \qquad e_{t,i} = \Delta t_i - \hat{\Delta t}_i$$
*注：在 1 Hz 轨迹中，95% 以上的点满足 $e_{t,i} = 0$。*

#### 2. 经纬度通道（`lat`, `lon`）—— 时间归一化恒速外推
当 $\Delta t_{i-1} > 0$ 且 $\Delta t_i > 0$ 时：
$$v_{\text{lat}, i-1} = \text{lat}_{i-1} - \text{lat}_{i-2}, \qquad v_{\text{lon}, i-1} = \text{lon}_{i-1} - \text{lon}_{i-2}$$
$$\hat{\text{lat}}_i = \text{lat}_{i-1} + \operatorname{round\_div}\!\left(v_{\text{lat}, i-1} \cdot \Delta t_i,\ \Delta t_{i-1}\right)$$
$$\hat{\text{lon}}_i = \text{lon}_{i-1} + \operatorname{round\_div}\!\left(v_{\text{lon}, i-1} \cdot \Delta t_i,\ \Delta t_{i-1}\right)$$
其中带符号整数四舍五入除法 $\operatorname{round\_div}(a, b)$（$b > 0$）：
```ts
function roundDiv(a: number, b: number): number {
  if (a >= 0) return Math.trunc((a + (b >> 1)) / b);
  return -Math.trunc((-a + (b >> 1)) / b);
}
```
若 $\Delta t_i == \Delta t_{i-1}$，上式精确退化为二阶差分 $2 x_{i-1} - x_{i-2}$；若 $\Delta t_{i-1} = 0$（重复时间戳），退化为 $\hat{x}_i = x_{i-1}$。

> **进阶消融项（航向解耦 / Lifting Scheme）**：
> 巡航时切向残差 $e_\parallel$（加减速）与法向残差 $e_\perp$（转弯/车道抖动）方差不同。可在消融实验中测试是否对 $(e_{\text{lat},i}, e_{\text{lon},i})$ 按 $\mathbf{v}_{i-1}$ 方向做整数可逆旋转（或让 `lon` 编码以上下文形式条件化于刚解码的 `lat` 残差桶）。

#### 3. 海拔通道（`alt`）
海拔受道路坡度约束且包含气压计/GPS 阶梯量化，建议对比两种预测器：
- **一阶**：$e_{\text{alt}, i} = \text{alt}_i - \text{alt}_{i-1}$
- **衰减二阶**：$\hat{\text{alt}}_i = \text{alt}_{i-1} + (\Delta\text{alt}_{i-1} \gg 1)$（防止单点尖峰在二阶震荡）

### 3.3 熵编码核心（直接复用 `ECGL0`）

#### 1. 11-bit 纯整数 Binary Range Coder
- 参数：`PROB_BITS = 11`（`PROB_SCALE = 2048`，初始中性概率 `1024`），`MOVE_BITS = 5`，`TOP = 1 << 24`。
- 存储概率 $P(\text{bit}=0) \times 2048$：
  - 编码 `bit = 0`：`prob += (2048 - prob) >> 5`
  - 编码 `bit = 1`：`prob -= prob >> 5`
- 无浮点、无乘法溢出（JS 中用 `BigInt` 或 32-bit 拆半，WASM/Rust 直接用 `u32/u64`）。

#### 2. 残差二值化（`zigzag` + 阶数条件化尾数）
对任意有符号残差 $e$：
1. `u = (e >= 0) ? (e * 2) : (-e * 2 - 1)`（即标准 ZigZag，`0->0, -1->1, 1->2, -2->3...`）。
2. **Zero flag**（`slot 0`）：编码 `u != 0`。若 `u == 0` 结束。
3. **Unary Order** $m = \lfloor\log_2 u\rfloor \in [0, M_{\max}-1]$（`slot 1 .. M_max`）：
   - 对 $k = 0 \dots m-1$ 在 `slot 1 + k` 编码 `1`；
   - 若 $m < M_{\max}-1$，在 `slot 1 + m` 编码 `0` 终止。
4. **阶数条件化尾数**（`slot (1 + M_max) + m * M_max + k`）：
   - 从高位到低位（或低位到高位，固定一致即可）编码 $u$ 的低 $m$ 位。
   - **关键收益**：`u` 的最低位（bit 0）就是符号位，按 $m$ 条件化后编码器能直接学到“大幅度机动后下一拍同号/异号”的概率。
   - 建议 `M_max = 22`（覆盖 $\pm 2^{21}$ 级别跳变，满足经纬度最大跨度），此时每个上下文的状态槽数 `N_SLOT = 1 + 22 + 22 * 22 = 507`（`u16` 占 `1 KB/ctx`；若限制 $m \ge 1$ 的有效尾数槽可更紧）。

### 3.4 运动学上下文模型（待调优核心）

所有上下文特征**必须严格从已解码状态派生**，不占用任何额外比特：

1. **时间上下文 `ctx_dt`**：
   - `prev_dt_zero`（上一点 $e_{t, i-1} == 0$ ? 0 : 1）$\times$ `dt_bucket(prev_dt)`（如 `0s, 1s, 2s, 3-5s, >5s`），仅 ~10 个上下文。
2. **坐标上下文 `ctx_coord(speed_regime, prev_q1)`**：
   - `speed_regime`（由已解码的 $|\Delta\text{lat}_{i-1}| + |\Delta\text{lon}_{i-1}|$ 与 $\Delta t_{i-1}$ 算出的速度划分 6～8 档）：
     - `0`: 静止/漂移（$< 0.3\text{ m/s}$）
     - `1`: 步行（$0.3\text{--}2.2\text{ m/s}$）
     - `2`: 慢跑/慢骑（$2.2\text{--}5.5\text{ m/s}$）
     - `3`: 快骑/城市慢行（$5.5\text{--}12\text{ m/s}$）
     - `4`: 城市快速路/高速（$12\text{--}30\text{ m/s}$）
     - `5`: 高铁/航空（$> 30\text{ m/s}$）
   - `prev_q1`（带符号的上一拍残差量化桶，17 桶，对标 `ECGL0` `quantize_d1_signed17`）：
     - 桶边界示例（可调优）：`0`, `±1`, `±(2..3)`, `±(4..7)`, `±(8..15)`, `±(16..31)`, `±(32..63)`, `±(64..127)`, `±(>=128)`。
   - 总上下文数：$6 \times 17 = 102$ 个上下文（每上下文 `~1 KB`，全量表仅 **`~100 KB`**，轻松常驻 CPU L2 Cache！）。
   - *调优方向*：测试 `lat` 与 `lon` 共享同一套 `(speed_regime, prev_q1)` 概率表 vs 分开维护；以及是否加入 $\Delta t$ 跳变标志 `dt_changed`（当 $\Delta t_i \neq \Delta t_{i-1}$ 时外推误差会放大，单独分桶可避免污染匀速状态的概率分布）。
3. **海拔上下文 `ctx_alt`**：
   - `(speed_regime, prev_dalt_q9)`，约 $6 \times 9 = 54$ 个上下文。

---

## 4. 容器与随机访问布局（供多轨迹打包或单轨迹块存）

```text
+---------------------------------------------------------------+
| HEADER (48 B)                                                 |
|   magic="GPSL0\0\0\0" (8B), version (u16), flags (u16)        |
|   precision_scale (u32: 1e7 or 1e6), n_points (u32)           |
|   block_points (u32, e.g. 4096), sync_blocks (u32, e.g. 8)    |
|   n_blocks (u32), model_id (u32), header_crc32 (u32)          |
+---------------------------------------------------------------+
| BLOCK INDEX (n_blocks * 24 B)                                 |
|   start_ts (u32), end_ts (u32), point_count (u16),            |
|   flags (u16), byte_offset (u32), byte_len (u32), ...         |
+---------------------------------------------------------------+
| BLOCK PAYLOADS [0 .. n_blocks - 1]                            |
|   Block Seed (28 B):                                          |
|     t0 (u32), lat0 (i32), lon0 (i32), alt0 (i32),             |
|     dt0 (u32), vlat0 (i32), vlon0 (i32)                       |
|   Range-Coded Bitstream:                                      |
|     for i = 2 .. point_count-1:                               |
|       encode(e_dt), encode(e_lat), encode(e_lon), encode(e_alt)
|   (Warm-start across blocks; reset to T_GPS every sync_blocks)|
+---------------------------------------------------------------+
```

- **单点索引税**：每块 4096 点、索引 24 B $\rightarrow$ `24 / 4096 = 0.0059 B/pt`（`0.047 bits/pt`）。
- **多轨迹合包扩展**：若将来把所有 123 条轨迹打进一个 `all-tracks.gpsl0`，只需在 Block Index 里加 `track_id` 映射即可通过 HTTP `Range` 请求按块拉取任意一天的轨迹，把 R2 请求数从 $N$ 降为 1。

---

## 5. 给调优模型的消融实验与评估脚本清单

建议在 `frontend/scripts/bench_gpsl0.mjs`（读取 `frontend/local-data/r2/tracks/*.gpz` 并用 `decodeGpsPointsV2` 解出全部 2,022,295 个点）按以下顺序做消融实验，每一步**严格记录 `bits/pt`、各通道分项比特率、编解码耗时**：

1. **Step 0 — 基线对齐**
   - 统计 `GPZ V2` 实测总字节数与 `bits/pt`。
   - 统计 `GPZ V2` + `zlib/zstd` 极限（作为通用压缩参照线）。
2. **Step 1 — 预测器纯香农熵消融（不接编码器，只算经验熵 $H$）**
   - 对比 `d1` vs `naive_d2` vs `time_norm_d2` vs `heading_rotated_d2` 在 `lat`/`lon`/`dt`/`alt` 上的零阶经验熵 $H_0$ 与一阶条件熵 $H_1$。
   - 验证关键假设：`time_norm_d2` 是否显著优于 `naive_d2`？`dt_changed` 时误差分布是否明显变宽？
3. **Step 2 — 接入 `ECGL0` Binary Range Coder 逐项消融**
   - `M0`：无上下文（1 个通用模型）
   - `M1`：分通道上下文（`dt`, `lat/lon`, `alt` 各一套 `N_SLOT`）
   - `M2`：`M1` + `(speed_regime, prev_q1)` + `dt_changed` 上下文
   - `M3`：`M2` + 跨轨迹 Warm Start / 离线训练全局先验表 `T_GPS`（用前 80% 轨迹训练 `T_GPS`，在后 20% 轨迹上测交叉验证泛化差距，确保无过拟合）
   - 消融验证：`MOVE_BITS`（4 vs 5 vs 6）、`prev_q1` 桶边界、尾数是否按阶数 $m$ 条件化各自贡献了多少 `bits/pt`。
4. **Step 3 — 精度档位与性能验证**
   - 分别输出 **Tier-0（`1e-7 deg` 完全无损）** 与 **Tier-1（`1e-6 deg` 准无损）** 的总大小与比特率。
   - 校验 Round-trip Bit-exactness（解码后每个点的 `(ts, lat, lon, ele)` 与输入逐点一致）。

---

## 6. 参考代码位置
- 当前 `GPZ V2` 编解码实现：`frontend/src/services/gpsCodec.ts`
- `GPZ V2` 规范文档：`docs/delta_compress_gpx.md`
- `ECGL0` 完整规格与 Range Coder 参考：`C:\Users\mgt\Desktop\proj\lepu\ecgfmt\SPEC.md`
- `ECGL0` 消融报告参考：`C:\Users\mgt\Desktop\proj\lepu\ecgfmt\REPORT.md`
