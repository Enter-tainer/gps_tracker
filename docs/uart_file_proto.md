# BLE UART 文件传输协议

## 1. 简介

本文档定义了通过 BLE UART 服务在主机（例如电脑、手机）和 nRF52 设备之间进行文件传输的协议。该协议允许主机浏览设备内部 Flash 上的文件系统、打开文件、读取文件内容以及关闭文件。

## 2. 协议基础

### 2.1. 传输层

本协议基于 BLE UART 服务进行数据传输。所有数据包都通过 UART 的 TX 和 RX 特性进行交换。

### 2.2. 字节序

所有多字节数值字段（例如长度、偏移量）均采用**小端字节序 (Little Endian)**。

### 2.3. 通用数据包结构

#### 2.3.1. 命令包 (主机 -> 设备)

```
+--------------+-----------------+--------------------+
| CMD ID (1B)  | Payload Len (2B)| Payload (Variable) |
+--------------+-----------------+--------------------+
```

*   **CMD ID**: 命令标识符 (见 3. 命令与响应标识符)。
*   **Payload Len**: `Payload` 字段的长度（字节数）。
*   **Payload**: 命令特定的数据。

#### 2.3.2. 响应包 (设备 -> 主机)

```
+-----------------+--------------------+
| Payload Len (2B)| Payload (Variable) |
+-----------------+--------------------+
```

*   **Payload Len**: `Payload` 字段的长度（字节数）。
*   **Payload**: 响应特定的数据。操作的成功或失败通过 `Payload Len` 和 `Payload` 内容来推断。

### 2.4. MTU (最大传输单元) 注意事项

*   BLE 的 ATT_MTU 限制了单个 BLE 包的最大长度。典型值可能是 23 字节（默认）到 517 字节（协商后）。
*   本协议设计时，单个命令或响应包（包括头部）应尽量适应协商后的 MTU 大小，以避免分片。
*   对于可能超过 MTU 的数据传输（如 `read_chunk` 的响应），协议层面需要进行数据分块处理。`read_chunk` 命令本身就是为了解决这个问题。

## 3. 命令与响应标识符

| 命令名称              | CMD ID | 描述                     |
| :-------------------- | :----- | :----------------------- |
| `LIST_DIR`            | `0x01` | 列出目录内容             |
| `OPEN_FILE`           | `0x02` | 打开文件                 |
| `READ_CHUNK`          | `0x03` | 读取文件块               |
| `CLOSE_FILE`          | `0x04` | 关闭文件                 |
| `DELETE_FILE`         | `0x05` | 删除文件                 |
| `GET_SYS_INFO`        | `0x06` | 查询设备系统信息         |
| `START_AGNSS_WRITE`   | `0x07` | 开始 AGNSS 数据写入      |
| `WRITE_AGNSS_CHUNK`   | `0x08` | 写入 AGNSS 数据块        |
| `END_AGNSS_WRITE`     | `0x09` | 结束 AGNSS 数据写入      |
| `GPS_WAKEUP`          | `0x0A` | 手动触发 GPS 唤醒        |
| `GPS_KEEP_ALIVE`      | `0x0B` | 设置 GPS 持续开启时长    |

## 4. 详细命令规范

### 4.1. `LIST_DIR`

*   **目的**: 列出指定目录下的文件和子目录。每次调用只返回一个文件或目录的信息。
*   **CMD ID**: `0x01`

#### 4.1.1. 命令包 (`LIST_DIR_CMD`)

*   **Payload**:
    ```
    +--------------------------+
    | Path Length (1B)         |
    +--------------------------+
    | Path (ASCII, Variable)   |
    +--------------------------+
    ```
    *   **Path Length**: `Path` 字段的长度。如果为 `0`，则表示列出根目录。
    *   **Path**: 要列出内容的目录路径，ASCII 编码。路径分隔符为 `/`。

#### 4.1.2. 响应包 (`LIST_DIR_RSP`)

