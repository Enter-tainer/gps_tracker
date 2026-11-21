import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addProtocol,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type AddProtocolAction,
  type DataDrivenPropertyValueSpecification,
  type GeoJSONSource,
  type MapMouseEvent
} from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { Protocol } from "pmtiles";

setWorkerUrl(maplibreWorkerUrl);

const pmtilesProtocol = new Protocol();
addProtocol("pmtiles", pmtilesProtocol.tile as unknown as AddProtocolAction);

import type {
  BaseMapId,
  FogPackData,
  FogRenderStyle,
  GpsPoint,
  LodTier,
  LonLat,
  MapVisualizationMode,
  RegionLevel,
  SelectedRegionInfo,
  TrackColorMode,
  TrackMetadata,
  VisitedRegion
} from "../types/track.ts";
import {
  applyDisplayLonLat,
  encodeTileKey,
  gcj02ToWgs84,
  haversineMeters,
  tileXYToLatLon,
  wgs84ToGcj02
} from "../utils/coordTransform.ts";
import { loadMapStyle } from "../utils/styleBase.ts";
import {
  FOG_BITMASK_BYTES,
  FOG_SUBGRID_SIZE,
  FOG_TILE_ZOOM
} from "../services/fogEngine.ts";
import { getRegionsPmtilesUrl } from "../services/regionClassifier.ts";

export type SpatialOverlayShape =
  | { kind: "point"; lat: number; lon: number; radiusM: number }
  | {
      kind: "bbox";
      minLat: number;
      minLon: number;
      maxLat: number;
      maxLon: number;
    }
  | null;

export type FitPadding = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

type FogMapViewProps = {
  mode: MapVisualizationMode;
  baseMapId: BaseMapId;
  useGcj02: boolean;
  fogPack: FogPackData | null;
  fogStyle: FogRenderStyle;
  fogOpacity: number;
  fogGlow: number;
  visitedRegions: VisitedRegion[];
  selectedRegionRid: number | null;
  tracks: TrackMetadata[];
  selectedTrackIds: string[];
  loadedTrackPoints: Record<string, GpsPoint[]>;
  trackColorMode: TrackColorMode;
  spatialShape: SpatialOverlayShape;
  spatialMatchIds: string[];
  spatialRadiusM: number;
  spatialDrawTool: "point" | "bbox";
  hoverPoint: { lat: number; lon: number } | null;
  fitBoundsTrigger: {
    bbox: [number, number, number, number];
    nonce: number;
  } | null;
  fitPadding?: FitPadding;
  onSelectTrack: (trackId: string, multi: boolean) => void;
  onSelectRegion: (info: SelectedRegionInfo | null) => void;
  onActiveLodChange?: (tier: LodTier) => void;
  onSpatialPointQuery: (lat: number, lon: number) => void;
  onSpatialBboxQuery: (
    minLat: number,
    minLon: number,
    maxLat: number,
    maxLon: number
  ) => void;
};

const REGION_SOURCE_ID = "global-regions";
const REGION_SOURCE_LAYERS = ["l0", "l1", "l2", "l3"] as const;
const WORLD_SHROUD_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [-180, -90, 0, 90].flatMap((west) =>
    [-85.05, 0].map((south) => {
      const east = west + 90;
      const north = south === 0 ? 85.05 : 0;
      return {
        type: "Feature" as const,
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south]
            ]
          ]
        },
        properties: {}
      };
    })
  )
};

const REGION_HEAT_COLOR_EXPR: DataDrivenPropertyValueSpecification<string> = [
  "case",
  ["boolean", ["feature-state", "visited"], false],
  [
    "interpolate",
    ["linear"],
    ["coalesce", ["feature-state", "heat"], 0.25],
    0.15,
    "#0284c7",
    0.35,
    "#06b6d4",
    0.55,
    "#10b981",
    0.72,
    "#facc15",
    0.88,
    "#f97316",
    1.0,
    "#f43f5e"
  ],
  "#070c18"
];

const REGION_LINE_COLOR_EXPR: DataDrivenPropertyValueSpecification<string> = [
  "case",
  ["boolean", ["feature-state", "selected"], false],
  "#ffffff",
  ["boolean", ["feature-state", "visited"], false],
  [
    "interpolate",
    ["linear"],
    ["coalesce", ["feature-state", "heat"], 0.25],
    0.15,
    "#38bdf8",
    0.35,
    "#22d3ee",
    0.55,
    "#34d399",
    0.72,
    "#fde047",
    0.88,
    "#fb923c",
    1.0,
    "#fb7185"
  ],
  "rgba(148, 163, 184, 0.3)"
];

function computeLodTier(zoom: number, fogStyle: FogRenderStyle): LodTier {
  if (fogStyle === "fine") return "fine";
  if (zoom < 3.8) return "l0";
  if (zoom < 6.4) return "l1";
  if (zoom < 8.4) return "l2";
  if (fogStyle === "hybrid" && zoom >= 10.2) return "fine";
  return "l3";
}

function buildTierFillOpacityExpr(
  tier: "l0" | "l1" | "l2" | "l3",
  fogOpacity: number,
  fogStyle: FogRenderStyle
): DataDrivenPropertyValueSpecification<number> {
  const shroudAlpha = Math.max(
    0.2,
    Math.min(0.92, fogOpacity * (fogStyle === "regions" ? 0.68 : 0.86))
  );
  const activeExpr: DataDrivenPropertyValueSpecification<number> = [
    "case",
    ["boolean", ["feature-state", "visited"], false],
    [
      "interpolate",
      ["linear"],
      ["coalesce", ["feature-state", "heat"], 0.25],
      0.15,
      0.24,
      0.55,
      0.34,
      1.0,
      0.48
    ],
    shroudAlpha
  ];

  if (tier === "l0") {
    return ["interpolate", ["linear"], ["zoom"], 3.6, activeExpr, 4.2, 0] as unknown as DataDrivenPropertyValueSpecification<number>;
  }
  if (tier === "l1") {
    return ["interpolate", ["linear"], ["zoom"], 3.4, 0, 4.0, activeExpr, 6.0, activeExpr, 6.6, 0] as unknown as DataDrivenPropertyValueSpecification<number>;
  }
  if (tier === "l2") {
    return ["interpolate", ["linear"], ["zoom"], 5.8, 0, 6.4, activeExpr, 8.0, activeExpr, 8.6, 0] as unknown as DataDrivenPropertyValueSpecification<number>;
  }
  if (fogStyle === "regions") {
    return ["interpolate", ["linear"], ["zoom"], 7.8, 0, 8.4, activeExpr] as unknown as DataDrivenPropertyValueSpecification<number>;
  }
  return ["interpolate", ["linear"], ["zoom"], 7.8, 0, 8.4, activeExpr, 9.8, activeExpr, 10.8, 0] as unknown as DataDrivenPropertyValueSpecification<number>;
}

function buildTierLineOpacityExpr(
  tier: "l0" | "l1" | "l2" | "l3",
  fogStyle: FogRenderStyle
): DataDrivenPropertyValueSpecification<number> {
  const activeExpr: DataDrivenPropertyValueSpecification<number> = [
    "case",
    ["boolean", ["feature-state", "selected"], false],
    0.98,
    ["boolean", ["feature-state", "visited"], false],
    0.85,
    0.34
  ];

  if (tier === "l0") {
    return ["interpolate", ["linear"], ["zoom"], 3.6, activeExpr, 4.2, 0] as unknown as DataDrivenPropertyValueSpecification<number>;
  }
  if (tier === "l1") {
    return ["interpolate", ["linear"], ["zoom"], 3.4, 0, 4.0, activeExpr, 6.0, activeExpr, 6.6, 0] as unknown as DataDrivenPropertyValueSpecification<number>;
  }
  if (tier === "l2") {
    return ["interpolate", ["linear"], ["zoom"], 5.8, 0, 6.4, activeExpr, 8.0, activeExpr, 8.6, 0] as unknown as DataDrivenPropertyValueSpecification<number>;
  }
  if (fogStyle === "regions") {
    return ["interpolate", ["linear"], ["zoom"], 7.8, 0, 8.4, activeExpr] as unknown as DataDrivenPropertyValueSpecification<number>;
  }
  return ["interpolate", ["linear"], ["zoom"], 7.8, 0, 8.4, activeExpr, 9.8, activeExpr, 10.8, 0] as unknown as DataDrivenPropertyValueSpecification<number>;
}

