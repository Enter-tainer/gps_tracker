/**
 * CASIC AGNSS 数据处理器
 * 下载星历数据，解析CASIC协议，添加AID-INI消息
 */
import AGNSSDataFetcher from './AgnssDataFetcher.js';

class CASICPacket {
  constructor() {
    this.header = 0;           // 0xBA 0xCE
    this.length = 0;           // 长度字段
    this.classId = 0;          // Class ID
    this.messageId = 0;        // Message ID
    this.payload = null;       // Payload 数据
    this.checksum = 0;         // 校验和
    this.rawBytes = null;      // 原始字节数据
  }

  toString() {
    const msgType = CASICProcessor.getMessageName(this.classId, this.messageId);
    return `CASIC包: ${msgType} (Class=0x${this.classId.toString(16).padStart(2, '0')}, ` +
      `ID=0x${this.messageId.toString(16).padStart(2, '0')}), 长度=${this.length}`;
  }
}

class CASICProcessor {
  constructor() {
    this.packets = [];
    this.HEADER_MAGIC = new Uint8Array([0xBA, 0xCE]);
    this.MIN_PACKET_SIZE = 10;

    // 消息类型定义
    this.MESSAGE_TYPES = new Map([
      [[0x0B, 0x01], "AID-INI"],     // 辅助初始化数据
      [[0x08, 0x00], "MSG_BDSUTC"],  // BDS UTC 数据
      [[0x08, 0x01], "MSG_BDSION"],  // BDS 电离层数据
      [[0x08, 0x02], "MSG_BDSEPH"],  // BDS 星历
      [[0x08, 0x05], "MSG_GPSUTC"],  // GPS UTC 数据
      [[0x08, 0x06], "MSG_GPSION"],  // GPS 电离层参数
      [[0x08, 0x07], "MSG_GPSEPH"],  // GPS 星历
      [[0x05, 0x01], "ACK"],         // 确认消息
      [[0x05, 0x00], "NACK"],        // 否定消息
    ]);
  }

  static getMessageName(classId, messageId) {
    const processor = new CASICProcessor();
    const key = [classId, messageId];
    return processor.MESSAGE_TYPES.get(key.toString()) ||
      processor.MESSAGE_TYPES.get(key) ||
      "UNKNOWN";
  }
  
  /**
   * 计算CASIC校验和
   * @param {number} classId 
   * @param {number} messageId 
   * @param {number} length 
   * @param {Uint8Array} payload 
   * @returns {number}
   */
  calculateChecksum(classId, messageId, length, payload) {
    // 初始校验和：(ID << 24) + (Class << 16) + Len
    let checksum = 0;
    checksum += (messageId & 0xFF) * 0x1000000;  // ID << 24
    checksum += (classId & 0xFF) * 0x10000;      // Class << 16  
    checksum += (length & 0xFFFF);               // Length
    checksum = checksum >>> 0; // 转为无符号32位

    // 按4字节为单位处理Payload
    const payloadLen = payload.length;
    const dataView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    for (let i = 0; i < Math.floor(payloadLen / 4); i++) {
      const offset = i * 4;
      if (offset + 4 <= payloadLen) {
        // 使用DataView读取小端序32位无符号整数
        const payloadWord = dataView.getUint32(offset, true); // true表示小端序
        checksum = (checksum + payloadWord) >>> 0; // 保持32位无符号
      }
    }

    return checksum;
  }

  /**
   * 解析CASIC数据
   * @param {Uint8Array} data 
   * @returns {CASICPacket[]}
   */
  parseData(data) {
    const packets = [];
    let offset = 0;

    while (offset < data.length - this.MIN_PACKET_SIZE) {
      // 查找包头 0xBA 0xCE
      const headerPos = this.findHeader(data, offset);
      if (headerPos === -1) {
        break;
      }

      offset = headerPos;

      // 解析包头
      if (offset + this.MIN_PACKET_SIZE > data.length) {
        break;
      }

      const packet = new CASICPacket();

      // 读取包头
      packet.header = (data[offset + 1] << 8) | data[offset];
      offset += 2;

      // 读取长度（小端序）
      packet.length = data[offset] | (data[offset + 1] << 8);
      offset += 2;

      // 读取Class ID和Message ID
      packet.classId = data[offset++];
      packet.messageId = data[offset++];

      // 检查是否有足够的数据
      if (offset + packet.length + 4 > data.length) {
        console.warn(`包长度超出数据范围，跳过`);
        break;
      }

      // 读取Payload
      packet.payload = data.slice(offset, offset + packet.length);
      offset += packet.length;
      
      // 读取校验和（小端序）
      const checksumView = new DataView(data.buffer, data.byteOffset + offset, 4);
      packet.checksum = checksumView.getUint32(0, true); // true表示小端序
      offset += 4;

      // 验证校验和
      const calculatedChecksum = this.calculateChecksum(
        packet.classId, packet.messageId, packet.length, packet.payload
      );

      if (packet.checksum !== calculatedChecksum) {
        console.warn(`包校验和错误: 期望 0x${calculatedChecksum.toString(16)}, 实际 0x${packet.checksum.toString(16)}`);
        continue;
      }

      // 保存原始字节数据
      const packetStart = headerPos;
      const packetEnd = offset;
      packet.rawBytes = data.slice(packetStart, packetEnd);

      packets.push(packet);
    }

    return packets;
  }

