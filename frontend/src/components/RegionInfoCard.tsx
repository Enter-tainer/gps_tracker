import React from "react";
import { Compass, Flame, MapPin, Route, X } from "lucide-react";

import { getRegionHeatColor } from "../services/regionEngine.ts";
import type { RegionLevel, SelectedRegionInfo } from "../types/track.ts";

export type RegionInfoCardProps = {
  region: SelectedRegionInfo;
  isMobile: boolean;
  loadingTracks?: boolean;
  onFitBounds: (bbox: [number, number, number, number]) => void;
  onLoadRegionTracks?: (rid: number) => void;
  onClose: () => void;
};

const LEVEL_LABELS: Record<RegionLevel, string> = {
  0: "国家 / 地区",
  1: "省 / 州",
  2: "地级市 / 县",
  3: "区 / 县"
};

function formatDateShort(ts: number): string {
  if (!ts) return "--";
  return new Date(ts * 1000).toLocaleDateString("zh-CN");
}

export const RegionInfoCard: React.FC<RegionInfoCardProps> = ({
  region,
  isMobile,
  loadingTracks = false,
  onFitBounds,
  onLoadRegionTracks,
  onClose
}) => {
  const visited = region.visited;
  const isParent = region.directChildCount > 0;
  const heatColor = visited ? getRegionHeatColor(visited.heat) : "#475569";

  const progressPct = visited
    ? isParent
      ? Math.min(
          100,
          Math.round(
            (visited.litDirectChildren / Math.max(1, region.directChildCount)) *
              100
          )
        )
      : Math.min(
          100,
          Math.round(
            Math.min(
              1,
              (visited.exploredAreaKm2 / Math.max(0.5, region.areaKm2)) / 0.08
            ) * 100
          )
        )
    : 0;

  return (
    <div
      className={`pointer-events-auto rounded-xl border border-border bg-card/95 ${
        isMobile ? "px-3.5 py-2.5" : "px-4 py-3"
      } text-card-foreground shadow-2xl backdrop-blur-xl`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{
                backgroundColor: heatColor,
                boxShadow: visited ? `0 0 8px ${heatColor}` : undefined
              }}
            />
            <span className="truncate text-sm font-semibold tracking-tight text-foreground">
              {region.nameZh || region.nameEn}
            </span>
            {region.nameEn && region.nameEn !== region.nameZh && (
              <span className="truncate text-xs text-muted-foreground">
                {region.nameEn}
              </span>
            )}
            <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {LEVEL_LABELS[region.level]}
            </span>
            {region.country && (
              <span className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground">
                {region.country}
              </span>
            )}
          </div>

          {visited ? (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1 font-medium text-foreground">
                  <Flame className="h-3.5 w-3.5" style={{ color: heatColor }} />
                  {isParent
                    ? `已点亮 ${visited.litDirectChildren} / ${region.directChildCount} 个下级区划 (${progressPct}%)`
                    : `探索 ${visited.exploredAreaKm2.toFixed(2)} / ${region.areaKm2.toFixed(1)} km²`}
                </span>
                <span
                  className="font-mono text-[11px] font-semibold tabular-nums"
                  style={{ color: heatColor }}
                >
                  热度 {Math.round(visited.heat * 100)}
                </span>
              </div>

              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.max(4, Math.round(visited.heat * 100))}%`,
                    backgroundColor: heatColor
                  }}
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                {isParent && region.leafChildCount > 0 && (
                  <span>
                    叶子区县 {visited.litLeafChildren}/{region.leafChildCount}
                  </span>
                )}
                <span>到访 {visited.visitDays} 天</span>
                <span>{visited.trackCount} 条轨迹</span>
                <span>最近 {formatDateShort(visited.lastTs)}</span>
              </div>
            </div>
          ) : (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                尚未解锁
              </span>
              <span className="font-mono tabular-nums">
                总面积 {region.areaKm2.toFixed(1)} km²
              </span>
              {isParent && (
                <span>包含 {region.directChildCount} 个下级区划</span>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="关闭区划详情"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onFitBounds(region.bbox)}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <Compass className="h-3.5 w-3.5 text-muted-foreground" />
          <span>定位到此区</span>
        </button>

        {visited && onLoadRegionTracks && (
          <button
            type="button"
            disabled={loadingTracks}
            onClick={() => onLoadRegionTracks(region.rid)}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Route className="h-3.5 w-3.5" />
            <span>{loadingTracks ? "加载轨迹..." : "查看经过轨迹"}</span>
          </button>
        )}
      </div>
    </div>
  );
};
