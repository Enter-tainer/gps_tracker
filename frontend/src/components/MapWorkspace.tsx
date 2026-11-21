import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bluetooth,
  Compass,
  Crosshair,
  EyeOff,
  Flame,
  Footprints,
  Layers,
  Loader2,
  MapPin,
  Route,
  SlidersHorizontal,
  Square,
  X
} from "lucide-react";

import { useIsMobile } from "../hooks/useIsMobile.ts";
import { ElevationProfileChart } from "./ElevationProfileChart.tsx";
import { FogMapView } from "./FogMapView.tsx";
import type { FitPadding, SpatialOverlayShape } from "./FogMapView.tsx";
import { LayerSettingsPanel } from "./LayerSettingsPanel.tsx";
import { RegionInfoCard } from "./RegionInfoCard.tsx";
import { TrackSidebar } from "./TrackSidebar.tsx";
import type { MobileSheetSnap } from "./TrackSidebar.tsx";
import { rebuildGlobalFogInBrowser } from "../services/clientEtl.ts";
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
  FogRenderStyle,
  GpsPoint,
  LodTier,
  MapVisualizationMode,
  SelectedRegionInfo,
  SpatialQueryMatch,
  TrackColorMode,
  TrackMetadata,
  VisitedRegion
} from "../types/track.ts";
import { getZ15TilesForBbox } from "../utils/coordTransform.ts";
import { BASE_MAP_OPTIONS } from "../utils/styleBase.ts";

export type MapWorkspaceProps = {
  tracks: TrackMetadata[];
  setTracks: React.Dispatch<React.SetStateAction<TrackMetadata[]>>;
  visitedRegions: VisitedRegion[];
  setVisitedRegions: React.Dispatch<React.SetStateAction<VisitedRegion[]>>;
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
  onFogRebuilt: (pack: FogPackData, regions?: VisitedRegion[]) => void;
};

const LOD_TIER_LABELS: Record<LodTier, string> = {
  l0: "国家级热力",
  l1: "省·州级热力",
  l2: "地市级热力",
  l3: "区·县级热力",
  fine: "街道精准迷雾"
};

const MODE_TABS = [
  { id: "fog", desktopLabel: "世界迷雾", mobileLabel: "迷雾", Icon: EyeOff },
  { id: "heatmap", desktopLabel: "足迹热力", mobileLabel: "热力", Icon: Flame },
  { id: "tracks", desktopLabel: "全部轨迹", mobileLabel: "轨迹", Icon: Route },
  { id: "spatial", desktopLabel: "空间反查", mobileLabel: "反查", Icon: MapPin }
] as const;

