# FMDN 设备注册 & 位置获取 实现方案

## 背景

当前 gps_tracker Python 工具 (`fmdn_fetch.py`) 已实现：
- Google OAuth 认证链 (Chrome → oauth_token → AAS → ADM/Spot tokens)
- Nova API 设备列表 (nbe_list_devices)
- Spot API 上传预计算 key IDs (UploadPrecomputedPublicKeyIds)
- 手动 protobuf 编解码（无需 .proto 编译）
- 位置报告解密（crowdsourced ECDH+HKDF+AES-EAX 和 own-report AES-GCM）

**设备端 EIK 已 provision**：前端 WebUI 通过 `crypto.getRandomValues()` 生成 32-byte EIK，
经 BLE NUS (cmd 0x0F) 发送到设备，固件存入 SD 卡 `/FMDN.EIK`，同时导出 JSON 备份
（格式：`{"eik": "hex", "generated_at": "..."}`）。设备拿到 EIK 后即开始 FMDN EID 广播。

**缺少**：将设备上已有的 EIK 注册到 Google FMDN 服务端（`CreateBleDevice`），
使 Android 设备网络能识别并上报该 tracker 的位置。

## Phase 1: 设备注册 (`gt fmdn register`)

### 1.1 Owner Key 获取

注册 DIY tracker 需要 owner_key 来加密 EIK。获取链：

```
Chrome 登录 → Google Security Domain 页面
→ 用户输入手机 PIN/密码 → JS 拦截 vault keys
→ 提取 shared_key (finder_hw domain)
→ Spot API GetEidInfoForE2eeDevices → encrypted_owner_key
→ AES-GCM 解密 → owner_key (32 bytes)
```

需要实现的函数：
- `_get_shared_key(cache)` — Chrome 自动化 + JS 注入获取 vault shared key
  - 打开 `accounts.google.com/` 等用户登录
  - 跳转到 `accounts.google.com/encryption/unlock/android?kdi=<base64>`
  - 注入 `window.mm.setVaultSharedKeys` JS 接口
  - 等待 alert 回调，解析 vault keys JSON → 提取 `finder_hw` key
- `_get_eid_info(spot_token)` — Spot API GetEidInfoForE2eeDevices
  - 请求 protobuf: field 1=ownerKeyVersion(-1), field 2=hasOwnerKeyVersion(true)
  - 响应 protobuf: field 4 → EncryptedOwnerKeyAndMetadata → field 1=encryptedOwnerKey
- `_get_owner_key(cache, spot_token)` — 组合上述两步
  - `decrypt_aes_gcm(shared_key, encrypted_owner_key)` → owner_key

### 1.2 CreateBleDevice 请求

Protobuf 字段映射（从 DeviceUpdate_pb2.py 提取）：

```
RegisterBleDeviceRequest {
  string fastPairModelId = 7;           // "003200"
  DeviceDescription description = 10 {
    string userDefinedName = 1;         // "GPS Tracker µC"
    SpotDeviceType deviceType = 2;      // DEVICE_TYPE_BEACON = 1
    repeated DeviceComponentInformation deviceComponentsInformation = 9 {
      string imageUrl = 1;
    }
  }
  DeviceCapabilities capabilities = 11 {
    bool isAdvertising = 1;             // true
    int32 capableComponents = 5;        // 1
    int32 trackableComponents = 6;      // 1
  }
  E2EEPublicKeyRegistration e2eePublicKeyRegistration = 16 {
    int32 rotationExponent = 1;         // 10
    EncryptedUserSecrets encryptedUserSecrets = 3 {
      bytes encryptedIdentityKey = 1;   // flip_bits(AES-GCM(owner_key, eik))
      int32 ownerKeyVersion = 3;        // 1
      bytes encryptedAccountKey = 4;    // random 44 bytes
      Time creationDate = 8 {           // pair_date
        uint32 seconds = 1;
      }
      bytes encryptedSha256AccountKeyPublicAddress = 11;  // random 60 bytes
    }
    PublicKeyIdList publicKeyIdList = 4 {
      repeated PublicKeyIdInfo publicKeyIdInfo = 1 {
        Time timestamp = 1 { uint32 seconds = 1; }
        TruncatedEID publicKeyId = 2 { bytes truncatedEid = 1; }
      }
    }
    int32 pairingDate = 5;              // unix timestamp
  }
  string manufacturerName = 17;        // "gps_tracker"
  bytes ringKey = 21;                   // SHA256(eik || 0x02)[:8]
  bytes recoveryKey = 22;              // SHA256(eik || 0x01)[:8]
  bytes unwantedTrackingKey = 24;      // SHA256(eik || 0x03)[:8]
  string modelName = 25;              // "µC"
}
```

