/**
 * GPS 数据解码器服务
 * 负责解析二进制 GPS 数据为轨迹点
 */

/**
 * 创建 GPS 数据解码器
 * @returns {Object} GPS 解码器接口
 */
export function createGpsDecoder() {
  return {
    /**
     * 解码 GPS 数据
     * @param {ArrayBuffer} arrayBuffer - GPS 原始数据缓冲区
     * @returns {Array} 解析后的 GPS 点数组
     */
    decode(arrayBuffer) {
      const points = [];
      
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        console.error("GpsDataDecoder: Input ArrayBuffer is empty or null.");
        return points;
      }

      const view = new DataView(arrayBuffer);
      let offsetObj = { offset: 0 };

      let previousPoint = {
        timestamp: 0, 
        latitude_scaled_1e5: 0,
        longitude_scaled_1e5: 0, 
        altitude_m_scaled_1e1: 0
      };
      
      let isFirstPoint = true;
      let pointIndex = 0;

      while (offsetObj.offset < view.byteLength) {
        const pointStartOffset = offsetObj.offset;
        
        try {
          if (offsetObj.offset + 1 > view.byteLength) {
            console.error(`GpsDataDecoder: Buffer underflow at offset ${offsetObj.offset}: cannot read header byte for point ${pointIndex}. Remaining bytes: ${view.byteLength - offsetObj.offset}`);
            break; // Cannot read header, critical
          }
          
          const header = view.getUint8(offsetObj.offset++);
          let currentPoint = {};

          if (header === 0xFF) { // Full Block
            if (offsetObj.offset + 16 > view.byteLength) {
              throw new Error(`Buffer underflow for Full Block payload at offset ${offsetObj.offset}. Needed 16, got ${view.byteLength - offsetObj.offset}.`);
            }
            
            currentPoint.timestamp = view.getUint32(offsetObj.offset, true); 
            offsetObj.offset += 4;
            
            currentPoint.latitude_scaled_1e5 = view.getInt32(offsetObj.offset, true); 
            offsetObj.offset += 4;
            
            currentPoint.longitude_scaled_1e5 = view.getInt32(offsetObj.offset, true); 
            offsetObj.offset += 4;
            
            currentPoint.altitude_m_scaled_1e1 = view.getInt32(offsetObj.offset, true); 
            offsetObj.offset += 4;
            
            isFirstPoint = false;
          } else if ((header & 0x80) === 0) { // Delta Block
            if (isFirstPoint) {
              throw new Error("Invalid data: Delta Block found as the first block.");
            }
            
            if ((header & 0xF0) !== 0x00) { // Check reserved bits (4-6)
              throw new Error(`Invalid Delta Block header: 0x${header.toString(16)}. Reserved bits (4-6) must be 0.`);
            }
            
            currentPoint = { ...previousPoint };
            const flags = header & 0x0F;

            if ((flags >> 3) & 1) { 
              currentPoint.timestamp = (currentPoint.timestamp + this._readVarintS32(view, offsetObj)) >>> 0; 
            }
            
            if ((flags >> 2) & 1) { 
              currentPoint.latitude_scaled_1e5 += this._readVarintS32(view, offsetObj); 
            }
            
            if ((flags >> 1) & 1) { 
              currentPoint.longitude_scaled_1e5 += this._readVarintS32(view, offsetObj); 
            }
            
            if (flags & 1) { 
              currentPoint.altitude_m_scaled_1e1 += this._readVarintS32(view, offsetObj); 
            }
          } else {
            throw new Error(`Invalid block header: 0x${header.toString(16)} at offset ${pointStartOffset}.`);
          }
          
          points.push(currentPoint);
          previousPoint = currentPoint;

        } catch (e) {
          console.error(`GpsDataDecoder: Error decoding point ${pointIndex} at data offset ${pointStartOffset}: ${e.message}. Skipping point.`);
          
          // 错误恢复逻辑
          if (offsetObj.offset <= pointStartOffset) {
            console.warn(`GpsDataDecoder: Offset did not advance after error at ${pointStartOffset}. Advancing by 1 to prevent infinite loop.`);
            offsetObj.offset = pointStartOffset + 1; // 强制前进
          }
        }
        
        pointIndex++;
      }

      if (offsetObj.offset !== view.byteLength) {
        console.warn(`GpsDataDecoder: Finished but not all bytes consumed. Offset: ${offsetObj.offset}, Length: ${view.byteLength}. May indicate trailing data or incomplete final block.`);
      }
      
      console.log(`GpsDataDecoder: Decoded ${points.length} points.`);
      return points;
    },

    /**
     * 读取变长有符号32位整数
     * @private
     * @param {DataView} view - 数据视图
     * @param {Object} offsetObj - 包含偏移量的对象引用
     * @returns {number} - 解码的有符号整数
     */
    _readVarintS32(view, offsetObj) {
      let unsigned_val = 0;
      let shift = 0;
      let byte;
      const initialOffset = offsetObj.offset; // For error reporting

      for (let i = 0; i < 5; i++) {
        if (offsetObj.offset >= view.byteLength) {
          throw new Error(`Buffer underflow at offset ${initialOffset} while reading varint (byte ${i + 1}).`);
        }
        
        byte = view.getUint8(offsetObj.offset++);
        unsigned_val |= (byte & 0x7F) << shift;
        shift += 7;
        
        if ((byte & 0x80) === 0) {
          return (unsigned_val >>> 1) ^ -(unsigned_val & 1);
        }
      }
      
      throw new Error(`Varint too long or malformed at offset ${initialOffset} (exceeded 5 bytes for s32).`);
    }
  };
}

export default createGpsDecoder;