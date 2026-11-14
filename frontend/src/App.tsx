import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { DeviceSyncModal } from "./components/DeviceSyncModal.tsx";
import { computeTrackStatsAndOverview } from "./services/gpsCodec.ts";
import { createEmptyFogPack } from "./services/fogEngine.ts";
import {
  fetchAndDecodeFog,
  setTrackPointsInCache
} from "./services/trackCache.ts";
import type {
  BootstrapStats,
  FogPackData,
  GpsPoint,
  TrackMetadata
} from "./types/track.ts";

const MapWorkspace = lazy(() => import("./components/MapWorkspace.tsx"));

type AppRoute = "/" | "/map";

function readRoute(): AppRoute {
  if (typeof window === "undefined") return "/";
  return window.location.pathname.startsWith("/map") ? "/map" : "/";
}

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
  const [route, setRoute] = useState<AppRoute>(readRoute);
  const [tracks, setTracks] = useState<TrackMetadata[]>([]);
  const [stats, setStats] = useState<BootstrapStats>(EMPTY_STATS);
  const [fogPack, setFogPack] = useState<FogPackData | null>(null);
  const [loadedTrackPoints, setLoadedTrackPoints] = useState<
    Record<string, GpsPoint[]>
  >({});
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [hasBootstrapped, setHasBootstrapped] = useState(false);

  const navigate = useCallback((nextRoute: AppRoute) => {
    if (window.location.pathname !== nextRoute) {
      window.history.pushState(null, "", nextRoute);
    }
    setRoute(nextRoute);
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
    },
    []
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
      navigate("/map");
    },
    [navigate]
  );

  if (route === "/map") {
    return (
      <Suspense
        fallback={
          <div className="flex h-screen w-screen items-center justify-center bg-background text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <span>正在加载地图引擎...</span>
          </div>
        }
      >
        <MapWorkspace
          tracks={tracks}
          setTracks={setTracks}
          stats={stats}
          setStats={setStats}
          fogPack={fogPack}
          setFogPack={setFogPack}
          loadedTrackPoints={loadedTrackPoints}
          setLoadedTrackPoints={setLoadedTrackPoints}
          selectedTrackIds={selectedTrackIds}
          setSelectedTrackIds={setSelectedTrackIds}
          hasBootstrapped={hasBootstrapped}
          setHasBootstrapped={setHasBootstrapped}
          onNavigateDevice={() => navigate("/")}
        />
      </Suspense>
    );
  }

  return (
    <DeviceSyncModal
      variant="page"
      onOpenMap={() => navigate("/map")}
      fogPack={fogPack}
      ensureFogPack={ensureFogPack}
      onTrackUploaded={handleTrackUploaded}
      onPreviewLocalTrack={handlePreviewLocalTrack}
    />
  );
}
