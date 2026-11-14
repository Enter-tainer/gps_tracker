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

import { DeviceSyncModal } from "./components/DeviceSyncModal.tsx";
import { ElevationProfileChart } from "./components/ElevationProfileChart.tsx";
import { FogMapView } from "./components/FogMapView.tsx";
import type { SpatialOverlayShape } from "./components/FogMapView.tsx";
import { TrackSidebar } from "./components/TrackSidebar.tsx";
import {
  computeTrackStatsAndOverview,
  pointsToGpxXml
} from "./services/gpsCodec.ts";
import { createEmptyFogPack } from "./services/fogEngine.ts";
import {
  fetchAndDecodeFog,
  fetchAndDecodeTrack,
  getCachedTrackPoints,
  removeTrackFromCache,
  setTrackPointsInCache,
  verifyBboxSpatialMatches,
  verifyPointSpatialMatches
} from "./services/trackCache.ts";
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
} from "./types/track.ts";
import { getZ15TilesForBbox } from "./utils/coordTransform.ts";
import { BASE_MAP_OPTIONS } from "./utils/styleBase.ts";

const EMPTY_STATS: BootstrapStats = {
  trackCount: 0,
  totalPoints: 0,
  totalDistanceM: 0,
  totalDurationS: 0,
  totalElevGainM: 0,
  firstDate: null,
  lastDate: null,
  visitedTilesZ15: 0,
  exploredCellsZ21: 0,
  exploredAreaKm2: 0
};