*   **Payload**:
    ```
    +--------------------------+
    | More Flag (1B)           |
    +--------------------------+
    | Entry Type (1B)          |
    +--------------------------+
    | Name Length (1B)         |
    +--------------------------+
    | Name (ASCII, Variable)   |
    +--------------------------+
    // Optional: File Size (4B, Little Endian) if Entry Type is File
    +--------------------------+
    | File Size (4B)           |
    +--------------------------+
    ```
    *   **More Flag**:
        *   `0x00`: 目录中没有更多条目，这是最后一项。
        *   `0x01`: 目录中还有更多条目，可以再次发送 `LIST_DIR` 命令获取下一项。
    *   **Entry Type**:
        *   `0x00`: 文件 (File)
        *   `0x01`: 目录 (Directory)
    *   **Name Length**: `Name` 字段的长度。
    *   **Name**: 文件或目录的名称，ASCII 编码。
    *   **File Size**: (仅当 `Entry Type` 为文件时存在) 文件大小，单位字节，小端字节序。

*   **行为**:
    *   首次发送带有特定路径的 `LIST_DIR_CMD`，设备返回该目录下的第一个条目。
    *   如果 `More Flag` 为 `0x01`，再次发送相同路径的 `LIST_DIR_CMD` 时，设备简单地返回下一个条目。
    *   对于空目录，返回 `More Flag` 为 `0x00`，且不包含其他字段（`Payload Len` 为 `1`）。
    *   遍历目录尚未完成时，不得遍历其他目录。

### 4.2. `OPEN_FILE`

*   **目的**: 打开一个文件以供读取。设备一次只能打开一个文件。如果已有一个文件打开，则此命令会失败，除非先调用 `CLOSE_FILE`。
*   **CMD ID**: `0x02`

#### 4.2.1. 命令包 (`OPEN_FILE_CMD`)

*   **Payload**:
    ```
    +--------------------------+
    | File Path Length (1B)    |
    +--------------------------+
    | File Path (ASCII, Var)   |
    +--------------------------+
    ```
    *   **File Path Length**: `File Path` 字段的长度。
    *   **File Path**: 要打开的文件的完整路径，UTF-8 编码。

#### 4.2.2. 响应包 (`OPEN_FILE_RSP`)

*   **Payload** (如果成功):
    ```
    +--------------------------+
    | File Size (4B)           |
    +--------------------------+
    ```
    *   **File Size**: 文件总大小（字节），小端字节序。
*   **行为**:
    *   如果文件成功打开，响应包的 `Payload Len` 为 `4`，`Payload` 包含 `File Size`。
    *   如果文件不存在、无法打开或已有其他文件打开，响应包的 `Payload Len` 为 `0`。

### 4.3. `READ_CHUNK`

*   **目的**: 从当前打开的文件中读取一块数据。
*   **CMD ID**: `0x03`

#### 4.3.1. 命令包 (`READ_CHUNK_CMD`)

*   **Payload**:
    ```
    +--------------------------+
    | Offset (4B)              |
    +--------------------------+
    | Bytes to Read (2B)       |
    +--------------------------+
    ```
    *   **Offset**: 读取的起始偏移量（从文件开头计算，0-based），小端字节序。
    *   **Bytes to Read**: 希望读取的字节数，小端字节序。此值应小于等于 `ATT_MTU - (RSP Header Size)`。主机需要根据 BLE 的 MTU 来决定此值。

#### 4.3.2. 响应包 (`READ_CHUNK_RSP`)

*   **Payload**:
    ```
    +--------------------------+
    | Actual Bytes Read (2B)   |
    +--------------------------+
    | Data (Variable)          |
    +--------------------------+
    ```
    *   **Actual Bytes Read**: 实际读取到的字节数，小端字节序。
    *   **Data**: 读取到的文件数据。仅当 `Actual Bytes Read > 0` 时存在。
