好的，我们来整理一份详细的GPS功耗与定位优化状态机设计规范文档。

---

**GPS功耗与定位优化状态机设计规范**

**版本**: 1.0
**日期**: 2025-05-25

**目录**
1.  引言
    1.1. 目的
    1.2. 范围
    1.3. 术语与定义
2.  系统组件
3.  设计目标
4.  关键常量与定时器定义
5.  状态机定义
    5.1. 状态列表
6.  状态详解
    6.1. S0\_INITIALIZING (初始化中)
    6.2. S1\_GPS\_SEARCHING\_FIX (GPS搜星定位中)
    6.3. S2\_IDLE\_GPS\_OFF (空闲GPS关闭/休眠模式)
    6.4. S3\_TRACKING\_FIXED (已定位，活动追踪模式)
    6.5. S4\_ANALYZING\_STILLNESS (分析静止状态性质)
    6.6. S5\_AGNSS\_PROCESSING (AGNSS数据注入处理中)
7.  核心逻辑交互
    7.1. 加速度传感器管理
    7.2. GPS模块控制
    7.3. AGNSS数据注入管理
8.  鲁棒性与异常处理考量
9.  待定与未来考虑

---

**1. 引言**

1.1. **目的**
本文档旨在详细定义一个用于便携式设备或物联网设备的GPS功耗与定位优化状态机。该状态机通过结合加速度传感器数据和GPS模块的智能控制，旨在平衡精确定位需求与设备功耗限制，延长设备续航时间。

1.2. **范围**
本文档描述了状态机的各个状态、状态之间的转换条件、每个状态下的行为、以及相关的事件和定时器。本文档不涉及具体硬件实现代码，但为软件实现提供清晰的逻辑指导。

1.3. **术语与定义**
*   **GPS**: 全球定位系统 (Global Positioning System)。
*   **加速度传感器 (Accel)**: 用于检测设备运动状态和加速度变化的传感器。
*   **GPS Fix**: GPS模块成功计算出当前位置信息。
*   **HDOP**: 水平精度因子 (Horizontal Dilution of Precision)，衡量GPS定位在水平方向上的精度，值越小精度越高。
*   **Power ON/OFF**: 指对GPS模块的供电控制或使其进入/退出低功耗工作模式。
*   **NMEA**: GPS模块输出数据的标准格式。
*   **AGNSS**: 辅助式全球卫星导航系统 (Assisted GNSS)，通过注入星历数据等辅助信息来加速GPS定位。
*   **CASIC协议**: 中科微电子的二进制通信协议，用于GPS模块的配置和数据传输。
*   **AID-INI**: CASIC协议中的辅助初始化命令，包含位置、时间、频率等初始信息。
*   **ACK/NACK**: 确认/否定应答消息，用于确认数据包的接收状态。

**2. 系统组件**
本设计依赖以下核心硬件组件：
*   **微控制器 (MCU)**: 运行状态机逻辑。
*   **加速度传感器**: 提供运动状态数据。
*   **GPS模块**: 提供定位、速度、时间等数据。

**3. 设计目标**
*   **节省功耗**: 在设备静止或不需要高频定位时，最大限度降低GPS模块的功耗。
*   **精确定位**: 在设备运动或需要定位时，及时、准确地提供定位信息。
*   **场景适应性**: 能够根据设备所处环境（如室内、室外、交通工具中）自动调整工作模式。
*   **鲁棒性**: 对GPS信号丢失、搜星失败等情况有合理的处理机制。

**4. 关键常量与定时器定义**
以下常量和定时器为状态机逻辑的基础，具体数值可根据实际应用场景调整。