  /**
   * 查找包头位置
   * @param {Uint8Array} data 
   * @param {number} startOffset 
   * @returns {number}
   */
  findHeader(data, startOffset) {
    for (let i = startOffset; i < data.length - 1; i++) {
      if (data[i] === 0xBA && data[i + 1] === 0xCE) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 创建AID-INI数据包
   * @param {Object} geoData - 地理位置数据 {latitude, longitude, hasPosition}
   * @returns {Uint8Array}
   */
  createAidIniPacket(geoData = null) {
    // 默认位置参数 (上海)
    let latitude = 31.2304;   // 上海纬度
    let longitude = 121.4737; // 上海经度
    let hasValidPosition = false;

    // 如果提供了地理位置数据，则使用实际位置
    if (geoData && geoData.hasPosition) {
      latitude = geoData.latitude;
      longitude = geoData.longitude;
      hasValidPosition = true;
      console.log(`使用实际地理位置: 纬度=${latitude.toFixed(6)}, 经度=${longitude.toFixed(6)}`);
    } else {
      console.log(`使用默认位置 (上海): 纬度=${latitude}, 经度=${longitude}`);
    }

    const altitude = 10.0;      // 平均海拔（米）

    // 获取当前时间
    const now = new Date();
    const gpsEpoch = new Date('2006-01-01T00:00:00Z');
    const totalSeconds = (now - gpsEpoch) / 1000;
    const gpsWeek = Math.floor(totalSeconds / (7 * 24 * 3600));
    const timeOfWeek = totalSeconds % (7 * 24 * 3600);

    const frequencyBias = 0.0;
    const positionAccuracy = hasValidPosition ? 50.0 : 10000.0;  // 有GPS则50米，否则10km
    const timeAccuracy = 1.0;       // 1秒精度
    const frequencyAccuracy = 1.0;  // 1Hz精度
    const reserved = 0;
    const weekNumber = gpsWeek;
    const timerSource = 1;          // 外部时间源

    // flags标志位配置:
    // B0: 位置有效位 - 根据是否获取到GPS设置
    // B1: 时间有效位 - 固定为1 (总是有时间)
    // B5: LLA格式位 - 固定为1 (使用经纬度格式)
    // B6: 高度无效位 - 固定为1 (高度数据无效)
    let flags = 0b01100010; // 基础flags: 时间有效(B1=1) + LLA格式(B5=1) + 高度无效(B6=1)
    if (hasValidPosition) {
      flags |= 0b00000001; // 设置B0=1，表示位置有效
    }
    // 如果没有获取到位置，B0保持为0

    // 创建56字节的payload
    const payload = new ArrayBuffer(56);
    const view = new DataView(payload);
    let offset = 0;

    // 小端序写入数据
    view.setFloat64(offset, latitude, true); offset += 8;  // R8 - Latitude
    view.setFloat64(offset, longitude, true); offset += 8;  // R8 - Longitude
    view.setFloat64(offset, altitude, true); offset += 8;  // R8 - Altitude
    view.setFloat64(offset, timeOfWeek, true); offset += 8;  // R8 - GPS Time of Week
    view.setFloat32(offset, frequencyBias, true); offset += 4;  // R4 - Clock frequency offset
    view.setFloat32(offset, positionAccuracy, true); offset += 4;  // R4 - Position accuracy
    view.setFloat32(offset, timeAccuracy, true); offset += 4;  // R4 - Time accuracy
    view.setFloat32(offset, frequencyAccuracy, true); offset += 4;  // R4 - Frequency accuracy
    view.setUint32(offset, reserved, true); offset += 4;  // U4 - Reserved
    view.setUint16(offset, weekNumber, true); offset += 2;  // U2 - GPS Week Number
    view.setUint8(offset, timerSource); offset += 1;  // U1 - Time source
    view.setUint8(offset, flags); offset += 1;  // U1 - Flag mask

    return this.createCasicPacket(0x0B, 0x01, new Uint8Array(payload));
  }

  /**
   * 创建完整的CASIC数据包
   * @param {number} classId 
   * @param {number} messageId 
   * @param {Uint8Array} payload 
   * @returns {Uint8Array}
   */
  createCasicPacket(classId, messageId, payload) {
    const length = payload.length;
    const checksum = this.calculateChecksum(classId, messageId, length, payload);

    // 创建完整数据包
    const packetSize = 2 + 2 + 1 + 1 + length + 4; // header + len + class + id + payload + checksum
    const packet = new Uint8Array(packetSize);
    let offset = 0;

    // 写入包头 0xBA 0xCE
    packet[offset++] = 0xBA;
    packet[offset++] = 0xCE;

    // 写入长度（小端序）
    packet[offset++] = length & 0xFF;
    packet[offset++] = (length >> 8) & 0xFF;

    // 写入Class ID和Message ID
    packet[offset++] = classId;
    packet[offset++] = messageId;

    // 写入Payload
    packet.set(payload, offset);
    offset += length;

    // 写入校验和（小端序）
    packet[offset++] = checksum & 0xFF;
    packet[offset++] = (checksum >> 8) & 0xFF;
    packet[offset++] = (checksum >> 16) & 0xFF;
    packet[offset++] = (checksum >> 24) & 0xFF;

    return packet;
  }

  /**
   * 分析解析后的数据包
   * @param {CASICPacket[]} packets 
   */
  analyzePackets(packets) {
    console.log(`\n=== CASIC 数据包分析 ===`);
    console.log(`总包数: ${packets.length}`);

    const stats = new Map();
    packets.forEach(packet => {
      const msgType = CASICProcessor.getMessageName(packet.classId, packet.messageId);
      stats.set(msgType, (stats.get(msgType) || 0) + 1);
    });

    console.log('\n消息类型统计:');
    for (const [msgType, count] of stats) {
      console.log(`  ${msgType}: ${count} 个`);
    }

    console.log('\n前10个数据包:');
    packets.slice(0, 10).forEach((packet, index) => {
      console.log(`  ${index + 1}. ${packet.toString()}`);
    });
  }
}

/**
 * 获取浏览器地理位置
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<Object>} - 返回位置数据 {latitude, longitude, hasPosition}
 */
async function getBrowserLocation(timeout = 10000) {
  return new Promise((resolve) => {
    // 检查是否在浏览器环境且支持地理位置API
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      console.log('地理位置API不可用或不在浏览器环境');
      resolve({ hasPosition: false });
      return;
    }

    const options = {
      enableHighAccuracy: true,  // 启用高精度
      timeout: timeout,          // 超时时间
      maximumAge: 300000        // 缓存5分钟
    };

    console.log('正在获取地理位置...');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        console.log(`地理位置获取成功: 纬度=${latitude.toFixed(6)}, 经度=${longitude.toFixed(6)}, 精度=${accuracy.toFixed(0)}米`);
        resolve({
          latitude: latitude,
          longitude: longitude,
          accuracy: accuracy,
          hasPosition: true
        });
      },
      (error) => {
        let errorMsg = '未知错误';
        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMsg = '用户拒绝了地理位置权限请求';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMsg = '位置信息不可用';
            break;
          case error.TIMEOUT:
            errorMsg = '地理位置请求超时';
            break;
        }
        console.log(`地理位置获取失败: ${errorMsg}`);
        resolve({ hasPosition: false });
      },
      options
    );
  });
}

