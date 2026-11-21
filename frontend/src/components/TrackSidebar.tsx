import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Footprints,
  Globe2,
  Layers2,
  MapPin,
  Search,
  Square,
  Trash2,
  X
} from "lucide-react";

import { getRegionHeatColor } from "../services/regionEngine.ts";
import type {
  BootstrapStats,
  MapVisualizationMode,
  RegionLevel,
  SpatialQueryMatch,
  TrackMetadata,
  VisitedRegion
} from "../types/track.ts";
import type { SpatialOverlayShape } from "./FogMapView.tsx";

export type MobileSheetSnap = "closed" | "half" | "full";

type TrackSidebarProps = {
  isOpen: boolean;
  isMobile: boolean;
  mobileSnap?: MobileSheetSnap;
  onChangeMobileSnap?: (snap: MobileSheetSnap) => void;
  onToggleOpen: () => void;
  stats: BootstrapStats;
  tracks: TrackMetadata[];
  visitedRegions: VisitedRegion[];
  selectedRegionRid: number | null;
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
  onSelectRegionFromList: (region: VisitedRegion) => void;
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
  isMobile,
  mobileSnap = "closed",
  onChangeMobileSnap,
  onToggleOpen,
  stats,
  tracks,
  visitedRegions,
  selectedRegionRid,
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
  onSelectRegionFromList,
  onClearSelection,
  onFitTrackBounds,
  onDeleteTrack
}) => {
  const [activeTab, setActiveTab] = useState<"tracks" | "regions">("tracks");
  const [regionLevelFilter, setRegionLevelFilter] = useState<"all" | RegionLevel>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Mobile sheet drag state
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartYRef = useRef(0);
  const dragStartTimeRef = useRef(0);
  const dragPointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (isMobile && mobileSnap === "closed") {
      setConfirmDeleteId(null);
      setDragOffsetY(0);
      setIsDragging(false);
    }
  }, [isMobile, mobileSnap]);

  useEffect(() => {
    if (!isMobile || mobileSnap === "closed") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onChangeMobileSnap?.("closed");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile, mobileSnap, onChangeMobileSnap]);

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

  const regionCounts = useMemo(() => {
    const counts = [0, 0, 0, 0];
    for (const r of visitedRegions) {
      counts[r.level] = (counts[r.level] || 0) + 1;
    }
    return counts;
  }, [visitedRegions]);

  const filteredRegions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return visitedRegions
      .filter((r) => {
        if (regionLevelFilter !== "all" && r.level !== regionLevelFilter) {
          return false;
        }
        if (!q) return true;
        return (
          r.nameZh.toLowerCase().includes(q) ||
          r.nameEn.toLowerCase().includes(q) ||
          r.country.toLowerCase().includes(q)
        );
      })
      .sort(
        (a, b) =>
          b.heat - a.heat ||
          b.exploredAreaKm2 - a.exploredAreaKm2 ||
          a.level - b.level
      );
  }, [visitedRegions, regionLevelFilter, searchQuery]);

  const handleGrabPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragPointerIdRef.current = e.pointerId;
    dragStartYRef.current = e.clientY;
    dragStartTimeRef.current = performance.now();
    setIsDragging(true);
    setDragOffsetY(0);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore unsupported targets
    }
  };

  const handleGrabPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || dragPointerIdRef.current !== e.pointerId) return;
    const dy = e.clientY - dragStartYRef.current;
    if (dy < 0) {
      const limited =
        mobileSnap === "full" ? dy * 0.15 : Math.max(-140, dy);
      setDragOffsetY(limited);
    } else {
      setDragOffsetY(dy);
    }
  };

  const finishGrabDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!isDragging || dragPointerIdRef.current !== e.pointerId) return;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }
    dragPointerIdRef.current = null;
    setIsDragging(false);

    if (cancelled) {
      setDragOffsetY(0);
      return;
    }

    const dy = e.clientY - dragStartYRef.current;
    const elapsed = Math.max(16, performance.now() - dragStartTimeRef.current);
    const velocity = dy / elapsed;

    setDragOffsetY(0);

    if (Math.abs(dy) < 8 && elapsed < 250) {
      onChangeMobileSnap?.(mobileSnap === "full" ? "half" : "full");
      return;
    }

    if (dy > 65 || velocity > 0.45) {
      onChangeMobileSnap?.(mobileSnap === "full" ? "half" : "closed");
      return;
    }

    if (dy < -50 || velocity < -0.45) {
      onChangeMobileSnap?.("full");
    }
  };

  if (isMobile && mobileSnap === "closed") {
    return null;
  }

  if (!isMobile && !isOpen) {
    return (
      <button
        type="button"
        onClick={onToggleOpen}
        className="pointer-events-auto absolute left-3 top-3 z-30 inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background/90 px-3 text-xs font-medium text-foreground shadow-md backdrop-blur-md transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Footprints className="h-3.5 w-3.5 text-muted-foreground" />
        <span>足迹档案 ({tracks.length})</span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    );
  }

  const totalKm = stats.totalDistanceM / 1000;
  const kpiBlock = isMobile ? (
    <div className="grid grid-cols-4 gap-1.5 border-b border-border px-3 py-2">
      <div className="rounded-md border border-border bg-muted/35 px-2 py-1.5">
        <div className="text-[10px] text-muted-foreground">总里程</div>
        <div className="mt-0.5 truncate font-mono text-xs font-semibold tabular-nums text-foreground">
          {totalKm.toLocaleString("en-US", {
            maximumFractionDigits: totalKm >= 100 ? 0 : 1
          })}
          <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">
            km
          </span>
        </div>
      </div>
      <div className="rounded-md border border-border bg-muted/35 px-2 py-1.5">
        <div className="text-[10px] text-muted-foreground">已点亮</div>
        <div className="mt-0.5 truncate font-mono text-xs font-semibold tabular-nums text-emerald-400">
          {stats.exploredAreaKm2.toFixed(1)}
          <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">
            km²
          </span>
        </div>
      </div>
      <div className="rounded-md border border-border bg-muted/35 px-2 py-1.5">
        <div className="text-[10px] text-muted-foreground">轨迹数</div>
        <div className="mt-0.5 truncate font-mono text-xs font-semibold tabular-nums text-foreground">
          {stats.trackCount}
          <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">
            条
          </span>
        </div>
      </div>
      <div className="rounded-md border border-border bg-muted/35 px-2 py-1.5">
        <div className="text-[10px] text-muted-foreground">总爬升</div>
        <div className="mt-0.5 truncate font-mono text-xs font-semibold tabular-nums text-foreground">
          {stats.totalElevGainM >= 1000
            ? `+${(stats.totalElevGainM / 1000).toFixed(1)}k`
            : `+${Math.round(stats.totalElevGainM)}m`}
        </div>
      </div>
    </div>
  ) : (
    <div className="grid grid-cols-2 gap-2 border-b border-border p-3">
      <div className="rounded-md border border-border bg-muted/35 px-3 py-2">
        <div className="text-[11px] font-medium text-muted-foreground">
          总里程
        </div>
        <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">
          {totalKm.toLocaleString("en-US", {
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
  );

  const innerContent = (
    <>
      {/* KPI Grid */}
      {kpiBlock}

      {/* Archive / Regions Tab Switcher */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-1.5">
        <div className="inline-flex rounded-md bg-muted p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setActiveTab("tracks")}
            className={`inline-flex items-center gap-1 rounded-sm px-2.5 py-1 font-medium transition-colors ${
              activeTab === "tracks"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Footprints className="h-3 w-3" />
            <span>轨迹 ({tracks.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("regions")}
            className={`inline-flex items-center gap-1 rounded-sm px-2.5 py-1 font-medium transition-colors ${
              activeTab === "regions"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Globe2 className="h-3 w-3" />
            <span>点亮版图</span>
          </button>
        </div>

        <span className="truncate font-mono text-[10px] tabular-nums text-muted-foreground">
          {regionCounts[0]}国·{regionCounts[1]}省·{regionCounts[2]}市·{regionCounts[3]}区县
        </span>
      </div>

      {activeTab === "regions" ? (
        <>
          <div className="space-y-2 border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索国家 / 省 / 市 / 区县..."
                className="flex h-9 w-full rounded-md border border-input bg-background/60 pl-8 pr-8 text-base text-foreground shadow-sm transition-colors placeholder:text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:h-8 md:text-xs"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="清空搜索"
                  className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              {(
                [
                  ["all", `全部 (${visitedRegions.length})`],
                  [0, `国家 (${regionCounts[0]})`],
                  [1, `省州 (${regionCounts[1]})`],
                  [2, `地市 (${regionCounts[2]})`],
                  [3, `区县 (${regionCounts[3]})`]
                ] as const
              ).map(([lvl, label]) => {
                const active = regionLevelFilter === lvl;
                return (
                  <button
                    key={String(lvl)}
                    type="button"
                    onClick={() => setRegionLevelFilter(lvl)}
                    className={`shrink-0 rounded-md px-2 py-1 font-medium transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto overscroll-contain p-2.5 scrollbar-thin">
            {filteredRegions.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                {visitedRegions.length === 0
                  ? "暂无行政区划统计（可先运行区划索引或重刷迷雾）"
                  : "没有匹配的行政区划"}
              </div>
            ) : (
              filteredRegions.map((region) => {
                const isSelected = selectedRegionRid === region.rid;
                const heatColor = getRegionHeatColor(region.heat);
                const isParent = region.directChildCount > 0;
                const levelTag =
                  region.level === 0
                    ? "国"
                    : region.level === 1
                      ? "省"
                      : region.level === 2
                        ? "市"
                        : "县";
                return (
                  <button
                    key={region.rid}
                    type="button"
                    onClick={() => {
                      onSelectRegionFromList(region);
                      if (isMobile) {
                        onChangeMobileSnap?.("closed");
                      }
                    }}
                    className={`w-full rounded-md border px-3 ${
                      isMobile ? "py-2.5" : "py-2"
                    } text-left transition-colors ${
                      isSelected
                        ? "border-foreground/40 bg-accent text-accent-foreground"
                        : "border-transparent hover:border-border hover:bg-accent/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: heatColor }}
                        />
                        <span className="truncate text-xs font-medium text-foreground">
                          {region.nameZh || region.nameEn}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                          {levelTag}
                        </span>
                      </div>
                      <span
                        className="shrink-0 font-mono text-[11px] font-semibold tabular-nums"
                        style={{ color: heatColor }}
                      >
                        {isParent
                          ? `${region.litDirectChildren}/${region.directChildCount}`
                          : `${region.exploredAreaKm2.toFixed(1)}km²`}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.max(6, Math.round(region.heat * 100))}%`,
                            backgroundColor: heatColor
                          }}
                        />
                      </div>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                        {region.visitDays}天 · {region.trackCount}条
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </>
      ) : (
        <>

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
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
                className={`flex items-center gap-1 rounded-sm ${
                  isMobile ? "px-2.5 py-1.5" : "px-2 py-1"
                } font-medium transition-colors ${
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
                className={`flex items-center gap-1 rounded-sm ${
                  isMobile ? "px-2.5 py-1.5" : "px-2 py-1"
                } font-medium transition-colors ${
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
              <div className="flex min-w-[140px] flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>半径</span>
                <input
                  type="range"
                  min={50}
                  max={1000}
                  step={50}
                  value={spatialRadiusM}
                  onChange={(e) => onChangeSpatialRadius(Number(e.target.value))}
                  className={`${isMobile ? "h-2" : "h-1"} flex-1 cursor-pointer accent-primary`}
                />
                <span className="w-11 text-right font-mono tabular-nums text-foreground">
                  {spatialRadiusM}m
                </span>
              </div>
            )}
          </div>

          {!spatialShape && (
            <p className="text-[11px] text-muted-foreground">
              {isMobile
                ? spatialDrawTool === "point"
                  ? "收起抽屉后，在上方地图任意位置轻点即可反查经过该处的所有日期。"
                  : "收起抽屉后，在上方地图单指拖拽画框（双指仍可缩放）即可反查。"
                : spatialDrawTool === "point"
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
            <div
              className={`${
                isMobile ? "max-h-36" : "max-h-40"
              } space-y-1.5 overflow-y-auto overscroll-contain pr-1 scrollbar-thin`}
            >
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
                        const multi = isMobile
                          ? multiSelectMode
                          : e.ctrlKey || e.metaKey;
                        onSelectTrack(m.trackId, multi);
                        if (t) onFitTrackBounds(t);
                        if (isMobile && !multi) {
                          onChangeMobileSnap?.("closed");
                        }
                      }}
                      className="flex w-full items-center justify-between rounded-md border border-border bg-background/70 px-2.5 py-2 text-left transition-colors hover:bg-accent"
                    >
                      <div className="min-w-0 pr-2">
                        <div className="truncate text-xs font-medium text-foreground">
                          {t?.title ?? m.trackId}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          经过时间: {formatTsDateTime(m.closestTs ?? m.firstTs)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right font-mono text-[10px] tabular-nums">
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
        <div className="border-b border-border px-3 py-2">
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
          <div className="flex h-10 items-end gap-1 overflow-x-auto pb-0.5 scrollbar-thin">
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
                  className={`group flex h-full ${
                    isMobile ? "min-w-[16px]" : "min-w-[12px]"
                  } flex-1 flex-col items-center justify-end`}
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
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索日期或轨迹名称 (如 2026-10)..."
              className="flex h-9 w-full rounded-md border border-input bg-background/60 pl-8 pr-8 text-base text-foreground shadow-sm transition-colors placeholder:text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:h-8 md:text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="清空搜索"
                className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {isMobile && (
            <button
              type="button"
              onClick={() => setMultiSelectMode((v) => !v)}
              aria-pressed={multiSelectMode}
              className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors ${
                multiSelectMode
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background/70 text-muted-foreground hover:text-foreground"
              }`}
            >
              <Layers2 className="h-3.5 w-3.5" />
              <span>多选</span>
            </button>
          )}
        </div>

        {(selectedTrackIds.length > 0 || (isMobile && multiSelectMode)) && (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              已选中 <strong className="text-foreground">{selectedTrackIds.length}</strong> 条轨迹
              {!isMobile && " (Ctrl/Cmd 多选)"}
              {isMobile && multiSelectMode && " · 多选模式已开"}
            </span>
            {selectedTrackIds.length > 0 && (
              <button
                type="button"
                onClick={onClearSelection}
                className="text-foreground hover:underline"
              >
                取消选择
              </button>
            )}
          </div>
        )}
      </div>

      {/* Scrollable Track List */}
      <div className="flex-1 space-y-1 overflow-y-auto overscroll-contain p-2.5 scrollbar-thin">
        {filteredTracks.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            没有匹配的轨迹记录
          </div>
        ) : (
          filteredTracks.map((track) => {
            const isSelected = selectedTrackIds.includes(track.id);
            const isLoading = loadingTrackId === track.id;
            const isConfirmingDelete = confirmDeleteId === track.id;
            return (
              <div
                key={track.id}
                onClick={(e) => {
                  setConfirmDeleteId(null);
                  const multi = isMobile
                    ? multiSelectMode
                    : e.ctrlKey || e.metaKey;
                  onSelectTrack(track.id, multi);
                  if (!multi) {
                    onFitTrackBounds(track);
                    if (isMobile) {
                      onChangeMobileSnap?.("closed");
                    }
                  }
                }}
                className={`group cursor-pointer rounded-md border px-3 ${
                  isMobile ? "py-2.5" : "py-2"
                } transition-colors ${
                  isSelected
                    ? "border-foreground/40 bg-accent text-accent-foreground"
                    : "border-transparent hover:border-border hover:bg-accent/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-xs font-medium text-foreground">
                    {track.title}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="font-mono text-[11px] font-medium tabular-nums text-foreground">
                      {(track.distance_m / 1000).toFixed(1)} km
                    </span>
                    {isConfirmingDelete ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                          onDeleteTrack(track.id);
                        }}
                        className="inline-flex items-center rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground shadow-sm hover:bg-destructive/90"
                      >
                        确认删除
                      </button>
                    ) : (
                      <button
                        type="button"
                        title="删除轨迹"
                        aria-label={`删除 ${track.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(track.id);
                        }}
                        className={`${
                          isMobile
                            ? "inline-flex p-1"
                            : "hidden p-0.5 group-hover:inline-flex"
                        } rounded text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-red-400`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
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
        </>
      )}
    </>
  );

  if (isMobile) {
    const baseHeight = mobileSnap === "full" ? "88dvh" : "56dvh";
    const dynamicHeight =
      dragOffsetY < 0
        ? `calc(${baseHeight} + ${Math.round(-dragOffsetY)}px)`
        : baseHeight;

    return (
      <>
        <div
          className="fixed inset-0 z-40 bg-black/45 transition-opacity"
          onClick={() => onChangeMobileSnap?.("closed")}
          aria-hidden="true"
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label="足迹档案"
          style={{
            height: dynamicHeight,
            transform: `translateY(${Math.max(0, dragOffsetY)}px)`,
            paddingBottom: "var(--safe-bottom)"
          }}
          className={`pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex flex-col overflow-hidden rounded-t-2xl border-t border-border bg-card/96 text-card-foreground shadow-2xl backdrop-blur-xl ${
            isDragging ? "" : "transition-[height,transform] duration-200 ease-out"
          }`}
        >
          {/* Draggable Grab Handle */}
          <div
            onPointerDown={handleGrabPointerDown}
            onPointerMove={handleGrabPointerMove}
            onPointerUp={(e) => finishGrabDrag(e, false)}
            onPointerCancel={(e) => finishGrabDrag(e, true)}
            className="flex cursor-grab touch-none justify-center pb-1 pt-2.5 active:cursor-grabbing"
          >
            <div className="h-1.5 w-10 rounded-full bg-muted-foreground/35" />
          </div>

          {/* Mobile Sheet Header */}
          <div className="flex items-center justify-between border-b border-border px-4 pb-2.5 pt-1">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted text-foreground">
                <Footprints className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-sm font-semibold tracking-tight text-foreground">
                  足迹档案
                </h1>
                <p className="text-[11px] text-muted-foreground">
                  {stats.firstDate && stats.lastDate
                    ? `${stats.firstDate} ~ ${stats.lastDate}`
                    : "暂无轨迹记录"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  onChangeMobileSnap?.(mobileSnap === "full" ? "half" : "full")
                }
                aria-label={mobileSnap === "full" ? "缩减高度" : "全屏展开"}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {mobileSnap === "full" ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronUp className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                onClick={() => onChangeMobileSnap?.("closed")}
                aria-label="关闭档案"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {innerContent}
        </aside>
      </>
    );
  }

  return (
    <aside className="pointer-events-auto absolute bottom-3 left-3 top-3 z-30 flex w-[340px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-border bg-card/92 text-card-foreground shadow-xl backdrop-blur-md">
      {/* Desktop Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted text-foreground">
            <Footprints className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-foreground">
              Traceveil
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

      {innerContent}
    </aside>
  );
};
