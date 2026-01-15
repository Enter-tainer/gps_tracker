import AGNSSDataFetcher from "./AgnssDataFetcher";

type GeoData = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  hasPosition: boolean;
};

const MESSAGE_TYPES = new Map<string, string>([
  ["11,1", "AID-INI"],
  ["8,0", "MSG_BDSUTC"],
  ["8,1", "MSG_BDSION"],
  ["8,2", "MSG_BDSEPH"],
  ["8,5", "MSG_GPSUTC"],
  ["8,6", "MSG_GPSION"],
  ["8,7", "MSG_GPSEPH"],
  ["5,1", "ACK"],
  ["5,0", "NACK"]
]);

export class CASICPacket {
  header = 0;
  length = 0;
  classId = 0;
  messageId = 0;
  payload: Uint8Array | null = null;
  checksum = 0;
  rawBytes: Uint8Array | null = null;

  toString() {
    const msgType = CASICProcessor.getMessageName(this.classId, this.messageId);
    return `CASIC ${msgType} (Class=0x${this.classId.toString(16).padStart(2, "0")}, ` +
      `ID=0x${this.messageId.toString(16).padStart(2, "0")}), len=${this.length}`;
  }
}

export class CASICProcessor {
  packets: CASICPacket[] = [];
  HEADER_MAGIC = new Uint8Array([0xba, 0xce]);
  MIN_PACKET_SIZE = 10;

  static getMessageName(classId: number, messageId: number) {
    return MESSAGE_TYPES.get(`${classId},${messageId}`) || "UNKNOWN";
  }

  calculateChecksum(classId: number, messageId: number, length: number, payload: Uint8Array) {
    let checksum = 0;
    checksum += (messageId & 0xff) * 0x1000000;
    checksum += (classId & 0xff) * 0x10000;
    checksum += length & 0xffff;
    checksum = checksum >>> 0;

    const payloadLen = payload.length;
    const dataView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    for (let i = 0; i < Math.floor(payloadLen / 4); i++) {
      const offset = i * 4;
      if (offset + 4 <= payloadLen) {
        const payloadWord = dataView.getUint32(offset, true);
        checksum = (checksum + payloadWord) >>> 0;
      }
    }

    return checksum;
  }

  parseData(data: Uint8Array) {
    const packets: CASICPacket[] = [];
    let offset = 0;

    while (offset < data.length - this.MIN_PACKET_SIZE) {
      const headerPos = this.findHeader(data, offset);
      if (headerPos === -1) {
        break;
      }

      offset = headerPos;

      if (offset + this.MIN_PACKET_SIZE > data.length) {
        break;
      }

      const packet = new CASICPacket();

      packet.header = (data[offset + 1] << 8) | data[offset];
      offset += 2;

      packet.length = data[offset] | (data[offset + 1] << 8);
      offset += 2;

      packet.classId = data[offset++];
      packet.messageId = data[offset++];

      if (offset + packet.length + 4 > data.length) {
        console.warn("Packet length exceeds data bounds, skipping.");
        break;
      }

      packet.payload = data.slice(offset, offset + packet.length);
      offset += packet.length;

      const checksumView = new DataView(data.buffer, data.byteOffset + offset, 4);
      packet.checksum = checksumView.getUint32(0, true);
      offset += 4;

      const calculatedChecksum = this.calculateChecksum(
        packet.classId,
        packet.messageId,
        packet.length,
        packet.payload
      );

      if (packet.checksum !== calculatedChecksum) {
        console.warn(
          `Checksum mismatch: expected 0x${calculatedChecksum.toString(16)}, got 0x${packet.checksum.toString(16)}`
        );
        continue;
      }

      const packetStart = headerPos;
      const packetEnd = offset;
      packet.rawBytes = data.slice(packetStart, packetEnd);

      packets.push(packet);
    }

    return packets;
  }

  findHeader(data: Uint8Array, startOffset: number) {
    for (let i = startOffset; i < data.length - 1; i++) {
      if (data[i] === this.HEADER_MAGIC[0] && data[i + 1] === this.HEADER_MAGIC[1]) {
        return i;
      }
    }
    return -1;
  }