function parseBboxProp(raw: unknown): [number, number, number, number] {
  if (Array.isArray(raw) && raw.length === 4) {
    return [
      Number(raw[0]) || 0,
      Number(raw[1]) || 0,
      Number(raw[2]) || 0,
      Number(raw[3]) || 0
    ];
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === 4) {
        return [
          Number(parsed[0]) || 0,
          Number(parsed[1]) || 0,
          Number(parsed[2]) || 0,
          Number(parsed[3]) || 0
        ];
      }
    } catch {
      // Ignore malformed bbox string
    }
  }
  return [0, 0, 0, 0];
}

const MACRO_ZOOM = 10;
const MACRO_SHIFT = FOG_TILE_ZOOM - MACRO_ZOOM; // 5 (32x32 Z15 tiles per Z10)

const TRACK_PALETTE = [
  "#0ea5e9",
  "#f59e0b",
  "#8b5cf6",
  "#10b981",
  "#f43f5e",
  "#3b82f6",
  "#eab308",
  "#ec4899"
];

const SPEED_BUCKETS = [
  { max: 4, color: "#38bdf8" },
  { max: 8, color: "#06b6d4" },
  { max: 15, color: "#10b981" },
  { max: 25, color: "#84cc16" },
  { max: 45, color: "#eab308" },
  { max: 75, color: "#f97316" },
  { max: 120, color: "#ef4444" },
  { max: 260, color: "#d946ef" },
  { max: Infinity, color: "#e11d48" }
];

const ELEV_BUCKETS = [
  { ratio: 0.12, color: "#3b82f6" },
  { ratio: 0.25, color: "#06b6d4" },
  { ratio: 0.4, color: "#10b981" },
  { ratio: 0.55, color: "#84cc16" },
  { ratio: 0.7, color: "#eab308" },
  { ratio: 0.85, color: "#f97316" },
  { ratio: 1.01, color: "#ef4444" }
];

function isStyleReady(map: MapLibreMap): boolean {
  const internalStyle = (map as unknown as { style?: { _loaded?: boolean } })
    .style;
  return Boolean(internalStyle?._loaded || map.isStyleLoaded());
}

