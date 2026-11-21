import { classifyRings, VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

import type {
  CompactTrackRegionTuple,
  FogPackData,
  RegionMetaRecord,
  TrackMetadata,
  VisitedRegion
} from "../types/track.ts";
import {
  cellAreaKm2AtTileY,
  decodeTileKey
} from "../utils/coordTransform.ts";
import {
  FOG_CELL_ZOOM,
  FOG_TILE_ZOOM,
  type RasterizedTrackTile
} from "./fogEngine.ts";
import {
  computeHierarchicalVisitedRegions,
  computeLeafRegionHeat,
  computeParentRegionHeat,
  decodeCompactRegionsMeta,
  type CompactRegionsMetaFile,
  type LeafRegionHit
} from "./regionEngine.ts";

let versionPromise: Promise<string | null> | null = null;
let cachedTileVersion: string | null | undefined;

export async function fetchRegionsTileVersion(): Promise<string | null> {
  if (cachedTileVersion !== undefined) return cachedTileVersion;
  if (!versionPromise) {
    versionPromise = (async () => {
      try {
        const resp = await fetch("/api/regions/tiles/version");
        if (!resp.ok) {
          versionPromise = null;
          return null;
        }
        const json = (await resp.json()) as { version?: unknown };
        const v = typeof json.version === "string" && json.version ? json.version : null;
        cachedTileVersion = v;
        return v;
      } catch {
        versionPromise = null;
        return null;
      }
    })();
  }
  return versionPromise;
}

export function getRegionsTileTemplateUrl(version?: string | null): string {
  const suffix = version ? `?v=${encodeURIComponent(version)}` : "";
  const base =
    typeof window === "undefined"
      ? "/api/regions/tiles/{z}/{x}/{y}.mvt"
      : `${window.location.origin}/api/regions/tiles/{z}/{x}/{y}.mvt`;
  return `${base}${suffix}`;
}

let metaPromise: Promise<Map<number, RegionMetaRecord> | null> | null = null;
let cachedMetaMap: Map<number, RegionMetaRecord> | null = null;

export async function fetchRegionsMeta(): Promise<Map<
  number,
  RegionMetaRecord
> | null> {
  if (cachedMetaMap) return cachedMetaMap;
  if (!metaPromise) {
    metaPromise = (async () => {
      try {
        const resp = await fetch("/api/regions/meta");
        if (!resp.ok) {
          metaPromise = null;
          return null;
        }
        const raw = (await resp.json()) as CompactRegionsMetaFile;
        const map = decodeCompactRegionsMeta(raw);
        cachedMetaMap = map;
        return map;
      } catch {
        metaPromise = null;
        return null;
      }
    })();
  }
  return metaPromise;
}

type RingPoint = { x: number; y: number };

type DecodedPolyFeature = {
  rid: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  polygons: RingPoint[][][];
};

function pointInRing(px: number, py: number, ring: RingPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;

    const intersect =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(
  px: number,
  py: number,
  rings: RingPoint[][]
): boolean {
  if (rings.length === 0 || !pointInRing(px, py, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(px, py, rings[h])) return false;
  }
  return true;
}

function distSqToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) {
    const ox = px - ax;
    const oy = py - ay;
    return ox * ox + oy * oy;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ox = px - cx;
  const oy = py - cy;
  return ox * ox + oy * oy;
}

function findRegionInTileFeatures(
  px: number,
  py: number,
  features: DecodedPolyFeature[]
): number | null {
  for (const feat of features) {
    if (
      px < feat.minX ||
      px > feat.maxX ||
      py < feat.minY ||
      py > feat.maxY
    ) {
      continue;
    }
    for (const poly of feat.polygons) {
      if (pointInPolygon(px, py, poly)) {
        return feat.rid;
      }
    }
  }

  // Coastal / estuary bridge fallback (~1.2 km in Z10 MVT coordinates)
  const pad = 48;
  let bestRid: number | null = null;
  let bestDistSq = pad * pad;

  for (const feat of features) {
    if (
      px < feat.minX - pad ||
      px > feat.maxX + pad ||
      py < feat.minY - pad ||
      py > feat.maxY + pad
    ) {
      continue;
    }
    for (const poly of feat.polygons) {
      const outer = poly[0];
      if (!outer || outer.length < 2) continue;
      for (let i = 0; i < outer.length - 1; i++) {
        const dSq = distSqToSegment(
          px,
          py,
          outer[i].x,
          outer[i].y,
          outer[i + 1].x,
          outer[i + 1].y
        );
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestRid = feat.rid;
        }
      }
    }
  }
  return bestRid;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        await worker(items[idx]);
      }
    }
  );
  await Promise.all(runners);
}

