import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bluetooth,
  Compass,
  EyeOff,
  Flame,
  Layers,
  Loader2,
  MapPin,
  Route,
  SlidersHorizontal
} from "lucide-react";

import { ElevationProfileChart } from "./ElevationProfileChart.tsx";
import { FogMapView } from "./FogMapView.tsx";
import type { SpatialOverlayShape } from "./FogMapView.tsx";
import { TrackSidebar } from "./TrackSidebar.tsx";
import { pointsToGpxXml } from "../services/gpsCodec.ts";
import {
  fetchAndDecodeFog,
  fetchAndDecodeTrack,
  getCachedTrackPoints,
  removeTrackFromCache,
  verifyBboxSpatialMatches,
  verifyPointSpatialMatches
} from "../services/trackCache.ts";
import type {
  BaseMapId,
  BootstrapResponse,
  BootstrapStats,
  FogPackData,
  GpsPoint,
  MapVisualizationMode,
  SpatialQueryMatch,
  TrackColorMode,
  TrackMetadata
} from "../types/track.ts";
import { getZ15TilesForBbox } from "../utils/coordTransform.ts";
import { BASE_MAP_OPTIONS } from "../utils/styleBase.ts";

export type MapWorkspaceProps = {
  tracks: TrackMetadata[];
  setTracks: React.Dispatch<React.SetStateAction<TrackMetadata[]>>;
  stats: BootstrapStats;
  setStats: React.Dispatch<React.SetStateAction<BootstrapStats>>;
  fogPack: FogPackData | null;
  setFogPack: React.Dispatch<React.SetStateAction<FogPackData | null>>;
  loadedTrackPoints: Record<string, GpsPoint[]>;
  setLoadedTrackPoints: React.Dispatch<
    React.SetStateAction<Record<string, GpsPoint[]>>
  >;
  selectedTrackIds: string[];
  setSelectedTrackIds: React.Dispatch<React.SetStateAction<string[]>>;
  hasBootstrapped: boolean;
  setHasBootstrapped: React.Dispatch<React.SetStateAction<boolean>>;
  onNavigateDevice: () => void;
};