function createBitmaskCanvas(
  bitmask: Uint8Array,
  size = FOG_SUBGRID_SIZE,
  feather = true
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const isHit = (x: number, y: number): number => {
    if (x < 0 || x >= size || y < 0 || y >= size) return 0;
    const bitIdx = y * size + x;
    return (bitmask[bitIdx >> 3] & (1 << (bitIdx & 7))) !== 0 ? 1 : 0;
  };

  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const bitIdx = y * size + x;
      let alpha = 0;
      if (isHit(x, y)) {
        alpha = 255;
      } else if (feather) {
        // 3x3 weighted neighbor feathering (cardinal=2, diagonal=1, max=12)
        // softens blocky square stair-steps when upscaled at street-level zoom
        const w =
          (isHit(x - 1, y) +
            isHit(x + 1, y) +
            isHit(x, y - 1) +
            isHit(x, y + 1)) *
            2 +
          isHit(x - 1, y - 1) +
          isHit(x + 1, y - 1) +
          isHit(x - 1, y + 1) +
          isHit(x + 1, y + 1);
        if (w > 0) {
          alpha = Math.min(220, Math.round((w / 12) * 225));
        }
      }
      if (alpha > 0) {
        const p = bitIdx * 4;
        data[p] = 255;
        data[p + 1] = 255;
        data[p + 2] = 255;
        data[p + 3] = alpha;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function buildMacroZ10Map(fogPack: FogPackData): Map<number, Uint8Array> {
  const macroMap = new Map<number, Uint8Array>();
  for (const tile of fogPack.tiles.values()) {
    const mx = tile.tx >> MACRO_SHIFT;
    const my = tile.ty >> MACRO_SHIFT;
    const mKey = encodeTileKey(mx, my);
    let mask = macroMap.get(mKey);
    if (!mask) {
      mask = new Uint8Array(FOG_BITMASK_BYTES);
      macroMap.set(mKey, mask);
    }

    const baseX = (tile.tx & 31) * 2;
    const baseY = (tile.ty & 31) * 2;
    for (let qy = 0; qy < 2; qy++) {
      for (let qx = 0; qx < 2; qx++) {
        let hit = false;
        const yStart = qy * 32;
        const xStart = qx * 32;
        for (let ly = yStart; ly < yStart + 32 && !hit; ly += 2) {
          const rowByte = (ly * 64 + xStart) >> 3;
          if (
            tile.bitmask[rowByte] |
            tile.bitmask[rowByte + 1] |
            tile.bitmask[rowByte + 2] |
            tile.bitmask[rowByte + 3]
          ) {
            hit = true;
          }
          const oddRowByte = ((ly + 1) * 64 + xStart) >> 3;
          if (
            tile.bitmask[oddRowByte] |
            tile.bitmask[oddRowByte + 1] |
            tile.bitmask[oddRowByte + 2] |
            tile.bitmask[oddRowByte + 3]
          ) {
            hit = true;
          }
        }
        if (hit) {
          const sx = baseX + qx;
          const sy = baseY + qy;
          const bitIdx = sy * 64 + sx;
          mask[bitIdx >> 3] |= 1 << (bitIdx & 7);
        }
      }
    }
  }
  return macroMap;
}

function buildCirclePolygonCoords(
  centerLat: number,
  centerLon: number,
  radiusM: number,
  useGcj02: boolean,
  steps = 64
): LonLat[] {
  const ring: LonLat[] = [];
  const dLat = (radiusM / 6371000) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.15, Math.cos((centerLat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    const lat = centerLat + dLat * Math.sin(theta);
    const lon = centerLon + dLon * Math.cos(theta);
    ring.push(applyDisplayLonLat(lon, lat, useGcj02));
  }
  return ring;
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export const FogMapView: React.FC<FogMapViewProps> = ({
  mode,
  baseMapId,
  useGcj02,
  fogPack,
  fogStyle,
  fogOpacity,
  fogGlow,
  visitedRegions,
  selectedRegionRid,
  tracks,
  selectedTrackIds,
  loadedTrackPoints,
  trackColorMode,
  spatialShape,
  spatialMatchIds,
  spatialRadiusM,
  spatialDrawTool,
  hoverPoint,
  fitBoundsTrigger,
  fitPadding,
  onSelectTrack,
  onSelectRegion,
  onActiveLodChange,
  onSpatialPointQuery,
  onSpatialBboxQuery
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fogCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fogBufferCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleReadyRef = useRef(false);
  const appliedBaseMapIdRef = useRef<BaseMapId>(baseMapId);
  const pendingFitBoundsRef = useRef<[number, number, number, number] | null>(
    null
  );
  const lastLodTierRef = useRef<LodTier | null>(null);

  const z15CanvasCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const z10CanvasCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const z10MacroMapRef = useRef<Map<number, Uint8Array>>(new Map());

  const visitedRegionsMapRef = useRef<Map<number, VisitedRegion>>(new Map());
  useMemo(() => {
    const m = new Map<number, VisitedRegion>();
    for (const r of visitedRegions) {
      m.set(r.rid, r);
    }
    visitedRegionsMapRef.current = m;
  }, [visitedRegions]);

  const [boxDragRect, setBoxDragRect] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const activeTouchesRef = useRef<Set<number>>(new Set());
  const activePointerIdRef = useRef<number | null>(null);

  const propsRef = useRef({
    mode,
    baseMapId,
    useGcj02,
    fogPack,
    fogStyle,
    fogOpacity,
    fogGlow,
    visitedRegions,
    selectedRegionRid,
    tracks,
    selectedTrackIds,
    loadedTrackPoints,
    spatialDrawTool,
    fitPadding,
    onSpatialPointQuery,
    onSpatialBboxQuery,
    onSelectTrack,
    onSelectRegion,
    onActiveLodChange
  });
  propsRef.current = {
    mode,
    baseMapId,
    useGcj02,
    fogPack,
    fogStyle,
    fogOpacity,
    fogGlow,
    visitedRegions,
    selectedRegionRid,
    tracks,
    selectedTrackIds,
    loadedTrackPoints,
    spatialDrawTool,
    fitPadding,
    onSpatialPointQuery,
    onSpatialBboxQuery,
    onSelectTrack,
    onSelectRegion,
    onActiveLodChange
  };

  // Rebuild macro Z10 pyramid whenever fogPack updates
  useEffect(() => {
    z15CanvasCacheRef.current.clear();
    z10CanvasCacheRef.current.clear();
    if (!fogPack) {
      z10MacroMapRef.current = new Map();
    } else {
      z10MacroMapRef.current = buildMacroZ10Map(fogPack);
    }
    drawFogCanvas();
    mapRef.current?.triggerRepaint();
  }, [fogPack]);

  const heatmapGeoJson = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!fogPack || fogPack.tiles.size === 0) return emptyFeatureCollection();
    const features: GeoJSON.Feature[] = [];
    for (const tile of fogPack.tiles.values()) {
      const [lat, lon] = tileXYToLatLon(
        tile.tx + 0.5,
        tile.ty + 0.5,
        FOG_TILE_ZOOM
      );
      const coords = applyDisplayLonLat(lon, lat, useGcj02);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: coords },
        properties: {
          weight: Math.min(12, Math.max(1, tile.visitCount))
        }
      });
    }
    return { type: "FeatureCollection", features };
  }, [fogPack, useGcj02]);

  const allTracksGeoJson = useMemo<GeoJSON.FeatureCollection>(() => {
    const matchSet = new Set(spatialMatchIds);
    const selectedSet = new Set(selectedTrackIds);
    const features: GeoJSON.Feature[] = tracks.map((t) => {
      const coords = t.overview_coords.map((seg) =>
        seg.map(([lon, lat]) => applyDisplayLonLat(lon, lat, useGcj02))
      );
      const year = Number.parseInt(t.date.slice(0, 4), 10) || 2025;
      return {
        type: "Feature",
        geometry: {
          type: "MultiLineString",
          coordinates: coords
        },
        properties: {
          id: t.id,
          date: t.date,
          title: t.title,
          year,
          isMatched: matchSet.has(t.id) ? 1 : 0,
          isSelected: selectedSet.has(t.id) ? 1 : 0
        }
      };
    });
    return { type: "FeatureCollection", features };
  }, [tracks, useGcj02, spatialMatchIds, selectedTrackIds]);

  const selectedTracksGeoJson = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];

    selectedTrackIds.forEach((trackId, trackIdx) => {
      const pts = loadedTrackPoints[trackId];
      if (!pts || pts.length < 2) return;

      let minEle = Infinity;
      let maxEle = -Infinity;
      if (trackColorMode === "elevation") {
        for (const p of pts) {
          const e = p.altitude_m_scaled_1e1 / 10;
          if (e < minEle) minEle = e;
          if (e > maxEle) maxEle = e;
        }
      }
      const eleSpan = Math.max(10, maxEle - minEle);
      const trackColor = TRACK_PALETTE[trackIdx % TRACK_PALETTE.length];

      let activeColor = trackColor;
      let activeCoords: LonLat[] = [];

      const flushSegment = () => {
        if (activeCoords.length >= 2) {
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: activeCoords },
            properties: { color: activeColor, trackId }
          });
        }
      };

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const lat = p.latitude_scaled_1e7 / 1e7;
        const lon = p.longitude_scaled_1e7 / 1e7;
        const disp = applyDisplayLonLat(lon, lat, useGcj02);

        if (i === 0) {
          activeCoords = [disp];
          continue;
        }

        const prev = pts[i - 1];
        const prevLat = prev.latitude_scaled_1e7 / 1e7;
        const prevLon = prev.longitude_scaled_1e7 / 1e7;
        const segM = haversineMeters(prevLat, prevLon, lat, lon);

        if (segM > 2000) {
          flushSegment();
          activeCoords = [disp];
          continue;
        }

        let segColor = trackColor;
        if (trackColorMode === "speed") {
          const dt = Math.max(1, p.timestamp - prev.timestamp);
          const kmh = segM <= 5000 ? (segM / dt) * 3.6 : 0;
          const bucket = SPEED_BUCKETS.find((b) => kmh <= b.max);
          segColor = bucket ? bucket.color : "#e11d48";
        } else if (trackColorMode === "elevation") {
          const ele = p.altitude_m_scaled_1e1 / 10;
          const ratio = (ele - minEle) / eleSpan;
          const bucket = ELEV_BUCKETS.find((b) => ratio <= b.ratio);
          segColor = bucket ? bucket.color : "#ef4444";
        }

        if (segColor !== activeColor && activeCoords.length >= 1) {
          const lastCoord = activeCoords[activeCoords.length - 1];
          flushSegment();
          activeColor = segColor;
          activeCoords = [lastCoord, disp];
        } else {
          activeColor = segColor;
          activeCoords.push(disp);
        }
      }

      flushSegment();
    });

    return { type: "FeatureCollection", features };
  }, [selectedTrackIds, loadedTrackPoints, trackColorMode, useGcj02]);

  const spatialGeoJson = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!spatialShape) return emptyFeatureCollection();
    if (spatialShape.kind === "point") {
      const ring = buildCirclePolygonCoords(
        spatialShape.lat,
        spatialShape.lon,
        spatialShape.radiusM,
        useGcj02
      );
      const center = applyDisplayLonLat(
        spatialShape.lon,
        spatialShape.lat,
        useGcj02
      );
      return {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [ring] },
            properties: {}
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: center },
            properties: {}
          }
        ]
      };
    }

    const sw = applyDisplayLonLat(
      spatialShape.minLon,
      spatialShape.minLat,
      useGcj02
    );
    const se = applyDisplayLonLat(
      spatialShape.maxLon,
      spatialShape.minLat,
      useGcj02
    );
    const ne = applyDisplayLonLat(
      spatialShape.maxLon,
      spatialShape.maxLat,
      useGcj02
    );
    const nw = applyDisplayLonLat(
      spatialShape.minLon,
      spatialShape.maxLat,
      useGcj02
    );
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [[sw, se, ne, nw, sw]] },
          properties: {}
        }
      ]
    };
  }, [spatialShape, useGcj02]);

  const hoverGeoJson = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!hoverPoint) return emptyFeatureCollection();
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: applyDisplayLonLat(
              hoverPoint.lon,
              hoverPoint.lat,
              useGcj02
            )
          },
          properties: {}
        }
      ]
    };
  }, [hoverPoint, useGcj02]);

  const latestDataRef = useRef({
    heatmapGeoJson,
    allTracksGeoJson,
    selectedTracksGeoJson,
    spatialGeoJson,
    hoverGeoJson,
    mode,
    fogStyle,
    fogOpacity,
    spatialShape,
    spatialMatchIds
  });
  latestDataRef.current = {
    heatmapGeoJson,
    allTracksGeoJson,
    selectedTracksGeoJson,
    spatialGeoJson,
    hoverGeoJson,
    mode,
    fogStyle,
    fogOpacity,
    spatialShape,
    spatialMatchIds
  };

  function syncRegionFeatureStates(map: MapLibreMap): void {
    if (!map.getSource(REGION_SOURCE_ID)) return;
    for (const sourceLayer of REGION_SOURCE_LAYERS) {
      map.removeFeatureState({ source: REGION_SOURCE_ID, sourceLayer });
    }

    const { visitedRegions: list, selectedRegionRid: selRid } = propsRef.current;
    const seenVisited = new Set<number>();
    for (const r of list) {
      seenVisited.add(r.rid);
      const state = {
        visited: true,
        heat: r.heat,
        selected: r.rid === selRid
      };
      for (const sourceLayer of REGION_SOURCE_LAYERS) {
        map.setFeatureState(
          { source: REGION_SOURCE_ID, sourceLayer, id: r.rid },
          state
        );
      }
    }

    if (selRid !== null && !seenVisited.has(selRid)) {
      for (const sourceLayer of REGION_SOURCE_LAYERS) {
        map.setFeatureState(
          { source: REGION_SOURCE_ID, sourceLayer, id: selRid },
          { visited: false, selected: true }
        );
      }
    }
  }

  function updateAllTracksLayerAppearance(map: MapLibreMap): void {
    const data = latestDataRef.current;
    const showRegions = data.mode === "fog" && data.fogStyle !== "fine";
    const visValue = showRegions ? "visible" : "none";

    if (map.getLayer("world-shroud-layer")) {
      map.setLayoutProperty("world-shroud-layer", "visibility", visValue);
      const shroudMax = Math.max(
        0.15,
        Math.min(0.88, data.fogOpacity * (data.fogStyle === "regions" ? 0.6 : 0.78))
      );
      map.setPaintProperty(
        "world-shroud-layer",
        "fill-opacity",
        data.fogStyle === "regions"
          ? shroudMax
          : (["interpolate", ["linear"], ["zoom"], 9.8, shroudMax, 10.8, 0] as unknown as DataDrivenPropertyValueSpecification<number>)
      );
    }

    for (const tier of REGION_SOURCE_LAYERS) {
      const fillId = `regions-${tier}-fill`;
      const lineId = `regions-${tier}-line`;
      if (map.getLayer(fillId)) {
        map.setLayoutProperty(fillId, "visibility", visValue);
        map.setPaintProperty(
          fillId,
          "fill-opacity",
          buildTierFillOpacityExpr(tier, data.fogOpacity, data.fogStyle)
        );
      }
      if (map.getLayer(lineId)) {
        map.setLayoutProperty(lineId, "visibility", visValue);
        map.setPaintProperty(
          lineId,
          "line-opacity",
          buildTierLineOpacityExpr(tier, data.fogStyle)
        );
      }
    }

    if (map.getLayer("regions-l3-context-line")) {
      map.setLayoutProperty(
        "regions-l3-context-line",
        "visibility",
        data.mode === "fog" && data.fogStyle === "hybrid" ? "visible" : "none"
      );
    }

    if (map.getLayer("heatmap-layer")) {
      map.setLayoutProperty(
        "heatmap-layer",
        "visibility",
        data.mode === "heatmap" ? "visible" : "none"
      );
    }

    if (map.getLayer("all-tracks-casing")) {
      const casingOpacity =
        data.mode === "tracks"
          ? 0.65
          : data.mode === "fog"
            ? 0.4
            : data.mode === "spatial"
              ? 0.45
              : 0;
      map.setPaintProperty(
        "all-tracks-casing",
        "line-opacity",
        casingOpacity
      );
    }

    if (map.getLayer("all-tracks-layer")) {
      const hasSpatialResult =
        data.mode === "spatial" && data.spatialShape !== null;
      let opacity: DataDrivenPropertyValueSpecification<number> = 0;
      if (data.mode === "tracks") {
        opacity = 0.88;
      } else if (data.mode === "fog") {
        opacity = 0.42;
      } else if (data.mode === "heatmap") {
        opacity = 0.14;
      } else if (data.mode === "spatial") {
        opacity = hasSpatialResult
          ? ["case", ["==", ["get", "isMatched"], 1], 0.94, 0.16]
          : 0.58;
      }
      map.setPaintProperty("all-tracks-layer", "line-opacity", opacity);
    }
  }

  function syncCustomSourcesAndLayers(map: MapLibreMap): void {
    if (!styleReadyRef.current && !isStyleReady(map)) return;
    const data = latestDataRef.current;

    const ensureGeoJsonSource = (
      id: string,
      collection: GeoJSON.FeatureCollection
    ) => {
      const existing = map.getSource(id) as GeoJSONSource | undefined;
      if (existing) {
        existing.setData(collection);
      } else {
        map.addSource(id, { type: "geojson", data: collection });
      }
    };

    if (!map.getSource(REGION_SOURCE_ID)) {
      map.addSource(REGION_SOURCE_ID, {
        type: "vector",
        url: `pmtiles://${getRegionsPmtilesUrl()}`
      });
    }
    ensureGeoJsonSource("world-shroud", WORLD_SHROUD_GEOJSON);
    ensureGeoJsonSource("heatmap-points", data.heatmapGeoJson);
    ensureGeoJsonSource("all-tracks", data.allTracksGeoJson);
    ensureGeoJsonSource("selected-tracks", data.selectedTracksGeoJson);
    ensureGeoJsonSource("spatial-query", data.spatialGeoJson);
    ensureGeoJsonSource("hover-marker", data.hoverGeoJson);

    const firstSymbolId = map
      .getStyle()
      ?.layers?.find((l) => l.type === "symbol")?.id;

    if (!map.getLayer("world-shroud-layer")) {
      map.addLayer(
        {
          id: "world-shroud-layer",
          type: "fill",
          source: "world-shroud",
          paint: {
            "fill-color": "#070c18",
            "fill-opacity": 0.62
          }
        },
        firstSymbolId
      );
    }

    const tierConfigs: Array<{
      tier: "l0" | "l1" | "l2" | "l3";
      minzoom: number;
      maxzoom: number;
    }> = [
      { tier: "l0", minzoom: 0, maxzoom: 4.5 },
      { tier: "l1", minzoom: 3.2, maxzoom: 6.9 },
      { tier: "l2", minzoom: 5.6, maxzoom: 8.9 },
      { tier: "l3", minzoom: 7.6, maxzoom: 22 }
    ];

    for (const cfg of tierConfigs) {
      const fillId = `regions-${cfg.tier}-fill`;
      const lineId = `regions-${cfg.tier}-line`;
      if (!map.getLayer(fillId)) {
        map.addLayer(
          {
            id: fillId,
            type: "fill",
            source: REGION_SOURCE_ID,
            "source-layer": cfg.tier,
            minzoom: cfg.minzoom,
            maxzoom: cfg.maxzoom,
            paint: {
              "fill-color": REGION_HEAT_COLOR_EXPR,
              "fill-opacity": buildTierFillOpacityExpr(
                cfg.tier,
                data.fogOpacity,
                data.fogStyle
              )
            }
          },
          firstSymbolId
        );
      }
      if (!map.getLayer(lineId)) {
        map.addLayer(
          {
            id: lineId,
            type: "line",
            source: REGION_SOURCE_ID,
            "source-layer": cfg.tier,
            minzoom: cfg.minzoom,
            maxzoom: cfg.maxzoom,
            paint: {
              "line-color": REGION_LINE_COLOR_EXPR,
              "line-width": [
                "case",
                ["boolean", ["feature-state", "selected"], false],
                2.4,
                ["boolean", ["feature-state", "visited"], false],
                1.3,
                0.55
              ],
              "line-opacity": buildTierLineOpacityExpr(cfg.tier, data.fogStyle)
            }
          },
          firstSymbolId
        );
      }
    }

    if (!map.getLayer("regions-l3-context-line")) {
      map.addLayer(
        {
          id: "regions-l3-context-line",
          type: "line",
          source: REGION_SOURCE_ID,
          "source-layer": "l3",
          minzoom: 9.8,
          maxzoom: 22,
          paint: {
            "line-color": "rgba(148, 163, 184, 0.25)",
            "line-width": 0.8,
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 9.8, 0, 10.8, 0.45]
          }
        },
        firstSymbolId
      );
    }

    if (!map.getLayer("heatmap-layer")) {
      map.addLayer({
        id: "heatmap-layer",
        type: "heatmap",
        source: "heatmap-points",
        layout: {
          visibility: data.mode === "heatmap" ? "visible" : "none"
        },
        paint: {
          "heatmap-weight": [
            "interpolate",
            ["linear"],
            ["get", "weight"],
            1,
            0.25,
            12,
            1
          ],
          "heatmap-intensity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            2,
            0.85,
            12,
            2.2
          ],
          "heatmap-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            2,
            5,
            8,
            12,
            13,
            24,
            16,
            34
          ],
          "heatmap-opacity": 0.88,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(0,0,0,0)",
            0.15,
            "rgba(14,165,233,0.55)",
            0.35,
            "rgba(34,211,238,0.8)",
            0.55,
            "rgba(52,211,153,0.9)",
            0.78,
            "rgba(250,204,21,0.95)",
            1.0,
            "rgba(244,63,94,1)"
          ]
        }
      });
    }

    if (!map.getLayer("all-tracks-casing")) {
      map.addLayer({
        id: "all-tracks-casing",
        type: "line",
        source: "all-tracks",
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            3,
            [
              "case",
              ["==", ["get", "isMatched"], 1],
              4.5,
              ["==", ["get", "isSelected"], 1],
              3.8,
              2.4
            ],
            10,
            [
              "case",
              ["==", ["get", "isMatched"], 1],
              5.5,
              ["==", ["get", "isSelected"], 1],
              4.5,
              3.6
            ],
            15,
            [
              "case",
              ["==", ["get", "isMatched"], 1],
              6.8,
              ["==", ["get", "isSelected"], 1],
              5.8,
              5.2
            ]
          ],
          "line-color": "rgba(15, 23, 42, 0.78)",
          "line-opacity": 0.55
        }
      });
    }

    if (!map.getLayer("all-tracks-layer")) {
      map.addLayer({
        id: "all-tracks-layer",
        type: "line",
        source: "all-tracks",
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            3,
            [
              "case",
              ["==", ["get", "isMatched"], 1],
              2.8,
              ["==", ["get", "isSelected"], 1],
              2.2,
              1.3
            ],
            10,
            [
              "case",
              ["==", ["get", "isMatched"], 1],
              3.4,
              ["==", ["get", "isSelected"], 1],
              2.6,
              2.1
            ],
            15,
            [
              "case",
              ["==", ["get", "isMatched"], 1],
              4.4,
              ["==", ["get", "isSelected"], 1],
              3.6,
              3.2
            ]
          ],
          "line-color": [
            "case",
            ["==", ["get", "isMatched"], 1],
            "#f59e0b",
            ["==", ["get", "year"], 2026],
            "#06b6d4",
            "#0284c7"
          ],
          "line-opacity": 0.78
        }
      });
    }

    if (!map.getLayer("selected-tracks-casing")) {
      map.addLayer({
        id: "selected-tracks-casing",
        type: "line",
        source: "selected-tracks",
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            5.2,
            14,
            8.2
          ],
          "line-color": "rgba(6, 10, 19, 0.82)"
        }
      });
    }

    if (!map.getLayer("selected-tracks-layer")) {
      map.addLayer({
        id: "selected-tracks-layer",
        type: "line",
        source: "selected-tracks",
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            2.8,
            14,
            4.8
          ],
          "line-color": ["get", "color"],
          "line-opacity": 0.98
        }
      });
    }

    if (!map.getLayer("spatial-query-fill")) {
      map.addLayer({
        id: "spatial-query-fill",
        type: "fill",
        source: "spatial-query",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": "rgba(245, 158, 11, 0.18)"
        }
      });
    }

    if (!map.getLayer("spatial-query-line")) {
      map.addLayer({
        id: "spatial-query-line",
        type: "line",
        source: "spatial-query",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "line-color": "#f59e0b",
          "line-width": 2.2,
          "line-dasharray": [3, 2]
        }
      });
    }

    if (!map.getLayer("spatial-query-center")) {
      map.addLayer({
        id: "spatial-query-center",
        type: "circle",
        source: "spatial-query",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 5.5,
          "circle-color": "#f59e0b",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2
        }
      });
    }

    if (!map.getLayer("hover-marker-layer")) {
      map.addLayer({
        id: "hover-marker-layer",
        type: "circle",
        source: "hover-marker",
        paint: {
          "circle-radius": 7,
          "circle-color": "#22d3ee",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2.5
        }
      });
    }

    updateAllTracksLayerAppearance(map);
    syncRegionFeatureStates(map);
  }

  function applyFitBounds(
    map: MapLibreMap,
    bbox: [number, number, number, number],
    gcj: boolean,
    container?: HTMLElement | null,
    customPadding?: FitPadding
  ): void {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    if (
      !Number.isFinite(minLon) ||
      !Number.isFinite(minLat) ||
      !Number.isFinite(maxLon) ||
      !Number.isFinite(maxLat)
    ) {
      return;
    }
    const w = container?.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 1024);
    const h = container?.clientHeight || (typeof window !== "undefined" ? window.innerHeight : 768);
    const basePadding: FitPadding = customPadding
      ? { ...customPadding }
      : w < 768
        ? { top: 76, bottom: 96, left: 24, right: 24 }
        : { top: 80, bottom: 120, left: 380, right: 60 };

    const maxHoriz = Math.max(16, Math.floor(w * 0.55));
    const maxVert = Math.max(16, Math.floor(h * 0.55));
    const horizSum = basePadding.left + basePadding.right;
    if (horizSum > maxHoriz && horizSum > 0) {
      const scale = maxHoriz / horizSum;
      basePadding.left = Math.round(basePadding.left * scale);
      basePadding.right = Math.round(basePadding.right * scale);
    }
    const vertSum = basePadding.top + basePadding.bottom;
    if (vertSum > maxVert && vertSum > 0) {
      const scale = maxVert / vertSum;
      basePadding.top = Math.round(basePadding.top * scale);
      basePadding.bottom = Math.round(basePadding.bottom * scale);
    }

    const sw = applyDisplayLonLat(minLon, minLat, gcj);
    const ne = applyDisplayLonLat(maxLon, maxLat, gcj);
    if (Math.abs(sw[0] - ne[0]) < 1e-6 && Math.abs(sw[1] - ne[1]) < 1e-6) {
      map.easeTo({ center: sw, zoom: 14, duration: 650 });
      return;
    }
    map.fitBounds([sw, ne], {
      padding: basePadding,
      maxZoom: 15,
      duration: 650
    });
  }

  // Draw the multi-scale 60fps Fog of War Canvas overlay
  function drawFogCanvas(): void {
    const map = mapRef.current;
    const canvas = fogCanvasRef.current;
    if (!map || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;

    const {
      mode: curMode,
      useGcj02: gcj,
      fogPack: pack,
      fogStyle: curFogStyle,
      fogOpacity: opacity,
      fogGlow: glow,
      tracks: curTracks,
      selectedTrackIds: curSelectedIds,
      loadedTrackPoints: curLoadedPoints
    } = propsRef.current;

    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    if (
      canvas.width !== Math.round(cssW * dpr) ||
      canvas.height !== Math.round(cssH * dpr)
    ) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (curMode !== "fog" || !pack) return;

    const zoom = map.getZoom();
    const fineBlend =
      curFogStyle === "regions"
        ? 0
        : curFogStyle === "fine"
          ? 1
          : zoom <= 9.6
            ? 0
            : zoom >= 10.8
              ? 1
              : (zoom - 9.6) / 1.2;
    if (fineBlend <= 0.01) return;

    let bufCanvas = fogBufferCanvasRef.current;
    if (!bufCanvas) {
      bufCanvas = document.createElement("canvas");
      fogBufferCanvasRef.current = bufCanvas;
    }
    if (bufCanvas.width !== cssW || bufCanvas.height !== cssH) {
      bufCanvas.width = cssW;
      bufCanvas.height = cssH;
    }
    const bufCtx = bufCanvas.getContext("2d");
    if (!bufCtx) return;

    // Dark blue-slate shroud over bright vector tiles keeps continents softly legible
    bufCtx.globalCompositeOperation = "source-over";
    bufCtx.globalAlpha = 1;
    bufCtx.clearRect(0, 0, cssW, cssH);
    bufCtx.fillStyle = `rgba(7, 12, 24, ${opacity})`;
    bufCtx.fillRect(0, 0, cssW, cssH);

    const useHighRes = zoom >= 10.5;
    const renderZoom = useHighRes ? FOG_TILE_ZOOM : MACRO_ZOOM;
    const maxTileIdx = (1 << renderZoom) - 1;

    const bounds = map.getBounds();
    const padDeg = gcj ? 0.03 : 0.01;
    const rawWest = bounds.getWest() - padDeg;
    const rawEast = bounds.getEast() + padDeg;
    const rawSouth = Math.max(-85.05, bounds.getSouth() - padDeg);
    const rawNorth = Math.min(85.05, bounds.getNorth() + padDeg);

    const [southWgs, westWgs] = gcj
      ? gcj02ToWgs84(rawSouth, rawWest)
      : [rawSouth, rawWest];
    const [northWgs, eastWgs] = gcj
      ? gcj02ToWgs84(rawNorth, rawEast)
      : [rawNorth, rawEast];

    bufCtx.globalCompositeOperation = "destination-out";
    bufCtx.imageSmoothingEnabled = true;

    // Pass 1: Continuous track corridor erasure so paths stay vivid & clear at low/medium zoom
    // Blends out cleanly between Z11.5 and Z13.5 where exact Z21 bitmask cells exceed 1px each.
    const corridorBlend =
      zoom <= 11.5 ? 1 : zoom >= 13.5 ? 0 : (13.5 - zoom) / 2;
    const corePx = Math.max(
      3.5,
      Math.min(18, Math.pow(2, zoom - 11) * 6)
    );
    let corridorPath: Path2D | null = null;

    if (corridorBlend > 0.02 && (curTracks.length > 0 || curSelectedIds.length > 0)) {
      corridorPath = new Path2D();
      const selectedSet = new Set(curSelectedIds);

      for (const t of curTracks) {
        if (
          t.max_lon < westWgs ||
          t.min_lon > eastWgs ||
          t.max_lat < southWgs ||
          t.min_lat > northWgs
        ) {
          continue;
        }
        const highPts = selectedSet.has(t.id)
          ? curLoadedPoints[t.id]
          : undefined;

        if (highPts && highPts.length >= 2) {
          const step = highPts.length > 1500 ? Math.ceil(highPts.length / 1500) : 1;
          let started = false;
          let prevLat = 0;
          let prevLon = 0;
          for (let i = 0; i < highPts.length; i += step) {
            const pt = highPts[i];
            const lat = pt.latitude_scaled_1e7 / 1e7;
            const lon = pt.longitude_scaled_1e7 / 1e7;
            const disp = applyDisplayLonLat(lon, lat, gcj);
            const p = map.project(disp);
            if (!started || haversineMeters(prevLat, prevLon, lat, lon) > 2000) {
              corridorPath.moveTo(p.x, p.y);
              started = true;
            } else {
              corridorPath.lineTo(p.x, p.y);
            }
            prevLat = lat;
            prevLon = lon;
          }
          continue;
        }

        for (const seg of t.overview_coords) {
          if (seg.length === 0) continue;
          const first = applyDisplayLonLat(seg[0][0], seg[0][1], gcj);
          const p0 = map.project(first);
          corridorPath.moveTo(p0.x, p0.y);
          if (seg.length === 1) {
            corridorPath.lineTo(p0.x + 0.5, p0.y + 0.5);
          } else {
            for (let i = 1; i < seg.length; i++) {
              const disp = applyDisplayLonLat(seg[i][0], seg[i][1], gcj);
              const pi = map.project(disp);
              corridorPath.lineTo(pi.x, pi.y);
            }
          }
        }
      }

      bufCtx.lineCap = "round";
      bufCtx.lineJoin = "round";
      if (glow > 0) {
        bufCtx.globalAlpha = 0.42 * corridorBlend;
        bufCtx.lineWidth = corePx * (1 + glow * 0.85);
        bufCtx.stroke(corridorPath);
      }
      bufCtx.globalAlpha = corridorBlend;
      bufCtx.lineWidth = corePx;
      bufCtx.stroke(corridorPath);
    }

    // Pass 2: Exact Z15 64x64 bitmask (high zoom) & Z10 macro bitmask (low zoom)
    const n = 2 ** renderZoom;
    const clampLon = (l: number) => Math.max(-180, Math.min(179.999999, l));
    const lonToTx = (lon: number) =>
      Math.max(
        0,
        Math.min(maxTileIdx, Math.floor(((clampLon(lon) + 180) / 360) * n))
      );
    const latToTy = (lat: number) => {
      const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
      const ty = Math.floor(
        ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
      );
      return Math.max(0, Math.min(maxTileIdx, ty));
    };

    const txMin = lonToTx(westWgs);
    const txMax = lonToTx(eastWgs);
    const tyMin = latToTy(northWgs);
    const tyMax = latToTy(southWgs);

    const drawTileMask = (
      tileCanvas: HTMLCanvasElement,
      tx: number,
      ty: number,
      glowPx: number,
      minDrawPx: number
    ) => {
      const [latN, lonW] = tileXYToLatLon(tx, ty, renderZoom);
      const [latS, lonE] = tileXYToLatLon(tx + 1, ty + 1, renderZoom);

      let dLat = 0;
      let dLon = 0;
      if (gcj) {
        const latC = (latN + latS) / 2;
        const lonC = (lonW + lonE) / 2;
        const [gLat, gLon] = wgs84ToGcj02(latC, lonC);
        dLat = gLat - latC;
        dLon = gLon - lonC;
      }

      const pNW = map.project([lonW + dLon, latN + dLat]);
      const pSE = map.project([lonE + dLon, latS + dLat]);

      const rawW = pSE.x - pNW.x;
      const rawH = pSE.y - pNW.y;
      const w = Math.max(minDrawPx, rawW);
      const h = Math.max(minDrawPx, rawH);
      const x = pNW.x - (w - rawW) / 2;
      const y = pNW.y - (h - rawH) / 2;

      if (glowPx > 0) {
        bufCtx.globalAlpha = 0.42;
        bufCtx.drawImage(
          tileCanvas,
          x - glowPx,
          y - glowPx,
          w + glowPx * 2,
          h + glowPx * 2
        );
      }
      bufCtx.globalAlpha = 1;
      bufCtx.drawImage(tileCanvas, x - 0.3, y - 0.3, w + 0.6, h + 0.6);
    };

    const glowPx =
      glow * (useHighRes ? Math.min(8, Math.max(1.2, (zoom - 9) * 0.9)) : 1.5);

    if (useHighRes) {
      const cache = z15CanvasCacheRef.current;
      const maxCache =
        typeof window !== "undefined" && window.innerWidth < 768 ? 500 : 1600;
      for (let tx = txMin; tx <= txMax; tx++) {
        for (let ty = tyMin; ty <= tyMax; ty++) {
          const key = encodeTileKey(tx, ty);
          const entry = pack.tiles.get(key);
          if (!entry) continue;

          let tileCanvas = cache.get(key);
          if (!tileCanvas) {
            if (cache.size > maxCache) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            tileCanvas = createBitmaskCanvas(entry.bitmask);
            cache.set(key, tileCanvas);
          }
          drawTileMask(tileCanvas, tx, ty, glowPx, 0);
        }
      }
    } else {
      const macroMap = z10MacroMapRef.current;
      const cache = z10CanvasCacheRef.current;
      for (let tx = txMin; tx <= txMax; tx++) {
        for (let ty = tyMin; ty <= tyMax; ty++) {
          const key = encodeTileKey(tx, ty);
          const mask = macroMap.get(key);
          if (!mask) continue;

          let tileCanvas = cache.get(key);
          if (!tileCanvas) {
            tileCanvas = createBitmaskCanvas(mask);
            cache.set(key, tileCanvas);
          }
          drawTileMask(tileCanvas, tx, ty, glowPx, 4);
        }
      }
    }

    // Blit fog cutout onto visible overlay canvas (scaled by fineBlend during Z9.6->Z10.8 cross-fade)
    ctx.save();
    ctx.globalAlpha = fineBlend;
    ctx.drawImage(bufCanvas, 0, 0, cssW, cssH);
    ctx.restore();

    // Subtle cyan rim highlight along explored corridors at low/medium zoom
    if (corridorPath && corridorBlend > 0.05) {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = `rgba(34, 211, 238, ${0.22 * corridorBlend * fineBlend})`;
      ctx.lineWidth = corePx + 1.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(corridorPath);
      ctx.restore();
    }
  }

  // Initialize MapLibre instance after fetching initial vector style
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let map: MapLibreMap | null = null;
    let resizeObs: ResizeObserver | null = null;
    let orientationRaf: number | null = null;

    const handleOrientationChange = () => {
      if (orientationRaf !== null) {
        cancelAnimationFrame(orientationRaf);
      }
      orientationRaf = requestAnimationFrame(() => {
        orientationRaf = null;
        map?.resize();
        drawFogCanvas();
      });
    };

    const initialBaseMapId = propsRef.current.baseMapId;
    appliedBaseMapIdRef.current = initialBaseMapId;

    loadMapStyle(initialBaseMapId).then((initialStyle) => {
      if (cancelled || !containerRef.current) return;

      map = new MapLibreMap({
        container,
        style: initialStyle,
        center: [114.2, 30.6],
        zoom: 5.2,
        attributionControl: { compact: true },
        renderWorldCopies: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxZoom: 20
      });

      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();

      map.addControl(
        new NavigationControl({ showCompass: false }),
        "bottom-right"
      );
      map.addControl(
        new ScaleControl({ maxWidth: 96, unit: "metric" }),
        "bottom-left"
      );

      mapRef.current = map;

      const emitActiveLod = () => {
        if (!map) return;
        const tier = computeLodTier(map.getZoom(), propsRef.current.fogStyle);
        if (tier !== lastLodTierRef.current) {
          lastLodTierRef.current = tier;
          propsRef.current.onActiveLodChange?.(tier);
        }
      };

      const onStyleReady = () => {
        if (!map) return;
        styleReadyRef.current = true;
        syncCustomSourcesAndLayers(map);
        drawFogCanvas();
        emitActiveLod();
      };

      map.on("load", onStyleReady);
      map.on("style.load", onStyleReady);
      map.on("styledata", () => {
        if (map && isStyleReady(map)) {
          styleReadyRef.current = true;
          syncCustomSourcesAndLayers(map);
        }
      });

      if (isStyleReady(map)) {
        onStyleReady();
      }

      map.on("zoom", emitActiveLod);

      map.on("render", () => {
        drawFogCanvas();
      });

      map.on("error", (e) => {
        const msg =
          e.error instanceof Error ? e.error.message : String(e.error || "");
        if (!/(?:tile|glyph|sprite|image|resource|fetch|load)/i.test(msg)) {
          console.error("MapLibre error:", e.error || e);
        }
      });

      map.on("click", (e: MapMouseEvent) => {
        if (!map) return;
        const p = propsRef.current;
        if (p.mode === "spatial" && p.spatialDrawTool === "point") {
          const [wgsLat, wgsLon] = p.useGcj02
            ? gcj02ToWgs84(e.lngLat.lat, e.lngLat.lng)
            : [e.lngLat.lat, e.lngLat.lng];
          p.onSpatialPointQuery(wgsLat, wgsLon);
          return;
        }

        if (map.getLayer("all-tracks-layer")) {
          const isCoarse =
            typeof window !== "undefined" &&
            (window.matchMedia?.("(pointer: coarse)").matches ?? false);
          const tol = isCoarse ? 14 : 6;
          const hits = map.queryRenderedFeatures(
            [
              [e.point.x - tol, e.point.y - tol],
              [e.point.x + tol, e.point.y + tol]
            ],
            { layers: ["all-tracks-layer"] }
          );
          if (hits.length > 0) {
            const trackId = hits[0].properties?.id;
            if (typeof trackId === "string" && trackId) {
              p.onSelectTrack(
                trackId,
                e.originalEvent.ctrlKey || e.originalEvent.metaKey
              );
              return;
            }
          }
        }

        if (
          p.mode === "fog" &&
          p.fogStyle !== "fine" &&
          (p.fogStyle === "regions" || map.getZoom() < 10.4)
        ) {
          const zoom = map.getZoom();
          const candidateLayers =
            zoom < 3.8
              ? ["regions-l0-fill", "regions-l1-fill"]
              : zoom < 6.4
                ? ["regions-l1-fill", "regions-l2-fill", "regions-l0-fill"]
                : zoom < 8.4
                  ? ["regions-l2-fill", "regions-l3-fill", "regions-l1-fill"]
                  : ["regions-l3-fill", "regions-l2-fill"];

          for (const layerId of candidateLayers) {
            if (!map.getLayer(layerId)) continue;
            const hits = map.queryRenderedFeatures(e.point, {
              layers: [layerId]
            });
            if (hits.length === 0) continue;

            const feat = hits[0];
            const props = feat.properties ?? {};
            const rid = Number(feat.id ?? props.rid);
            if (!Number.isFinite(rid) || rid <= 0) continue;

            const visited = visitedRegionsMapRef.current.get(rid) ?? null;
            const lv = Number(props.lv ?? visited?.level ?? 0);
            const bbox = visited?.bbox ?? parseBboxProp(props.b);
            p.onSelectRegion({
              rid,
              level: Math.max(0, Math.min(3, lv)) as RegionLevel,
              nameZh: String(props.n ?? visited?.nameZh ?? ""),
              nameEn: String(props.ne ?? visited?.nameEn ?? ""),
              country: String(props.c ?? visited?.country ?? ""),
              directChildCount: Number(
                props.cc ?? visited?.directChildCount ?? 0
              ),
              leafChildCount: Number(props.lc ?? visited?.leafChildCount ?? 0),
              areaKm2: Number(props.a ?? visited?.areaKm2 ?? 0),
              bbox,
              visited
            });
            return;
          }
          p.onSelectRegion(null);
        }
      });

      map.on("mousemove", "all-tracks-layer", () => {
        if (map && propsRef.current.mode !== "spatial") {
          map.getCanvas().style.cursor = "pointer";
        }
      });
      map.on("mouseleave", "all-tracks-layer", () => {
        if (map && propsRef.current.mode !== "spatial") {
          map.getCanvas().style.cursor = "";
        }
      });

      if (pendingFitBoundsRef.current) {
        const bbox = pendingFitBoundsRef.current;
        pendingFitBoundsRef.current = null;
        applyFitBounds(
          map,
          bbox,
          propsRef.current.useGcj02,
          containerRef.current,
          propsRef.current.fitPadding
        );
      }

      resizeObs = new ResizeObserver(() => {
        map?.resize();
        drawFogCanvas();
      });
      resizeObs.observe(container);
      window.addEventListener("orientationchange", handleOrientationChange);
    });

    return () => {
      cancelled = true;
      if (orientationRaf !== null) {
        cancelAnimationFrame(orientationRaf);
      }
      window.removeEventListener("orientationchange", handleOrientationChange);
      resizeObs?.disconnect();
      styleReadyRef.current = false;
      if (map) {
        map.remove();
      }
      mapRef.current = null;
    };
  }, []);

  // Switch basemap style cleanly with diff: false so new style loads deterministically
  useEffect(() => {
    const map = mapRef.current;
    if (!map || baseMapId === appliedBaseMapIdRef.current) {
      return;
    }
    let cancelled = false;
    styleReadyRef.current = false;
    appliedBaseMapIdRef.current = baseMapId;

    loadMapStyle(baseMapId).then((nextStyle) => {
      if (!cancelled && mapRef.current === map) {
        map.setStyle(nextStyle, { diff: false });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [baseMapId]);

  // Toggle cursor and dragPan when spatial bbox drawing tool is active
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mode === "spatial" && spatialDrawTool === "bbox") {
      map.dragPan.disable();
      map.getCanvas().style.cursor = "crosshair";
    } else if (mode === "spatial") {
      map.dragPan.enable();
      map.getCanvas().style.cursor = "crosshair";
    } else {
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
    }
  }, [mode, spatialDrawTool]);

  // Sync GeoJSON sources & visibility whenever data props change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || (!styleReadyRef.current && !isStyleReady(map))) return;
    syncCustomSourcesAndLayers(map);
    drawFogCanvas();
    const tier = computeLodTier(map.getZoom(), fogStyle);
    if (tier !== lastLodTierRef.current) {
      lastLodTierRef.current = tier;
      propsRef.current.onActiveLodChange?.(tier);
    }
  }, [
    mode,
    useGcj02,
    fogStyle,
    fogOpacity,
    fogGlow,
    heatmapGeoJson,
    allTracksGeoJson,
    selectedTracksGeoJson,
    spatialGeoJson,
    hoverGeoJson,
    spatialMatchIds,
    spatialRadiusM
  ]);

  // Sync PMTiles feature-state whenever visited regions or selected region changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || (!styleReadyRef.current && !isStyleReady(map))) return;
    syncRegionFeatureStates(map);
  }, [visitedRegions, selectedRegionRid]);

  // Fly/fit bounds when requested (also queues if initial style is still fetching)
  useEffect(() => {
    if (!fitBoundsTrigger) return;
    const map = mapRef.current;
    if (!map) {
      pendingFitBoundsRef.current = fitBoundsTrigger.bbox;
      return;
    }
    pendingFitBoundsRef.current = null;
    applyFitBounds(
      map,
      fitBoundsTrigger.bbox,
      useGcj02,
      containerRef.current,
      propsRef.current.fitPadding
    );
  }, [fitBoundsTrigger, useGcj02]);

  const releaseCaptureQuietly = (
    el: HTMLDivElement,
    pointerId: number | null
  ) => {
    if (pointerId === null) return;
    try {
      if (el.hasPointerCapture(pointerId)) {
        el.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore if pointer capture is already released
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    activeTouchesRef.current.add(e.pointerId);
    if (activeTouchesRef.current.size > 1) {
      releaseCaptureQuietly(e.currentTarget, activePointerIdRef.current);
      activePointerIdRef.current = null;
      dragStartRef.current = null;
      setBoxDragRect(null);
      return;
    }

    if (mode !== "spatial") return;
    const isBbox = spatialDrawTool === "bbox" || e.shiftKey;
    if (!isBbox || !e.isPrimary) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    activePointerIdRef.current = e.pointerId;
    dragStartRef.current = { x, y };
    setBoxDragRect({ x0: x, y0: y, x1: x, y1: y });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture errors on unsupported targets
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId || !dragStartRef.current) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setBoxDragRect({
      x0: dragStartRef.current.x,
      y0: dragStartRef.current.y,
      x1: x,
      y1: y
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activeTouchesRef.current.delete(e.pointerId);
    if (activePointerIdRef.current !== e.pointerId || !dragStartRef.current) {
      return;
    }

    releaseCaptureQuietly(e.currentTarget, e.pointerId);
    activePointerIdRef.current = null;
    const start = dragStartRef.current;
    dragStartRef.current = null;
    setBoxDragRect(null);

    const map = mapRef.current;
    if (!map) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x1 = e.clientX - rect.left;
    const y1 = e.clientY - rect.top;

    const minDrag = e.pointerType === "touch" ? 10 : 6;
    if (Math.abs(x1 - start.x) < minDrag && Math.abs(y1 - start.y) < minDrag) {
      return;
    }

    const minX = Math.min(start.x, x1);
    const maxX = Math.max(start.x, x1);
    const minY = Math.min(start.y, y1);
    const maxY = Math.max(start.y, y1);

    const nwLngLat = map.unproject([minX, minY]);
    const seLngLat = map.unproject([maxX, maxY]);

    const [nwLat, nwLon] = useGcj02
      ? gcj02ToWgs84(nwLngLat.lat, nwLngLat.lng)
      : [nwLngLat.lat, nwLngLat.lng];
    const [seLat, seLon] = useGcj02
      ? gcj02ToWgs84(seLngLat.lat, seLngLat.lng)
      : [seLngLat.lat, seLngLat.lng];

    onSpatialBboxQuery(
      Math.min(nwLat, seLat),
      Math.min(nwLon, seLon),
      Math.max(nwLat, seLat),
      Math.max(nwLon, seLon)
    );
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    activeTouchesRef.current.delete(e.pointerId);
    if (activePointerIdRef.current === e.pointerId) {
      releaseCaptureQuietly(e.currentTarget, e.pointerId);
      activePointerIdRef.current = null;
      dragStartRef.current = null;
      setBoxDragRect(null);
    }
  };

  return (
    <div
      className="relative h-full w-full touch-none select-none overflow-hidden bg-slate-950"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div ref={containerRef} className="h-full w-full" />
      <canvas
        ref={fogCanvasRef}
        className="pointer-events-none absolute inset-0 z-[2] h-full w-full"
      />
      {boxDragRect && (
        <div
          className="pointer-events-none absolute z-[3] border-2 border-dashed border-amber-400 bg-amber-400/15"
          style={{
            left: Math.min(boxDragRect.x0, boxDragRect.x1),
            top: Math.min(boxDragRect.y0, boxDragRect.y1),
            width: Math.abs(boxDragRect.x1 - boxDragRect.x0),
            height: Math.abs(boxDragRect.y1 - boxDragRect.y0)
          }}
        />
      )}
    </div>
  );
};