/**
 * Classifies a list of Z15 tile keys into their global leaf region ID (`rid`)
 * by fetching only the covering Z10 vector tiles from `/api/regions/tiles/{z}/{x}/{y}.mvt`
 * and doing exact MVT-space Point-in-Polygon.
 */
export async function classifyZ15TilesViaPmtiles(
  tileKeys: number[]
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (tileKeys.length === 0) return result;

  const tileVer = await fetchRegionsTileVersion();
  const qs = tileVer ? `?v=${encodeURIComponent(tileVer)}` : "";

  // Group Z15 tiles by their parent Z10 tile (15 - 10 = 5 bits)
  const byZ10 = new Map<
    string,
    { z10x: number; z10y: number; items: Array<{ key: number; tx15: number; ty15: number }> }
  >();
  for (const key of tileKeys) {
    const [tx15, ty15] = decodeTileKey(key);
    const z10x = tx15 >> 5;
    const z10y = ty15 >> 5;
    const zKey = `${z10x}:${z10y}`;
    let group = byZ10.get(zKey);
    if (!group) {
      group = { z10x, z10y, items: [] };
      byZ10.set(zKey, group);
    }
    group.items.push({ key, tx15, ty15 });
  }

  const groups = Array.from(byZ10.values());
  await runWithConcurrency(groups, 6, async (group) => {
    try {
      const resp = await fetch(
        `/api/regions/tiles/10/${group.z10x}/${group.z10y}.mvt${qs}`
      );
      if (resp.status === 204 || resp.status === 404 || !resp.ok) return;

      const buf = await resp.arrayBuffer();
      const vt = new VectorTile(new PbfReader(new Uint8Array(buf)));
      const layer = vt.layers["l3"];
      if (!layer || layer.length === 0) return;

      const extent = layer.extent || 4096;
      const decodedFeatures: DecodedPolyFeature[] = [];

      for (let i = 0; i < layer.length; i++) {
        const feat = layer.feature(i);
        if (feat.type !== 3) continue;
        const rid = Number(feat.id ?? feat.properties?.rid);
        if (!Number.isFinite(rid) || rid <= 0) continue;

        const rings = feat.loadGeometry();
        const polygons = classifyRings(rings);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const poly of polygons) {
          for (const pt of poly[0] ?? []) {
            if (pt.x < minX) minX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y > maxY) maxY = pt.y;
          }
        }
        decodedFeatures.push({ rid, minX, minY, maxX, maxY, polygons });
      }

      for (const item of group.items) {
        const px = (((item.tx15 & 31) + 0.5) / 32) * extent;
        const py = (((item.ty15 & 31) + 0.5) / 32) * extent;
        const rid = findRegionInTileFeatures(px, py, decodedFeatures);
        if (rid !== null) {
          result.set(item.key, rid);
        }
      }
    } catch {
      // Skip unreadable tile
    }
  });

  return result;
}

export type RebuiltRegionsPayload = {
  visitedRegions: VisitedRegion[];
  trackRegions: Array<[number, string, number, number, number]>;
};

