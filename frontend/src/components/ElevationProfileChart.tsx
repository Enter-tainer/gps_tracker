import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Compass,
  Download,
  Palette,
  X
} from "lucide-react";

import type {
  GpsPoint,
  TrackColorMode,
  TrackMetadata
} from "../types/track.ts";
import { computePointSeries } from "../services/gpsCodec.ts";

type ElevationProfileChartProps = {
  track: TrackMetadata;
  points: GpsPoint[];
  colorMode: TrackColorMode;
  isMobile?: boolean;
  minimized?: boolean;
  onToggleMinimize?: () => void;
  onChangeColorMode: (mode: TrackColorMode) => void;
  onHoverPoint: (pt: { lat: number; lon: number } | null) => void;
  onFitBounds: () => void;
  onDownloadGpx: () => void;
  onClose: () => void;
};

type HoverSample = {
  x: number;
  distKm: number;
  eleM: number;
  speedKmh: number;
  timestamp: number;
};

function getChartMargins(cssW: number) {
  const narrow = cssW < 420;
  return {
    padL: narrow ? 36 : 44,
    padR: narrow ? 30 : 44,
    ticks: narrow ? 3 : 5
  };
}

export const ElevationProfileChart: React.FC<ElevationProfileChartProps> = ({
  track,
  points,
  colorMode,
  isMobile = false,
  minimized = false,
  onToggleMinimize,
  onChangeColorMode,
  onHoverPoint,
  onFitBounds,
  onDownloadGpx,
  onClose
}) => {
  const plotContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isScrubbingRef = useRef(false);
  const [hoverSample, setHoverSample] = useState<HoverSample | null>(null);
  const [resizeTick, setResizeTick] = useState(0);

  const series = useMemo(() => computePointSeries(points), [points]);

  useEffect(() => {
    setHoverSample(null);
  }, [track.id]);

  useEffect(() => {
    if (isMobile && minimized) return;
    const el = plotContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const obs = new ResizeObserver(() => {
      setResizeTick((t) => t + 1);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [isMobile, minimized]);

  const { totalKm, minEle, maxEle, maxSpeed } = useMemo(() => {
    const n = points.length;
    if (n === 0) {
      return { totalKm: 0, minEle: 0, maxEle: 100, maxSpeed: 30 };
    }
    let minE = Infinity;
    let maxE = -Infinity;
    let maxS = 10;
    for (let i = 0; i < n; i++) {
      const e = series.elevationsM[i];
      const s = series.speedsKmh[i];
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      if (s > maxS) maxS = s;
    }
    if (!Number.isFinite(minE)) minE = 0;
    if (!Number.isFinite(maxE) || maxE <= minE) maxE = minE + 10;
    return {
      totalKm: Math.max(0.01, series.distancesKm[n - 1]),
      minEle: minE,
      maxEle: maxE,
      maxSpeed: Math.min(350, maxS * 1.1)
    };
  }, [points.length, series]);

  useEffect(() => {
    if (isMobile && minimized) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;

    const cssW = Math.max(180, Math.round(rect.width));
    const cssH = Math.max(72, Math.round(rect.height));
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

    const n = points.length;
    if (n < 2) return;

    const { padL, padR, ticks } = getChartMargins(cssW);
    const padT = 10;
    const padB = 18;
    const plotW = Math.max(10, cssW - padL - padR);
    const plotH = Math.max(10, cssH - padT - padB);
    const eleSpan = Math.max(1, maxEle - minEle);

    // Subtle horizontal grid lines
    ctx.strokeStyle = "rgba(148, 163, 184, 0.14)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(148, 163, 184, 0.7)";
    ctx.font = `${cssW < 420 ? 9 : 10}px 'JetBrains Mono', monospace`;

    for (let g = 0; g <= 2; g++) {
      const ratio = g / 2;
      const y = padT + plotH * (1 - ratio);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();

      const eleLabel = Math.round(minEle + eleSpan * ratio);
      ctx.textAlign = "right";
      ctx.fillText(`${eleLabel}m`, padL - 5, y + 3);

      const spdLabel = Math.round(maxSpeed * ratio);
      ctx.textAlign = "left";
      ctx.fillText(`${spdLabel}`, padL + plotW + 5, y + 3);
    }

    // Decimate indices to at most plotW * 2 samples for crisp fast stroke
    const step = Math.max(1, Math.floor(n / (plotW * 2)));

    // Elevation area
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, "rgba(34, 211, 238, 0.42)");
    grad.addColorStop(1, "rgba(34, 211, 238, 0.03)");

    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    for (let i = 0; i < n; i += step) {
      const x = padL + (series.distancesKm[i] / totalKm) * plotW;
      const y =
        padT + plotH - ((series.elevationsM[i] - minEle) / eleSpan) * plotH;
      ctx.lineTo(x, y);
    }
    const lastX = padL + (series.distancesKm[n - 1] / totalKm) * plotW;
    const lastY =
      padT + plotH - ((series.elevationsM[n - 1] - minEle) / eleSpan) * plotH;
    ctx.lineTo(lastX, lastY);
    ctx.lineTo(lastX, padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Elevation stroke
    ctx.beginPath();
    for (let i = 0; i < n; i += step) {
      const x = padL + (series.distancesKm[i] / totalKm) * plotW;
      const y =
        padT + plotH - ((series.elevationsM[i] - minEle) / eleSpan) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(lastX, lastY);
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Speed stroke
    ctx.beginPath();
    for (let i = 0; i < n; i += step) {
      const x = padL + (series.distancesKm[i] / totalKm) * plotW;
      const y = padT + plotH - (series.speedsKmh[i] / maxSpeed) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(251, 191, 36, 0.85)";
    ctx.lineWidth = 1.3;
    ctx.stroke();

    // X-axis distance ticks
    ctx.fillStyle = "rgba(148, 163, 184, 0.7)";
    ctx.textAlign = "center";
    for (let t = 0; t <= ticks; t++) {
      const ratio = t / ticks;
      const x = padL + plotW * ratio;
      const kmVal = (totalKm * ratio).toFixed(totalKm < 10 ? 1 : 0);
      ctx.fillText(`${kmVal}km`, x, cssH - 4);
    }

    // Hover / scrub crosshair
    if (hoverSample) {
      const hx = Math.max(padL, Math.min(padL + plotW, hoverSample.x));
      ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [
    points,
    series,
    totalKm,
    minEle,
    maxEle,
    maxSpeed,
    hoverSample,
    resizeTick,
    isMobile,
    minimized
  ]);

  const updateSampleFromClientX = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas || points.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const { padL, padR } = getChartMargins(rect.width);
    const plotW = Math.max(10, rect.width - padL - padR);
    const ratio = Math.max(0, Math.min(1, (x - padL) / plotW));
    const targetKm = ratio * totalKm;

    // Binary search nearest point by cumulative distance
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (series.distancesKm[mid] < targetKm) lo = mid + 1;
      else hi = mid;
    }

    const pt = points[lo];
    setHoverSample({
      x,
      distKm: series.distancesKm[lo],
      eleM: series.elevationsM[lo],
      speedKmh: series.speedsKmh[lo],
      timestamp: series.timestamps[lo]
    });
    onHoverPoint({
      lat: pt.latitude_scaled_1e7 / 1e7,
      lon: pt.longitude_scaled_1e7 / 1e7
    });
  };

  const releasePointerCaptureQuietly = (
    el: HTMLCanvasElement,
    pointerId: number
  ) => {
    try {
      if (el.hasPointerCapture(pointerId)) {
        el.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore if pointer capture is already released
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isScrubbingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore unsupported targets
    }
    updateSampleFromClientX(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" || isScrubbingRef.current) {
      updateSampleFromClientX(e.clientX);
    }
  };

  const handlePointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isScrubbingRef.current = false;
    releasePointerCaptureQuietly(e.currentTarget, e.pointerId);
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse") {
      isScrubbingRef.current = false;
      setHoverSample(null);
      onHoverPoint(null);
    }
  };

  const formatTime = (ts: number) => {
    if (!ts) return "--:--:--";
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  };

  if (isMobile && minimized) {
    return (
      <div className="pointer-events-auto flex items-center justify-between gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 text-card-foreground shadow-xl backdrop-blur-md">
        <button
          type="button"
          onClick={onToggleMinimize}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="truncate text-xs font-semibold text-foreground">
            {track.title}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {(track.distance_m / 1000).toFixed(2)} km
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-emerald-400">
            +{Math.round(track.elev_gain_m)}m
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {onToggleMinimize && (
            <button
              type="button"
              onClick={onToggleMinimize}
              title="展开海拔曲线"
              aria-label="展开海拔曲线"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-foreground transition-colors hover:bg-accent"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onFitBounds}
            title="定位轨迹"
            aria-label="定位轨迹"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-foreground transition-colors hover:bg-accent"
          >
            <Compass className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="关闭图表"
            aria-label="关闭图表"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="pointer-events-auto rounded-xl border border-border bg-card/95 px-3 py-2.5 text-card-foreground shadow-xl backdrop-blur-md">
        {/* Row 1: Title + metrics + actions */}
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-semibold tracking-tight text-foreground">
              {track.title}
            </span>
            <span className="shrink-0 rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-secondary-foreground">
              {(track.distance_m / 1000).toFixed(1)}km
            </span>
            <span className="shrink-0 rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-emerald-400">
              +{Math.round(track.elev_gain_m)}m
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {onToggleMinimize && (
              <button
                type="button"
                onClick={onToggleMinimize}
                title="收起曲线"
                aria-label="收起曲线"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onFitBounds}
              title="定位轨迹"
              aria-label="定位轨迹"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Compass className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onDownloadGpx}
              title="导出 GPX"
              aria-label="导出 GPX"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="关闭图表"
              aria-label="关闭图表"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Row 2: Live scrub readout + color mode switcher */}
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="min-w-0 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
            {hoverSample ? (
              <span className="text-foreground">
                {hoverSample.distKm.toFixed(2)}km · {hoverSample.eleM.toFixed(0)}m ·{" "}
                {hoverSample.speedKmh.toFixed(1)}km/h ·{" "}
                {formatTime(hoverSample.timestamp)}
              </span>
            ) : (
              <span>滑动下方曲线查看轨迹点</span>
            )}
          </div>

          <div className="inline-flex shrink-0 items-center rounded-md bg-muted p-0.5 text-[11px]">
            {(["speed", "elevation", "track"] as TrackColorMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onChangeColorMode(m)}
                className={`rounded-sm px-2 py-0.5 font-medium transition-colors ${
                  colorMode === m
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "speed" ? "速度" : m === "elevation" ? "海拔" : "纯色"}
              </button>
            ))}
          </div>
        </div>

        {/* Plot canvas */}
        <div ref={plotContainerRef} className="relative h-20 w-full">
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onPointerLeave={handlePointerLeave}
            className="h-full w-full touch-none cursor-crosshair"
          />
          <div className="pointer-events-none absolute left-10 top-0.5 flex gap-2.5 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400" />
              海拔
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
              速度
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-auto rounded-lg border border-border bg-card/95 px-4 py-3 text-card-foreground shadow-xl backdrop-blur-md">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tracking-tight text-foreground">
            {track.title}
          </span>
          <span className="inline-flex items-center rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-xs font-medium tabular-nums text-secondary-foreground">
            {(track.distance_m / 1000).toFixed(2)} km
          </span>
          <span className="inline-flex items-center rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-xs font-medium tabular-nums text-emerald-400">
            +{Math.round(track.elev_gain_m)} m
          </span>
          <span className="hidden font-mono text-xs tabular-nums text-muted-foreground sm:inline">
            {track.point_count.toLocaleString()} pts
          </span>
          {hoverSample && (
            <span className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs tabular-nums text-foreground">
              {hoverSample.distKm.toFixed(2)} km · {hoverSample.eleM.toFixed(0)} m ·{" "}
              {hoverSample.speedKmh.toFixed(1)} km/h ·{" "}
              {formatTime(hoverSample.timestamp)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <div className="inline-flex items-center rounded-md bg-muted p-0.5 text-xs">
            <Palette className="ml-1.5 mr-1 h-3.5 w-3.5 text-muted-foreground" />
            {(["speed", "elevation", "track"] as TrackColorMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onChangeColorMode(m)}
                className={`rounded-sm px-2 py-1 text-[11px] font-medium transition-colors ${
                  colorMode === m
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "speed" ? "速度" : m === "elevation" ? "海拔" : "纯色"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onFitBounds}
            title="定位轨迹"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Compass className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="hidden sm:inline">定位</span>
          </button>
          <button
            type="button"
            onClick={onDownloadGpx}
            title="导出 GPX"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="hidden sm:inline">GPX</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            title="关闭图表"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div ref={plotContainerRef} className="relative h-28 w-full">
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onPointerLeave={handlePointerLeave}
          className="h-full w-full touch-none cursor-crosshair"
        />
        <div className="pointer-events-none absolute left-12 top-0.5 flex gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-cyan-400" />
            海拔 (m)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
            速度 (km/h)
          </span>
        </div>
      </div>
    </div>
  );
};