| 名称                                      | 符号                                     | 建议值        | 单位    | 描述                                                                 |
| :---------------------------------------- | :--------------------------------------- | :----------- | :------ | :------------------------------------------------------------------- |
| 活动追踪采样间隔                          | `T_ACTIVE_SAMPLING_INTERVAL`             | 10           | 秒      | `S3_TRACKING_FIXED`状态下获取GPS定位的周期。                           |
| 加速度静止阈值                            | `ACCEL_STILL_THRESHOLD`                  | 0.1          | g       | 低于此加速度值认为设备可能处于静止状态。                             |
| 持续静止确认时长                          | `T_STILLNESS_CONFIRM_DURATION`           | 60           | 秒      | 加速度持续低于静止阈值此有时长后，确认为设备进入持续静止状态。         |
| GPS速度判断车辆阈值                       | `GPS_SPEED_VEHICLE_THRESHOLD`            | 5            | km/h    | `S4_ANALYZING_STILLNESS`状态下，用于判断是否为交通工具短暂停留的GPS速度阈值。 |
| GPS高速运动阈值                           | `GPS_HIGH_SPEED_THRESHOLD`               | 20           | km/h    | 平均速度超过此阈值时，忽略HDOP检查，只要求卫星数 > 4。               |
| S4分析静止状态GPS查询超时                 | `T_GPS_QUERY_TIMEOUT_FOR_STILLNESS`      | 5            | 秒      | 在`S4`状态下，等待获取GPS当前速度和状态的超时时间。                    |
| GPS冷/温启动搜星定位超时                  | `T_GPS_COLD_START_FIX_TIMEOUT`           | 90           | 秒      | 从GPS关闭状态启动后，尝试获取首次定位的最大允许时间。                  |
| GPS重捕获定位超时                         | `T_GPS_REACQUIRE_FIX_TIMEOUT`            | 30           | 秒      | 在已有定位后信号丢失，尝试重新获取定位的最大允许时间。                 |
| 有效定位最小HDOP                          | `MIN_HDOP_FOR_VALID_FIX`                 | 2.0          | (float) | HDOP值小于此值才认为是一次有效的定位（低速场景）。                   |
| GPS连续搜星失败次数阈值                   | `MAX_CONSECUTIVE_FIX_FAILURES`           | 16            | 次      | 连续搜星失败达到此次数后，可能采取特殊操作（如GPS模块重启）。            |
| 加速度数据采样/处理频率                   | (非直接状态机定时器，但为前提)             | 20         | Hz      | 加速度传感器采样数据的频率，用于及时检测运动和静止。                   |
| AGNSS单条消息发送超时                     | `T_AGNSS_MESSAGE_SEND_TIMEOUT`           | 5            | 秒      | 发送单条AGNSS消息并等待ACK的超时时间。                              |
| AGNSS整体处理超时                         | `T_AGNSS_TOTAL_TIMEOUT`                  | 60           | 秒      | AGNSS整体注入过程的最大超时时间。                                   |
| AGNSS消息重发最大次数                     | `MAX_AGNSS_MESSAGE_RETRY`                | 3            | 次      | 单条AGNSS消息发送失败后的最大重试次数。                             |

**内部变量 (非固定常量，由状态机维护):**
*   `Stillness_Confirm_Timer`: 用于计时`T_STILLNESS_CONFIRM_DURATION`。
*   `Active_Sampling_Timer`: 用于计时`T_ACTIVE_SAMPLING_INTERVAL`。
*   `Fix_Attempt_Timer`: 用于计时当前的搜星超时 (`T_GPS_COLD_START_FIX_TIMEOUT` 或 `T_GPS_REACQUIRE_FIX_TIMEOUT`)。
*   `GPS_Query_Timeout_Timer_S4`: 用于计时`T_GPS_QUERY_TIMEOUT_FOR_STILLNESS`。
*   `Consecutive_Fix_Failures_Counter`: 连续搜星失败计数器。
*   `AGNSS_Message_Timer`: 用于计时`T_AGNSS_MESSAGE_SEND_TIMEOUT`。
*   `AGNSS_Total_Timer`: 用于计时`T_AGNSS_TOTAL_TIMEOUT`。
*   `AGNSS_Message_Queue`: AGNSS消息队列，存储待发送的消息列表。
*   `AGNSS_Current_Message_Index`: 当前正在发送的AGNSS消息索引。
*   `AGNSS_Current_Message_Retry_Count`: 当前消息的重试次数。
*   `AGNSS_Previous_State`: 进入AGNSS处理前的状态，用于完成后返回。