export async function rebuildVisitedRegionsInBrowser(
  fogPack: FogPackData,
  trackTilesList: Array<{
    trackId: string;
    date: string;
    tiles: Map<number, RasterizedTrackTile>;
  }>,
  onProgress?: (stage: string) => void
): Promise<RebuiltRegionsPayload | null> {
  const metaMap = await fetchRegionsMeta();
  if (!metaMap || metaMap.size === 0) {
    return null;
  }

  onProgress?.("正在读取全球区县 PMTiles 空间索引...");
  const tileKeys = Array.from(fogPack.tiles.keys());
  const tileKeyToRid = await classifyZ15TilesViaPmtiles(tileKeys);
  if (tileKeyToRid.size === 0) {
    return null;
  }

  onProgress?.("正在聚合省/市/区县层级热力...");
  const leafHits = new Map<number, LeafRegionHit>();
  const trackRegionAgg = new Map<
    string,
    { rid: number; trackId: string; cellCount: number; firstTs: number; lastTs: number }
  >();

  for (const tile of fogPack.tiles.values()) {
    const rid = tileKeyToRid.get(tile.tileKey);
    if (!rid) continue;

    const [, ty] = decodeTileKey(tile.tileKey);
    const tileAreaKm2 =
      tile.cellCount * cellAreaKm2AtTileY(ty, FOG_CELL_ZOOM, FOG_TILE_ZOOM);

    let hit = leafHits.get(rid);
    if (!hit) {
      hit = {
        rid,
        exploredCells: 0,
        exploredAreaKm2: 0,
        dates: new Set(),
        trackIds: new Set(),
        firstTs: Number.POSITIVE_INFINITY,
        lastTs: 0
      };
      leafHits.set(rid, hit);
    }
    hit.exploredCells += tile.cellCount;
    hit.exploredAreaKm2 += tileAreaKm2;
  }

  for (const item of trackTilesList) {
    for (const [tileKey, tTile] of item.tiles.entries()) {
      const rid = tileKeyToRid.get(tileKey);
      if (!rid) continue;
      const hit = leafHits.get(rid);
      if (hit) {
        hit.trackIds.add(item.trackId);
        if (item.date) hit.dates.add(item.date);
        if (tTile.firstTs > 0 && tTile.firstTs < hit.firstTs) {
          hit.firstTs = tTile.firstTs;
        }
        if (tTile.lastTs > hit.lastTs) {
          hit.lastTs = tTile.lastTs;
        }
      }

      let currRid: number | null = rid;
      const seen = new Set<number>();
      while (currRid !== null && !seen.has(currRid)) {
        seen.add(currRid);
        const key = `${currRid}:${item.trackId}`;
        let agg = trackRegionAgg.get(key);
        if (!agg) {
          agg = {
            rid: currRid,
            trackId: item.trackId,
            cellCount: 0,
            firstTs: Number.POSITIVE_INFINITY,
            lastTs: 0
          };
          trackRegionAgg.set(key, agg);
        }
        agg.cellCount += Math.max(1, tTile.pointCount);
        if (tTile.firstTs > 0 && tTile.firstTs < agg.firstTs) {
          agg.firstTs = tTile.firstTs;
        }
        if (tTile.lastTs > agg.lastTs) {
          agg.lastTs = tTile.lastTs;
        }
        currRid = metaMap.get(currRid)?.parentRid ?? null;
      }
    }
  }

  const visitedRegions = computeHierarchicalVisitedRegions(leafHits, metaMap);
  const trackRegions: Array<[number, string, number, number, number]> = Array.from(
    trackRegionAgg.values()
  ).map((r) => [
    r.rid,
    r.trackId,
    r.cellCount,
    Number.isFinite(r.firstTs) ? r.firstTs : 0,
    r.lastTs
  ]);

  const resp = await fetch("/api/regions/visited", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitedRegions, trackRegions })
  });
  if (!resp.ok) {
    throw new Error(`PUT /api/regions/visited failed: HTTP ${resp.status}`);
  }

  return { visitedRegions, trackRegions };
}

