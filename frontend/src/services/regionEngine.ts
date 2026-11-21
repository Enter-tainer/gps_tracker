import type {
  RegionLevel,
  RegionMetaRecord,
  VisitedRegion
} from "../types/track.ts";

export type CompactRegionRow = [
  rid: number,
  level: RegionLevel,
  parentRid: number | null,
  directChildCount: number,
  leafChildCount: number,
  areaKm2: number,
  isLeaf: 0 | 1,
  country: string,
  nameZh: string,
  nameEn: string,
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number
];

export type CompactRegionsMetaFile = {
  version: number;
  release: string;
  rows: CompactRegionRow[];
};

export type LeafRegionHit = {
  rid: number;
  exploredCells: number;
  exploredAreaKm2: number;
  dates: Set<string>;
  trackIds: Set<string>;
  firstTs: number;
  lastTs: number;
};

export function decodeCompactRegionsMeta(
  file: CompactRegionsMetaFile
): Map<number, RegionMetaRecord> {
  const map = new Map<number, RegionMetaRecord>();
  for (const row of file.rows) {
    const [
      rid,
      level,
      parentRid,
      directChildCount,
      leafChildCount,
      areaKm2,
      isLeaf,
      country,
      nameZh,
      nameEn,
      minLon,
      minLat,
      maxLon,
      maxLat
    ] = row;
    map.set(rid, {
      rid,
      level,
      parentRid,
      directChildCount,
      leafChildCount,
      areaKm2,
      isLeaf: isLeaf === 1,
      country,
      nameZh,
      nameEn,
      bbox: [minLon, minLat, maxLon, maxLat]
    });
  }
  return map;
}

export function computeLeafRegionHeat(
  exploredAreaKm2: number,
  areaKm2: number,
  visitDays: number
): number {
  const areaRatio = exploredAreaKm2 / Math.max(0.5, areaKm2);
  const areaScore = Math.min(1, Math.log1p(areaRatio * 100) / Math.log1p(8));
  const dayScore = Math.min(1, Math.log1p(visitDays) / Math.log1p(15));
  const raw = 0.22 + 0.78 * (0.75 * areaScore + 0.25 * dayScore);
  return Math.round(Math.max(0.2, Math.min(1, raw)) * 1000) / 1000;
}

export function computeParentRegionHeat(
  litDirectChildren: number,
  directChildCount: number,
  litLeafChildren: number,
  leafChildCount: number,
  exploredAreaKm2: number,
  areaKm2: number
): number {
  const directRatio = Math.min(
    1,
    litDirectChildren / Math.max(1, directChildCount)
  );
  const leafRatio = Math.min(1, litLeafChildren / Math.max(1, leafChildCount));
  const coverage = 0.7 * directRatio + 0.3 * leafRatio;
  const areaDamp =
    directChildCount <= 2
      ? Math.min(
          1,
          0.4 +
            0.6 *
              Math.min(
                1,
                Math.log1p((exploredAreaKm2 / Math.max(0.5, areaKm2)) * 100) /
                  Math.log1p(5)
              )
        )
      : 1;
  const raw = 0.2 + 0.8 * Math.pow(coverage * areaDamp, 0.58);
  return Math.round(Math.max(0.2, Math.min(1, raw)) * 1000) / 1000;
}

type MutableRollupAcc = {
  meta: RegionMetaRecord;
  litDirectChildRids: Set<number>;
  litLeafChildRids: Set<number>;
  dates: Set<string>;
  trackIds: Set<string>;
  exploredCells: number;
  exploredAreaKm2: number;
  firstTs: number;
  lastTs: number;
};

export function computeHierarchicalVisitedRegions(
  leafHits: Map<number, LeafRegionHit>,
  metaMap: Map<number, RegionMetaRecord>
): VisitedRegion[] {
  const accMap = new Map<number, MutableRollupAcc>();

  const getOrCreateAcc = (meta: RegionMetaRecord): MutableRollupAcc => {
    let acc = accMap.get(meta.rid);
    if (!acc) {
      acc = {
        meta,
        litDirectChildRids: new Set(),
        litLeafChildRids: new Set(),
        dates: new Set(),
        trackIds: new Set(),
        exploredCells: 0,
        exploredAreaKm2: 0,
        firstTs: Number.POSITIVE_INFINITY,
        lastTs: 0
      };
      accMap.set(meta.rid, acc);
    }
    return acc;
  };

  for (const hit of leafHits.values()) {
    const leafMeta = metaMap.get(hit.rid);
    if (!leafMeta) continue;

    // Walk up the hierarchy from leaf -> parent -> ... -> L0 country
    let currMeta: RegionMetaRecord | undefined = leafMeta;
    let prevRid: number | null = null;
    const seen = new Set<number>();

    while (currMeta && !seen.has(currMeta.rid)) {
      seen.add(currMeta.rid);
      const acc = getOrCreateAcc(currMeta);
      acc.exploredCells += hit.exploredCells;
      acc.exploredAreaKm2 += hit.exploredAreaKm2;
      for (const d of hit.dates) acc.dates.add(d);
      for (const tid of hit.trackIds) acc.trackIds.add(tid);
      if (hit.firstTs > 0 && hit.firstTs < acc.firstTs) {
        acc.firstTs = hit.firstTs;
      }
      if (hit.lastTs > acc.lastTs) {
        acc.lastTs = hit.lastTs;
      }

      if (prevRid !== null) {
        acc.litDirectChildRids.add(prevRid);
        acc.litLeafChildRids.add(leafMeta.rid);
      }

      prevRid = currMeta.rid;
      currMeta =
        currMeta.parentRid !== null ? metaMap.get(currMeta.parentRid) : undefined;
    }
  }

  const visited: VisitedRegion[] = [];
  for (const acc of accMap.values()) {
    const { meta } = acc;
    const visitDays = acc.dates.size;
    const trackCount = acc.trackIds.size;
    const exploredAreaKm2 = Math.round(acc.exploredAreaKm2 * 1000) / 1000;
    const litDirectChildren = acc.litDirectChildRids.size;
    const litLeafChildren = acc.litLeafChildRids.size;

    const heat =
      meta.isLeaf || meta.directChildCount === 0
        ? computeLeafRegionHeat(exploredAreaKm2, meta.areaKm2, visitDays)
        : computeParentRegionHeat(
            litDirectChildren,
            meta.directChildCount,
            litLeafChildren,
            meta.leafChildCount,
            exploredAreaKm2,
            meta.areaKm2
          );

    visited.push({
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
      visitDays,
      trackCount,
      heat,
      firstTs: Number.isFinite(acc.firstTs) ? acc.firstTs : 0,
      lastTs: acc.lastTs,
      bbox: meta.bbox
    });
  }

  visited.sort(
    (a, b) =>
      a.level - b.level ||
      b.heat - a.heat ||
      b.exploredAreaKm2 - a.exploredAreaKm2
  );
  return visited;
}

const HEAT_STOPS: Array<[number, string]> = [
  [0.15, "#0284c7"],
  [0.35, "#06b6d4"],
  [0.55, "#10b981"],
  [0.72, "#facc15"],
  [0.88, "#f97316"],
  [1.0, "#f43f5e"]
];

export function getRegionHeatColor(heat: number): string {
  if (heat <= HEAT_STOPS[0][0]) return HEAT_STOPS[0][1];
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    if (heat <= HEAT_STOPS[i][0]) {
      const prev = HEAT_STOPS[i - 1];
      const next = HEAT_STOPS[i];
      return heat - prev[0] < next[0] - heat ? prev[1] : next[1];
    }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1][1];
}