**5. 状态机定义**

5.1. **状态列表**
*   **S0\_INITIALIZING**: 初始化中
*   **S1\_GPS\_SEARCHING\_FIX**: GPS搜星定位中
*   **S2\_IDLE\_GPS\_OFF**: 空闲GPS关闭/休眠模式
*   **S3\_TRACKING\_FIXED**: 已定位，活动追踪模式
*   **S4\_ANALYZING\_STILLNESS**: 分析静止状态性质
*   **S5\_AGNSS\_PROCESSING**: AGNSS数据注入处理中

**6. 状态详解**

---
**6.1. S0\_INITIALIZING (初始化中)**
*   **描述**: 系统启动后的初始状态，进行必要的硬件和软件初始化。
*   **进入动作**:
    1.  执行MCU、时钟等基础初始化。
    2.  初始化加速度传感器模块。
    3.  初始化GPS模块（例如：配置串口通信参数、发送初始配置指令给GPS模块）。
    4.  （可选）如果默认启动后立即尝试定位：Power ON GPS模块。
*   **事件处理**:
    *   **事件**: `E0.1_Initialization_Complete` (所有初始化任务完成)
        *   **动作**:
            *   如果默认启动后立即尝试定位：启动 `Fix_Attempt_Timer` (使用 `T_GPS_COLD_START_FIX_TIMEOUT` 作为时长)。
            *   否则 (默认省电，等待运动触发)：Power OFF GPS模块 (确保关闭)。
        *   **下一状态**:
            *   如果尝试定位: `S1_GPS_SEARCHING_FIX`
            *   否则: `S2_IDLE_GPS_OFF`

---
**6.2. S1\_GPS\_SEARCHING\_FIX (GPS搜星定位中)**
*   **描述**: GPS模块已上电，正在尝试获取有效的GPS定位信息（包括位置、时间、HDOP等）。
*   **进入动作**:
    1.  确保GPS模块已 Power ON。
    2.  向GPS模块发送开始定位指令 (如果需要)。
    3.  根据进入此状态的来源，设置并启动 `Fix_Attempt_Timer`：
        *   来自S0 (首次启动) 或 S2 (休眠唤醒)：使用 `T_GPS_COLD_START_FIX_TIMEOUT`。
        *   来自S3 (信号丢失后重捕获)：使用 `T_GPS_REACQUIRE_FIX_TIMEOUT`。
    4.  (如果从S2进入) 清零 `Consecutive_Fix_Failures_Counter` (或在首次进入S1时清零)。
