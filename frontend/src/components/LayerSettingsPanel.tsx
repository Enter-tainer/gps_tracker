import React, { useEffect } from "react";
import { RefreshCw, X } from "lucide-react";

import type { FogRenderStyle } from "../types/track.ts";

export type LayerSettingsPanelProps = {
  isOpen: boolean;
  isMobile: boolean;
  onClose: () => void;
  fogStyle: FogRenderStyle;
  onChangeFogStyle: (style: FogRenderStyle) => void;
  fogOpacity: number;
  onChangeFogOpacity: (val: number) => void;
  fogGlow: number;
  onChangeFogGlow: (val: number) => void;
  rebuildStatus: string | null;
  onRebuildFog: () => void;
  useGcj02: boolean;
  onToggleGcj02: () => void;
  showRailway: boolean;
  onToggleRailway: () => void;
  showTerrain: boolean;
  onToggleTerrain: () => void;
};

const FOG_STYLE_OPTIONS: Array<{
  id: FogRenderStyle;
  label: string;
  desc: string;
}> = [
  { id: "hybrid", label: "智能分级 LOD", desc: "宏观区划热力 + 放大街道擦除" },
  { id: "fine", label: "精细街道", desc: "全程显示 Z15/Z21 GPS 精准擦除" },
  { id: "regions", label: "仅区划热力", desc: "始终按国/省/市/区县热力展示" }
];

export const LayerSettingsPanel: React.FC<LayerSettingsPanelProps> = ({
  isOpen,
  isMobile,
  onClose,
  fogStyle,
  onChangeFogStyle,
  fogOpacity,
  onChangeFogOpacity,
  fogGlow,
  onChangeFogGlow,
  rebuildStatus,
  onRebuildFog,
  useGcj02,
  onToggleGcj02,
  showRailway,
  onToggleRailway,
  showTerrain,
  onToggleTerrain
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sliderCls = `${isMobile ? "h-2" : "h-1.5"} w-full cursor-pointer accent-primary`;

  const bodyContent = (
    <>
      <div className="mb-3 space-y-2 border-b border-border pb-3">
        <div className="text-xs font-medium text-foreground">
          迷雾渲染模式 (LOD)
        </div>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
          {FOG_STYLE_OPTIONS.map((opt) => {
            const active = fogStyle === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                title={opt.desc}
                onClick={() => onChangeFogStyle(opt.id)}
                className={`rounded-md px-1.5 ${
                  isMobile ? "py-2 text-xs" : "py-1.5 text-[11px]"
                } font-medium transition-colors ${
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {FOG_STYLE_OPTIONS.find((o) => o.id === fogStyle)?.desc}
        </div>
      </div>

      <div className="mb-3 space-y-2.5 border-b border-border pb-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-foreground">迷雾遮罩浓度</span>
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
          onChange={(e) => onChangeFogOpacity(Number(e.target.value))}
          className={sliderCls}
        />
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-foreground">擦除柔边光晕</span>
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
          onChange={(e) => onChangeFogGlow(Number(e.target.value))}
          className={sliderCls}
        />
        <button
          type="button"
          onClick={onRebuildFog}
          disabled={Boolean(rebuildStatus)}
          className={`mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 ${
            isMobile ? "py-2.5 text-xs" : "py-1.5 text-[11px]"
          } font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50`}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${rebuildStatus ? "animate-spin" : ""}`}
          />
          <span>{rebuildStatus || "从云端轨迹全量重刷迷雾"}</span>
        </button>
      </div>

      <div className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-3">
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
          role="switch"
          aria-checked={useGcj02}
          aria-label="切换 GCJ-02 火星坐标纠偏"
          onClick={onToggleGcj02}
          className={`inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
            useGcj02 ? "bg-primary" : "bg-input"
          }`}
        >
          <span
            className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${
              useGcj02 ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-foreground">
              铁路图层 (OpenRailwayMap)
            </div>
            <div className="text-[11px] text-muted-foreground">
              叠加铁路线网与车站标识
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={showRailway}
            aria-label="切换铁路图层"
            onClick={onToggleRailway}
            className={`inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
              showRailway ? "bg-primary" : "bg-input"
            }`}
          >
            <span
              className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${
                showRailway ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-foreground">
              高程地形与等高线 (Mapterhorn)
            </div>
            <div className="text-[11px] text-muted-foreground">
              山体阴影与等高线
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={showTerrain}
            aria-label="切换高程地形与等高线"
            onClick={onToggleTerrain}
            className={`inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
              showTerrain ? "bg-primary" : "bg-input"
            }`}
          >
            <span
              className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${
                showTerrain ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <>
        <div
          className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]"
          onClick={onClose}
          aria-hidden="true"
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="底图与迷雾设置"
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[82dvh] flex-col rounded-t-2xl border-t border-border bg-popover/98 text-popover-foreground shadow-2xl backdrop-blur-xl"
        >
          <div className="flex justify-center pb-1 pt-2.5">
            <div className="h-1 w-10 rounded-full bg-muted-foreground/35" />
          </div>
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold text-foreground">
              底图与迷雾
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭设置"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div
            className="flex-1 overflow-y-auto overscroll-contain px-4 pt-3 scrollbar-thin"
            style={{ paddingBottom: "max(1rem, var(--safe-bottom))" }}
          >
            {bodyContent}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="底图与迷雾设置"
        className="absolute right-0 z-50 mt-2 max-h-[calc(100dvh-84px)] w-72 overflow-y-auto rounded-lg border border-border bg-popover/95 p-3.5 text-popover-foreground shadow-xl backdrop-blur-md scrollbar-thin"
      >
        {bodyContent}
      </div>
    </>
  );
};
