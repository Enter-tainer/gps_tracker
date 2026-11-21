export type GpsPoint = {
  timestamp: number;
  latitude_scaled_1e7: number;
  longitude_scaled_1e7: number;
  altitude_m_scaled_1e1: number;
};

export type LonLat = [number, number];

export type TrackMetadata = {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  source_file: string;
  point_count: number;
  distance_m: number;
  duration_s: number;
  elev_gain_m: number;
  min_ele: number;
  max_ele: number;
  start_time: number;
  end_time: number;
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
  r2_key: string;
  /** Simplified segments in WGS-84 [lon, lat] pairs */
  overview_coords: LonLat[][];
  created_at: number;
};

export type BootstrapStats = {
  trackCount: number;
  totalPoints: number;
  totalDistanceM: number;
  totalDurationS: number;
  totalElevGainM: number;
  firstDate: string | null;
  lastDate: string | null;
  visitedTilesZ15: number;
  exploredCellsZ21: number;
  exploredAreaKm2: number;
};

export type FogRenderStyle = "hybrid" | "fine" | "regions";
export type RegionLevel = 0 | 1 | 2 | 3;
export type LodTier = "l0" | "l1" | "l2" | "l3" | "fine";

export type RegionMetaRecord = {
  rid: number;
  level: RegionLevel;
  parentRid: number | null;
  country: string;
  nameZh: string;
  nameEn: string;
  directChildCount: number;
  leafChildCount: number;
  areaKm2: number;
  isLeaf: boolean;
  bbox: [number, number, number, number];
};

export type VisitedRegion = {
  rid: number;
  level: RegionLevel;
  parentRid: number | null;
  country: string;
  nameZh: string;
  nameEn: string;
  directChildCount: number;
  leafChildCount: number;
  litDirectChildren: number;
  litLeafChildren: number;
  areaKm2: number;
  exploredCells: number;
  exploredAreaKm2: number;
  visitDays: number;
  trackCount: number;
  heat: number;
  firstTs: number;
  lastTs: number;
  bbox: [number, number, number, number];
};

export type SelectedRegionInfo = {
  rid: number;
  level: RegionLevel;
  nameZh: string;
  nameEn: string;
  country: string;
  directChildCount: number;
  leafChildCount: number;
  areaKm2: number;
  bbox: [number, number, number, number];
  visited: VisitedRegion | null;
};

export type CompactTrackRegionTuple = [
  rid: number,
  cellCount: number,
  firstTs: number,
  lastTs: number
];

export type BootstrapResponse = {
  stats: BootstrapStats;
  tracks: TrackMetadata[];
  regions?: VisitedRegion[];
};

export type SpatialQueryMatch = {
  trackId: string;
  matchedPoints: number;
  firstTs: number;
  lastTs: number;
  minDistanceM?: number;
  closestTs?: number;
};

export type SpatialQueryResponse = {
  matches: SpatialQueryMatch[];
};

export type FogTileEntry = {
  tx: number;
  ty: number;
  tileKey: number;
  visitCount: number;
  cellCount: number;
  bitmask: Uint8Array; // 512 bytes (64 x 64 bits)
};

export type FogPackData = {
  version: number;
  tileCount: number;
  totalCells: number;
  exploredAreaKm2: number;
  tiles: Map<number, FogTileEntry>;
};

export type MapVisualizationMode = "fog" | "heatmap" | "tracks" | "spatial";
export type TrackColorMode = "speed" | "elevation" | "track";
export type BaseMapId =
  | "openfreemap-liberty"
  | "openfreemap-bright"
  | "openfreemap-positron"
  | "openfreemap-fiord"
  | "openfreemap-dark"
  | "amap-standard";

export type CompactTrackTileTuple = [
  tileKey: number,
  pointCount: number,
  firstTs: number,
  lastTs: number
];

export type UploadTrackMetaPayload = {
  track: TrackMetadata;
  tiles: CompactTrackTileTuple[];
  trackRegions?: CompactTrackRegionTuple[];
  visitedRegions?: VisitedRegion[];
};