export default function App() {
  const [tracks, setTracks] = useState<TrackMetadata[]>([]);
  const [stats, setStats] = useState<BootstrapStats>(EMPTY_STATS);
  const [fogPack, setFogPack] = useState<FogPackData | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const [mode, setMode] = useState<MapVisualizationMode>("fog");
  const [baseMapId, setBaseMapId] = useState<BaseMapId>("openfreemap-liberty");
  const [useGcj02, setUseGcj02] = useState(false);
  const [fogOpacity, setFogOpacity] = useState(0.8);
  const [fogGlow, setFogGlow] = useState(1.5);
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [deviceModalOpen, setDeviceModalOpen] = useState(false);

  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [loadedTrackPoints, setLoadedTrackPoints] = useState<
    Record<string, GpsPoint[]>
  >({});
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
        fetchAndDecodeFog().catch(() => null)
      ]);
      if (!bootResp.ok) {
        throw new Error(`HTTP ${bootResp.status}`);
      }
      const boot = (await bootResp.json()) as BootstrapResponse;
      setTracks(boot.tracks ?? []);
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
    } catch (err) {
      setBootError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    loadBootstrapAndFog();
  }, [loadBootstrapAndFog]);

  // Auto-fit map viewport to the user's tracks on initial bootstrap
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

  const ensureFogPack = useCallback(async (): Promise<FogPackData> => {
    if (fogPack) return fogPack;
    try {
      const loaded = await fetchAndDecodeFog();
      setFogPack(loaded);
      return loaded;
    } catch {
      const empty = createEmptyFogPack();
      setFogPack(empty);
      return empty;
    }
  }, [fogPack]);

  // Ensure all selected tracks have decoded points loaded
  useEffect(() => {
    let cancelled = false;
    const missing = selectedTrackIds.filter(
      (id) => !loadedTrackPoints[id]
    );
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
  }, [selectedTrackIds, loadedTrackPoints]);

  const handleSelectTrack = useCallback((trackId: string, multi: boolean) => {
    setHoverPoint(null);
    setSelectedTrackIds((prev) => {
      if (!multi) {
        return prev.length === 1 && prev[0] === trackId ? [] : [trackId];
      }
      return prev.includes(trackId)
        ? prev.filter((id) => id !== trackId)
        : [...prev, trackId];
    });
  }, []);

  const handleFitTrackBounds = useCallback((track: TrackMetadata) => {
    setFitBoundsTrigger((prev) => ({
      bbox: [track.min_lon, track.min_lat, track.max_lon, track.max_lat],
      nonce: (prev?.nonce ?? 0) + 1
    }));
  }, []);

  const handleDeleteTrack = useCallback(async (trackId: string) => {
    const resp = await fetch(`/api/tracks/${encodeURIComponent(trackId)}`, {
      method: "DELETE"
    });
    if (!resp.ok) return;
    removeTrackFromCache(trackId);
    setTracks((prev) => prev.filter((t) => t.id !== trackId));
    setSelectedTrackIds((prev) => prev.filter((id) => id !== trackId));
    setSpatialMatches((prev) => prev.filter((m) => m.trackId !== trackId));
  }, []);

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

  const handleTrackUploaded = useCallback(
    (track: TrackMetadata, points: GpsPoint[], updatedFogPack: FogPackData) => {
      setTrackPointsInCache(track.id, points);
      setLoadedTrackPoints((prev) => ({ ...prev, [track.id]: points }));
      setFogPack(updatedFogPack);
      setTracks((prev) => {
        const nextTracks = [
          track,
          ...prev.filter((t) => t.id !== track.id)
        ].sort(
          (a, b) => b.date.localeCompare(a.date) || b.start_time - a.start_time
        );
        const dates = nextTracks.map((t) => t.date).sort();
        setStats({
          trackCount: nextTracks.length,
          totalPoints: nextTracks.reduce((s, t) => s + t.point_count, 0),
          totalDistanceM: Math.round(
            nextTracks.reduce((s, t) => s + t.distance_m, 0)
          ),
          totalDurationS: nextTracks.reduce((s, t) => s + t.duration_s, 0),
          totalElevGainM: Math.round(
            nextTracks.reduce((s, t) => s + t.elev_gain_m, 0)
          ),
          firstDate: dates[0] ?? null,
          lastDate: dates[dates.length - 1] ?? null,
          visitedTilesZ15: updatedFogPack.tileCount,
          exploredCellsZ21: updatedFogPack.totalCells,
          exploredAreaKm2: updatedFogPack.exploredAreaKm2
        });
        return nextTracks;
      });
      setSelectedTrackIds([track.id]);
      handleFitTrackBounds(track);
    },
    [handleFitTrackBounds]
  );

  const handlePreviewLocalTrack = useCallback(
    (name: string, points: GpsPoint[]) => {
      const previewId = `preview-${name}`;
      const summary = computeTrackStatsAndOverview(points);
      const previewTrack: TrackMetadata = {
        id: previewId,
        date: new Date((summary.startTime || Date.now() / 1000) * 1000)
          .toISOString()
          .slice(0, 10),
        title: `预览: ${name}`,
        source_file: name,
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
        r2_key: "",
        overview_coords: summary.overviewCoords,
        created_at: Math.floor(Date.now() / 1000)
      };
      setTrackPointsInCache(previewId, points);
      setLoadedTrackPoints((prev) => ({ ...prev, [previewId]: points }));
      setTracks((prev) => [
        previewTrack,
        ...prev.filter((t) => t.id !== previewId)
      ]);
      setSelectedTrackIds([previewId]);
      handleFitTrackBounds(previewTrack);
    },
    [handleFitTrackBounds]
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
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
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
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-xl border border-slate-700/70 bg-slate-900/90 px-3 py-2 text-xs text-cyan-300 shadow-xl backdrop-blur-xl">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>加载足迹与迷雾...</span>
          </div>
        )}

        {bootError && (
          <div className="pointer-events-auto rounded-xl border border-rose-500/40 bg-rose-950/90 px-3 py-2 text-xs text-rose-200 shadow-xl">
            数据加载失败: {bootError}
          </div>
        )}

        {/* Visualization Mode Switcher */}
        <div className="pointer-events-auto flex items-center rounded-xl border border-slate-700/70 bg-slate-900/90 p-1 shadow-xl backdrop-blur-xl">
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
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                mode === id
                  ? "bg-cyan-500 text-slate-950 shadow-sm"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
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
            className="flex items-center gap-1.5 rounded-xl border border-slate-700/70 bg-slate-900/90 px-3 py-2 text-xs font-medium text-slate-200 shadow-xl backdrop-blur-xl hover:bg-slate-800"
          >
            <Layers className="h-3.5 w-3.5 text-cyan-400" />
            <span className="hidden md:inline">底图与迷雾</span>
            <SlidersHorizontal className="h-3 w-3 text-slate-400" />
          </button>

          {showLayerMenu && (
            <div className="absolute right-0 mt-2 w-72 rounded-2xl border border-slate-700/80 bg-slate-900/95 p-3.5 shadow-2xl backdrop-blur-xl">
              <div className="mb-3 space-y-2 border-b border-slate-800 pb-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-200">
                    迷雾遮罩浓度
                  </span>
                  <span className="font-mono text-cyan-300">
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
                  className="h-1.5 w-full accent-cyan-400"
                />
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-200">
                    擦除柔边光晕
                  </span>
                  <span className="font-mono text-cyan-300">
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
                  className="h-1.5 w-full accent-cyan-400"
                />
              </div>

              <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <div className="text-xs font-semibold text-slate-200">
                    GCJ-02 火星坐标纠偏
                  </div>
                  <div className="text-[10px] text-slate-400">
                    使用高德底图时需开启，OpenFreeMap 请关闭
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setUseGcj02((v) => !v)}
                  className={`h-5 w-9 rounded-full p-0.5 transition ${
                    useGcj02 ? "bg-cyan-500" : "bg-slate-700"
                  }`}
                >
                  <div
                    className={`h-4 w-4 rounded-full bg-white transition-transform ${
                      useGcj02 ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              <div className="space-y-1">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  底图源 (OpenFreeMap 矢量瓦片 / 高德)
                </div>
                {BASE_MAP_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleChangeBaseMap(opt.id)}
                    className={`w-full rounded-lg px-2.5 py-1.5 text-left transition ${
                      baseMapId === opt.id
                        ? "bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/50"
                        : "text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    <div className="text-xs font-medium">{opt.label}</div>
                    <div className="text-[10px] text-slate-400">
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
          className="pointer-events-auto flex items-center gap-1.5 rounded-xl border border-slate-700/70 bg-slate-900/90 px-3 py-2 text-xs font-medium text-slate-200 shadow-xl backdrop-blur-xl hover:bg-slate-800"
        >
          <Compass className="h-3.5 w-3.5 text-emerald-400" />
          <span className="hidden md:inline">全局视野</span>
        </button>

        {/* BLE Device & Upload Modal Trigger */}
        <button
          type="button"
          onClick={() => setDeviceModalOpen(true)}
          className="pointer-events-auto flex items-center gap-1.5 rounded-xl bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 shadow-xl hover:bg-cyan-400"
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

      {/* Device & Upload Modal */}
      <DeviceSyncModal
        isOpen={deviceModalOpen}
        onClose={() => setDeviceModalOpen(false)}
        fogPack={fogPack}
        ensureFogPack={ensureFogPack}
        onTrackUploaded={handleTrackUploaded}
        onPreviewLocalTrack={handlePreviewLocalTrack}
      />
    </div>
  );
}