export default function MapWorkspace({
  tracks,
  setTracks,
  stats,
  setStats,
  fogPack,
  setFogPack,
  loadedTrackPoints,
  setLoadedTrackPoints,
  selectedTrackIds,
  setSelectedTrackIds,
  hasBootstrapped,
  setHasBootstrapped,
  onNavigateDevice
}: MapWorkspaceProps) {
  const [isBootstrapping, setIsBootstrapping] = useState(!hasBootstrapped);
  const [bootError, setBootError] = useState<string | null>(null);

  const [mode, setMode] = useState<MapVisualizationMode>("fog");
  const [baseMapId, setBaseMapId] = useState<BaseMapId>("openfreemap-liberty");
  const [useGcj02, setUseGcj02] = useState(false);
  const [fogOpacity, setFogOpacity] = useState(0.8);
  const [fogGlow, setFogGlow] = useState(1.5);
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [loadingTrackId, setLoadingTrackId] = useState<string | null>(null);
  const [trackColorMode, setTrackColorMode] =
    useState<TrackColorMode>("speed");
  const [hoverPoint, setHoverPoint] = useState<{
    lat: number;
    lon: number;
  } | null>(null);
  const [fitBoundsTrigger, setFitBoundsTrigger] = useState<{
    bbox: [number, number, number, number];
    nonce: number;
  } | null>(null);

  // Spatial query state
  const [spatialDrawTool, setSpatialDrawTool] = useState<"point" | "bbox">(
    "point"
  );
  const [spatialRadiusM, setSpatialRadiusM] = useState(200);
  const [spatialShape, setSpatialShape] = useState<SpatialOverlayShape>(null);
  const [spatialMatches, setSpatialMatches] = useState<SpatialQueryMatch[]>([]);
  const [spatialSearching, setSpatialSearching] = useState(false);
  const spatialSeqRef = useRef(0);
  const hasAutoFittedRef = useRef(false);

  const loadBootstrapAndFog = useCallback(async () => {
    setIsBootstrapping(true);
    setBootError(null);
    try {
      const [bootResp, fog] = await Promise.all([
        fetch("/api/bootstrap"),
        fogPack ? Promise.resolve(fogPack) : fetchAndDecodeFog().catch(() => null)
      ]);
      if (!bootResp.ok) {
        throw new Error(`HTTP ${bootResp.status}`);
      }
      const boot = (await bootResp.json()) as BootstrapResponse;
      setTracks((prev) => {
        const previewOnly = prev.filter((t) => t.id.startsWith("preview-"));
        const serverTracks = boot.tracks ?? [];
        const merged = [...previewOnly, ...serverTracks];
        return merged;
      });
      if (fog) {
        setFogPack(fog);
        setStats({
          ...boot.stats,
          visitedTilesZ15: fog.tileCount,
          exploredCellsZ21: fog.totalCells,
          exploredAreaKm2: fog.exploredAreaKm2
        });
      } else {
        setStats(boot.stats);
      }
      setHasBootstrapped(true);
    } catch (err) {
      setBootError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBootstrapping(false);
    }
  }, [fogPack, setFogPack, setHasBootstrapped, setStats, setTracks]);

  useEffect(() => {
    if (!hasBootstrapped) {
      loadBootstrapAndFog();
    } else {
      setIsBootstrapping(false);
    }
  }, [hasBootstrapped, loadBootstrapAndFog]);

  // Auto-fit map viewport to the user's tracks on initial load
  useEffect(() => {
    if (hasAutoFittedRef.current || tracks.length === 0) return;
    const valid = tracks.filter(
      (t) =>
        Number.isFinite(t.min_lon) &&
        Number.isFinite(t.max_lon) &&
        Number.isFinite(t.min_lat) &&
        Number.isFinite(t.max_lat)
    );
    if (valid.length === 0) return;

    hasAutoFittedRef.current = true;
    const eastAsia = valid.filter((t) => {
      const lonC = (t.min_lon + t.max_lon) / 2;
      const latC = (t.min_lat + t.max_lat) / 2;
      return lonC >= 70 && lonC <= 140 && latC >= 15 && latC <= 55;
    });
    const scope = eastAsia.length > 0 ? eastAsia : valid;

    let minLon = 180;
    let maxLon = -180;
    let minLat = 90;
    let maxLat = -90;
    for (const t of scope) {
      if (t.min_lon < minLon) minLon = t.min_lon;
      if (t.max_lon > maxLon) maxLon = t.max_lon;
      if (t.min_lat < minLat) minLat = t.min_lat;
      if (t.max_lat > maxLat) maxLat = t.max_lat;
    }

    setFitBoundsTrigger((prev) => ({
      bbox: [minLon, minLat, maxLon, maxLat],
      nonce: (prev?.nonce ?? 0) + 1
    }));
  }, [tracks]);

  // Ensure all selected tracks have decoded points loaded
  useEffect(() => {
    let cancelled = false;
    const missing = selectedTrackIds.filter((id) => !loadedTrackPoints[id]);
    if (missing.length === 0) return;

    (async () => {
      for (const id of missing) {
        if (cancelled) return;
        const cached = getCachedTrackPoints(id);
        if (cached) {
          setLoadedTrackPoints((prev) => ({ ...prev, [id]: cached }));
          continue;
        }
        setLoadingTrackId(id);
        try {
          const pts = await fetchAndDecodeTrack(id);
          if (!cancelled) {
            setLoadedTrackPoints((prev) => ({ ...prev, [id]: pts }));
          }
        } catch (err) {
          console.error(err);
        } finally {
          if (!cancelled) setLoadingTrackId(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedTrackIds, loadedTrackPoints, setLoadedTrackPoints]);

  const handleSelectTrack = useCallback(
    (trackId: string, multi: boolean) => {
      setHoverPoint(null);
      setSelectedTrackIds((prev) => {
        if (!multi) {
          return prev.length === 1 && prev[0] === trackId ? [] : [trackId];
        }
        return prev.includes(trackId)
          ? prev.filter((id) => id !== trackId)
          : [...prev, trackId];
      });
    },
    [setSelectedTrackIds]
  );

  const handleFitTrackBounds = useCallback((track: TrackMetadata) => {
    setFitBoundsTrigger((prev) => ({
      bbox: [track.min_lon, track.min_lat, track.max_lon, track.max_lat],
      nonce: (prev?.nonce ?? 0) + 1
    }));
  }, []);

  const handleDeleteTrack = useCallback(
    async (trackId: string) => {
      const resp = await fetch(`/api/tracks/${encodeURIComponent(trackId)}`, {
        method: "DELETE"
      });
      if (!resp.ok) return;
      removeTrackFromCache(trackId);
      setTracks((prev) => prev.filter((t) => t.id !== trackId));
      setSelectedTrackIds((prev) => prev.filter((id) => id !== trackId));
      setSpatialMatches((prev) => prev.filter((m) => m.trackId !== trackId));
    },
    [setSelectedTrackIds, setTracks]
  );

  const handleChangeBaseMap = useCallback((nextId: BaseMapId) => {
    setBaseMapId(nextId);
    const opt = BASE_MAP_OPTIONS.find((o) => o.id === nextId);
    if (opt) {
      setUseGcj02(opt.isGcj02Default);
    }
  }, []);

  const runPointSpatialQuery = useCallback(
    async (lat: number, lon: number, radiusM: number) => {
      const seq = ++spatialSeqRef.current;
      setSpatialShape({ kind: "point", lat, lon, radiusM });
      setSpatialSearching(true);
      setSidebarOpen(true);

      try {
        const dLat = (radiusM / 6371000) * (180 / Math.PI);
        const dLon = dLat / Math.max(0.15, Math.cos((lat * Math.PI) / 180));
        const tileKeys = getZ15TilesForBbox(
          lat - dLat,
          lon - dLon,
          lat + dLat,
          lon + dLon,
          15
        );
        const resp = await fetch("/api/query-spatial", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tileKeys })
        });
        const data = (await resp.json()) as { matches?: SpatialQueryMatch[] };
        const candidates = data.matches ?? [];
        const verified = await verifyPointSpatialMatches(
          lat,
          lon,
          radiusM,
          candidates
        );
        if (seq === spatialSeqRef.current) {
          setSpatialMatches(verified);
        }
      } catch (err) {
        console.error("Spatial point query failed:", err);
      } finally {
        if (seq === spatialSeqRef.current) {
          setSpatialSearching(false);
        }
      }
    },
    []
  );

  const handleSpatialPointQuery = useCallback(
    (lat: number, lon: number) => {
      runPointSpatialQuery(lat, lon, spatialRadiusM);
    },
    [runPointSpatialQuery, spatialRadiusM]
  );

  const handleSpatialBboxQuery = useCallback(
    async (minLat: number, minLon: number, maxLat: number, maxLon: number) => {
      const seq = ++spatialSeqRef.current;
      setSpatialShape({ kind: "bbox", minLat, minLon, maxLat, maxLon });
      setSpatialSearching(true);
      setSidebarOpen(true);

      try {
        const tileKeys = getZ15TilesForBbox(
          minLat,
          minLon,
          maxLat,
          maxLon,
          15
        );
        const resp = await fetch("/api/query-spatial", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tileKeys })
        });
        const data = (await resp.json()) as { matches?: SpatialQueryMatch[] };
        const candidates = data.matches ?? [];
        const verified = await verifyBboxSpatialMatches(
          minLat,
          minLon,
          maxLat,
          maxLon,
          candidates
        );
        if (seq === spatialSeqRef.current) {
          setSpatialMatches(verified);
        }
      } catch (err) {
        console.error("Spatial bbox query failed:", err);
      } finally {
        if (seq === spatialSeqRef.current) {
          setSpatialSearching(false);
        }
      }
    },
    []
  );

  const primaryTrack = useMemo(() => {
    if (selectedTrackIds.length === 0) return null;
    const primaryId = selectedTrackIds[0];
    return tracks.find((t) => t.id === primaryId) ?? null;
  }, [selectedTrackIds, tracks]);

  const primaryTrackPoints = primaryTrack
    ? loadedTrackPoints[primaryTrack.id] ?? null
    : null;

  const spatialMatchIds = useMemo(
    () => spatialMatches.map((m) => m.trackId),
    [spatialMatches]
  );

  const handleDownloadSelectedGpx = useCallback(() => {
    if (!primaryTrack || !primaryTrackPoints) return;
    const xml = pointsToGpxXml(primaryTrackPoints, primaryTrack.title);
    const blob = new Blob([xml], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${primaryTrack.id}.gpx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }, [primaryTrack, primaryTrackPoints]);

  const handleFitAllTracks = useCallback(() => {
    if (tracks.length === 0) return;
    let minLon = 180;
    let maxLon = -180;
    let minLat = 90;
    let maxLat = -90;
    for (const t of tracks) {
      if (t.min_lon < minLon) minLon = t.min_lon;
      if (t.max_lon > maxLon) maxLon = t.max_lon;
      if (t.min_lat < minLat) minLat = t.min_lat;
      if (t.max_lat > maxLat) maxLat = t.max_lat;
    }
    setFitBoundsTrigger((prev) => ({
      bbox: [minLon, minLat, maxLon, maxLat],
      nonce: (prev?.nonce ?? 0) + 1
    }));
  }, [tracks]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Full-viewport MapLibre + 60fps Fog Canvas */}
      <FogMapView
        mode={mode}
        baseMapId={baseMapId}
        useGcj02={useGcj02}
        fogPack={fogPack}
        fogOpacity={fogOpacity}
        fogGlow={fogGlow}
        tracks={tracks}
        selectedTrackIds={selectedTrackIds}
        loadedTrackPoints={loadedTrackPoints}
        trackColorMode={trackColorMode}
        spatialShape={spatialShape}
        spatialMatchIds={spatialMatchIds}
        spatialRadiusM={spatialRadiusM}
        spatialDrawTool={spatialDrawTool}
        hoverPoint={hoverPoint}
        fitBoundsTrigger={fitBoundsTrigger}
        onSelectTrack={handleSelectTrack}
        onSpatialPointQuery={handleSpatialPointQuery}
        onSpatialBboxQuery={handleSpatialBboxQuery}
      />

      {/* Left Sidebar Overlay */}
      <TrackSidebar
        isOpen={sidebarOpen}
        onToggleOpen={() => setSidebarOpen((v) => !v)}
        stats={stats}
        tracks={tracks}
        selectedTrackIds={selectedTrackIds}
        loadingTrackId={loadingTrackId}
        mode={mode}
        spatialShape={spatialShape}
        spatialMatches={spatialMatches}
        spatialSearching={spatialSearching}
        spatialRadiusM={spatialRadiusM}
        spatialDrawTool={spatialDrawTool}
        onChangeSpatialRadius={(r) => {
          setSpatialRadiusM(r);
          if (spatialShape?.kind === "point") {
            runPointSpatialQuery(spatialShape.lat, spatialShape.lon, r);
          }
        }}
        onChangeSpatialDrawTool={setSpatialDrawTool}
        onClearSpatial={() => {
          spatialSeqRef.current++;
          setSpatialShape(null);
          setSpatialMatches([]);
          setSpatialSearching(false);
        }}
        onSelectTrack={handleSelectTrack}
        onClearSelection={() => {
          setSelectedTrackIds([]);
          setHoverPoint(null);
        }}
        onFitTrackBounds={handleFitTrackBounds}
        onDeleteTrack={handleDeleteTrack}
      />

      {/* Top Floating Mode & Basemap Bar */}
      <div className="pointer-events-none absolute right-3 top-3 z-20 flex max-w-[calc(100vw-24px)] flex-wrap items-center justify-end gap-2">
        {isBootstrapping && (
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-md border border-border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur-md">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />
            <span>加载足迹与迷雾...</span>
          </div>
        )}

        {bootError && (
          <div className="pointer-events-auto rounded-md border border-destructive/50 bg-destructive/15 px-3 py-1.5 text-xs text-red-300 shadow-md backdrop-blur-md">
            数据加载失败: {bootError}
          </div>
        )}

        {/* Visualization Mode Switcher (shadcn Tabs style) */}
        <div className="pointer-events-auto inline-flex items-center rounded-lg border border-border bg-background/90 p-1 shadow-md backdrop-blur-md">
          {(
            [
              ["fog", "世界迷雾", EyeOff],
              ["heatmap", "足迹热力", Flame],
              ["tracks", "全部轨迹", Route],
              ["spatial", "空间反查", MapPin]
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mode === id
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        {/* Fog Controls & Layer Switcher */}
        <div className="pointer-events-auto relative">
          <button
            type="button"
            onClick={() => setShowLayerMenu((v) => !v)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background/90 px-3 text-xs font-medium text-foreground shadow-md backdrop-blur-md transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="hidden md:inline">底图与迷雾</span>
            <SlidersHorizontal className="h-3 w-3 text-muted-foreground" />
          </button>

          {showLayerMenu && (
            <div className="absolute right-0 mt-2 w-72 rounded-lg border border-border bg-popover/95 p-3.5 text-popover-foreground shadow-xl backdrop-blur-md">
              <div className="mb-3 space-y-2 border-b border-border pb-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-foreground">
                    迷雾遮罩浓度
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {Math.round(fogOpacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.35}
                  max={0.95}
                  step={0.05}
                  value={fogOpacity}
                  onChange={(e) => setFogOpacity(Number(e.target.value))}
                  className="h-1.5 w-full cursor-pointer accent-primary"
                />
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-foreground">
                    擦除柔边光晕
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {fogGlow.toFixed(1)}x
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={3.5}
                  step={0.5}
                  value={fogGlow}
                  onChange={(e) => setFogGlow(Number(e.target.value))}
                  className="h-1.5 w-full cursor-pointer accent-primary"
                />
              </div>

              <div className="mb-3 flex items-center justify-between border-b border-border pb-3">
                <div>
                  <div className="text-xs font-medium text-foreground">
                    GCJ-02 火星坐标纠偏
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    高德底图开启，OpenFreeMap 关闭
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setUseGcj02((v) => !v)}
                  className={`inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
                    useGcj02 ? "bg-primary" : "bg-input"
                  }`}
                >
                  <span
                    className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${
                      useGcj02 ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              <div className="space-y-1">
                <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                  底图源 (OpenFreeMap / 高德)
                </div>
                {BASE_MAP_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleChangeBaseMap(opt.id)}
                    className={`w-full rounded-md px-2.5 py-1.5 text-left transition-colors ${
                      baseMapId === opt.id
                        ? "bg-accent text-accent-foreground ring-1 ring-border"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    }`}
                  >
                    <div className="text-xs font-medium text-foreground">
                      {opt.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {opt.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Fit All Tracks */}
        <button
          type="button"
          onClick={handleFitAllTracks}
          title="全览所有足迹"
          className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background/90 px-3 text-xs font-medium text-foreground shadow-md backdrop-blur-md transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Compass className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="hidden md:inline">全局视野</span>
        </button>

        {/* Back to First-Class Device / Ingest Console (/) */}
        <button
          type="button"
          onClick={onNavigateDevice}
          className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-md transition-colors hover:bg-primary/90"
        >
          <Bluetooth className="h-3.5 w-3.5" />
          <span>设备 / 入库</span>
        </button>
      </div>

      {/* Bottom Elevation & Speed Profile Drawer */}
      {primaryTrack && primaryTrackPoints && (
        <div
          className={`pointer-events-none absolute bottom-3 right-3 z-20 transition-all ${
            sidebarOpen ? "left-[368px] max-md:left-3" : "left-3"
          } mr-10`}
        >
          <ElevationProfileChart
            track={primaryTrack}
            points={primaryTrackPoints}
            colorMode={trackColorMode}
            onChangeColorMode={setTrackColorMode}
            onHoverPoint={setHoverPoint}
            onFitBounds={() => handleFitTrackBounds(primaryTrack)}
            onDownloadGpx={handleDownloadSelectedGpx}
            onClose={() => {
              setSelectedTrackIds([]);
              setHoverPoint(null);
            }}
          />
        </div>
      )}
    </div>
  );
}