*   **行为**:
    *   如果读取成功，`Payload Len` = `2 + Actual Bytes Read`。`Actual Bytes Read` 为实际读取的字节数。
    *   如果 `Offset` 超出文件范围、没有文件被打开或发生其他读取错误，`Payload Len` 为 `2`，且 `Actual Bytes Read` 为 `0`。
    *   如果读取到文件末尾，`Actual Bytes Read` 会小于请求的 `Bytes to Read`。如果 `Offset` 就在文件末尾，`Actual Bytes Read` 为 `0` (此时 `Payload Len` 为 `2`)。
    *   主机应检查 `Actual Bytes Read` 来确定接收了多少数据。
    *   **MTU 处理**: 主机请求的 `Bytes to Read` 必须考虑到响应包的头部大小 (`RSP ID`, `Payload Len`, `Actual Bytes Read`)，确保整个响应包不超过 MTU。
        *   `Max Data per RSP = Negotiated_MTU - (1+2+2)` (RSP ID + Payload Len字段 + Actual Bytes Read 字段)
        *   主机请求的 `Bytes to Read` 应 `<= Max Data per RSP`。

### 4.4. `CLOSE_FILE`

*   **目的**: 关闭当前打开的文件。
*   **CMD ID**: `0x04`

#### 4.4.1. 命令包 (`CLOSE_FILE_CMD`)

*   **Payload**: 无。(`Payload Len` 为 `0`)

#### 4.4.2. 响应包 (`CLOSE_FILE_RSP`)

*   **Payload**: 无。(`Payload Len` 为 `0`)
*   **行为**:
    *   收到此响应包（`Payload Len` 为 `0`）即表示操作完成。设备应确保文件已关闭。

### 4.5. `DELETE_FILE`

*   **目的**: 删除指定路径的文件。仅支持删除文件，不支持删除目录。
*   **CMD ID**: `0x05`

#### 4.5.1. 命令包 (`DELETE_FILE_CMD`)

*   **Payload**:
    ```
    +--------------------------+
    | File Path Length (1B)    |
    +--------------------------+
    | File Path (ASCII, Var)   |
    +--------------------------+
    ```
    *   **File Path Length**: `File Path` 字段的长度。
    *   **File Path**: 要删除的文件完整路径，UTF-8 编码。

#### 4.5.2. 响应包 (`DELETE_FILE_RSP`)

*   **Payload**:
    *   成功: `Payload Len` 为 `0`，无内容。
    *   失败: `Payload Len` 为 `0`，无内容。
*   **行为**:
    *   如果文件删除成功，响应包 `Payload Len` 为 `0`。
    *   如果文件不存在、路径非法或删除失败，响应包 `Payload Len` 也为 `0`。
    *   主机可通过后续 `LIST_DIR` 命令确认文件是否已被删除。

### 4.6. `GET_SYS_INFO`

*   **目的**: 主机主动查询设备当前系统信息（如 GPS 状态、电池电压等）。
*   **CMD ID**: `0x06`

#### 4.6.1. 命令包 (`GET_SYS_INFO_CMD`)

*   **Payload**: 无（`Payload Len` 为 `0`）

#### 4.6.2. 响应包 (`GET_SYS_INFO_RSP`)

*   **版本说明**: 支持 V1 (50 字节) 和 V2 (63 字节) 两种格式，主机通过 payload 长度区分。

*   **V1 格式 (50 字节, master 分支)**:
    ```
    +--------------------------+
    | latitude (8B, double)    |
    +--------------------------+
    | longitude (8B, double)   |
    +--------------------------+
    | altitude (4B, float)     |
    +--------------------------+
    | satellites (4B, uint32)  |
    +--------------------------+
    | hdop (4B, float)         |
    +--------------------------+
    | speed (4B, float)        |
    +--------------------------+
    | course (4B, float)       |
    +--------------------------+
    | year (2B, uint16)        |
    +--------------------------+
    | month (1B, uint8)        |
    +--------------------------+
    | day (1B, uint8)          |
    +--------------------------+
    | hour (1B, uint8)         |
    +--------------------------+
    | minute (1B, uint8)       |
    +--------------------------+
    | second (1B, uint8)       |
    +--------------------------+
    | locationValid (1B, uint8)|
    +--------------------------+
    | dateTimeValid (1B, uint8)|
    +--------------------------+
    | batteryVoltage (4B, float)|
    +--------------------------+
    | gpsState (1B, uint8)     |
    +--------------------------+
    ```

