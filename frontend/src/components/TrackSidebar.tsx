import React, { useMemo, useState } from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Footprints,
  MapPin,
  Search,
  Square,
  Trash2,
  X
} from "lucide-react";

import type {
  BootstrapStats,
  MapVisualizationMode,
  SpatialQueryMatch,
  TrackMetadata
} from "../types/track.ts";
import type { SpatialOverlayShape } from "./FogMapView.tsx";

type TrackSidebarProps = {
  isOpen: boolean;
  onToggleOpen: () => void;
  stats: BootstrapStats;
  tracks: TrackMetadata[];
  selectedTrackIds: string[];
  loadingTrackId: string | null;
  mode: MapVisualizationMode;
  spatialShape: SpatialOverlayShape;
  spatialMatches: SpatialQueryMatch[];
  spatialSearching: boolean;
  spatialRadiusM: number;
  spatialDrawTool: "point" | "bbox";
  onChangeSpatialRadius: (r: number) => void;
  onChangeSpatialDrawTool: (tool: "point" | "bbox") => void;
  onClearSpatial: () => void;
  onSelectTrack: (trackId: string, multi: boolean) => void;
  onClearSelection: () => void;
  onFitTrackBounds: (track: TrackMetadata) => void;
  onDeleteTrack: (trackId: string) => void;
};

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatTsDateTime(ts: number): string {
  if (!ts) return "--";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

export const TrackSidebar: React.FC<TrackSidebarProps> = ({
  isOpen,
  onToggleOpen,
  stats,
  tracks,
  selectedTrackIds,
  loadingTrackId,
  mode,
  spatialShape,
  spatialMatches,
  spatialSearching,
  spatialRadiusM,
  spatialDrawTool,
  onChangeSpatialRadius,
  onChangeSpatialDrawTool,
  onClearSpatial,
  onSelectTrack,
  onClearSelection,
  onFitTrackBounds,
  onDeleteTrack
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMonth, setActiveMonth] = useState<string | null>(null);

  const trackMap = useMemo(() => {
    const m = new Map<string, TrackMetadata>();
    for (const t of tracks) m.set(t.id, t);
    return m;
  }, [tracks]);

  const monthlyBuckets = useMemo(() => {
    const map = new Map<string, { month: string; km: number; count: number }>();
    for (const t of tracks) {
      const m = t.date.slice(0, 7);
      const prev = map.get(m);
      if (!prev) {
        map.set(m, { month: m, km: t.distance_m / 1000, count: 1 });
      } else {
        prev.km += t.distance_m / 1000;
        prev.count += 1;
      }
    }
    return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [tracks]);

  const maxMonthKm = useMemo(
    () => Math.max(10, ...monthlyBuckets.map((b) => b.km)),
    [monthlyBuckets]
  );

  const filteredTracks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tracks.filter((t) => {
      if (activeMonth && !t.date.startsWith(activeMonth)) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        t.date.includes(q) ||
        t.source_file.toLowerCase().includes(q)
      );
    });
  }, [tracks, searchQuery, activeMonth]);

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={onToggleOpen}
        className="pointer-events-auto absolute left-3 top-3 z-20 inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background/90 px-3 text-xs font-medium text-foreground shadow-md backdrop-blur-md transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Footprints className="h-3.5 w-3.5 text-muted-foreground" />
        <span>足迹档案 ({tracks.length})</span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    );
  }

  return (
    <aside className="pointer-events-auto absolute bottom-3 left-3 top-3 z-20 flex w-[340px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-border bg-card/92 text-card-foreground shadow-xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted text-foreground">
            <Footprints className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-foreground">
              Atlas Fog
            </h1>
            <p className="text-[11px] text-muted-foreground">
              {stats.firstDate && stats.lastDate
                ? `${stats.firstDate} ~ ${stats.lastDate}`
                : "暂无轨迹记录"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleOpen}
          title="收起侧栏"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 gap-2 border-b border-border p-3">
        <div className="rounded-md border border-border bg-muted/35 px-3 py-2">
          <div className="text-[11px] font-medium text-muted-foreground">
            总里程
          </div>
          <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">
            {(stats.totalDistanceM / 1000).toLocaleString("en-US", {
              maximumFractionDigits: 1
            })}{" "}
            <span className="text-xs font-normal text-muted-foreground">km</span>
          </div>
        </div>
        <div className="rounded-md border border-border bg-muted/35 px-3 py-2">
          <div className="text-[11px] font-medium text-muted-foreground">
            已点亮面积
          </div>
          <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-emerald-400">
            {stats.exploredAreaKm2.toFixed(1)}{" "}
            <span className="text-xs font-normal text-muted-foreground">km²</span>
          </div>
        </div>
        <div className="rounded-md border border-border bg-muted/35 px-3 py-2">
          <div className="text-[11px] font-medium text-muted-foreground">
            轨迹天数 / 瓦片
          </div>
          <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
            {stats.trackCount} 条 ·{" "}
            <span className="text-muted-foreground">
              {stats.visitedTilesZ15.toLocaleString()}
            </span>
          </div>
        </div>
        <div className="rounded-md border border-border bg-muted/35 px-3 py-2">
          <div className="text-[11px] font-medium text-muted-foreground">
            累计点位 / 爬升
          </div>
          <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
            {(stats.totalPoints / 10000).toFixed(1)}w ·{" "}
            <span className="text-muted-foreground">
              +{Math.round(stats.totalElevGainM / 1000)}km
            </span>
          </div>
        </div>
      </div>

      {/* Spatial Inspector Box (active in spatial mode or when results exist) */}
      {(mode === "spatial" || spatialShape !== null) && (
        <div className="border-b border-border bg-muted/30 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <MapPin className="h-3.5 w-3.5 text-amber-400" />
              <span>空间反查 (Z15 索引 + 精确匹配)</span>
            </div>
            {spatialShape && (
              <button
                type="button"
                onClick={onClearSpatial}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-3 w-3" />
                清除
              </button>
            )}
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md bg-muted p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => onChangeSpatialDrawTool("point")}
                className={`flex items-center gap-1 rounded-sm px-2 py-1 font-medium transition-colors ${
                  spatialDrawTool === "point"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Crosshair className="h-3 w-3" />
                点击选点
              </button>
              <button
                type="button"
                onClick={() => onChangeSpatialDrawTool("bbox")}
                className={`flex items-center gap-1 rounded-sm px-2 py-1 font-medium transition-colors ${
                  spatialDrawTool === "bbox"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Square className="h-3 w-3" />
                框选区域
              </button>
            </div>

            {spatialDrawTool === "point" && (
              <div className="flex flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>半径</span>
                <input
                  type="range"
                  min={50}
                  max={1000}
                  step={50}
                  value={spatialRadiusM}
                  onChange={(e) => onChangeSpatialRadius(Number(e.target.value))}
                  className="h-1 flex-1 cursor-pointer accent-primary"
                />
                <span className="w-11 text-right font-mono tabular-nums text-foreground">
                  {spatialRadiusM}m
                </span>
              </div>
            )}
          </div>

          {!spatialShape && (
            <p className="text-[11px] text-muted-foreground">
              {spatialDrawTool === "point"
                ? "在右侧地图任意位置单击（或按住 Shift 拖拽框选），即可查出经过该处的所有日期。"
                : "在地图上按住鼠标左键拖拽画框，松开后查询框内所有历史轨迹。"}
            </p>
          )}

          {spatialSearching && (
            <div className="py-2 text-xs text-muted-foreground">
              正在检索 D1 空间索引并校验精确距离...
            </div>
          )}

          {!spatialSearching && spatialShape && (
            <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin">
              {spatialMatches.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  该范围内没有找到经过的轨迹。
                </div>
              ) : (
                spatialMatches.map((m) => {
                  const t = trackMap.get(m.trackId);
                  return (
                    <button
                      key={m.trackId}
                      type="button"
                      onClick={(e) => {
                        onSelectTrack(m.trackId, e.ctrlKey || e.metaKey);
                        if (t) onFitTrackBounds(t);
                      }}
                      className="flex w-full items-center justify-between rounded-md border border-border bg-background/70 px-2.5 py-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <div>
                        <div className="text-xs font-medium text-foreground">
                          {t?.title ?? m.trackId}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          经过时间: {formatTsDateTime(m.closestTs ?? m.firstTs)}
                        </div>
                      </div>
                      <div className="text-right font-mono text-[10px] tabular-nums">
                        {m.minDistanceM !== undefined && (
                          <div className="text-emerald-400">
                            最近 {m.minDistanceM}m
                          </div>
                        )}
                        <div className="text-muted-foreground">
                          {m.matchedPoints} 点
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}

      {/* Monthly Distance Histogram */}
      {monthlyBuckets.length > 0 && (
        <div className="border-b border-border px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              月度足迹分布
            </span>
            {activeMonth && (
              <button
                type="button"
                onClick={() => setActiveMonth(null)}
                className="text-foreground hover:underline"
              >
                {activeMonth} (清除)
              </button>
            )}
          </div>
          <div className="flex h-11 items-end gap-1 overflow-x-auto pb-0.5 scrollbar-thin">
            {monthlyBuckets.map((b) => {
              const hPct = Math.max(12, Math.round((b.km / maxMonthKm) * 100));
              const isSelected = activeMonth === b.month;
              return (
                <button
                  key={b.month}
                  type="button"
                  title={`${b.month}: ${b.km.toFixed(1)} km (${b.count} 条)`}
                  onClick={() =>
                    setActiveMonth(isSelected ? null : b.month)
                  }
                  className="group flex h-full min-w-[12px] flex-1 flex-col items-center justify-end"
                >
                  <div
                    className={`w-full rounded-t-sm transition-all ${
                      isSelected
                        ? "bg-primary"
                        : "bg-muted-foreground/30 group-hover:bg-primary/70"
                    }`}
                    style={{ height: `${hPct}%` }}
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Search + Selection Controls */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索日期或轨迹名称 (如 2026-10)..."
            className="flex h-8 w-full rounded-md border border-input bg-background/60 pl-8 pr-3 text-xs text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        {selectedTrackIds.length > 0 && (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              已选中 <strong className="text-foreground">{selectedTrackIds.length}</strong> 条轨迹 (Ctrl/Cmd 多选)
            </span>
            <button
              type="button"
              onClick={onClearSelection}
              className="text-foreground hover:underline"
            >
              取消选择
            </button>
          </div>
        )}
      </div>

      {/* Scrollable Track List */}
      <div className="flex-1 space-y-1 overflow-y-auto p-2.5 scrollbar-thin">
        {filteredTracks.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            没有匹配的轨迹记录
          </div>
        ) : (
          filteredTracks.map((track) => {
            const isSelected = selectedTrackIds.includes(track.id);
            const isLoading = loadingTrackId === track.id;
            return (
              <div
                key={track.id}
                onClick={(e) => {
                  onSelectTrack(track.id, e.ctrlKey || e.metaKey);
                  if (!e.ctrlKey && !e.metaKey) {
                    onFitTrackBounds(track);
                  }
                }}
                className={`group cursor-pointer rounded-md border px-3 py-2 transition-colors ${
                  isSelected
                    ? "border-foreground/40 bg-accent text-accent-foreground"
                    : "border-transparent hover:border-border hover:bg-accent/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-xs font-medium text-foreground">
                    {track.title}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px] font-medium tabular-nums text-foreground">
                      {(track.distance_m / 1000).toFixed(1)} km
                    </span>
                    <button
                      type="button"
                      title="删除轨迹"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteTrack(track.id);
                      }}
                      className="hidden rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-red-400 group-hover:inline-flex"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <div className="mt-1 flex items-center justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
                  <span>
                    {formatDuration(track.duration_s)} · +{Math.round(track.elev_gain_m)}m
                  </span>
                  <span>
                    {isLoading
                      ? "加载 GPZ..."
                      : `${track.point_count.toLocaleString()} pts`}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