*   **事件处理**:
    *   **事件**: `E1.1_GPS_Fix_Acquired`
        *   **条件**: 从GPS模块接收到数据，且数据满足有效定位标准 (e.g., `gps.location.isValid()`, `gps.time.isValid()`, `gps.hdop.value() <= MIN_HDOP_FOR_VALID_FIX`)。
        *   **动作**:
            1.  停止 `Fix_Attempt_Timer`。
            2.  记录/处理获取到的GPS定位信息 (例如：更新系统时间、经纬度等)。
            3.  清零 `Consecutive_Fix_Failures_Counter`。
            4.  启动 `Active_Sampling_Timer` (使用 `T_ACTIVE_SAMPLING_INTERVAL` 作为时长)。
            5.  清除 `Stillness_Confirm_Timer` (如果意外残留)。
        *   **下一状态**: `S3_TRACKING_FIXED`
    *   **事件**: `E1.2_Fix_Attempt_Timer_Expired` (`Fix_Attempt_Timer` 超时)
        *   **动作**:
            1.  增加 `Consecutive_Fix_Failures_Counter`。
            2.  **如果** `Consecutive_Fix_Failures_Counter >= MAX_CONSECUTIVE_FIX_FAILURES`:
                *   (可选) 执行GPS模块重启命令 (e.g., `PCAS10,1` 热启动，或更强的冷启动命令)。
                *   重置 `Consecutive_Fix_Failures_Counter` 为 0。
            3.  Power OFF GPS模块。
        *   **下一状态**: `S2_IDLE_GPS_OFF`
    *   **事件**: `E1.3_Motion_Detected_During_Search` (加速度瞬时值 `> ACCEL_STILL_THRESHOLD`)
        *   **动作**: (通常情况下) 无特殊动作，继续当前搜星过程。搜星过程不应被短期运动打断。
            *   (可选高级策略): 如果认为运动意味着环境变化有利于搜星，可以考虑重置 `Fix_Attempt_Timer`，但这可能增加功耗。本规范默认不重置。
        *   **下一状态**: `S1_GPS_SEARCHING_FIX` (保持当前状态)
    *   **事件**: `E1.4_Significant_Stillness_During_Search`
        *   **条件**: 在搜星期间，加速度持续低于 `ACCEL_STILL_THRESHOLD` 达到一个预设较短时长 (例如 `T_STILLNESS_CONFIRM_DURATION / 2`，以避免在明显无望搜星的静止场景下（如深层室内）空耗电)。这是一个可选的优化。
        *   **动作**: (如果启用此优化)
            1.  停止 `Fix_Attempt_Timer`。
            2.  Power OFF GPS模块。
        *   **下一状态**: `S2_IDLE_GPS_OFF`
    *   **事件**: `E1.5_AGNSS_Request` (外部触发AGNSS数据注入请求)
        *   **动作**:
            1.  停止 `Fix_Attempt_Timer`。
            2.  记录当前状态为 `AGNSS_Previous_State = S1_GPS_SEARCHING_FIX`。
            3.  确保GPS模块已 Power ON。
            4.  初始化AGNSS相关变量。
        *   **下一状态**: `S5_AGNSS_PROCESSING`

---
**6.3. S2\_IDLE\_GPS\_OFF (空闲GPS关闭/休眠模式)**
*   **描述**: GPS模块已关闭电源或进入深度休眠状态，以最大限度节省功耗。加速度传感器持续工作以检测运动。S2仅通过运动检测、外部BLE唤醒命令或AGNSS请求退出，不再进行周期性唤醒（已移除，因A-GNSS注入已能解决冷启动问题）。
*   **进入动作**:
    1.  确保GPS模块已 Power OFF 或进入深度休眠。
*   **事件处理**:
    *   **事件**: `E2.1_Motion_Detected` (加速度瞬时值 `> ACCEL_STILL_THRESHOLD`，或外部GPS唤醒/Keep-Alive命令)
        *   **动作**:
            1.  Power ON GPS模块。
            2.  启动 `Fix_Attempt_Timer` (使用 `T_GPS_COLD_START_FIX_TIMEOUT` 作为时长)。
        *   **下一状态**: `S1_GPS_SEARCHING_FIX`
    *   **事件**: `E2.2_AGNSS_Request` (外部触发AGNSS数据注入请求)
        *   **动作**:
            1.  记录当前状态为 `AGNSS_Previous_State = S2_IDLE_GPS_OFF`。
            2.  Power ON GPS模块。
            3.  初始化AGNSS相关变量。
        *   **下一状态**: `S5_AGNSS_PROCESSING`

---
**6.4. S3\_TRACKING\_FIXED (已定位，活动追踪模式)**
*   **描述**: GPS已获得有效定位，并按 `T_ACTIVE_SAMPLING_INTERVAL` 周期性采样/处理定位数据。加速度传感器持续监控运动状态。
*   **进入动作**: (从`S1`转换而来时，`Active_Sampling_Timer` 已启动，定位信息已获取)。
    1.  确保 `Stillness_Confirm_Timer` 已停止/复位。