*   **V2 格式 (63 字节, 当前版本)**:
    ```
    +--------------------------+
    | version (1B, uint8) = 2  |
    +--------------------------+
    | [上述 50 字节 legacy]    |
    +--------------------------+
    | keepAliveRemainingS      |
    | (2B, uint16)             |
    +--------------------------+
    | batteryPercent (1B, u8)  |
    +--------------------------+
    | isStationary (1B, u8)    |
    +--------------------------+
    | temperatureC (4B, float) |
    +--------------------------+
    | pressurePa (4B, float)   |
    +--------------------------+
    ```
    *   `version`: 版本号，V2 = 2
    *   `batteryPercent`: 电池百分比 (0-100)
    *   `isStationary`: 设备是否静止 (0/1)
    *   `temperatureC`: BMP280 温度（摄氏度）
    *   `pressurePa`: BMP280 气压（帕斯卡）
    *   `keepAliveRemainingS`：GPS keep-alive 剩余秒数，0 表示未激活

*   **行为**:
    *   主机发送 `GET_SYS_INFO` 命令，设备立即返回当前系统信息。
    *   响应包长度：V1 = 50 字节，V2 = 63 字节。
    *   字段均为小端字节序。

### 4.7. `START_AGNSS_WRITE`

*   **目的**: 开始 AGNSS 数据写入传输。
*   **CMD ID**: `0x07`

#### 4.7.1. 命令包 (`START_AGNSS_WRITE_CMD`)

*   **Payload**: 无

#### 4.7.2. 响应包 (`START_AGNSS_WRITE_RSP`)

*   **Payload**: 无（`Payload Len` 为 `0`）
*   **行为**: 收到此响应包即表示设备准备接收 AGNSS 数据。

### 4.8. `WRITE_AGNSS_CHUNK`

*   **目的**: 传输一块 AGNSS 数据。
*   **CMD ID**: `0x08`

#### 4.8.1. 命令包 (`WRITE_AGNSS_CHUNK_CMD`)

*   **Payload**:
    ```
    +--------------------------+
    | Chunk Size (2B)          |
    +--------------------------+
    | Data (Variable)          |
    +--------------------------+
    ```
    *   **Chunk Size**: `Data` 字段的大小（字节），小端字节序。
    *   **Data**: 要写入的 AGNSS 数据块。大小应考虑 MTU 限制。

#### 4.8.2. 响应包 (`WRITE_AGNSS_CHUNK_RSP`)

*   **Payload**: 无（`Payload Len` 为 `0`）
*   **行为**: 收到此响应包即表示 AGNSS 数据块写入成功。

### 4.9. `END_AGNSS_WRITE`

*   **目的**: 结束当前的 AGNSS 数据写入传输。
*   **CMD ID**: `0x09`

#### 4.9.1. 命令包 (`END_AGNSS_WRITE_CMD`)

*   **Payload**: 无（`Payload Len` 为 `0`）

#### 4.9.2. 响应包 (`END_AGNSS_WRITE_RSP`)

*   **Payload**: 无（`Payload Len` 为 `0`）

*   **行为**:
    *   设备收到 `END_AGNSS_WRITE` 命令后，完成 AGNSS 数据处理。
    *   设备会将 AGNSS 数据发送给 GPS 模块。
    *   收到响应包即表示 AGNSS 数据传输完成。

### 4.10. `GPS_WAKEUP`

*   **目的**: 手动触发 GPS 唤醒，模拟运动检测以启动 GPS 定位。
*   **CMD ID**: `0x0A`

#### 4.10.1. 命令包 (`GPS_WAKEUP_CMD`)

*   **Payload**: 无（`Payload Len` 为 `0`）

#### 4.10.2. 响应包 (`GPS_WAKEUP_RSP`)