export async function classifyUploadedTrackRegions(params: {
  track: TrackMetadata;
  trackTiles: Map<number, RasterizedTrackTile>;
  existingVisitedRegions: VisitedRegion[];
}): Promise<{
  trackRegions: CompactTrackRegionTuple[];
  visitedRegions: VisitedRegion[];
} | null> {
  const { track, trackTiles, existingVisitedRegions } = params;
  const metaMap = await fetchRegionsMeta();
  if (!metaMap || metaMap.size === 0 || trackTiles.size === 0) {
    return null;
  }

  const tileKeyToRid = await classifyZ15TilesViaPmtiles(
    Array.from(trackTiles.keys())
  );
  if (tileKeyToRid.size === 0) {
    return null;
  }

  // Build trackRegions tuples across matched leaves & ancestors
  const trackAgg = new Map<
    number,
    { cellCount: number; firstTs: number; lastTs: number }
  >();
  const trackLeafStats = new Map<
    number,
    { cells: number; areaKm2: number; firstTs: number; lastTs: number }
  >();

  for (const [tileKey, tTile] of trackTiles.entries()) {
    const rid = tileKeyToRid.get(tileKey);
    if (!rid) continue;

    const [, ty] = decodeTileKey(tileKey);
    const tileCells = tTile.bitmask.reduce((sum, b) => {
      let c = 0;
      let v = b;
      while (v) {
        v &= v - 1;
        c++;
      }
      return sum + c;
    }, 0);
    const tileAreaKm2 =
      tileCells * cellAreaKm2AtTileY(ty, FOG_CELL_ZOOM, FOG_TILE_ZOOM);

    const prevLeaf = trackLeafStats.get(rid) ?? {
      cells: 0,
      areaKm2: 0,
      firstTs: Number.POSITIVE_INFINITY,
      lastTs: 0
    };
    prevLeaf.cells += tileCells;
    prevLeaf.areaKm2 += tileAreaKm2;
    if (tTile.firstTs > 0 && tTile.firstTs < prevLeaf.firstTs) {
      prevLeaf.firstTs = tTile.firstTs;
    }
    if (tTile.lastTs > prevLeaf.lastTs) {
      prevLeaf.lastTs = tTile.lastTs;
    }
    trackLeafStats.set(rid, prevLeaf);

    let currRid: number | null = rid;
    const seen = new Set<number>();
    while (currRid !== null && !seen.has(currRid)) {
      seen.add(currRid);
      const prev = trackAgg.get(currRid) ?? {
        cellCount: 0,
        firstTs: Number.POSITIVE_INFINITY,
        lastTs: 0
      };
      prev.cellCount += Math.max(1, tTile.pointCount);
      if (tTile.firstTs > 0 && tTile.firstTs < prev.firstTs) {
        prev.firstTs = tTile.firstTs;
      }
      if (tTile.lastTs > prev.lastTs) {
        prev.lastTs = tTile.lastTs;
      }
      trackAgg.set(currRid, prev);
      currRid = metaMap.get(currRid)?.parentRid ?? null;
    }
  }

  const trackRegions: CompactTrackRegionTuple[] = Array.from(
    trackAgg.entries()
  ).map(([rid, s]) => [
    rid,
    s.cellCount,
    Number.isFinite(s.firstTs) ? s.firstTs : track.start_time,
    s.lastTs || track.end_time
  ]);

  // Incrementally merge newly hit leaves into existing visited leaf states, then roll up
  const leafStateMap = new Map<number, VisitedRegion>();
  for (const r of existingVisitedRegions) {
    const meta = metaMap.get(r.rid);
    if (meta && (meta.isLeaf || meta.directChildCount === 0)) {
      leafStateMap.set(r.rid, { ...r });
    }
  }

  for (const [rid, delta] of trackLeafStats.entries()) {
    const meta = metaMap.get(rid);
    if (!meta) continue;
    const prev = leafStateMap.get(rid);
    const firstTs = Number.isFinite(delta.firstTs)
      ? delta.firstTs
      : track.start_time;
    const lastTs = delta.lastTs || track.end_time;

    if (!prev) {
      const exploredAreaKm2 = Math.round(delta.areaKm2 * 1000) / 1000;
      leafStateMap.set(rid, {
        rid,
        level: meta.level,
        parentRid: meta.parentRid,
        country: meta.country,
        nameZh: meta.nameZh,
        nameEn: meta.nameEn,
        directChildCount: meta.directChildCount,
        leafChildCount: meta.leafChildCount,
        litDirectChildren: 0,
        litLeafChildren: 0,
        areaKm2: meta.areaKm2,
        exploredCells: delta.cells,
        exploredAreaKm2,
        visitDays: 1,
        trackCount: 1,
        heat: computeLeafRegionHeat(exploredAreaKm2, meta.areaKm2, 1),
        firstTs,
        lastTs,
        bbox: meta.bbox
      });
    } else {
      const exploredAreaKm2 =
        Math.round((prev.exploredAreaKm2 + delta.areaKm2) * 1000) / 1000;
      const visitDays = prev.visitDays + (lastTs > prev.lastTs ? 1 : 0);
      prev.exploredCells += delta.cells;
      prev.exploredAreaKm2 = exploredAreaKm2;
      prev.visitDays = visitDays;
      prev.trackCount += 1;
      prev.firstTs =
        prev.firstTs > 0 ? Math.min(prev.firstTs, firstTs) : firstTs;
      prev.lastTs = Math.max(prev.lastTs, lastTs);
      prev.heat = computeLeafRegionHeat(exploredAreaKm2, meta.areaKm2, visitDays);
    }
  }

  // Roll up all leaf states along parentRid chains
  const accMap = new Map<
    number,
    {
      meta: RegionMetaRecord;
      litDirect: Set<number>;
      litLeaves: Set<number>;
      exploredCells: number;
      exploredAreaKm2: number;
      visitDays: number;
      trackCount: number;
      firstTs: number;
      lastTs: number;
    }
  >();

  for (const leaf of leafStateMap.values()) {
    const leafMeta = metaMap.get(leaf.rid);
    if (!leafMeta) continue;
    let currMeta: RegionMetaRecord | undefined = leafMeta;
    let prevRid: number | null = null;
    const seen = new Set<number>();

    while (currMeta && !seen.has(currMeta.rid)) {
      seen.add(currMeta.rid);
      let acc = accMap.get(currMeta.rid);
      if (!acc) {
        acc = {
          meta: currMeta,
          litDirect: new Set(),
          litLeaves: new Set(),
          exploredCells: 0,
          exploredAreaKm2: 0,
          visitDays: 0,
          trackCount: 0,
          firstTs: Number.POSITIVE_INFINITY,
          lastTs: 0
        };
        accMap.set(currMeta.rid, acc);
      }
      acc.exploredCells += leaf.exploredCells;
      acc.exploredAreaKm2 += leaf.exploredAreaKm2;
      acc.visitDays = Math.max(acc.visitDays, leaf.visitDays);
      acc.trackCount += leaf.trackCount;
      if (leaf.firstTs > 0 && leaf.firstTs < acc.firstTs) {
        acc.firstTs = leaf.firstTs;
      }
      if (leaf.lastTs > acc.lastTs) {
        acc.lastTs = leaf.lastTs;
      }
      if (prevRid !== null) {
        acc.litDirect.add(prevRid);
        acc.litLeaves.add(leaf.rid);
      }

      prevRid = currMeta.rid;
      currMeta =
        currMeta.parentRid !== null ? metaMap.get(currMeta.parentRid) : undefined;
    }
  }

  const visitedRegions: VisitedRegion[] = [];
  for (const acc of accMap.values()) {
    const { meta } = acc;
    const existingLeaf = leafStateMap.get(meta.rid);
    if (existingLeaf && (meta.isLeaf || meta.directChildCount === 0)) {
      visitedRegions.push(existingLeaf);
      continue;
    }
    const exploredAreaKm2 = Math.round(acc.exploredAreaKm2 * 1000) / 1000;
    const litDirectChildren = acc.litDirect.size;
    const litLeafChildren = acc.litLeaves.size;
    visitedRegions.push({
      rid: meta.rid,
      level: meta.level,
      parentRid: meta.parentRid,
      country: meta.country,
      nameZh: meta.nameZh,
      nameEn: meta.nameEn,
      directChildCount: meta.directChildCount,
      leafChildCount: meta.leafChildCount,
      litDirectChildren,
      litLeafChildren,
      areaKm2: meta.areaKm2,
      exploredCells: acc.exploredCells,
      exploredAreaKm2,
      visitDays: acc.visitDays,
      trackCount: acc.trackCount,
      heat: computeParentRegionHeat(
        litDirectChildren,
        meta.directChildCount,
        litLeafChildren,
        meta.leafChildCount,
        exploredAreaKm2,
        meta.areaKm2
      ),
      firstTs: Number.isFinite(acc.firstTs) ? acc.firstTs : 0,
      lastTs: acc.lastTs,
      bbox: meta.bbox
    });
  }

  visitedRegions.sort(
    (a, b) =>
      a.level - b.level ||
      b.heat - a.heat ||
      b.exploredAreaKm2 - a.exploredAreaKm2
  );

  return { trackRegions, visitedRegions };
}
