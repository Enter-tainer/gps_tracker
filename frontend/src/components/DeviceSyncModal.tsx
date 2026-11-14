import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bluetooth,
  CloudUpload,
  Download,
  Eye,
  FileDown,
  Folder,
  FolderOpen,
  Key,
  Map as MapIcon,
  Power,
  RefreshCw,
  Satellite,
  Terminal,
  Timer,
  Trash2,
  Upload,
  X
} from "lucide-react";

import { ENTRY_TYPE } from "../constants.ts";
import { useLogger } from "../hooks/useLogger.ts";
import { processAGNSSData } from "../modules/agnss/CasicAgnssProcessor.ts";
import { createBleService } from "../services/bleService.ts";
import {
  cloneFogPack,
  runBrowserTrackEtl,
  uploadPreparedTrackToServer
} from "../services/clientEtl.ts";
import { createFileService } from "../services/fileService.ts";
import {
  exportKeysAsJson,
  generateFindMyKeys,
  unpackKeys
} from "../services/findmyKeyGen.ts";
import type { FindMyKeyBundle } from "../services/findmyKeyGen.ts";
import { createGpsDecoder } from "../services/gpsDecoder.ts";
import { createGpxConverter } from "../services/gpxConverter.ts";
import type { FileEntry, SysInfo } from "../types/ble.ts";
import type { FogPackData, GpsPoint, TrackMetadata } from "../types/track.ts";
import { formatFileSize } from "../utils/helpers.ts";

type DeviceSyncModalProps = {
  isOpen: boolean;
  onClose: () => void;
  fogPack: FogPackData | null;
  ensureFogPack: () => Promise<FogPackData>;
  onTrackUploaded: (
    track: TrackMetadata,
    points: GpsPoint[],
    updatedFogPack: FogPackData
  ) => void;
  onPreviewLocalTrack: (name: string, points: GpsPoint[]) => void;
};

type ModalTab = "upload" | "ble" | "findmy" | "logs";
type DisplayEntry = FileEntry & { isParent?: boolean };

const gpsStateLabels = [
  "Initializing",
  "Searching",
  "Off",
  "Fixed",
  "Static",
  "Transferring AGNSS"
];

const getParentPath = (p: string) => {
  if (p === "/") return "/";
  const normalized = p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  return normalized.slice(0, idx);
};

const formatSysInfo = (info: SysInfo | null) => {
  if (!info) {
    return {
      latitude: "-",
      longitude: "-",
      altitude: "-",
      satellites: "-",
      hdop: "-",
      speed: "-",
      course: "-",
      date: "-",
      time: "-",
      locationValid: "-",
      dateTimeValid: "-",
      battery: "-",
      gpsState: "-",
      temperature: "-",
      pressure: "-",
      motion: "-"
    };
  }
  const yesNo = (value: number) => (value ? "Yes" : "No");
  const date = `${info.year}-${String(info.month).padStart(2, "0")}-${String(info.day).padStart(2, "0")}`;
  const time = `${String(info.hour).padStart(2, "0")}:${String(info.minute).padStart(2, "0")}:${String(
    info.second
  ).padStart(2, "0")}`;
  const battery =
    info.batteryPercent !== undefined
      ? `${info.batteryPercent}% (${info.batteryVoltage.toFixed(2)}V)`
      : `${info.batteryVoltage.toFixed(2)} V`;
  const temperature =
    info.temperatureC !== undefined && !Number.isNaN(info.temperatureC)
      ? `${info.temperatureC.toFixed(1)} °C`
      : "-";
  const pressure =
    info.pressurePa !== undefined && !Number.isNaN(info.pressurePa)
      ? `${(info.pressurePa / 100).toFixed(2)} hPa`
      : "-";
  const motion =
    info.isStationary !== undefined
      ? info.isStationary
        ? "Stationary"
        : "Moving"
      : "-";

  return {
    latitude: `${info.latitude.toFixed(7)}°`,
    longitude: `${info.longitude.toFixed(7)}°`,
    altitude: `${info.altitude.toFixed(1)} m`,
    satellites: `${info.satellites}`,
    hdop: info.hdop.toFixed(2),
    speed: `${info.speed.toFixed(2)} km/h`,
    course: `${info.course.toFixed(2)}°`,
    date,
    time,
    locationValid: yesNo(info.locationValid),
    dateTimeValid: yesNo(info.dateTimeValid),
    battery,
    gpsState: gpsStateLabels[info.gpsState] ?? `${info.gpsState}`,
    temperature,
    pressure,
    motion
  };
};