/**
 * 主处理函数
 */
async function processAGNSSData() {
  try {
    console.log('=== CASIC AGNSS 数据处理器 ===\n');

    // 并发执行：同时获取地理位置和下载数据
    console.log('正在并发执行：获取地理位置和下载星历数据...');

    const [geoData, rawData] = await Promise.all([
      // 1. 获取地理位置
      getBrowserLocation().catch(error => {
        console.warn('获取地理位置失败:', error);
        return { hasPosition: false };
      }),

      // 2. 下载数据
      (async () => {
        const fetcher = new AGNSSDataFetcher();
        return await fetcher.downloadEphemeris('gps_bds.eph', '/');
      })().catch(error => {
        console.error('下载星历数据失败:', error);
        throw error;
      })
    ]);

    console.log('并发任务完成！');

    // 3. 解析CASIC数据包
    console.log('\n正在解析CASIC数据包...');
    const uint8Data = new Uint8Array(rawData);
    const processor = new CASICProcessor();
    const packets = processor.parseData(uint8Data);

    if (packets.length === 0) {
      console.log('未找到有效的CASIC数据包');
      return;
    }

    // 4. 分析数据包
    processor.analyzePackets(packets);

    // 5. 创建AID-INI数据包（使用获取的地理位置）
    console.log('\n正在创建AID-INI数据包...');
    const aidIniPacket = processor.createAidIniPacket(geoData);

    // 6. 合并数据包（AID-INI在前）
    const allPackets = [aidIniPacket];
    packets.forEach(packet => {
      allPackets.push(packet.rawBytes);
    });

    return allPackets;

  } catch (error) {
    console.error('处理失败:', error);
    throw error;
  }
}

// 导出模块
export { CASICProcessor, CASICPacket, processAGNSSData, getBrowserLocation };