关键步骤：
1. **从 JSON 文件加载已有 EIK**（与 `gt fmdn fetch -k` 相同的 JSON 格式，设备上已 provision）
2. 用 owner_key AES-GCM 加密 EIK → encrypted_eik（12-byte random IV + ciphertext + 16-byte tag）
3. **Flip bits**（`XOR 0xFF` 每个字节，防止 Android 设备直接解密，只有持有 owner_key 的服务端能还原）
4. 派生 ring/recovery/tracking keys: `SHA256(eik || byte)[:8]`（已有函数 `derive_*_key()`）
5. 生成初始 4 天窗口的 precomputed key IDs（truncated EID 前 10 bytes，可复用 `compute_eid()`）
6. 构造 protobuf 并发送到 `Spot API CreateBleDevice`
7. 打印注册成功信息（canonic_id 等）

### 1.3 CLI 接口

```
gt fmdn register -k eik.json [--token-cache ~/.config/gps-tracker/google_tokens.json] [--name "GPS Tracker"]
```

- `-k eik.json`：**必须**，指向已 provision 到设备的 EIK JSON 文件（复用 `load_eik()` 函数）
- `--name`：可选，设备显示名称（默认 "GPS Tracker µC"）
- 如果没有 cached owner_key → 触发 Chrome 登录 + LSKF vault 解锁流程
- 注册成功后打印 canonic_id 和设备信息

### 1.4 实现位置

在 `fmdn_fetch.py` 中添加：
- `_get_shared_key(cache)` — Chrome 自动化 + JS 注入获取 vault shared key
- `_build_eid_info_request()` / `_parse_eid_info_response()` — GetEidInfoForE2eeDevices 请求/解析
- `_get_owner_key(cache, spot_token)` — 组合 shared_key + encrypted_owner_key → owner_key
- `_flip_bits(data)` — XOR 0xFF 每个字节
- `_encrypt_eik(owner_key, eik)` — AES-GCM 加密 + flip_bits
- `_build_register_request(eik, owner_key, pair_date, name)` — 构造 RegisterBleDeviceRequest protobuf
- `register_device(eik, token_cache, name)` — 顶层函数，串联整个注册流程

在 `fmdn.py` 中添加：
- `cmd_register(args)` 子命令
- `add_subcommands()` 中注册 register 子命令

**不需要新依赖**：所有加密操作（AES-GCM, SHA256）已在 `cryptography` 中可用

## Phase 2: 主动位置获取 (FCM Push)

### 2.1 当前方式的问题

当前 `fetch_fmdn_reports()` 从 `nbe_list_devices` 响应中直接解析 `raw_locations`。
但对于新注册的 MCU tracker，nbe_list_devices 的响应 **可能不包含位置数据**（只有设备元数据）。

GoogleFindMyTools 的正确流程：
1. FCM 注册 → 获取 FCM token
2. 通过 Nova API 发送 `ExecuteAction/LocateTracker` 请求（携带 FCM token）
3. 等待 FCM push 通知 → 解析 protobuf → 解密位置

### 2.2 FCM 集成

需要引入 `firebase-messaging` 客户端库（GoogleFindMyTools 内置了一个 `Auth/firebase_messaging/` 模块）。