*   **Payload**: 无（`Payload Len` 为 `0`）
*   **行为**:
    *   设备收到此命令后，会模拟运动检测信号。
    *   如果 GPS 当前处于关闭状态 (`S2_IDLE_GPS_OFF`)，会立即启动 GPS 并开始搜索定位。
    *   如果 GPS 已经在工作状态，会记录运动检测但不改变当前状态。
    *   收到响应包即表示唤醒命令已执行。

### 4.11. `GPS_KEEP_ALIVE`

*   **目的**: 设置 GPS 持续开启时长，在指定时间内阻止 GPS 因静止而关闭。
*   **CMD ID**: `0x0B`

#### 4.11.1. 命令包 (`GPS_KEEP_ALIVE_CMD`)

*   **Payload** (`2` 字节):
    | 字段              | 大小 (字节) | 类型       | 描述                                              |
    | :---------------- | :---------- | :--------- | :------------------------------------------------ |
    | `Duration`        | 2           | uint16\_LE | 持续开启时长（分钟）。`0` = 取消当前的 Keep-Alive。 |

#### 4.11.2. 响应包 (`GPS_KEEP_ALIVE_RSP`)

*   **Payload**: 无（`Payload Len` 为 `0`）
*   **行为**:
    *   设备收到此命令后，GPS 将在指定时间内保持开启，不因静止检测而进入 S2 休眠状态。
    *   如果 GPS 当前处于关闭状态 (`S2_IDLE_GPS_OFF`)，会立即启动 GPS 并开始搜索定位。
    *   在 Keep-Alive 期间，S1 搜星超时后不会进入 S2，而是继续重试。
    *   发送 `Duration = 0` 可立即取消 Keep-Alive，恢复正常功耗管理。
    *   Keep-Alive 到期后自动恢复正常状态机行为。

## 5. 流程示例

### 5.1. 列出根目录并读取文件 "/log.txt"


1.  **主机发送 `LIST_DIR` 命令 (列出根目录)**
    *   `CMD ID`: `0x01`
    *   `Payload Len`: `1` (Path Length 字段本身)
    *   `Payload`:
        *   `Path Length`: `0x01`
        *   `Path`: `/` (ASCII: `2F`)
    *   设备的根目录为 `/`，主机希望列出该目录下的所有文件和子目录。

2.  **设备发送一个或多个 `LIST_DIR_RSP` 响应包**
    *   主机持续接收，直到某个包的 `Finish Flag` 为 `0x01`。
    *   假设在这些响应中，主机找到了名为 "log.txt" 且类型为文件的条目。

3.  **主机发送 `OPEN_FILE` 命令 (打开 "/log.txt")**
    *   `CMD ID`: `0x02`
    *   `Payload Len`: `1 + 8` (File Path Length 字段 + "/log.txt" 的长度)
    *   `Payload`:
        *   `File Path Length`: `0x08`
        *   `File Path`: `/log.txt` (ASCII: `2F 6C 6F 67 2E 74 78 74`)

4.  **设备发送 `OPEN_FILE_RSP` 响应包**
    *   如果成功:
        *   `Payload Len`: `4`
        *   `Payload`: `File Size` (例如，如果文件大小为 1024 字节，则为 `00 04 00 00` 小端)
    *   如果失败 (例如文件不存在):
        *   `Payload Len`: `0`
    *   主机记录文件大小。

