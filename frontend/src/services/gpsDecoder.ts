export type GpsPoint = {
  timestamp: number;
  latitude_scaled_1e5: number;
  longitude_scaled_1e5: number;
  altitude_m_scaled_1e1: number;
};

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

      let previousPoint: GpsPoint = {
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
            console.error(
              `GpsDataDecoder: buffer underflow at offset ${offsetObj.offset}. Remaining bytes: ${
                view.byteLength - offsetObj.offset
              }`
            );
            break;
          }

          const header = view.getUint8(offsetObj.offset++);
          let currentPoint: GpsPoint;

          if (header === 0xff) {
            if (offsetObj.offset + 16 > view.byteLength) {
              throw new Error(
                `Buffer underflow for full block payload at offset ${offsetObj.offset}. Needed 16, got ${
                  view.byteLength - offsetObj.offset
                }.`
              );
            }

            currentPoint = {
              timestamp: view.getUint32(offsetObj.offset, true),
              latitude_scaled_1e5: view.getInt32(offsetObj.offset + 4, true),
              longitude_scaled_1e5: view.getInt32(offsetObj.offset + 8, true),
              altitude_m_scaled_1e1: view.getInt32(offsetObj.offset + 12, true)
            };
            offsetObj.offset += 16;
            isFirstPoint = false;
          } else if ((header & 0x80) === 0) {
            if (isFirstPoint) {
              throw new Error("Invalid data: delta block found as the first block.");
            }

            if ((header & 0xf0) !== 0x00) {
              throw new Error(
                `Invalid delta block header: 0x${header.toString(16)}. Reserved bits must be 0.`
              );
            }

            currentPoint = { ...previousPoint };
            const flags = header & 0x0f;

            if ((flags >> 3) & 1) {
              currentPoint.timestamp = (currentPoint.timestamp + readVarintS32(view, offsetObj)) >>> 0;
            }

            if ((flags >> 2) & 1) {
              currentPoint.latitude_scaled_1e5 += readVarintS32(view, offsetObj);
            }

            if ((flags >> 1) & 1) {
              currentPoint.longitude_scaled_1e5 += readVarintS32(view, offsetObj);
            }

            if (flags & 1) {
              currentPoint.altitude_m_scaled_1e1 += readVarintS32(view, offsetObj);
            }
          } else {
            throw new Error(
              `Invalid block header: 0x${header.toString(16)} at offset ${pointStartOffset}.`
            );
          }

          points.push(currentPoint);
          previousPoint = currentPoint;
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