export const DeviceSyncModal: React.FC<DeviceSyncModalProps> = ({
  isOpen,
  onClose,
  fogPack,
  ensureFogPack,
  onTrackUploaded,
  onPreviewLocalTrack
}) => {
  const [activeTab, setActiveTab] = useState<ModalTab>("upload");
  const { entries: logEntries, logger, clear: clearLogs } = useLogger(120);
  const bleServiceRef = useRef<ReturnType<typeof createBleService> | null>(null);
  const fileServiceRef = useRef<ReturnType<typeof createFileService> | null>(null);

  // Upload state
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<
    Array<{ name: string; status: string; ok?: boolean }>
  >([]);
  const [isUploading, setIsUploading] = useState(false);

  // BLE state
  const [isBluetoothSupported, setIsBluetoothSupported] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [mtuSize, setMtuSize] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState("Disconnected");
  const [isConnecting, setIsConnecting] = useState(false);
  const [agnssStatus, setAgnssStatus] = useState<string | null>(null);
  const [isAgnssBusy, setIsAgnssBusy] = useState(false);
  const [sysInfo, setSysInfo] = useState<SysInfo | null>(null);
  const [sysInfoError, setSysInfoError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("/");
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [isListing, setIsListing] = useState(false);
  const [activeFileAction, setActiveFileAction] = useState<string | null>(null);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [keepAliveMinutes, setKeepAliveMinutes] = useState(30);

  // FindMy state
  const [findMyKeys, setFindMyKeys] = useState<FindMyKeyBundle | null>(null);
  const [findMyEnabled, setFindMyEnabled] = useState<boolean | null>(null);
  const [findMyBusy, setFindMyBusy] = useState(false);

  const getReadyStatus = useCallback(() => {
    const connected = bleServiceRef.current?.isConnected() ?? false;
    if (!connected) return "Disconnected";
    return `Connected to ${deviceName ?? "device"}`;
  }, [deviceName]);

  const resetStatus = useCallback(
    (delay = 0) => {
      if (delay <= 0) {
        setStatusMessage(getReadyStatus());
        return;
      }
      window.setTimeout(() => {
        setStatusMessage(getReadyStatus());
      }, delay);
    },
    [getReadyStatus]
  );

  useEffect(() => {
    const supported =
      typeof navigator !== "undefined" &&
      "bluetooth" in navigator &&
      !!(navigator as Navigator & { bluetooth?: unknown }).bluetooth;
    setIsBluetoothSupported(supported);
    if (!supported) {
      setStatusMessage("Web Bluetooth is not supported in this browser.");
    }

    const bleService = createBleService(logger);
    bleService.onConnectionChanged((connected, name) => {
      setIsConnected(connected);
      setDeviceName(name ?? null);
      setMtuSize(connected ? bleService.getMtuSize() : null);
      setStatusMessage(connected ? `Connected to ${name ?? "device"}` : "Disconnected");
      if (!connected) {
        setSysInfo(null);
        setFileEntries([]);
        setCurrentPath("/");
      }
    });
    bleServiceRef.current = bleService;

    fileServiceRef.current = createFileService(bleService, logger, {
      onStatus: setStatusMessage
    });

    return () => {
      if (bleService.isConnected()) {
        bleService.disconnect();
      }
    };
  }, [logger]);

  const handleUploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) =>
        /\.(gpx|gpz)$/i.test(f.name)
      );
      if (list.length === 0) {
        logger.error("请选择 .gpx 或 .gpz 文件");
        return;
      }

      setIsUploading(true);
      setUploadQueue(
        list.map((f) => ({ name: f.name, status: "等待浏览器 ETL..." }))
      );

      let workingPack = fogPack ? cloneFogPack(fogPack) : await ensureFogPack();

      const setItemStatus = (idx: number, status: string, ok?: boolean) => {
        setUploadQueue((prev) =>
          prev.map((item, i) => (i === idx ? { ...item, status, ok } : item))
        );
      };

      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        try {
          const isFinal = i === list.length - 1;
          const etl = await runBrowserTrackEtl({
            file: f,
            baseFogPack: workingPack,
            encodeFogBinary: isFinal,
            onStage: (stage) => setItemStatus(i, stage)
          });

          setItemStatus(
            i,
            isFinal
              ? `上传预计算 GPZ (${(etl.gpzBytes.byteLength / 1024).toFixed(1)} KB) + 迷雾...`
              : `上传预计算 GPZ (${(etl.gpzBytes.byteLength / 1024).toFixed(1)} KB) + ${etl.tiles.length} 个空间瓦片...`
          );

          const savedTrack = await uploadPreparedTrackToServer({
            track: etl.track,
            gpzBytes: etl.gpzBytes,
            tiles: etl.tiles,
            fogBytes: etl.fogBytes
          });

          workingPack = etl.fogPack;
          onTrackUploaded(savedTrack, etl.points, etl.fogPack);
          logger.success(
            `浏览器 ETL 入库成功: ${f.name} (${savedTrack.point_count} 点 · ${(etl.gpzBytes.byteLength / 1024).toFixed(1)} KB GPZ · ${etl.tiles.length} 瓦片)`
          );
          setItemStatus(
            i,
            `成功 · ${(savedTrack.distance_m / 1000).toFixed(1)} km (${savedTrack.point_count} 点 · ${(etl.gpzBytes.byteLength / 1024).toFixed(1)} KB GPZ)`,
            true
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`入库失败 ${f.name}: ${msg}`);
          setItemStatus(i, `失败: ${msg}`, false);
        }
      }
      setIsUploading(false);
    },
    [ensureFogPack, fogPack, logger, onTrackUploaded]
  );

  const listDirectory = useCallback(
    async (targetPath: string) => {
      const fileService = fileServiceRef.current;
      if (!fileService) return;

      setIsListing(true);
      setStatusMessage(`Listing directory: ${targetPath}`);
      setFileEntries([]);
      setCurrentPath(targetPath);

      try {
        await fileService.listDirectory(
          targetPath,
          (name, type, size, entryPath) => {
            setFileEntries((prev) => [
              ...prev,
              {
                name,
                type:
                  type === ENTRY_TYPE.DIRECTORY
                    ? ENTRY_TYPE.DIRECTORY
                    : ENTRY_TYPE.FILE,
                size,
                path: entryPath
              }
            ]);
          },
          () => setFileEntries([])
        );
        logger.success(`Directory listed: ${targetPath}`);
      } catch (error) {
        logger.error(`Error listing directory: ${error}`);
      } finally {
        setIsListing(false);
        resetStatus(1200);
      }
    },
    [logger, resetStatus]
  );

  useEffect(() => {
    if (isConnected) {
      const timer = setTimeout(() => {
        listDirectory("/");
      }, 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isConnected, listDirectory]);

  const displayEntries = useMemo<DisplayEntry[]>(() => {
    if (currentPath === "/") return fileEntries;
    return [
      {
        name: "..",
        type: ENTRY_TYPE.DIRECTORY,
        size: null,
        path: getParentPath(currentPath),
        isParent: true
      },
      ...fileEntries
    ];
  }, [currentPath, fileEntries]);

  const handleConnect = useCallback(async () => {
    if (!isBluetoothSupported) return;
    const bleService = bleServiceRef.current;
    if (!bleService) return;
    setIsConnecting(true);
    setSysInfoError(null);
    try {
      if (bleService.isConnected()) {
        bleService.disconnect();
        return;
      }
      setStatusMessage("Connecting...");
      const success = await bleService.connect();
      if (!success) setStatusMessage("Connection failed.");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setStatusMessage("Connection failed.");
      logger.error(`Connection failed: ${msg}`);
    } finally {
      setIsConnecting(false);
    }
  }, [isBluetoothSupported, logger]);

  const handleQueryStatus = useCallback(async () => {
    const bleService = bleServiceRef.current;
    if (!bleService) return;
    setSysInfoError(null);
    setStatusMessage("Querying status...");
    try {
      const info = await bleService.getSysInfo();
      setSysInfo(info);
      logger.success("System info updated.");
      resetStatus(1200);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setSysInfo(null);
      setSysInfoError(msg);
      logger.error(`System info query failed: ${msg}`);
      resetStatus(1600);
    }
  }, [logger, resetStatus]);

  const handleGpsWakeup = useCallback(async () => {
    const bleService = bleServiceRef.current;
    if (!bleService) return;
    setStatusMessage("Triggering GPS wakeup...");
    try {
      await bleService.triggerGpsWakeup();
      logger.success("GPS wakeup command sent.");
      resetStatus(1200);
    } catch (error) {
      logger.error(`GPS wakeup failed: ${error}`);
      resetStatus(1600);
    }
  }, [logger, resetStatus]);

  const keepAliveRemainingS = sysInfo?.keepAliveRemainingS ?? 0;
  const isKeepAliveActive = keepAliveRemainingS > 0;
  const keepAliveRemainingText = isKeepAliveActive
    ? `${Math.floor(keepAliveRemainingS / 60)}:${(keepAliveRemainingS % 60).toString().padStart(2, "0")}`
    : null;

  const handleKeepAlive = useCallback(async () => {
    const bleService = bleServiceRef.current;
    if (!bleService) return;
    const minutes = isKeepAliveActive ? 0 : keepAliveMinutes;
    try {
      await bleService.setGpsKeepAlive(minutes);
      logger.success(
        minutes > 0
          ? `GPS keep-alive set for ${minutes} min.`
          : "GPS keep-alive cancelled."
      );
      resetStatus(1600);
    } catch (error) {
      logger.error(`GPS keep-alive failed: ${error}`);
      resetStatus(1600);
    }
  }, [isKeepAliveActive, keepAliveMinutes, logger, resetStatus]);

  const handleAgnss = useCallback(async () => {
    const bleService = bleServiceRef.current;
    if (!bleService || !bleService.isConnected()) return;
    setIsAgnssBusy(true);
    setAgnssStatus("Downloading ephemeris...");
    try {
      const result = await processAGNSSData();
      if (!result || !Array.isArray(result) || result.length === 0) {
        throw new Error("No AGNSS data received.");
      }
      await bleService.startAgnssWrite();
      const maxChunkSize = Math.max(16, Math.min(128, bleService.getMtuSize() - 8));
      for (let i = 0; i < result.length; i++) {
        const chunkData = result[i];
        if (!(chunkData instanceof Uint8Array)) continue;
        setAgnssStatus(`Sending ${i + 1}/${result.length}...`);
        let offset = 0;
        while (offset < chunkData.length) {
          const slice = chunkData.slice(
            offset,
            Math.min(offset + maxChunkSize, chunkData.length)
          );
          await bleService.writeAgnssChunk(slice);
          offset += slice.length;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      await bleService.endAgnssWrite();
      setAgnssStatus("AGNSS transfer completed.");
      logger.success("AGNSS transfer completed.");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setAgnssStatus(`Failed: ${msg}`);
      logger.error(`AGNSS failed: ${msg}`);
    } finally {
      setIsAgnssBusy(false);
      setTimeout(() => setAgnssStatus(null), 5000);
      resetStatus(1600);
    }
  }, [logger, resetStatus]);

  const handleBleSyncToCloud = useCallback(
    async (entry: FileEntry) => {
      const fileService = fileServiceRef.current;
      if (!fileService) return;
      setActiveFileAction(entry.path);
      try {
        setStatusMessage(`Downloading ${entry.name} over BLE...`);
        const rawBuf = await fileService.downloadRawBuffer(
          entry.path,
          entry.name,
          entry.size
        );
        const fileName = entry.name.toLowerCase().endsWith(".gpz")
          ? entry.name
          : `${entry.name}.gpz`;
        const basePack = fogPack ? cloneFogPack(fogPack) : await ensureFogPack();
        const etl = await runBrowserTrackEtl({
          file: { name: fileName, buffer: rawBuf },
          baseFogPack: basePack,
          encodeFogBinary: true,
          onStage: (stage) => setStatusMessage(`${fileName}: ${stage}`)
        });
        setStatusMessage(`Uploading pre-computed ${fileName} to R2 & D1...`);
        const savedTrack = await uploadPreparedTrackToServer({
          track: etl.track,
          gpzBytes: etl.gpzBytes,
          tiles: etl.tiles,
          fogBytes: etl.fogBytes
        });
        onTrackUploaded(savedTrack, etl.points, etl.fogPack);
        logger.success(`Synced ${fileName} to Cloud R2 + D1!`);
        setStatusMessage(`Synced ${fileName}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Sync failed: ${msg}`);
        setStatusMessage(`Sync failed: ${msg}`);
      } finally {
        setActiveFileAction(null);
        resetStatus(1800);
      }
    },
    [ensureFogPack, fogPack, logger, onTrackUploaded, resetStatus]
  );

  const handleBlePreview = useCallback(
    async (entry: FileEntry) => {
      const fileService = fileServiceRef.current;
      if (!fileService) return;
      setActiveFileAction(entry.path);
      try {
        const rawBuf = await fileService.downloadRawBuffer(
          entry.path,
          entry.name,
          entry.size
        );
        const pts = createGpsDecoder().decode(rawBuf);
        if (pts.length > 0) {
          onPreviewLocalTrack(entry.name, pts);
          onClose();
        } else {
          logger.error(`No points found in ${entry.name}`);
        }
      } catch (err) {
        logger.error(`Preview failed: ${err}`);
      } finally {
        setActiveFileAction(null);
        resetStatus(1200);
      }
    },
    [logger, onClose, onPreviewLocalTrack, resetStatus]
  );

  const handleBleDownloadGpx = useCallback(
    async (entry: FileEntry) => {
      const fileService = fileServiceRef.current;
      if (!fileService) return;
      setActiveFileAction(entry.path);
      try {
        const rawBuf = await fileService.downloadRawBuffer(
          entry.path,
          entry.name,
          entry.size
        );
        const pts = createGpsDecoder().decode(rawBuf);
        const converter = createGpxConverter(logger);
        const gpx = converter.pointsToGpxString(pts, entry.name);
        if (gpx) converter.saveGpxFile(gpx, entry.name);
      } finally {
        setActiveFileAction(null);
        resetStatus(1200);
      }
    },
    [logger, resetStatus]
  );

  const handleBleDelete = useCallback(
    async (entry: FileEntry) => {
      const fileService = fileServiceRef.current;
      if (!fileService) return;
      setActiveFileAction(entry.path);
      try {
        await fileService.deleteFile(entry.path);
        setConfirmDeletePath(null);
        logger.success(`Deleted ${entry.name}`);
        await listDirectory(currentPath);
      } catch (err) {
        logger.error(`Delete failed: ${err}`);
      } finally {
        setActiveFileAction(null);
        resetStatus(1200);
      }
    },
    [currentPath, listDirectory, logger, resetStatus]
  );

  // FindMy handlers
  const handleFindMyGenerate = () => {
    setFindMyKeys(generateFindMyKeys());
    logger.success("FindMy keys generated.");
  };
  const handleFindMyProvision = async () => {
    const ble = bleServiceRef.current;
    if (!ble || !findMyKeys) return;
    setFindMyBusy(true);
    try {
      const res = await ble.writeFindMyKeys(findMyKeys.packed);
      if (res.success) {
        setFindMyEnabled(true);
        logger.success("FindMy keys written to device.");
      } else {
        logger.error("Device rejected FindMy keys.");
      }
    } finally {
      setFindMyBusy(false);
    }
  };
  const handleFindMyDump = async () => {
    const ble = bleServiceRef.current;
    if (!ble) return;
    setFindMyBusy(true);
    try {
      const res = await ble.readFindMyKeys();
      if (res.success && res.keys) {
        const bundle = unpackKeys(res.keys);
        if (bundle) {
          setFindMyKeys(bundle);
          logger.success("FindMy keys read from device.");
        }
      }
    } finally {
      setFindMyBusy(false);
    }
  };
  const handleFindMyStatus = async () => {
    const ble = bleServiceRef.current;
    if (!ble) return;
    const res = await ble.getFindMyStatus();
    setFindMyEnabled(res.enabled);
    logger.log(`FindMy status: ${res.enabled ? "enabled" : "disabled"}`);
  };
  const handleFindMyExport = () => {
    if (!findMyKeys) return;
    const json = exportKeysAsJson(findMyKeys);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `findmy-keys-${findMyKeys.epoch}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  const info = useMemo(() => formatSysInfo(sysInfo), [sysInfo]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted text-foreground">
              <Bluetooth className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold tracking-tight text-foreground">
                设备同步与轨迹入库中心
              </h2>
              <p className="text-xs text-muted-foreground">
                状态: {statusMessage} {mtuSize ? `· MTU ${mtuSize}` : ""}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-border bg-muted/30 px-5 py-2">
          <div className="inline-flex items-center rounded-md bg-muted p-1">
            {(
              [
                ["upload", "轨迹上传入库", Upload],
                ["ble", "蓝牙设备 & SD 卡", Bluetooth],
                ["findmy", "Find My 密钥", Key],
                ["logs", `运行日志 (${logEntries.length})`, Terminal]
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
                  activeTab === id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 scrollbar-thin">
          {activeTab === "upload" && (
            <div className="space-y-4">
              <div
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragOver(false);
                  if (e.dataTransfer.files.length > 0) {
                    handleUploadFiles(e.dataTransfer.files);
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setIsDragOver(false);
                }}
                className={`flex flex-col items-center justify-center rounded-lg border border-dashed p-10 text-center transition-colors ${
                  isDragOver
                    ? "border-foreground bg-accent/60"
                    : "border-border bg-muted/20 hover:border-muted-foreground/60"
                }`}
              >
                <CloudUpload className="mb-3 h-9 w-9 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">
                  拖拽一个或多个 <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.gpx</code> /{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.gpz</code> 文件到此处
                </p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  浏览器端闭环 ETL：解析 XML → GPZ V2 压缩 → 光栅化 Z15/Z21 迷雾位图，Worker 零计算纯 I/O 落盘 R2 & D1
                </p>
                <label className="mt-4 inline-flex h-8 cursor-pointer items-center rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90">
                  {isUploading ? "正在处理..." : "选择本地文件"}
                  <input
                    type="file"
                    multiple
                    accept=".gpx,.gpz"
                    disabled={isUploading}
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleUploadFiles(e.target.files);
                      }
                      e.target.value = "";
                    }}
                    className="hidden"
                  />
                </label>
              </div>

              {uploadQueue.length > 0 && (
                <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                  <div className="text-xs font-medium text-foreground">
                    入库队列
                  </div>
                  {uploadQueue.map((item, idx) => (
                    <div
                      key={`${item.name}-${idx}`}
                      className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-xs"
                    >
                      <span className="font-mono text-foreground">
                        {item.name}
                      </span>
                      <span
                        className={
                          item.ok === true
                            ? "text-emerald-400"
                            : item.ok === false
                              ? "text-red-400"
                              : "text-muted-foreground"
                        }
                      >
                        {item.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "ble" && (
            <div className="space-y-5">
              {!isBluetoothSupported && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/15 p-3 text-xs text-red-300">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                  <span>
                    当前浏览器不支持 Web Bluetooth，请使用桌面/Android 版 Chrome 或 Edge。
                  </span>
                </div>
              )}

              {/* Connection & Commands */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={!isBluetoothSupported || isConnecting}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  <Power className="h-3.5 w-3.5" />
                  {isConnected ? "断开连接" : "连接设备"}
                </button>
                <button
                  type="button"
                  onClick={handleQueryStatus}
                  disabled={!isConnected}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
                >
                  <Activity className="h-3.5 w-3.5" />
                  查询状态
                </button>
                <button
                  type="button"
                  onClick={handleAgnss}
                  disabled={!isConnected || isAgnssBusy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
                >
                  <Satellite className="h-3.5 w-3.5" />
                  同步 A-GNSS 星历
                </button>
                <button
                  type="button"
                  onClick={handleGpsWakeup}
                  disabled={!isConnected}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  唤醒 GPS
                </button>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    max={720}
                    value={keepAliveMinutes}
                    disabled={!isConnected || isKeepAliveActive}
                    onChange={(e) =>
                      setKeepAliveMinutes(
                        Math.max(1, Math.min(720, Number(e.target.value) || 1))
                      )
                    }
                    className="w-16 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-center text-xs text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={handleKeepAlive}
                    disabled={!isConnected}
                    className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs disabled:opacity-40 ${
                      isKeepAliveActive
                        ? "border-rose-500/60 bg-rose-500/20 text-rose-200"
                        : "border-slate-700 bg-slate-800 text-slate-200"
                    }`}
                  >
                    <Timer className="h-3.5 w-3.5" />
                    {isKeepAliveActive
                      ? `取消保活 (${keepAliveRemainingText})`
                      : "GPS 保活(分)"}
                  </button>
                </div>
              </div>

              {agnssStatus && (
                <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
                  AGNSS: {agnssStatus}
                </div>
              )}
              {sysInfoError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                  {sysInfoError}
                </div>
              )}

              {/* System Snapshot */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["纬度", info.latitude],
                  ["经度", info.longitude],
                  ["海拔", info.altitude],
                  ["卫星 / HDOP", `${info.satellites} / ${info.hdop}`],
                  ["速度", info.speed],
                  ["电量", info.battery],
                  ["GPS 状态", info.gpsState],
                  ["温压", `${info.temperature} · ${info.pressure}`]
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"
                  >
                    <div className="text-[10px] text-slate-400">{label}</div>
                    <div className="mt-0.5 font-mono text-xs text-slate-100">
                      {value}
                    </div>
                  </div>
                ))}
              </div>

              {/* SD Card File Browser */}
              <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <FolderOpen className="h-4 w-4 text-cyan-400" />
                    <span>SD 卡文件系统 ({currentPath})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => listDirectory(currentPath)}
                    disabled={!isConnected || isListing}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 disabled:opacity-40"
                  >
                    <RefreshCw className="h-3 w-3" />
                    {isListing ? "刷新中..." : "刷新目录"}
                  </button>
                </div>

                <div className="max-h-60 space-y-1.5 overflow-y-auto scrollbar-thin">
                  {displayEntries.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-500">
                      {isConnected ? "当前目录为空" : "连接蓝牙设备后可浏览 SD 卡轨迹"}
                    </div>
                  ) : (
                    displayEntries.map((entry) => {
                      const isDir = entry.type === ENTRY_TYPE.DIRECTORY;
                      const isBusy = activeFileAction === entry.path;
                      return (
                        <div
                          key={entry.path}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/75 px-3 py-2"
                        >
                          <div className="flex items-center gap-2">
                            {isDir ? (
                              <Folder className="h-4 w-4 text-amber-400" />
                            ) : (
                              <FileDown className="h-4 w-4 text-slate-400" />
                            )}
                            <button
                              type="button"
                              disabled={!isDir}
                              onClick={() => isDir && listDirectory(entry.path)}
                              className={`text-xs font-medium ${
                                isDir
                                  ? "text-amber-300 hover:underline"
                                  : "text-slate-100"
                              }`}
                            >
                              {entry.name}
                            </button>
                            {!isDir && (
                              <span className="font-mono text-[10px] text-slate-400">
                                {formatFileSize(entry.size)}
                              </span>
                            )}
                          </div>

                          {!isDir && (
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleBleSyncToCloud(entry)}
                                className="inline-flex items-center gap-1 rounded-md bg-cyan-500/20 px-2 py-1 text-[11px] font-medium text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-40"
                              >
                                <CloudUpload className="h-3 w-3" />
                                入库
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleBlePreview(entry)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                              >
                                <Eye className="h-3 w-3" />
                                预览
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleBleDownloadGpx(entry)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                              >
                                <MapIcon className="h-3 w-3" />
                                GPX
                              </button>
                              {confirmDeletePath === entry.path ? (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleBleDelete(entry)}
                                  className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-[11px] text-white"
                                >
                                  确认删除
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => setConfirmDeletePath(entry.path)}
                                  className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20 disabled:opacity-40"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === "findmy" && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleFindMyGenerate}
                  disabled={findMyBusy}
                  className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700"
                >
                  生成密钥
                </button>
                <button
                  type="button"
                  onClick={handleFindMyProvision}
                  disabled={!isConnected || !findMyKeys || findMyBusy}
                  className="rounded-xl bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-40"
                >
                  写入设备
                </button>
                <button
                  type="button"
                  onClick={handleFindMyDump}
                  disabled={!isConnected || findMyBusy}
                  className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs text-slate-100 disabled:opacity-40"
                >
                  读取设备密钥
                </button>
                <button
                  type="button"
                  onClick={handleFindMyStatus}
                  disabled={!isConnected || findMyBusy}
                  className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs text-slate-100 disabled:opacity-40"
                >
                  查询广播状态
                </button>
              </div>
              {findMyEnabled !== null && (
                <div className="text-xs text-slate-300">
                  状态:{" "}
                  <span
                    className={
                      findMyEnabled ? "text-emerald-400" : "text-slate-400"
                    }
                  >
                    {findMyEnabled ? "FindMy Active" : "FindMy Inactive"}
                  </span>
                </div>
              )}
              {findMyKeys && (
                <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/70 p-3 font-mono text-xs text-slate-300">
                  <div>
                    Epoch: {new Date(findMyKeys.epoch * 1000).toISOString()}
                  </div>
                  <div className="break-all">
                    PubKey (x):{" "}
                    {Array.from(findMyKeys.publicKey.slice(1, 29))
                      .map((b) => b.toString(16).padStart(2, "0"))
                      .join("")}
                  </div>
                  <button
                    type="button"
                    onClick={handleFindMyExport}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-700"
                  >
                    <Download className="h-3.5 w-3.5" />
                    导出 JSON 备份
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === "logs" && (
            <div className="space-y-2">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={clearLogs}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
                >
                  清空日志
                </button>
              </div>
              <div className="max-h-80 space-y-1.5 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/80 p-3 font-mono text-xs scrollbar-thin">
                {logEntries.length === 0 ? (
                  <div className="text-slate-500">暂无日志</div>
                ) : (
                  logEntries.map((entry) => (
                    <div key={entry.id} className="flex gap-2">
                      <span className="text-slate-500">[{entry.time}]</span>
                      <span
                        className={
                          entry.level === "error"
                            ? "text-rose-400"
                            : entry.level === "success"
                              ? "text-emerald-400"
                              : "text-slate-200"
                        }
                      >
                        {entry.message}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