*   **事件处理**:
    *   **事件**: `E3.1_Active_Sampling_Timer_Expired` (`Active_Sampling_Timer` 超时)
        *   **动作**:
            1.  请求/读取GPS模块当前最新的定位数据（通常GPS模块会持续输出NMEA，此步骤为解析最新数据）。
            2.  处理GPS数据（例如：记录GPX航迹点、更新UI显示、发送数据等）。
            3.  重启 `Active_Sampling_Timer`。
        *   **下一状态**: `S3_TRACKING_FIXED` (保持当前状态)
    *   **事件**: `E3.2_Motion_Sensed` (加速度瞬时值 `> ACCEL_STILL_THRESHOLD`)
        *   **动作**:
            1.  **如果** `Stillness_Confirm_Timer` 正在运行，则停止并复位它。 (表示设备重新开始运动)。
        *   **下一状态**: `S3_TRACKING_FIXED` (保持当前状态)
    *   **事件**: `E3.3_Potential_Stillness_Sensed` (加速度瞬时值 `< ACCEL_STILL_THRESHOLD`)
        *   **动作**:
            1.  **如果** `Stillness_Confirm_Timer` 未运行，则启动它 (使用 `T_STILLNESS_CONFIRM_DURATION` 作为时长)。 (开始监测是否为持续静止)。
        *   **下一状态**: `S3_TRACKING_FIXED` (保持当前状态，同时计时)
    *   **事件**: `E3.4_Stillness_Confirmed` (`Stillness_Confirm_Timer` 超时)
        *   **动作**:
            1.  停止 `Active_Sampling_Timer`。
            2.  (GPS模块此时仍保持 Power ON)。
        *   **下一状态**: `S4_ANALYZING_STILLNESS`
    *   **事件**: `E3.5_GPS_Signal_Lost_Or_Degraded`
        *   **条件**: 连续多次从GPS模块获取的数据无效 (e.g., `!gps.location.isValid()` 或 HDOP持续高于 `MIN_HDOP_FOR_VALID_FIX` 一段时间)。
        *   **动作**:
            1.  停止 `Active_Sampling_Timer`。
            2.  停止并复位 `Stillness_Confirm_Timer` (如果正在运行)。
            3.  (GPS模块此时仍保持 Power ON)。
            4.  启动 `Fix_Attempt_Timer` (使用 `T_GPS_REACQUIRE_FIX_TIMEOUT` 作为时长)。
        *   **下一状态**: `S1_GPS_SEARCHING_FIX`
    *   **事件**: `E3.6_AGNSS_Request` (外部触发AGNSS数据注入请求)
        *   **动作**:
            1.  停止 `Active_Sampling_Timer`。
            2.  停止并复位 `Stillness_Confirm_Timer` (如果正在运行)。
            3.  记录当前状态为 `AGNSS_Previous_State = S3_TRACKING_FIXED`。
            4.  确保GPS模块已 Power ON。
            5.  初始化AGNSS相关变量。
        *   **下一状态**: `S5_AGNSS_PROCESSING`

---
**6.5. S4\_ANALYZING\_STILLNESS (分析静止状态性质)**
*   **描述**: 设备已被加速度传感器确认为持续静止状态 (`T_STILLNESS_CONFIRM_DURATION` 已到)。GPS模块在此状态进入时仍处于Power ON状态。此状态的目的是根据当前的GPS数据（主要是速度和信号质量）决策下一步是返回追踪模式还是进入GPS休眠模式以节省功耗。
*   **进入动作**:
    1.  立即尝试从GPS模块获取当前最新的数据（尤其是速度 `gps.speed.kmph()` 和定位有效性 `gps.location.isValid()`）。
    2.  启动 `GPS_Query_Timeout_Timer_S4` (使用 `T_GPS_QUERY_TIMEOUT_FOR_STILLNESS` 作为时长)。
