import type {
  CompactTrackTileTuple,
  FogPackData,
  FogTileEntry,
  GpsPoint,
  TrackMetadata,
  UploadTrackMetaPayload
} from "../types/track.ts";
import {
  createEmptyFogPack,
  encodeFogPack,
  mergeTrackTilesIntoFogPack,
  rasterizeTrackToFogTiles
} from "./fogEngine.ts";
import {
  computeTrackStatsAndOverview,
  decodeGpsPoints,
  parseGpxXmlToPoints
} from "./gpsCodec.ts";
import { encodeGpsl0Points } from "./gpsl0/index.ts";

export type BrowserEtlInputFile =
  | File
  | {
      name: string;
      buffer: ArrayBuffer;
    };

export type BrowserTrackEtlOptions = {
  file: BrowserEtlInputFile;
  baseFogPack: FogPackData | null;
  customId?: string;
  customTitle?: string;
  customDate?: string;
  encodeFogBinary?: boolean;
  onStage?: (stage: string) => void;
};

export type BrowserTrackEtlResult = {
  track: TrackMetadata;
  points: GpsPoint[];
  gpsl0Bytes: Uint8Array;
  tiles: CompactTrackTileTuple[];
  fogPack: FogPackData;
  fogBytes?: Uint8Array;
};

export function sanitizeTrackId(raw: string): string {
  const cleaned = raw
    .replace(/\.(gpx|gpz)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `track-${Date.now()}`;
}

function inferTrackIdentity(
  fileName: string,
  points: GpsPoint[],
  customTitle?: string,
  customDate?: string
): { id: string; date: string; title: string } {
  const base = fileName.replace(/\.(gpx|gpz)$/i, "");
  const ymd = fileName.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);

  let date = customDate?.trim() || "";
  if (!date && ymd) {
    date = `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }
  if (!date && points.length > 0 && points[0].timestamp > 0) {
    date = new Date((points[0].timestamp + 8 * 3600) * 1000)
      .toISOString()
      .slice(0, 10);
  }
  if (!date) {
    date = new Date().toISOString().slice(0, 10);
  }

  const title = customTitle?.trim() || (ymd ? date : base);
  const id = sanitizeTrackId(base);
  return { id, date, title };
}

export function cloneFogPack(source: FogPackData | null): FogPackData {
  if (!source) {
    return createEmptyFogPack();
  }
  const clonedTiles = new Map<number, FogTileEntry>();
  for (const [key, entry] of source.tiles.entries()) {
    clonedTiles.set(key, {
      tx: entry.tx,
      ty: entry.ty,
      tileKey: entry.tileKey,
      visitCount: entry.visitCount,
      cellCount: entry.cellCount,
      bitmask: new Uint8Array(entry.bitmask)
    });
  }
  return {
    version: source.version,
    tileCount: source.tileCount,
    totalCells: source.totalCells,
    exploredAreaKm2: source.exploredAreaKm2,
    tiles: clonedTiles
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function runBrowserTrackEtl(
  options: BrowserTrackEtlOptions
): Promise<BrowserTrackEtlResult> {
  const {
    file,
    baseFogPack,
    customId,
    customTitle,
    customDate,
    encodeFogBinary = true,
    onStage
  } = options;
  const fileName = file.name || `track-${Date.now()}.gpz`;
  const lowerName = fileName.toLowerCase();

  onStage?.("浏览器解析轨迹...");
  let points: GpsPoint[];
  if (lowerName.endsWith(".gpz")) {
    const buf = file instanceof File ? await file.arrayBuffer() : file.buffer;
    points = decodeGpsPoints(buf);
  } else if (lowerName.endsWith(".gpx")) {
    const xml =
      file instanceof File
        ? await file.text()
        : new TextDecoder().decode(file.buffer);
    points = parseGpxXmlToPoints(xml, customDate);
  } else {
    throw new Error("仅支持 .gpx 或 .gpz 文件");
  }

  if (points.length === 0) {
    throw new Error("文件中未解析出有效 GPS 轨迹点");
  }

  onStage?.("浏览器压缩 GPSL0 & 计算统计...");
  const inferred = inferTrackIdentity(fileName, points, customTitle, customDate);
  const trackId =
    customId && customId.trim() ? sanitizeTrackId(customId) : inferred.id;

  const summary = computeTrackStatsAndOverview(points);
  const gpsl0Bytes = encodeGpsl0Points(points);
  const r2Key = `d1://track_blobs/${trackId}`;

  onStage?.("浏览器光栅化 Z15/Z21 迷雾位图...");
  const trackTiles = rasterizeTrackToFogTiles(points);
  const fogPack = cloneFogPack(baseFogPack);
  mergeTrackTilesIntoFogPack(fogPack, trackTiles, true);

  const tiles: CompactTrackTileTuple[] = [];
  for (const [tileKey, t] of trackTiles.entries()) {
    tiles.push([tileKey, t.pointCount, t.firstTs, t.lastTs]);
  }
  tiles.sort((a, b) => a[0] - b[0]);

  const fogBytes = encodeFogBinary ? encodeFogPack(fogPack) : undefined;

  const track: TrackMetadata = {
    id: trackId,
    date: inferred.date,
    title: inferred.title,
    source_file: fileName,
    point_count: summary.pointCount,
    distance_m: summary.distanceM,
    duration_s: summary.durationS,
    elev_gain_m: summary.elevGainM,
    min_ele: summary.minEle,
    max_ele: summary.maxEle,
    start_time: summary.startTime,
    end_time: summary.endTime,
    min_lat: summary.minLat,
    max_lat: summary.maxLat,
    min_lon: summary.minLon,
    max_lon: summary.maxLon,
    r2_key: r2Key,
    overview_coords: summary.overviewCoords,
    created_at: Math.floor(Date.now() / 1000)
  };

  return {
    track,
    points,
    gpsl0Bytes,
    tiles,
    fogPack,
    fogBytes
  };
}

export async function uploadPreparedTrackToServer(params: {
  track: TrackMetadata;
  gpsl0Bytes: Uint8Array;
  tiles: CompactTrackTileTuple[];
  fogBytes?: Uint8Array;
}): Promise<TrackMetadata> {
  const { track, gpsl0Bytes, tiles, fogBytes } = params;
  const meta: UploadTrackMetaPayload = { track, tiles };

  const form = new FormData();
  form.append(
    "gpsl0",
    new Blob([toArrayBuffer(gpsl0Bytes)], { type: "application/octet-stream" }),
    `${track.id}.gpsl0`
  );
  form.append("meta", JSON.stringify(meta));
  if (fogBytes) {
    form.append(
      "fog",
      new Blob([toArrayBuffer(fogBytes)], { type: "application/octet-stream" }),
      "global-fog.bin"
    );
  }

  const resp = await fetch("/api/tracks/upload", {
    method: "POST",
    body: form
  });
  const json = (await resp.json()) as {
    ok?: boolean;
    track?: TrackMetadata;
    error?: string;
  };
  if (!resp.ok || !json.track) {
    throw new Error(json.error || `HTTP ${resp.status}`);
  }
  return json.track;
}