5.  **主机循环发送 `READ_CHUNK` 命令以读取文件内容**
    *   假设文件大小为 `TOTAL_FILE_SIZE`，主机选择一次读取 `CHUNK_SIZE` 字节 (需考虑 MTU)。
    *   **第一次读取:**
        *   `CMD ID`: `0x03`
        *   `Payload Len`: `6` (Offset 4B + Bytes to Read 2B)
        *   `Payload`:
            *   `Offset`: `0x00000000`
            *   `Bytes to Read`: `CHUNK_SIZE` (例如 `0x0080` 表示 128 字节)
    *   **设备发送 `READ_CHUNK_RSP` 响应包:**
        *   `Payload Len`: `2 + Actual Bytes Read`
        *   `Payload`:
            *   `Actual Bytes Read`: 实际读取的字节数 (例如 `0x0080`)
            *   `Data`: 文件数据
    *   主机将接收到的数据追加到本地缓冲区。
    *   **后续读取:**
        *   主机更新 `Offset` (上一轮 `Offset + Actual Bytes Read`)。
        *   继续发送 `READ_CHUNK_CMD` 直到读取完整文件 (总读取字节数达到 `TOTAL_FILE_SIZE` 或 `Actual Bytes Read` 为 0)。

6.  **文件读取完毕后，主机发送 `CLOSE_FILE` 命令**
    *   `CMD ID`: `0x04`
    *   `Payload Len`: `0`

7.  **设备发送 `CLOSE_FILE_RSP` 响应包**
    *   `Payload Len`: `0`
    *   主机确认文件已关闭。

### 5.2. 传输 AGNSS 数据到设备

1.  **主机发送 `START_AGNSS_WRITE` 命令 (开始 AGNSS 数据传输)**
    *   `CMD ID`: `0x07`
    *   `Payload Len`: `4` (Total Size)
    *   `Payload`:
        *   `Total Size`: AGNSS 数据的总大小 (例如 `0x00000800` 表示 2048 字节，小端)

2.  **设备发送 `START_AGNSS_WRITE_RSP` 响应包**
    *   `Payload Len`: `0`
    *   主机确认设备准备接收 AGNSS 数据。

3.  **主机循环发送 `WRITE_AGNSS_CHUNK` 命令传输数据**
    *   假设总数据大小为 `TOTAL_DATA_SIZE`，主机选择一次传输 `CHUNK_SIZE` 字节 (需考虑 MTU)。
    *   **第一次传输:**
        *   `CMD ID`: `0x08`
        *   `Payload Len`: `2 + CHUNK_SIZE` (Chunk Size + Data)
        *   `Payload`:
            *   `Chunk Size`: 当前块大小 (例如 `0x0080` 表示 128 字节)
            *   `Data`: AGNSS 数据的第一块
    *   **设备发送 `WRITE_AGNSS_CHUNK_RSP` 响应包:**
        *   `Payload Len`: `0`
    *   **后续传输:**
        *   继续发送 `WRITE_AGNSS_CHUNK_CMD` 直到传输完所有 AGNSS 数据。

4.  **数据传输完毕后，主机发送 `END_AGNSS_WRITE` 命令**
    *   `CMD ID`: `0x09`
    *   `Payload Len`: `0`

5.  **设备发送 `END_AGNSS_WRITE_RSP` 响应包**
    *   `Payload Len`: `0`

6.  **传输完成**
    *   设备将 AGNSS 数据发送给 GPS 模块以加速定位。

### 5.3. 手动触发 GPS 唤醒

1.  **主机发送 `GPS_WAKEUP` 命令**
    *   `CMD ID`: `0x0A`
    *   `Payload Len`: `0`
    *   `Payload`: 无

2.  **设备发送 `GPS_WAKEUP_RSP` 响应包**
    *   `Payload Len`: `0`
    *   设备会模拟运动检测，如果 GPS 处于关闭状态则立即启动 GPS 定位。

3.  **唤醒完成**
    *   GPS 开始工作，设备状态转换为定位搜索模式。

## 6. MTU 考虑

*   主机在 `WRITE_AGNSS_CHUNK` 命令中发送的数据大小应考虑 BLE MTU 限制。
*   推荐的最大数据块大小: `Negotiated_MTU - (1+2+2)` (CMD ID + Payload Len + Chunk Size)
*   对于典型的 BLE MTU (23-517 字节)，建议单个数据块不超过 100-500 字节。

## 7. 协议版本和兼容性

*   当前协议版本: 1.2
*   新增的 GPS 唤醒功能保持向后兼容，不影响现有的文件读取和 AGNSS 功能。