*   **事件处理**:
    *   **事件**: `E4.1_Motion_Detected_During_Analysis` (加速度瞬时值 `> ACCEL_STILL_THRESHOLD`)
        *   **动作**:
            1.  停止 `GPS_Query_Timeout_Timer_S4`。
            2.  启动 `Active_Sampling_Timer`。
            3.  (GPS模块保持 Power ON)。
        *   **下一状态**: `S3_TRACKING_FIXED` (设备再次运动，立即恢复追踪)
    *   **事件**: `E4.2_GPS_Query_Results_Received` (在 `GPS_Query_Timeout_Timer_S4` 超时前，成功获取到来自GPS模块的最新数据)
        *   **动作**:
            1.  停止 `GPS_Query_Timeout_Timer_S4`。
            2.  **决策逻辑**:
                *   **Case 1: 交通工具短暂停止**
                    *   **条件**: GPS数据有效 (`gps.location.isValid()`) 并且 GPS报告的速度 `gps.speed.kmph() > GPS_SPEED_VEHICLE_THRESHOLD`。
                    *   **后续动作**: 启动 `Active_Sampling_Timer`。 (GPS模块保持 Power ON)。
                    *   **下一状态**: `S3_TRACKING_FIXED` (返回活动追踪模式)
                *   **Case 2: 室内/信号极差 或 户外低速静止**
                    *   **条件**: GPS数据无效 (`!gps.location.isValid()` 或 HDOP非常差) **或者** (GPS数据有效 且 GPS报告的速度 `gps.speed.kmph() <= GPS_SPEED_VEHICLE_THRESHOLD`)。
                    *   **后续动作**: Power OFF GPS模块。
                    *   **下一状态**: `S2_IDLE_GPS_OFF` (进入GPS休眠省电模式)
    *   **事件**: `E4.3_GPS_Query_Timeout_Timer_S4_Expired` (`GPS_Query_Timeout_Timer_S4` 超时)
        *   **动作**: (未能及时从GPS模块获取明确数据，采取保守省电策略)
            1.  Power OFF GPS模块。
        *   **下一状态**: `S2_IDLE_GPS_OFF`
    *   **事件**: `E4.4_AGNSS_Request` (外部触发AGNSS数据注入请求)
        *   **动作**:
            1.  停止 `GPS_Query_Timeout_Timer_S4`。
            2.  记录当前状态为 `AGNSS_Previous_State = S4_ANALYZING_STILLNESS`。
            3.  确保GPS模块已 Power ON。
            4.  初始化AGNSS相关变量。
        *   **下一状态**: `S5_AGNSS_PROCESSING`

---
**6.6. S5\_AGNSS\_PROCESSING (AGNSS数据注入处理中)**
*   **描述**: 正在进行AGNSS数据注入处理。GPS模块已上电，系统按序发送AGNSS消息队列中的数据包并等待每个包的ACK响应。
*   **进入动作**:
    1.  确保GPS模块已 Power ON。
    2.  初始化AGNSS处理变量：
        *   `AGNSS_Current_Message_Index = 0`
        *   `AGNSS_Current_Message_Retry_Count = 0`
    3.  启动 `AGNSS_Total_Timer` (使用 `T_AGNSS_TOTAL_TIMEOUT` 作为时长)。
    4.  发送第一条AGNSS消息（AID-INI）。
    5.  启动 `AGNSS_Message_Timer` (使用 `T_AGNSS_MESSAGE_SEND_TIMEOUT` 作为时长)。