  createAidIniPacket(geoData: GeoData | null = null) {
    let latitude = 31.2304;
    let longitude = 121.4737;
    let hasValidPosition = false;

    if (geoData && geoData.hasPosition) {
      latitude = geoData.latitude;
      longitude = geoData.longitude;
      hasValidPosition = true;
      console.log(
        `Using browser location: lat=${latitude.toFixed(6)}, lon=${longitude.toFixed(6)}`
      );
    } else {
      console.log(`Using default location: lat=${latitude}, lon=${longitude}`);
    }

    const altitude = 10.0;
    const now = new Date();
    const gpsEpoch = new Date("2006-01-01T00:00:00Z");
    const totalSeconds = (now.getTime() - gpsEpoch.getTime()) / 1000;
    const gpsWeek = Math.floor(totalSeconds / (7 * 24 * 3600));
    const timeOfWeek = totalSeconds % (7 * 24 * 3600);

    const frequencyBias = 0.0;
    const positionAccuracy = hasValidPosition ? 50.0 : 10000.0;
    const timeAccuracy = 1.0;
    const frequencyAccuracy = 1.0;
    const reserved = 0;
    const weekNumber = gpsWeek;
    const timerSource = 1;
    let flags = 0b01100010;
    if (hasValidPosition) {
      flags |= 0b00000001;
    }

    const payload = new ArrayBuffer(56);
    const view = new DataView(payload);
    let offset = 0;

    view.setFloat64(offset, latitude, true); offset += 8;
    view.setFloat64(offset, longitude, true); offset += 8;
    view.setFloat64(offset, altitude, true); offset += 8;
    view.setFloat64(offset, timeOfWeek, true); offset += 8;
    view.setFloat32(offset, frequencyBias, true); offset += 4;
    view.setFloat32(offset, positionAccuracy, true); offset += 4;
    view.setFloat32(offset, timeAccuracy, true); offset += 4;
    view.setFloat32(offset, frequencyAccuracy, true); offset += 4;
    view.setUint32(offset, reserved, true); offset += 4;
    view.setUint16(offset, weekNumber, true); offset += 2;
    view.setUint8(offset, timerSource); offset += 1;
    view.setUint8(offset, flags); offset += 1;

    return this.createCasicPacket(0x0b, 0x01, new Uint8Array(payload));
  }

  createCasicPacket(classId: number, messageId: number, payload: Uint8Array) {
    const length = payload.length;
    const checksum = this.calculateChecksum(classId, messageId, length, payload);

    const packetSize = 2 + 2 + 1 + 1 + length + 4;
    const packet = new Uint8Array(packetSize);
    let offset = 0;

    packet[offset++] = 0xba;
    packet[offset++] = 0xce;

    packet[offset++] = length & 0xff;
    packet[offset++] = (length >> 8) & 0xff;

    packet[offset++] = classId;
    packet[offset++] = messageId;

    packet.set(payload, offset);
    offset += length;

    packet[offset++] = checksum & 0xff;
    packet[offset++] = (checksum >> 8) & 0xff;
    packet[offset++] = (checksum >> 16) & 0xff;
    packet[offset++] = (checksum >> 24) & 0xff;

    return packet;
  }

  analyzePackets(packets: CASICPacket[]) {
    console.log("=== CASIC Packet Analysis ===");
    console.log(`Total packets: ${packets.length}`);

    const stats = new Map<string, number>();
    packets.forEach((packet) => {
      const msgType = CASICProcessor.getMessageName(packet.classId, packet.messageId);
      stats.set(msgType, (stats.get(msgType) || 0) + 1);
    });

    console.log("Message counts:");
    for (const [msgType, count] of stats) {
      console.log(`  ${msgType}: ${count}`);
    }

    console.log("First 10 packets:");
    packets.slice(0, 10).forEach((packet, index) => {
      console.log(`  ${index + 1}. ${packet.toString()}`);
    });
  }
}

export async function getBrowserLocation(timeout = 10000): Promise<GeoData> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      console.log("Geolocation API is not available.");
      resolve({ hasPosition: false, latitude: 0, longitude: 0 });
      return;
    }

    const options: PositionOptions = {
      enableHighAccuracy: true,
      timeout,
      maximumAge: 300000
    };

    console.log("Requesting geolocation...");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        console.log(
          `Geolocation success: lat=${latitude.toFixed(6)}, lon=${longitude.toFixed(6)}, accuracy=${accuracy.toFixed(0)}m`
        );
        resolve({ latitude, longitude, accuracy, hasPosition: true });
      },
      (error) => {
        let errorMsg = "Unknown error";
        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMsg = "Permission denied";
            break;
          case error.POSITION_UNAVAILABLE:
            errorMsg = "Position unavailable";
            break;
          case error.TIMEOUT:
            errorMsg = "Geolocation timeout";
            break;
        }
        console.log(`Geolocation failed: ${errorMsg}`);
        resolve({ hasPosition: false, latitude: 0, longitude: 0 });
      },
      options
    );
  });
}

export async function processAGNSSData() {
  try {
    console.log("=== CASIC AGNSS Processing ===");
    console.log("Fetching geolocation and ephemeris data...");

    const [geoData, rawData] = await Promise.all([
      getBrowserLocation().catch((error) => {
        console.warn("Geolocation failed:", error);
        return { hasPosition: false, latitude: 0, longitude: 0 };
      }),
      (async () => {
        const fetcher = new AGNSSDataFetcher();
        return await fetcher.downloadEphemeris("gps_bds.eph", "/");
      })()
    ]);

    console.log("Parallel tasks completed.");

    const uint8Data = new Uint8Array(rawData);
    const processor = new CASICProcessor();
    const packets = processor.parseData(uint8Data);

    if (packets.length === 0) {
      console.log("No valid CASIC packets found.");
      return [];
    }

    processor.analyzePackets(packets);

    console.log("Creating AID-INI packet...");
    const aidIniPacket = processor.createAidIniPacket(geoData);

    const allPackets: Uint8Array[] = [aidIniPacket];
    packets.forEach((packet) => {
      if (packet.rawBytes) {
        allPackets.push(packet.rawBytes);
      }
    });

    return allPackets;
  } catch (error) {
    console.error("AGNSS processing failed:", error);
    throw error;
  }
}

