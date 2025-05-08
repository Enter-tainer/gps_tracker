好的，这是一种非常实用的存储优化方式。我们来整理一下，形成一个规范的协议文档。

---

## GPS 数据存储协议文档

**版本:** 1.0
**最后修订日期:** 2025-05-08

### 1. 引言

本文档描述了一种用于在资源受限的单片机 (MCU) 环境中高效存储 GPS 轨迹数据的二进制协议。该协议旨在通过使用固定大小的完整数据点和基于可变长度整数 (Varint) 编码的增量数据点来最小化存储空间。

### 2. 设计目标

* **空间效率:** 最大限度地减少 GPS 数据的存储占用。
* **简单性:** 易于在 MCU 上实现编码和解码。
* **灵活性:** 允许完整数据点和增量数据点混合存储。

### 3. 基本数据类型

本协议中使用以下基本数据类型：

* `uint8_t`: 无符号 8 位整数。
* `uint32_t`: 无符号 32 位整数。
* `int32_t`: 有符号 32 位整数。
* `varint_s32`: 使用 ZigZag 编码后进行 Varint(aka LEB128) 编码的有符号 32 位整数。Varint 编码是一种使用一个或多个字节序列化整数的方法，数值越小的整数（绝对值）占用的字节数越少。ZigZag 编码将有符号整数映射到无符号整数，以便具有较小绝对值的数字（正数或负数）在 Varint 编码后占用较少空间。
    * ZigZag 编码: `(n << 1) ^ (n >> 31)` (对于32位整数 `n`)
    * ZigZag 解码: `(unsigned_val >> 1) ^ -(unsigned_val & 1)`
    * Varint 编码: 使用 LEB128 编码格式，具体实现可以参考 [LEB128](https://en.wikipedia.org/wiki/LEB128)。

除非另有说明，所有多字节整数均以**小端序 (Little-Endian)** 存储。

### 4. GPS 数据点原始结构 (`GpxPointInternal`)

这是 GPS 数据点的完整（未压缩）表示形式，总大小为 16 字节。

```c
#pragma pack(push, 1) // 确保字节对齐为1，无填充
typedef struct {
  uint32_t timestamp;           // Unix 时间戳 (秒)，自 1970-01-01 00:00:00 UTC 起的秒数
  int32_t latitude_scaled_1e5;  // 纬度，单位：度 * 10^5 (例如，34.12345 度存储为 3412345)
  int32_t longitude_scaled_1e5; // 经度，单位：度 * 10^5 (例如，-118.12345 度存储为 -11812345)
  int32_t altitude_m_scaled_1e1; // 海拔高度，单位：米 * 10 (例如，123.4 米存储为 1234)
} GpxPointInternal;
#pragma pack(pop)
```

### 5. 文件结构

GPS 数据文件由一个或多个数据块 (`Data Block`) 序列组成。
**第一个数据块必须是完整数据块 (Full Block)。**

```
[Data Block 1] [Data Block 2] ... [Data Block N]
```

### 6. 数据块 (`Data Block`)

每个数据块由一个 1 字节的头部 (`Header`) 和一个可变长度的有效负载 (`Payload`) 组成。

```
+-------------+-------------------------+
| Header (1B) | Payload (Variable Size) |
+-------------+-------------------------+
```

#### 6.1. 头部字节 (`Header`)

头部字节的最高位 (`bit 7`) 用于区分数据块类型：

* **`bit 7 == 1`**: 表示这是一个**完整数据块 (Full Block)**。此时，头部字节固定为 `0xFF`。
* **`bit 7 == 0`**: 表示这是一个**增量数据块 (Delta Block)**。此时，头部字节的低 4 位 (`bit 0` 到 `bit 3`) 用于指示哪些字段的增量值存在于 `Payload` 中。高 4 位中的其余 3 位 (`bit 4` 到 `bit 6`) 当前保留，应设置为 `0`。因此，Delta Block 的 Header 格式为 `0000b_ttt b_lll b_ooo b_aaa`，简写为 `0x0F` (其中 `F` 是一个 4 位掩码)。

#### 6.2. 完整数据块 (Full Block)

* **Header**: `0xFF`
* **Payload**: 直接存储一个 `GpxPointInternal` 结构体的内容（16 字节）。
    * `timestamp` (4 字节, `uint32_t`)
    * `latitude_scaled_1e5` (4 字节, `int32_t`)
    * `longitude_scaled_1e5` (4 字节, `int32_t`)
    * `altitude_m_scaled_1e1` (4 字节, `int32_t`)

#### 6.3. 增量数据块 (Delta Block)

增量数据块存储当前数据点相对于**前一个已解码/存储的数据点**的变化量。

* **Header**: `0x0F` (其中 `F` 是一个 4 位掩码，`0000 H_TS H_LAT H_LON H_ALT` (二进制))
    * `H_TS` (`bit 3`): 如果为 `1`，表示时间戳 (`timestamp`) 的增量存在于 `Payload` 中。
    * `H_LAT` (`bit 2`): 如果为 `1`，表示纬度 (`latitude_scaled_1e5`) 的增量存在于 `Payload` 中。
    * `H_LON` (`bit 1`): 如果为 `1`，表示经度 (`longitude_scaled_1e5`) 的增量存在于 `Payload` 中。
    * `H_ALT` (`bit 0`): 如果为 `1`，表示海拔 (`altitude_m_scaled_1e1`) 的增量存在于 `Payload` 中。

    如果某个字段的增量为 `0`，则对应的标志位应为 `0`，并且该字段的增量值不包含在 `Payload` 中。

* **Payload**: 包含一个或多个 `varint_s32` 编码的增量值。这些增量值的出现顺序严格按照 `timestamp`, `latitude`, `longitude`, `altitude` 的顺序，但仅包含那些在 `Header` 中对应标志位为 `1` 的字段。

    * `delta_timestamp` (`varint_s32`, 可选)
    * `delta_latitude` (`varint_s32`, 可选)
    * `delta_longitude` (`varint_s32`, 可选)
    * `delta_altitude` (`varint_s32`, 可选)

* **Delta 计算**:
    对于每个字段（时间戳、纬度、经度、海拔）：
    `delta_value = current_value - previous_value`

    解码时：
    `current_value = previous_value + delta_value`

    如果 Header 中某个字段的标志位为 `0`，则表示该字段的 `delta_value` 为 `0`，即 `current_value = previous_value`。

### 7. 解码流程概要

1.  **初始化**:
    * 维护一个 "上一个数据点" (`PreviousPoint`) 的状态，初始为空。
2.  **读取数据块**:
    * 读取 1 字节的 `Header`。
3.  **判断块类型**:
    * 如果 `Header == 0xFF` (Full Block):
        1.  读取 16 字节的 `Payload`。
        2.  将 `Payload` 解析为一个 `GpxPointInternal` 结构体，得到 `CurrentPoint`。
        3.  将 `CurrentPoint` 存储/处理。
        4.  更新 `PreviousPoint = CurrentPoint`。
    * 如果 `Header` 的 `bit 7 == 0` (Delta Block, `Header = 0x0F`):
        1.  如果 `PreviousPoint` 为空（这意味着这是第一个数据块，但它不是 Full Block），则这是一个错误/无效的数据流。
        2.  从 `PreviousPoint` 初始化 `CurrentPoint` (即 `CurrentPoint = PreviousPoint`)。
        3.  解析 `Header` 的低 4 位 (`H_TS, H_LAT, H_LON, H_ALT`)。
        4.  **按顺序**检查标志位：
            * 如果 `H_TS == 1`: 从 `Payload` 读取一个 `varint_s32` 值作为 `delta_timestamp`，解码 ZigZag，然后 `CurrentPoint.timestamp = PreviousPoint.timestamp + decoded_delta_timestamp`。
            * 如果 `H_LAT == 1`: 从 `Payload` 读取一个 `varint_s32` 值作为 `delta_latitude`，解码 ZigZag，然后 `CurrentPoint.latitude_scaled_1e5 = PreviousPoint.latitude_scaled_1e5 + decoded_delta_latitude`。
            * 如果 `H_LON == 1`: 从 `Payload` 读取一个 `varint_s32` 值作为 `delta_longitude`，解码 ZigZag，然后 `CurrentPoint.longitude_scaled_1e5 = PreviousPoint.longitude_scaled_1e5 + decoded_delta_longitude`。
            * 如果 `H_ALT == 1`: 从 `Payload` 读取一个 `varint_s32` 值作为 `delta_altitude`，解码 ZigZag，然后 `CurrentPoint.altitude_m_scaled_1e1 = PreviousPoint.altitude_m_scaled_1e1 + decoded_delta_altitude`。
        5.  将 `CurrentPoint` 存储/处理。
        6.  更新 `PreviousPoint = CurrentPoint`。
4.  重复步骤 2-3 直到文件结束。

### 8. 示例

假设 `PreviousPoint` (上一个点) 为:
* `timestamp: 1678886400`
* `latitude_scaled_1e5: 35680000` (35.68000 度)
* `longitude_scaled_1e5: 139750000` (139.75000 度)
* `altitude_m_scaled_1e1: 500` (50.0 米)

**当前点** (`CurrentPoint`) 为:
* `timestamp: 1678886405`
* `latitude_scaled_1e5: 35680100`
* `longitude_scaled_1e5: 139750000` (未变化)
* `altitude_m_scaled_1e1: 525`

**计算增量**:
* `delta_timestamp = 1678886405 - 1678886400 = 5`
* `delta_latitude = 35680100 - 35680000 = 100`
* `delta_longitude = 139750000 - 139750000 = 0`
* `delta_altitude = 525 - 500 = 25`

**编码为 Delta Block**:

1.  **Header**:
    * `delta_timestamp != 0` -> `H_TS = 1`
    * `delta_latitude != 0` -> `H_LAT = 1`
    * `delta_longitude == 0` -> `H_LON = 0`
    * `delta_altitude != 0` -> `H_ALT = 1`
    * Header 掩码: `1101` (二进制) = `0xD`
    * Header 字节: `0x0D`

2.  **Payload**:
    * `delta_timestamp = 5`:
        * ZigZag(5) = `(5 << 1) ^ (5 >> 31) = 10 ^ 0 = 10` (0x0A)
        * Varint(10) = `0x0A` (1 字节)
    * `delta_latitude = 100`:
        * ZigZag(100) = `(100 << 1) ^ (100 >> 31) = 200 ^ 0 = 200` (0xC8)
        * Varint(200) = `0xC8 0x01` (2 字节: 200 = 128*1 + 72 -> 11001000, 00000001)
    * `delta_longitude = 0`: 不包含在 payload 中。
    * `delta_altitude = 25`:
        * ZigZag(25) = `(25 << 1) ^ (25 >> 31) = 50 ^ 0 = 50` (0x32)
        * Varint(50) = `0x32` (1 字节)

    Payload 字节序列 (假设小端序，Varint本身定义了字节序): `0x0A C8 01 32`

**最终 Delta Block**:
`0x0D 0A C8 01 32` (总共 1 + 1 + 2 + 1 = 5 字节)

相比之下，如果作为 Full Block 存储，则需要 1 + 16 = 17 字节。