*   **事件处理**:
    *   **事件**: `E5.1_AGNSS_ACK_Received` (收到当前AGNSS消息的ACK响应)
        *   **动作**:
            1.  停止 `AGNSS_Message_Timer`。
            2.  `AGNSS_Current_Message_Index++`。
            3.  重置 `AGNSS_Current_Message_Retry_Count = 0`。
            4.  **如果** `AGNSS_Current_Message_Index >= AGNSS_Message_Queue.size()`:
                *   **所有AGNSS消息已成功发送完成**
                *   停止 `AGNSS_Total_Timer`。
                *   清空 `AGNSS_Message_Queue`。
                *   根据 `AGNSS_Previous_State` 返回到之前的状态：
                    *   如果是 `S1_GPS_SEARCHING_FIX`: 启动 `Fix_Attempt_Timer`，下一状态为 `S1_GPS_SEARCHING_FIX`
                    *   如果是 `S2_IDLE_GPS_OFF`: Power OFF GPS模块，下一状态为 `S2_IDLE_GPS_OFF`
                    *   如果是 `S3_TRACKING_FIXED`: 启动 `Active_Sampling_Timer`，下一状态为 `S3_TRACKING_FIXED`
                    *   如果是 `S4_ANALYZING_STILLNESS`: 启动 `GPS_Query_Timeout_Timer_S4`，下一状态为 `S4_ANALYZING_STILLNESS`
            5.  **否则**:
                *   发送下一条AGNSS消息。
                *   启动 `AGNSS_Message_Timer`。
        *   **下一状态**: 根据是否完成所有消息决定，见上述动作说明
    *   **事件**: `E5.2_AGNSS_NACK_Received` (收到当前AGNSS消息的NACK响应)
        *   **动作**:
            1.  停止 `AGNSS_Message_Timer`。
            2.  `AGNSS_Current_Message_Retry_Count++`。
            3.  **如果** `AGNSS_Current_Message_Retry_Count >= MAX_AGNSS_MESSAGE_RETRY`:
                *   **当前消息重试次数已达上限，AGNSS处理失败**
                *   执行AGNSS失败清理动作（见 `E5.4` 动作）。
            4.  **否则**:
                *   重新发送当前AGNSS消息。
                *   启动 `AGNSS_Message_Timer`。
        *   **下一状态**: `S5_AGNSS_PROCESSING` (继续处理) 或根据失败清理返回之前状态
    *   **事件**: `E5.3_AGNSS_Message_Timer_Expired` (`AGNSS_Message_Timer` 超时)
        *   **动作**: (当前消息发送超时，按NACK处理)
            1.  `AGNSS_Current_Message_Retry_Count++`。
            2.  **如果** `AGNSS_Current_Message_Retry_Count >= MAX_AGNSS_MESSAGE_RETRY`:
                *   **当前消息重试次数已达上限，AGNSS处理失败**
                *   执行AGNSS失败清理动作（见 `E5.4` 动作）。
            3.  **否则**:
                *   重新发送当前AGNSS消息。
                *   启动 `AGNSS_Message_Timer`。
        *   **下一状态**: `S5_AGNSS_PROCESSING` (继续处理) 或根据失败清理返回之前状态
    *   **事件**: `E5.4_AGNSS_Total_Timer_Expired` (`AGNSS_Total_Timer` 超时)
        *   **动作**: (AGNSS整体处理超时，强制结束)
            1.  停止 `AGNSS_Message_Timer`。
            2.  清空 `AGNSS_Message_Queue`。
            3.  根据 `AGNSS_Previous_State` 返回到之前的状态：
                *   如果是 `S1_GPS_SEARCHING_FIX`: 启动 `Fix_Attempt_Timer`，下一状态为 `S1_GPS_SEARCHING_FIX`
                *   如果是 `S2_IDLE_GPS_OFF`: Power OFF GPS模块，下一状态为 `S2_IDLE_GPS_OFF`
                *   如果是 `S3_TRACKING_FIXED`: 启动 `Active_Sampling_Timer`，下一状态为 `S3_TRACKING_FIXED`
                *   如果是 `S4_ANALYZING_STILLNESS`: 启动 `GPS_Query_Timeout_Timer_S4`，下一状态为 `S4_ANALYZING_STILLNESS`
        *   **下一状态**: 根据 `AGNSS_Previous_State` 决定
    *   **事件**: `E5.5_Motion_Detected_During_AGNSS` (AGNSS处理期间检测到运动)
        *   **动作**: (运动检测不中断AGNSS处理，但记录状态变化)
            *   更新 `AGNSS_Previous_State` 为运动相关的状态（如 `S3_TRACKING_FIXED` 或 `S1_GPS_SEARCHING_FIX`）以便AGNSS完成后正确返回。
        *   **下一状态**: `S5_AGNSS_PROCESSING` (保持当前状态)

---
**7. 核心逻辑交互**

7.1. **加速度传感器管理**
*   加速度传感器应以足够高的频率 (e.g., 1-10Hz) 持续采样。
*   其实时数据用于：
    *   在`S2_IDLE_GPS_OFF`中检测运动 (`E2.1`) 以唤醒GPS。
    *   在`S1_GPS_SEARCHING_FIX`中检测运动 (`E1.3`) 或长时间静止 (`E1.4`，可选)。
    *   在`S3_TRACKING_FIXED`中检测运动以复位静止计时 (`E3.2`) 或开始静止计时 (`E3.3`)。
    *   在`S4_ANALYZING_STILLNESS`中检测运动以立即返回追踪模式 (`E4.1`)。
