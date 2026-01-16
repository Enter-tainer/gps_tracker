// GPS 数据点统一使用 1e7 精度存储（内部表示）
// V1 数据会自动转换为 1e7 精度
export type GpsPoint = {
  timestamp: number;
  latitude_scaled_1e7: number;
  longitude_scaled_1e7: number;
  altitude_m_scaled_1e1: number;
};

type FormatVersion = "V1" | "V2" | null;

export function createGpsDecoder() {
  const readVarintS32 = (view: DataView, offsetObj: { offset: number }) => {
    let unsignedVal = 0;
    let shift = 0;
    let byte = 0;
    const initialOffset = offsetObj.offset;

    for (let i = 0; i < 5; i++) {
      if (offsetObj.offset >= view.byteLength) {
        throw new Error(
          `Buffer underflow at offset ${initialOffset} while reading varint (byte ${i + 1}).`
        );
      }

      byte = view.getUint8(offsetObj.offset++);
      unsignedVal |= (byte & 0x7f) << shift;
      shift += 7;

      if ((byte & 0x80) === 0) {
        return (unsignedVal >>> 1) ^ -(unsignedVal & 1);
      }
    }

    throw new Error(
      `Varint too long or malformed at offset ${initialOffset} (exceeded 5 bytes for s32).`
    );
  };

  return {
    decode(arrayBuffer: ArrayBuffer) {
      const points: GpsPoint[] = [];

      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        console.error("GpsDataDecoder: input ArrayBuffer is empty or null.");
        return points;
      }

      const view = new DataView(arrayBuffer);
      const offsetObj = { offset: 0 };

      // V1 和 V2 各自维护前一个点的状态
      let previousPointV1: GpsPoint | null = null;
      let previousPointV2: GpsPoint | null = null;
      let currentVersion: FormatVersion = null;

      let pointIndex = 0;

      while (offsetObj.offset < view.byteLength) {
        const pointStartOffset = offsetObj.offset;

        try {
          if (offsetObj.offset + 1 > view.byteLength) {
            console.error(
              `GpsDataDecoder: buffer underflow at offset ${offsetObj.offset}. Remaining bytes: ${
                view.byteLength - offsetObj.offset
              }`
            );
            break;
          }

          const header = view.getUint8(offsetObj.offset++);
          let currentPoint: GpsPoint;

          // V1 Full Block (0xFF)
          if (header === 0xff) {
            if (offsetObj.offset + 16 > view.byteLength) {
              throw new Error(
                `Buffer underflow for V1 full block payload at offset ${offsetObj.offset}. Needed 16, got ${
                  view.byteLength - offsetObj.offset
                }.`
              );
            }

            // V1 使用 1e5 精度，转换为 1e7 (乘以 100)
            currentPoint = {
              timestamp: view.getUint32(offsetObj.offset, true),
              latitude_scaled_1e7: view.getInt32(offsetObj.offset + 4, true) * 100,
              longitude_scaled_1e7: view.getInt32(offsetObj.offset + 8, true) * 100,
              altitude_m_scaled_1e1: view.getInt32(offsetObj.offset + 12, true)
            };
            offsetObj.offset += 16;
            currentVersion = "V1";
            previousPointV1 = currentPoint;
          }
          // V2 Full Block (0xFE)
          else if (header === 0xfe) {
            if (offsetObj.offset + 16 > view.byteLength) {
              throw new Error(
                `Buffer underflow for V2 full block payload at offset ${offsetObj.offset}. Needed 16, got ${
                  view.byteLength - offsetObj.offset
                }.`
              );
            }

            // V2 直接使用 1e7 精度
            currentPoint = {
              timestamp: view.getUint32(offsetObj.offset, true),
              latitude_scaled_1e7: view.getInt32(offsetObj.offset + 4, true),
              longitude_scaled_1e7: view.getInt32(offsetObj.offset + 8, true),
              altitude_m_scaled_1e1: view.getInt32(offsetObj.offset + 12, true)
            };
            offsetObj.offset += 16;
            currentVersion = "V2";
            previousPointV2 = currentPoint;
          }
          // V1 Delta Block (0x00-0x0F, bit 4 = 0)
          else if ((header & 0xf0) === 0x00) {
            if (currentVersion !== "V1" || !previousPointV1) {
              throw new Error(
                `V1 Delta block at offset ${pointStartOffset} without preceding V1 Full block.`
              );
            }

            currentPoint = { ...previousPointV1 };
            const flags = header & 0x0f;

            if ((flags >> 3) & 1) {
              currentPoint.timestamp = (currentPoint.timestamp + readVarintS32(view, offsetObj)) >>> 0;
            }

            if ((flags >> 2) & 1) {
              // V1 delta 是 1e5 精度，转换为 1e7
              currentPoint.latitude_scaled_1e7 += readVarintS32(view, offsetObj) * 100;
            }

            if ((flags >> 1) & 1) {
              // V1 delta 是 1e5 精度，转换为 1e7
              currentPoint.longitude_scaled_1e7 += readVarintS32(view, offsetObj) * 100;
            }

            if (flags & 1) {
              currentPoint.altitude_m_scaled_1e1 += readVarintS32(view, offsetObj);
            }

            previousPointV1 = currentPoint;
          }
          // V2 Delta Block (0x10-0x1F, bit 4 = 1)
          else if ((header & 0xf0) === 0x10) {
            if (currentVersion !== "V2" || !previousPointV2) {
              throw new Error(
                `V2 Delta block at offset ${pointStartOffset} without preceding V2 Full block.`
              );
            }

            currentPoint = { ...previousPointV2 };
            const flags = header & 0x0f;

            if ((flags >> 3) & 1) {
              currentPoint.timestamp = (currentPoint.timestamp + readVarintS32(view, offsetObj)) >>> 0;
            }

            if ((flags >> 2) & 1) {
              // V2 delta 直接是 1e7 精度
              currentPoint.latitude_scaled_1e7 += readVarintS32(view, offsetObj);
            }

            if ((flags >> 1) & 1) {
              // V2 delta 直接是 1e7 精度
              currentPoint.longitude_scaled_1e7 += readVarintS32(view, offsetObj);
            }

            if (flags & 1) {
              currentPoint.altitude_m_scaled_1e1 += readVarintS32(view, offsetObj);
            }

            previousPointV2 = currentPoint;
          }
          else {
            throw new Error(
              `Invalid block header: 0x${header.toString(16)} at offset ${pointStartOffset}.`
            );
          }

          points.push(currentPoint);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            `GpsDataDecoder: error decoding point ${pointIndex} at offset ${pointStartOffset}: ${message}.`
          );

          if (offsetObj.offset <= pointStartOffset) {
            console.warn(
              `GpsDataDecoder: offset did not advance after error at ${pointStartOffset}. Advancing by 1.`
            );
            offsetObj.offset = pointStartOffset + 1;
          }
        }

        pointIndex++;
      }

      if (offsetObj.offset !== view.byteLength) {
        console.warn(
          `GpsDataDecoder: finished but not all bytes consumed. Offset: ${offsetObj.offset}, Length: ${view.byteLength}.`
        );
      }

      console.log(`GpsDataDecoder: decoded ${points.length} points.`);
      return points;
    }
  };
}

export default createGpsDecoder;
