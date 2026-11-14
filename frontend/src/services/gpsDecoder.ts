import type { GpsPoint } from "../types/track.ts";
import { decodeGpsPoints } from "./gpsCodec.ts";

export type { GpsPoint };

export function createGpsDecoder() {
  return {
    decode(arrayBuffer: ArrayBuffer | Uint8Array): GpsPoint[] {
      const points = decodeGpsPoints(arrayBuffer);
      console.log(`GpsDataDecoder: decoded ${points.length} points.`);
      return points;
    }
  };
}

export default createGpsDecoder;