*   通过比较加速度矢量模的变化与 `ACCEL_STILL_THRESHOLD` 来判断运动/静止。
*   `T_STILLNESS_CONFIRM_DURATION` 的计时需要在后台独立于状态机主循环进行，但其超时会触发状态转换事件 (`E3.4`)。

7.2. **GPS模块控制**
*   **Power ON/OFF**: 状态机根据逻辑在恰当的时候对GPS模块进行上电或断电（或使其进入/退出深度休眠模式）。
*   **指令发送**:
    *   在`S0`中可能发送初始化配置指令。
    *   在`S1`中可能需要发送开始定位的指令。
    *   在`S1`中，若连续搜星失败，可能发送重启指令。
*   **数据解析**: 需要持续或按需解析来自GPS模块的NMEA语句 (或其他格式数据)，提取位置、速度、时间、HDOP、卫星数等信息，并更新到全局可访问的结构体中，供状态机决策使用。

7.3. **AGNSS数据注入管理**
*   **外部数据接口**: 外部系统通过调用状态机接口设置 `AGNSS_Message_Queue`（类型为 `vector<vector<uint8_t>>`），其中每个 `vector<uint8_t>` 都是已编码好的CASIC协议数据包。
*   **数据包格式**: 队列中第一条消息为AID-INI命令，其余为各种星历数据（MSG_GPSEPH、MSG_BDSEPH等）。
*   **发送流程**: 在`S5_AGNSS_PROCESSING`状态下，按序发送队列中的每条消息，并等待GPS模块的ACK响应后再发送下一条。
*   **错误处理**: 如果收到NACK或发送超时，会根据重试次数限制进行重发或失败处理。
*   **完成处理**: 所有消息成功发送完成后，状态机会返回到进入AGNSS处理前的状态继续正常工作。

**8. 鲁棒性与异常处理考量**
*   **GPS模块无响应**:
    *   若Power ON后GPS模块串口无数据输出，应有超时机制（部分体现在`S1`的`Fix_Attempt_Timer`）。
    *   若发送指令后无预期回应，也应有相应处理。
*   **加速度传感器故障**: 若传感器数据异常或无更新，系统应能检测到并可能进入一种安全模式（例如，固定周期开关GPS，或始终保持GPS开启但降低采样率）。此规范未详细定义此故障模式。
*   **数据有效性校验**: 对从GPS模块获取的数据（如日期、时间、经纬度范围）进行基本校验，防止因异常数据导致逻辑错误。`MIN_HDOP_FOR_VALID_FIX`是其中一种校验。

**9. 待定与未来考虑**
*   **动态调整参数**: 基于历史定位成功率、电池电量、用户场景等因素动态调整 `T_GPS_SLEEP_PERIODIC_WAKE_INTERVAL`、`T_GPS_COLD_START_FIX_TIMEOUT` 等参数。
*   **AGNSS数据管理**: 本规范定义了AGNSS数据注入的状态机逻辑，但AGNSS数据的获取、存储、有效期管理等需要额外的模块支持。外部系统需要负责：
    *   从网络服务器获取最新的星历数据
    *   将数据按照CASIC协议格式编码成 `vector<vector<uint8_t>>` 格式
    *   在适当时机触发状态机的AGNSS请求事件
*   **更精细的运动状态分析**: 利用加速度传感器数据进行更复杂的活动识别（如步行、跑步、车辆），以更智能地调整GPS策略。
*   **GPS模块低功耗模式**: 如果GPS模块支持多种低功耗模式而不仅仅是完全关闭，状态机可以利用这些模式进行更细致的功耗管理。
*   **GPX航迹记录的具体逻辑**: 本规范主要关注状态切换，GPX记录点在何时记录 (例如，仅在`S3`的`E3.1`事件，还是`S1`获得首次定位时也记录) 可作为应用层细节进一步明确。

---

这份规范文档应该为您提供了清晰的实现蓝图。在具体编码时，还需要考虑您所用MCU平台和传感器、GPS模块的具体特性。