FCM 配置（Google ADM 项目，公开参数）：
```python
project_id = "google.com:api-project-289722593072"
app_id = "1:289722593072:android:3cfcf5bc359f0308"
api_key = "AIzaSyD_gko3P392v6how2H7UpdeXQ0v2HLettc"
sender_id = "289722593072"
bundle_id = "com.google.android.apps.adm"
```

FCM 注册 → 获取 `credentials`（含 `gcm.android_id` 和 `fcm.registration.token`）。
`android_id` 也用于 gpsoauth 认证。

### 2.3 LocateTracker 请求

```
ExecuteActionRequest {
  ExecuteActionScope scope = 1 {
    DeviceType type = 2;     // SPOT_DEVICE = 2
    ExecuteActionDeviceIdentifier device = 3 {
      CanonicId canonicId = 1 { string id = 1; }
    }
  }
  ExecuteActionType action = 2 {
    ExecuteActionLocateTrackerType locateTracker = 30 {
      Time lastHighTrafficEnablingTime = 2;
      SpotContributorType contributorType = 3;  // FMDN_ALL_LOCATIONS = 2
    }
  }
  ExecuteActionRequestMetadata requestMetadata = 3 {
    DeviceType type = 1;     // SPOT_DEVICE = 2
    string requestUuid = 2;
    string fmdClientUuid = 3;
    GcmCloudMessagingIdProtobuf gcmRegistrationId = 4 { string id = 1; }
    bool unknown = 6;        // true
  }
}
```

发送到 Nova API `nbe_execute_action`。

### 2.4 FCM Push 接收 & 解密

FCM 回调中：
- 检查 `data['com.google.android.apps.adm.FCM_PAYLOAD']`
- Base64 decode → protobuf (DeviceUpdate)
- 匹配 `requestUuid` → 解密位置报告
- 解密方式：与当前 `_decrypt_location_report()` 相同

### 2.5 复杂度评估

| 组件 | 难度 | 说明 |
|------|------|------|
| Owner Key 获取 | 高 | Chrome + JS 注入 + 多层密钥解密 |
| CreateBleDevice | 中 | 大量 protobuf 字段，但逻辑清晰 |
| FCM 集成 | 高 | 需要 async push client，GCM checkin |
| LocateTracker | 低 | 构造请求 + 发送，逻辑简单 |
| 位置解密 | 已完成 | 已在 fmdn_fetch.py 中实现 |

## Phase 3: 建议实现顺序

### Step 1: Owner Key + Register（优先）
- 这是让固件端 EID 广播被 Google 网络收集的前提条件
- 没有注册，固件广播的 EID 不会被任何 Android 设备上报

### Step 2: 验证 nbe_list_devices 是否能拿到位置
- 注册后，等待一段时间让 crowdsourced reports 积累
- 尝试用现有 `gt fmdn fetch` 看能否解密位置
- 如果可以，Phase 2 可以延后

### Step 3: FCM 位置获取（如果 Step 2 不工作）
- 完整实现 FCM 注册 + LocateTracker + push 接收
- 这是最可靠的方式，但实现复杂度最高

## 关键依赖

当前 `fmdn_fetch.py` 用随机生成的 `android_id`（`os.urandom(8).hex()`）。
GoogleFindMyTools 用 FCM checkin 获取的 `android_id`。

**重要**：如果要实现 FCM，需要统一 `android_id` 来源：
- FCM checkin → credentials → `gcm.android_id`
- 这个 android_id 同时用于 gpsoauth 认证
- 当前随机生成的方式可能导致认证问题

## 文件改动清单

- `fmdn_fetch.py`: 添加 owner_key 获取、register 函数、（可选）FCM 集成
- `fmdn.py`: 添加 `register` 子命令
- `cli.py`: 无需改动（fmdn 子命令自动注册）
- `pyproject.toml`: 可能需要添加 `firebase-messaging` 依赖（Phase 2）