export default function MapWorkspace({
  tracks,
  setTracks,
  visitedRegions,
  setVisitedRegions,
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
  onNavigateDevice,
  onFogRebuilt
}: MapWorkspaceProps) {
  const isMobile = useIsMobile();

  const [isBootstrapping, setIsBootstrapping] = useState(!hasBootstrapped);
  const [bootError, setBootError] = useState<string | null>(null);
  const [rebuildStatus, setRebuildStatus] = useState<string | null>(null);

  const [mode, setMode] = useState<MapVisualizationMode>("fog");
  const [fogStyle, setFogStyle] = useState<FogRenderStyle>("hybrid");
  const [baseMapId, setBaseMapId] = useState<BaseMapId>("openfreemap-liberty");
  const [useGcj02, setUseGcj02] = useState(false);
  const [fogOpacity, setFogOpacity] = useState(0.8);
  const [fogGlow, setFogGlow] = useState(1.5);
  const [showLayerMenu, setShowLayerMenu] = useState(false);

  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [mobileSheetSnap, setMobileSheetSnap] =
    useState<MobileSheetSnap>("closed");
  const [elevationMinimized, setElevationMinimized] = useState(false);

  const [selectedRegion, setSelectedRegion] =
    useState<SelectedRegionInfo | null>(null);
  const [activeLodTier, setActiveLodTier] = useState<LodTier>("l1");
  const [loadingRegionTracks, setLoadingRegionTracks] = useState(false);

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
        fetch("/api/bootstrap", { redirect: "manual" }),
        fogPack ? Promise.resolve(fogPack) : fetchAndDecodeFog().catch(() => null)
      ]);
      if (bootResp.type === "opaqueredirect") {
        let shouldReload = true;
        try {
          const now = Date.now();
          const last = Number(sessionStorage.getItem("traceveil_reauth_ts") || "0");
          if (now - last <= 15_000) {
            shouldReload = false;
          } else {
            sessionStorage.setItem("traceveil_reauth_ts", String(now));
          }
        } catch {
          // Ignore sessionStorage errors in restricted contexts
        }
        if (shouldReload) {
          window.location.reload();
          return;
        }
        throw new Error("登录状态已过期，请刷新页面重新登录 Cloudflare Access");
      }
      if (!bootResp.ok) {
        throw new Error(`HTTP ${bootResp.status}`);
      }
      const boot = (await bootResp.json()) as BootstrapResponse;
      setTracks((prev) => {
        const previewOnly = prev.filter((t) => t.id.startsWith("preview-"));
        const serverTracks = boot.tracks ?? [];
        return [...previewOnly, ...serverTracks];
      });
      if (Array.isArray(boot.regions)) {
        setVisitedRegions(boot.regions);
      }
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
      setSelectedRegion(null);
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

  const handleFitBbox = useCallback((bbox: [number, number, number, number]) => {
    setFitBoundsTrigger((prev) => ({
      bbox,
      nonce: (prev?.nonce ?? 0) + 1
    }));
  }, []);

  const handleSelectRegionFromMap = useCallback(
    (info: SelectedRegionInfo | null) => {
      setSelectedRegion(info);
      if (info) {
        setSelectedTrackIds([]);
        setHoverPoint(null);
      }
    },
    [setSelectedTrackIds]
  );

  const handleSelectRegionFromList = useCallback(
    (region: VisitedRegion) => {
      setMode("fog");
      setSelectedTrackIds([]);
      setHoverPoint(null);
      setSelectedRegion({
        rid: region.rid,
        level: region.level,
        nameZh: region.nameZh,
        nameEn: region.nameEn,
        country: region.country,
        directChildCount: region.directChildCount,
        leafChildCount: region.leafChildCount,
        areaKm2: region.areaKm2,
        bbox: region.bbox,
        visited: region
      });
      handleFitBbox(region.bbox);
    },
    [handleFitBbox, setSelectedTrackIds]
  );

  const handleLoadRegionTracks = useCallback(
    async (rid: number) => {
      setLoadingRegionTracks(true);
      try {
        const resp = await fetch(`/api/regions/tracks?rids=${rid}`);
        if (!resp.ok) return;
        const json = (await resp.json()) as { trackIds?: string[] };
        const ids = Array.isArray(json.trackIds) ? json.trackIds : [];
        if (ids.length === 0) return;

        setSelectedRegion(null);
        setHoverPoint(null);
        setSelectedTrackIds(ids);

        const matched = tracks.filter((t) => ids.includes(t.id));
        if (matched.length > 0) {
          let minLon = 180;
          let maxLon = -180;
          let minLat = 90;
          let maxLat = -90;
          for (const t of matched) {
            if (t.min_lon < minLon) minLon = t.min_lon;
            if (t.max_lon > maxLon) maxLon = t.max_lon;
            if (t.min_lat < minLat) minLat = t.min_lat;
            if (t.max_lat > maxLat) maxLat = t.max_lat;
          }
          handleFitBbox([minLon, minLat, maxLon, maxLat]);
        }
      } finally {
        setLoadingRegionTracks(false);
      }
    },
    [handleFitBbox, setSelectedTrackIds, tracks]
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
      if (isMobile) {
        setMobileSheetSnap("half");
      } else {
        setDesktopSidebarOpen(true);
      }

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
    [isMobile]
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
      if (isMobile) {
        setMobileSheetSnap("half");
      } else {
        setDesktopSidebarOpen(true);
      }

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
    [isMobile]
  );

  const primaryTrack = useMemo(() => {
    if (selectedTrackIds.length === 0) return null;
    const primaryId = selectedTrackIds[0];
    return tracks.find((t) => t.id === primaryId) ?? null;
  }, [selectedTrackIds, tracks]);

  useEffect(() => {
    setElevationMinimized(false);
  }, [primaryTrack?.id]);

  const primaryTrackPoints = primaryTrack
    ? loadedTrackPoints[primaryTrack.id] ?? null
    : null;

  const hasElevationCard = Boolean(primaryTrack && primaryTrackPoints);
  const sidebarOpen = isMobile
    ? mobileSheetSnap !== "closed"
    : desktopSidebarOpen;

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

  const handleRebuildFog = useCallback(async () => {
    if (rebuildStatus) return;
    setRebuildStatus("准备重刷...");
    try {
      let rebuiltRegions: VisitedRegion[] | undefined;
      const trackDatesById = new Map(tracks.map((t) => [t.id, t.date]));
      const rebuilt = await rebuildGlobalFogInBrowser(
        (msg) => setRebuildStatus(msg),
        (regions) => {
          rebuiltRegions = regions;
        },
        trackDatesById
      );
      onFogRebuilt(rebuilt, rebuiltRegions);
    } catch (err) {
      console.error("Rebuild fog failed:", err);
      setBootError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebuildStatus(null);
    }
  }, [onFogRebuilt, rebuildStatus, tracks]);

  const hasRegionCard = Boolean(selectedRegion && !hasElevationCard);
  const hasBottomCard = hasElevationCard || hasRegionCard;

  const fitPadding = useMemo<FitPadding>(() => {
    if (isMobile) {
      const vh = typeof window !== "undefined" ? window.innerHeight : 700;
      return {
        top: mode === "spatial" ? 136 : 86,
        bottom:
          mobileSheetSnap === "half"
            ? Math.round(vh * 0.52)
            : hasElevationCard
              ? elevationMinimized
                ? 136
                : 236
              : hasRegionCard
                ? 192
                : 96,
        left: 24,
        right: 24
      };
    }
    return {
      top: 76,
      bottom: hasElevationCard ? 210 : hasRegionCard ? 164 : 64,
      left: desktopSidebarOpen ? 372 : 48,
      right: 64
    };
  }, [
    isMobile,
    mode,
    mobileSheetSnap,
    hasElevationCard,
    hasRegionCard,
    elevationMinimized,
    desktopSidebarOpen
  ]);

  const bottomClearance = isMobile
    ? hasElevationCard
      ? elevationMinimized
        ? "128px"
        : "232px"
      : hasRegionCard
        ? "190px"
        : "78px"
    : "12px";

  const clearSpatial = useCallback(() => {
    spatialSeqRef.current++;
    setSpatialShape(null);
    setSpatialMatches([]);
    setSpatialSearching(false);
  }, []);

  return (
    <div
      style={
        {
          "--map-bottom-clearance": bottomClearance
        } as React.CSSProperties
      }
      className="relative h-viewport w-screen overflow-hidden bg-background text-foreground"
    >
      {/* Full-viewport MapLibre + 60fps Fog + Global Regions LOD */}
      <FogMapView
        mode={mode}
        baseMapId={baseMapId}
        useGcj02={useGcj02}
        fogPack={fogPack}
        fogStyle={fogStyle}
        fogOpacity={fogOpacity}
        fogGlow={fogGlow}
        visitedRegions={visitedRegions}
        selectedRegionRid={selectedRegion?.rid ?? null}
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
        fitPadding={fitPadding}
        onSelectTrack={handleSelectTrack}
        onSelectRegion={handleSelectRegionFromMap}
        onActiveLodChange={setActiveLodTier}
        onSpatialPointQuery={handleSpatialPointQuery}
        onSpatialBboxQuery={handleSpatialBboxQuery}
      />

      {/* Track & Regions Archive (Desktop Left Sidebar / Mobile Bottom Sheet) */}
      <TrackSidebar
        isOpen={sidebarOpen}
        isMobile={isMobile}
        mobileSnap={mobileSheetSnap}
        onChangeMobileSnap={setMobileSheetSnap}
        onToggleOpen={() => setDesktopSidebarOpen((v) => !v)}
        stats={stats}
        tracks={tracks}
        visitedRegions={visitedRegions}
        selectedRegionRid={selectedRegion?.rid ?? null}
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
        onClearSpatial={clearSpatial}
        onSelectTrack={handleSelectTrack}
        onSelectRegionFromList={handleSelectRegionFromList}
        onClearSelection={() => {
          setSelectedTrackIds([]);
          setHoverPoint(null);
        }}
        onFitTrackBounds={handleFitTrackBounds}
        onDeleteTrack={handleDeleteTrack}
      />

      {isMobile ? (
        <>
          {/* Mobile Top Floating Bar */}
          <div
            style={{ top: "max(0.75rem, var(--safe-top))" }}
            className="pointer-events-none absolute inset-x-3 z-20 flex items-center justify-between gap-2"
          >
            <div className="pointer-events-auto flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={onNavigateDevice}
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-medium text-primary-foreground shadow-lg transition-colors hover:bg-primary/90"
              >
                <Bluetooth className="h-3.5 w-3.5" />
                <span>设备</span>
              </button>

              <button
                type="button"
                onClick={() => setMobileSheetSnap("half")}
                className="inline-flex h-10 min-w-0 items-center gap-1.5 truncate rounded-xl border border-border bg-background/90 px-3 text-xs font-medium text-foreground shadow-lg backdrop-blur-md transition-colors hover:bg-accent"
              >
                <Footprints className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                <span className="truncate font-mono tabular-nums">
                  {tracks.length > 0
                    ? `${Math.round(stats.totalDistanceM / 1000)}km · ${tracks.length}条`
                    : "Traceveil"}
                </span>
              </button>
            </div>

            <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={handleFitAllTracks}
                title="全局视野"
                aria-label="全局视野"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background/90 text-foreground shadow-lg backdrop-blur-md transition-colors hover:bg-accent"
              >
                <Compass className="h-4 w-4 text-muted-foreground" />
              </button>
              <button
                type="button"
                onClick={() => setShowLayerMenu((v) => !v)}
                title="底图与迷雾"
                aria-label="底图与迷雾"
                className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background/90 text-foreground shadow-lg backdrop-blur-md transition-colors hover:bg-accent"
              >
                <Layers className="h-4 w-4 text-muted-foreground" />
                {(showLayerMenu || useGcj02) && (
                  <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-cyan-400" />
                )}
              </button>
            </div>
          </div>

          {/* Mobile Status / Error, LOD Legend & Spatial HUD Stack */}
          {(isBootstrapping ||
            bootError ||
            mode === "spatial" ||
            (mode === "fog" && fogStyle !== "fine")) && (
            <div
              style={{
                top: "calc(max(0.75rem, var(--safe-top)) + 48px)"
              }}
              className="pointer-events-none absolute inset-x-3 z-20 flex flex-col gap-2"
            >
              {mode === "fog" && fogStyle !== "fine" && (
                <div className="pointer-events-auto inline-flex items-center gap-2 self-start rounded-full border border-border/85 bg-background/85 px-2.5 py-1 text-[11px] text-foreground shadow-md backdrop-blur-md">
                  <span className="font-medium text-cyan-300">
                    {LOD_TIER_LABELS[activeLodTier]}
                  </span>
                  {activeLodTier !== "fine" && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span>冷</span>
                      <span
                        className="h-1.5 w-12 rounded-full"
                        style={{
                          background:
                            "linear-gradient(90deg, #0284c7, #06b6d4, #10b981, #facc15, #f97316, #f43f5e)"
                        }}
                      />
                      <span>热</span>
                    </div>
                  )}
                </div>
              )}

              {isBootstrapping && (
                <div className="pointer-events-auto inline-flex items-center gap-1.5 self-center rounded-lg border border-border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur-md">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />
                  <span>加载足迹与迷雾...</span>
                </div>
              )}

              {bootError && (
                <div className="pointer-events-auto flex items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/15 px-3 py-1.5 text-xs text-red-300 shadow-md backdrop-blur-md">
                  <span className="truncate">数据加载失败: {bootError}</span>
                  <button
                    type="button"
                    onClick={loadBootstrapAndFog}
                    className="shrink-0 rounded bg-destructive/30 px-2 py-0.5 text-[11px] font-medium text-red-100 hover:bg-destructive/50"
                  >
                    重试
                  </button>
                </div>
              )}

              {mode === "spatial" && (
                <div className="pointer-events-auto rounded-xl border border-border bg-background/92 px-3 py-2 shadow-lg backdrop-blur-md">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex rounded-md bg-muted p-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setSpatialDrawTool("point")}
                        className={`flex items-center gap-1 rounded-sm px-2.5 py-1 font-medium transition-colors ${
                          spatialDrawTool === "point"
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground"
                        }`}
                      >
                        <Crosshair className="h-3 w-3" />
                        点选
                      </button>
                      <button
                        type="button"
                        onClick={() => setSpatialDrawTool("bbox")}
                        className={`flex items-center gap-1 rounded-sm px-2.5 py-1 font-medium transition-colors ${
                          spatialDrawTool === "bbox"
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground"
                        }`}
                      >
                        <Square className="h-3 w-3" />
                        框选
                      </button>
                    </div>

                    {spatialDrawTool === "point" && (
                      <div className="flex min-w-[120px] flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <input
                          type="range"
                          min={50}
                          max={1000}
                          step={50}
                          value={spatialRadiusM}
                          onChange={(e) => {
                            const r = Number(e.target.value);
                            setSpatialRadiusM(r);
                            if (spatialShape?.kind === "point") {
                              runPointSpatialQuery(
                                spatialShape.lat,
                                spatialShape.lon,
                                r
                              );
                            }
                          }}
                          className="h-2 flex-1 cursor-pointer accent-primary"
                        />
                        <span className="w-10 text-right font-mono tabular-nums text-foreground">
                          {spatialRadiusM}m
                        </span>
                      </div>
                    )}

                    {spatialShape && (
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setMobileSheetSnap("half")}
                          className="rounded-md border border-border bg-secondary px-2 py-1 text-[11px] font-medium text-secondary-foreground"
                        >
                          {spatialSearching
                            ? "检索中..."
                            : `结果 (${spatialMatches.length})`}
                        </button>
                        <button
                          type="button"
                          onClick={clearSpatial}
                          aria-label="清除空间筛选"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  {!spatialShape && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {spatialDrawTool === "point"
                        ? "轻点地图任意位置，反查经过该处的历史轨迹"
                        : "单指拖拽地图画框反查，双指仍可缩放地图"}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Mobile Track Point Decoding Pill */}
          {primaryTrack &&
            !primaryTrackPoints &&
            loadingTrackId === primaryTrack.id && (
              <div
                style={{
                  bottom: "calc(72px + max(0.5rem, var(--safe-bottom)))"
                }}
                className="pointer-events-none absolute inset-x-3 z-20 flex justify-center"
              >
                <div className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur-md">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" />
                  <span>正在解码轨迹...</span>
                </div>
              </div>
            )}

          {/* Mobile Elevation & Speed Profile Card */}
          {primaryTrack && primaryTrackPoints && (
            <div
              style={{
                bottom: "calc(72px + max(0.5rem, var(--safe-bottom)))"
              }}
              className="pointer-events-none absolute inset-x-2.5 z-30"
            >
              <ElevationProfileChart
                track={primaryTrack}
                points={primaryTrackPoints}
                colorMode={trackColorMode}
                isMobile={true}
                minimized={elevationMinimized}
                onToggleMinimize={() => setElevationMinimized((v) => !v)}
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

          {/* Mobile Region Detail Card */}
          {hasRegionCard && selectedRegion && (
            <div
              style={{
                bottom: "calc(72px + max(0.5rem, var(--safe-bottom)))"
              }}
              className="pointer-events-none absolute inset-x-2.5 z-30"
            >
              <RegionInfoCard
                region={selectedRegion}
                isMobile={true}
                loadingTracks={loadingRegionTracks}
                onFitBounds={handleFitBbox}
                onLoadRegionTracks={handleLoadRegionTracks}
                onClose={() => setSelectedRegion(null)}
              />
            </div>
          )}

          {/* Mobile Bottom 5-Tab Mode Dock */}
          <nav
            aria-label="地图模式导航"
            style={{ bottom: "max(0.5rem, var(--safe-bottom))" }}
            className="pointer-events-none absolute inset-x-3 z-20"
          >
            <div className="pointer-events-auto grid grid-cols-5 gap-1 rounded-2xl border border-border/85 bg-background/92 p-1 shadow-2xl backdrop-blur-xl">
              {MODE_TABS.map(({ id, mobileLabel, Icon }) => {
                const active = mode === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMode(id)}
                    className={`flex flex-col items-center justify-center gap-0.5 rounded-xl py-2 text-[11px] font-medium transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{mobileLabel}</span>
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() =>
                  setMobileSheetSnap((s) => (s === "closed" ? "half" : "closed"))
                }
                className={`relative flex flex-col items-center justify-center gap-0.5 rounded-xl py-2 text-[11px] font-medium transition-colors ${
                  mobileSheetSnap !== "closed"
                    ? "bg-accent text-accent-foreground ring-1 ring-border"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
              >
                <Footprints className="h-4 w-4" />
                <span>档案</span>
                {tracks.length > 0 && (
                  <span className="absolute right-2 top-1 rounded-full bg-cyan-500/20 px-1 font-mono text-[9px] tabular-nums text-cyan-300">
                    {tracks.length}
                  </span>
                )}
              </button>
            </div>
          </nav>

          {/* Mobile Layer & Fog Settings Sheet */}
          <LayerSettingsPanel
            isOpen={showLayerMenu}
            isMobile={true}
            onClose={() => setShowLayerMenu(false)}
            fogStyle={fogStyle}
            onChangeFogStyle={setFogStyle}
            fogOpacity={fogOpacity}
            onChangeFogOpacity={setFogOpacity}
            fogGlow={fogGlow}
            onChangeFogGlow={setFogGlow}
            rebuildStatus={rebuildStatus}
            onRebuildFog={handleRebuildFog}
            useGcj02={useGcj02}
            onToggleGcj02={() => setUseGcj02((v) => !v)}
            baseMapId={baseMapId}
            onChangeBaseMap={handleChangeBaseMap}
          />
        </>
      ) : (
        <>
          {/* Desktop Top Bar: LOD Legend Pill + Floating Mode & Basemap Actions */}
          <div
            className={`pointer-events-none absolute right-3 top-3 z-20 flex flex-wrap items-center justify-between gap-2 transition-all ${
              desktopSidebarOpen ? "left-[364px]" : "left-[144px]"
            }`}
          >
            {mode === "fog" && fogStyle !== "fine" && (
              <div className="pointer-events-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background/90 px-2.5 py-1.5 text-[11px] shadow-md backdrop-blur-md">
                <span className="font-medium text-cyan-300">
                  {LOD_TIER_LABELS[activeLodTier]}
                </span>
                {activeLodTier !== "fine" && (
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span>冷</span>
                    <span
                      className="h-1.5 w-12 rounded-full"
                      style={{
                        background:
                          "linear-gradient(90deg, #0284c7, #06b6d4, #10b981, #facc15, #f97316, #f43f5e)"
                      }}
                    />
                    <span>热</span>
                  </div>
                )}
              </div>
            )}

            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {isBootstrapping && (
                <div className="pointer-events-auto flex items-center gap-1.5 rounded-md border border-border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur-md">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />
                  <span>加载足迹与迷雾...</span>
                </div>
              )}

              {bootError && (
                <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/15 px-3 py-1.5 text-xs text-red-300 shadow-md backdrop-blur-md">
                  <span>数据加载失败: {bootError}</span>
                  <button
                    type="button"
                    onClick={loadBootstrapAndFog}
                    className="rounded bg-destructive/30 px-1.5 py-0.5 text-[11px] font-medium text-red-100 hover:bg-destructive/50"
                  >
                    重试
                  </button>
                </div>
              )}

              {/* Visualization Mode Switcher */}
              <div className="pointer-events-auto inline-flex items-center rounded-lg border border-border bg-background/90 p-1 shadow-md backdrop-blur-md">
                {MODE_TABS.map(({ id, desktopLabel, Icon }) => (
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
                    <span>{desktopLabel}</span>
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
                  <span>底图与迷雾</span>
                  <SlidersHorizontal className="h-3 w-3 text-muted-foreground" />
                </button>

                <LayerSettingsPanel
                  isOpen={showLayerMenu}
                  isMobile={false}
                  onClose={() => setShowLayerMenu(false)}
                  fogStyle={fogStyle}
                  onChangeFogStyle={setFogStyle}
                  fogOpacity={fogOpacity}
                  onChangeFogOpacity={setFogOpacity}
                  fogGlow={fogGlow}
                  onChangeFogGlow={setFogGlow}
                  rebuildStatus={rebuildStatus}
                  onRebuildFog={handleRebuildFog}
                  useGcj02={useGcj02}
                  onToggleGcj02={() => setUseGcj02((v) => !v)}
                  baseMapId={baseMapId}
                  onChangeBaseMap={handleChangeBaseMap}
                />
              </div>

              {/* Fit All Tracks */}
              <button
                type="button"
                onClick={handleFitAllTracks}
                title="全览所有足迹"
                className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background/90 px-3 text-xs font-medium text-foreground shadow-md backdrop-blur-md transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Compass className="h-3.5 w-3.5 text-muted-foreground" />
                <span>全局视野</span>
              </button>

              {/* Back to Device / Ingest Console (/) */}
              <button
                type="button"
                onClick={onNavigateDevice}
                className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-md transition-colors hover:bg-primary/90"
              >
                <Bluetooth className="h-3.5 w-3.5" />
                <span>设备 / 入库</span>
              </button>
            </div>
          </div>

          {/* Desktop Bottom Region Detail Card */}
          {hasRegionCard && selectedRegion && (
            <div
              className={`pointer-events-none absolute bottom-3 right-14 z-30 max-w-md transition-all ${
                desktopSidebarOpen ? "left-[368px]" : "left-3"
              }`}
            >
              <RegionInfoCard
                region={selectedRegion}
                isMobile={false}
                loadingTracks={loadingRegionTracks}
                onFitBounds={handleFitBbox}
                onLoadRegionTracks={handleLoadRegionTracks}
                onClose={() => setSelectedRegion(null)}
              />
            </div>
          )}

          {/* Desktop Bottom Elevation & Speed Profile Drawer */}
          {primaryTrack && primaryTrackPoints && (
            <div
              className={`pointer-events-none absolute bottom-3 right-14 z-30 transition-all ${
                desktopSidebarOpen ? "left-[368px]" : "left-3"
              }`}
            >
              <ElevationProfileChart
                track={primaryTrack}
                points={primaryTrackPoints}
                colorMode={trackColorMode}
                isMobile={false}
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
        </>
      )}
    </div>
  );
}
