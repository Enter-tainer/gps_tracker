import React, { useEffect } from "react";
import { Check, RefreshCw, X } from "lucide-react";

import type { BaseMapId } from "../types/track.ts";
import { BASE_MAP_OPTIONS } from "../utils/styleBase.ts";

export type LayerSettingsPanelProps = {
  isOpen: boolean;
  isMobile: boolean;
  onClose: () => void;
  fogOpacity: number;
  onChangeFogOpacity: (val: number) => void;
  fogGlow: number;
  onChangeFogGlow: (val: number) => void;
  rebuildStatus: string | null;
  onRebuildFog: () => void;
  useGcj02: boolean;
  onToggleGcj02: () => void;
  baseMapId: BaseMapId;
  onChangeBaseMap: (id: BaseMapId) => void;
};

export const LayerSettingsPanel: React.FC<LayerSettingsPanelProps> = ({
  isOpen,
  isMobile,
  onClose,
  fogOpacity,
  onChangeFogOpacity,
  fogGlow,
  onChangeFogGlow,
  rebuildStatus,
  onRebuildFog,
  useGcj02,
  onToggleGcj02,
  baseMapId,
  onChangeBaseMap
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

      <div className="space-y-1">
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
          底图源 (OpenFreeMap / 高德)
        </div>
        {BASE_MAP_OPTIONS.map((opt) => {
          const active = baseMapId === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChangeBaseMap(opt.id)}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 ${
                isMobile ? "py-2.5" : "py-1.5"
              } text-left transition-colors ${
                active
                  ? "bg-accent text-accent-foreground ring-1 ring-border"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">
                  {opt.label}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {opt.description}
                </div>
              </div>
              {active && <Check className="h-4 w-4 shrink-0 text-cyan-400" />}
            </button>
          );
        })}
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
