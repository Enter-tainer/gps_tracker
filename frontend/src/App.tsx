import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bluetooth,
  Download,
  Eye,
  FileDown,
  Folder,
  FolderOpen,
  Map,
  Power,
  RefreshCw,
  Satellite,
  Terminal,
  Trash2,
  Upload
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "./components/ui/alert-dialog";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { ENTRY_TYPE } from "./constants";
import { useLogger } from "./hooks/useLogger";
import { processAGNSSData } from "./modules/agnss/CasicAgnssProcessor";
import { createBleService } from "./services/bleService";
import { createFileService } from "./services/fileService";
import { createGpsDecoder } from "./services/gpsDecoder";
import { createGpxConverter } from "./services/gpxConverter";
import type { FileEntry, SysInfo } from "./types/ble";
import { formatFileSize } from "./utils/helpers";

const gpsStateLabels = [
  "Initializing",
  "Searching",
  "Off",
  "Fixed",
  "Static",
  "Transferring AGNSS"
];

type GpxViewerElement = HTMLElement & { setGpx?: (gpxString: string) => void };

type DisplayEntry = FileEntry & { isParent?: boolean };

const getParentPath = (path: string) => {
  if (path === "/") return "/";
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
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
      batteryVoltage: "-",
      gpsState: "-"
    };
  }

  const yesNo = (value: number) => (value ? "Yes" : "No");
  const date = `${info.year}-${String(info.month).padStart(2, "0")}-${String(info.day).padStart(2, "0")}`;
  const time = `${String(info.hour).padStart(2, "0")}:${String(info.minute).padStart(2, "0")}:${String(
    info.second
  ).padStart(2, "0")}`;

  return {
    latitude: `${info.latitude.toFixed(7)} deg`,
    longitude: `${info.longitude.toFixed(7)} deg`,
    altitude: `${info.altitude.toFixed(1)} m`,
    satellites: `${info.satellites}`,
    hdop: info.hdop.toFixed(2),
    speed: `${info.speed.toFixed(2)} km/h`,
    course: `${info.course.toFixed(2)} deg`,
    date,
    time,
    locationValid: yesNo(info.locationValid),
    dateTimeValid: yesNo(info.dateTimeValid),
    batteryVoltage: `${info.batteryVoltage.toFixed(2)} V`,
    gpsState: gpsStateLabels[info.gpsState] ?? `${info.gpsState}`
  };
};

export default function App() {
  const { entries: logEntries, logger, clear: clearLogs } = useLogger(120);
  const bleServiceRef = useRef<ReturnType<typeof createBleService> | null>(null);
  const fileServiceRef = useRef<ReturnType<typeof createFileService> | null>(null);
  const gpxViewerRef = useRef<GpxViewerElement | null>(null);

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
  const [gpxFileName, setGpxFileName] = useState<string | null>(null);
  const [localGpxString, setLocalGpxString] = useState<string | null>(null);
  const [localFileName, setLocalFileName] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const getReadyStatus = useCallback(() => {
    const connected = bleServiceRef.current?.isConnected() ?? false;
    if (!connected) {
      return "Disconnected";
    }
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

  const handlePreview = useCallback(
    (gpxString: string, fileName: string) => {
      const viewer = gpxViewerRef.current;
      if (!viewer || typeof viewer.setGpx !== "function") {
        logger.error("GPX viewer is not ready.");
        return;
      }

      viewer.setGpx(gpxString);
      setGpxFileName(fileName);
      logger.success(`GPX loaded in viewer: ${fileName}`);
    },
    [logger]
  );

  const handleLocalFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".gpz")) {
        logger.error("Only .gpz files are supported.");
        return;
      }

      logger.log(`Processing local file: ${file.name}`);
      setStatusMessage(`Converting ${file.name}...`);

      try {
        const arrayBuffer = await file.arrayBuffer();
        const decoder = createGpsDecoder();
        const points = decoder.decode(arrayBuffer);

        if (points.length === 0) {
          logger.error("No GPS points found in file.");
          setStatusMessage("No GPS points found.");
          return;
        }

        const converter = createGpxConverter(logger, handlePreview);
        const gpxString = converter.pointsToGpxString(points, file.name);

        if (!gpxString) {
          logger.error("Failed to convert to GPX.");
          setStatusMessage("Conversion failed.");
          return;
        }

        setLocalGpxString(gpxString);
        setLocalFileName(file.name.replace(/\.gpz$/i, ".gpx"));

        // Preview immediately
        handlePreview(gpxString, file.name);
        logger.success(`Converted ${points.length} points from ${file.name}`);
        setStatusMessage(`Converted ${points.length} points.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to process file: ${message}`);
        setStatusMessage("File processing failed.");
      }
    },
    [logger, handlePreview]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        handleLocalFile(files[0]);
      }
    },
    [handleLocalFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        handleLocalFile(files[0]);
      }
      e.target.value = "";
    },
    [handleLocalFile]
  );

  const handleDownloadLocalGpx = useCallback(() => {
    if (!localGpxString || !localFileName) return;

    const blob = new Blob([localGpxString], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = localFileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    logger.success(`Downloaded: ${localFileName}`);
  }, [localGpxString, localFileName, logger]);

  useEffect(() => {
    const supported = typeof navigator !== "undefined" && !!navigator.bluetooth;
    setIsBluetoothSupported(supported);
    if (!supported) {
      setStatusMessage("Web Bluetooth is not supported in this browser.");
      logger.error("Web Bluetooth API is not available.");
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
      onStatus: setStatusMessage,
      onPreview: handlePreview
    });

    return () => {
      if (bleService.isConnected()) {
        bleService.disconnect();
      }
    };
  }, [logger, handlePreview]);

  const listDirectory = useCallback(
    async (path: string) => {
      const fileService = fileServiceRef.current;
      if (!fileService) return;

      setIsListing(true);
      setStatusMessage(`Listing directory: ${path}`);
      setFileEntries([]);
      setCurrentPath(path);

      try {
        await fileService.listDirectory(
          path,
          (name, type, size, entryPath) => {
            setFileEntries((prev) => [
              ...prev,
              {
                name,
                type: type === ENTRY_TYPE.DIRECTORY ? ENTRY_TYPE.DIRECTORY : ENTRY_TYPE.FILE,
                size,
                path: entryPath
              }
            ]);
          },
          () => {
            setFileEntries([]);
          }
        );
        logger.success(`Directory listed: ${path}`);
        setStatusMessage(`Directory listed: ${path}`);
      } catch (error) {
        logger.error(`Error listing directory: ${error}`);
        setStatusMessage("Directory listing failed.");
      } finally {
        setIsListing(false);
        resetStatus(1200);
      }
    },
    [logger]
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
    if (currentPath === "/") {
      return fileEntries;
    }

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

  const pathSegments = useMemo(() => {
    if (currentPath === "/") {
      return [{ label: "root", path: "/" }];
    }

    const segments = currentPath.split("/").filter(Boolean);
    const crumbs = [{ label: "root", path: "/" }];
    let current = "";

    segments.forEach((segment) => {
      current += `/${segment}`;
      crumbs.push({ label: segment, path: current });
    });

    return crumbs;
  }, [currentPath]);

  const handleConnect = useCallback(async () => {
    if (!isBluetoothSupported) {
      return;
    }

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
      if (!success) {
        setStatusMessage("Connection failed.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage("Connection failed.");
      logger.error(`Connection failed: ${message}`);
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
      setStatusMessage("System info updated.");
      resetStatus(1200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSysInfo(null);
      setSysInfoError(message);
      logger.error(`System info query failed: ${message}`);
      setStatusMessage("System info query failed.");
      resetStatus(1600);
    }
  }, [logger, resetStatus]);

  const handleGpsWakeup = useCallback(async () => {
    const bleService = bleServiceRef.current;
    if (!bleService) return;

    setStatusMessage("Triggering GPS wakeup...");
    try {
      await bleService.triggerGpsWakeup();
      setStatusMessage("GPS wakeup successful.");
      logger.success("GPS wakeup command sent.");
      resetStatus(1200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage("GPS wakeup failed.");
      logger.error(`GPS wakeup failed: ${message}`);
      resetStatus(1600);
    }
  }, [logger, resetStatus]);

  const handleAgnss = useCallback(async () => {
    const bleService = bleServiceRef.current;
    if (!bleService) return;

    if (!bleService.isConnected()) {
      logger.error("Cannot send AGNSS data: not connected.");
      return;
    }

    setIsAgnssBusy(true);
    setAgnssStatus("Downloading data...");
    setStatusMessage("AGNSS transfer in progress...");

    try {
      const result = await processAGNSSData();

      if (!result || !Array.isArray(result) || result.length === 0) {
        throw new Error("No AGNSS data received or invalid format.");
      }

      logger.log(`Received ${result.length} AGNSS data chunks.`);
      setAgnssStatus(`Downloaded ${result.length} chunks. Starting transfer...`);

      await bleService.startAgnssWrite();
      logger.log("AGNSS write session started.");

      const maxChunkSize = Math.max(16, Math.min(128, bleService.getMtuSize() - 8));
      logger.log(`Using max chunk size: ${maxChunkSize} bytes.`);

      let totalChunks = 0;
      let totalBytes = 0;

      for (let i = 0; i < result.length; i++) {
        const agnssData = result[i];
        if (!(agnssData instanceof Uint8Array)) {
          logger.error(`AGNSS data chunk ${i} is not Uint8Array, skipping.`);
          continue;
        }

        setAgnssStatus(`Sending chunk ${i + 1}/${result.length}...`);

        let offset = 0;
        while (offset < agnssData.length) {
          const chunkSize = Math.min(maxChunkSize, agnssData.length - offset);
          const chunk = agnssData.slice(offset, offset + chunkSize);

          await bleService.writeAgnssChunk(chunk);
          logger.log(`Sent AGNSS chunk ${totalChunks + 1}: ${chunkSize} bytes`);

          offset += chunkSize;
          totalChunks++;
          totalBytes += chunkSize;

          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      await bleService.endAgnssWrite();
      logger.success(`AGNSS transfer completed: ${totalChunks} chunks, ${totalBytes} bytes.`);
      setAgnssStatus(`Transfer completed (${totalChunks} chunks, ${totalBytes} bytes).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`AGNSS transfer failed: ${message}`);
      setAgnssStatus(`Transfer failed - ${message}`);
    } finally {
      setIsAgnssBusy(false);
      setTimeout(() => setAgnssStatus(null), 5000);
      resetStatus(1600);
    }
  }, [logger, resetStatus]);

  const handleDownloadRaw = useCallback(async (entry: FileEntry) => {
    const fileService = fileServiceRef.current;
    if (!fileService) return;

    setActiveFileAction(entry.path);
    try {
      await fileService.downloadFile(entry.path, entry.name, entry.size);
    } finally {
      setActiveFileAction(null);
      resetStatus(1200);
    }
  }, [resetStatus]);

  const handleDownloadGpx = useCallback(async (entry: FileEntry) => {
    const fileService = fileServiceRef.current;
    if (!fileService) return;

    setActiveFileAction(entry.path);
    try {
      await fileService.downloadAndConvertToGpx(entry.path, entry.name, entry.size, true);
    } finally {
      setActiveFileAction(null);
      resetStatus(1200);
    }
  }, [resetStatus]);

  const handlePreviewGpx = useCallback(async (entry: FileEntry) => {
    const fileService = fileServiceRef.current;
    if (!fileService) return;

    setActiveFileAction(entry.path);
    try {
      await fileService.downloadAndConvertToGpx(entry.path, entry.name, entry.size, false);
    } finally {
      setActiveFileAction(null);
      resetStatus(1200);
    }
  }, [resetStatus]);

  const handleDeleteFile = useCallback(
    async (entry: FileEntry) => {
      const fileService = fileServiceRef.current;
      if (!fileService) return;

      setActiveFileAction(entry.path);
      try {
        await fileService.deleteFile(entry.path);
        logger.success(`File deleted: ${entry.name}`);
        await listDirectory(currentPath);
      } catch (error) {
        logger.error(`Delete failed: ${error}`);
      } finally {
        setActiveFileAction(null);
        resetStatus(1200);
      }
    },
    [currentPath, listDirectory, logger, resetStatus]
  );

  const info = useMemo(() => formatSysInfo(sysInfo), [sysInfo]);

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-10 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <Badge variant="secondary" className="bg-white/70 text-foreground">
              Field Console
            </Badge>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              GPS Tracker Control Deck
            </h1>
            <p className="max-w-xl text-sm text-muted-foreground">
              Connect to your device, inspect telemetry, manage files, and render GPX tracks with a
              focused workflow.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={isConnected ? "default" : "muted"}>
              {isConnected ? "Connected" : "Disconnected"}
            </Badge>
            <Badge variant="outline">{deviceName ?? "No device"}</Badge>
            <Badge variant="outline">MTU {mtuSize ?? "--"}</Badge>
          </div>
        </header>

        {!isBluetoothSupported && (
          <Alert variant="destructive" className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Web Bluetooth not available</AlertTitle>
            <AlertDescription>
              Your browser does not support Web Bluetooth. Please use a compatible browser (Chrome
              or Edge) on desktop or Android.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="order-2 space-y-6 lg:order-1">
            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="animate-fade-up">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Activity className="h-5 w-5 text-primary" />
                    System Snapshot
                  </CardTitle>
                  <CardDescription>Live GNSS metrics reported by the tracker.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {[
                      ["Latitude", info.latitude],
                      ["Longitude", info.longitude],
                      ["Altitude", info.altitude],
                      ["Satellites", info.satellites],
                      ["HDOP", info.hdop],
                      ["Speed", info.speed],
                      ["Course", info.course],
                      ["Date", info.date],
                      ["Time", info.time],
                      ["Location Valid", info.locationValid],
                      ["Date/Time Valid", info.dateTimeValid],
                      ["Battery", info.batteryVoltage],
                      ["GPS State", info.gpsState]
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-md border border-border/70 bg-white/60 p-3">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {label}
                        </div>
                        <div className="mt-1 font-mono text-sm text-foreground">{value}</div>
                      </div>
                    ))}
                  </div>
                  {sysInfoError && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>System info error</AlertTitle>
                      <AlertDescription>{sysInfoError}</AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>

              <Card className="animate-fade-up">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FolderOpen className="h-5 w-5 text-primary" />
                    File System
                  </CardTitle>
                  <CardDescription>Browse device storage and manage raw or GPX exports.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-[240px] flex-1">
                      <Input value={currentPath} readOnly />
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => listDirectory(currentPath)}
                      disabled={!isConnected || isListing}
                    >
                      <RefreshCw className="h-4 w-4" />
                      {isListing ? "Listing..." : "List Directory"}
                    </Button>
                  </div>

                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {pathSegments.map((segment, idx) => (
                      <Button
                        key={`${segment.path}-${idx}`}
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2"
                        onClick={() => listDirectory(segment.path)}
                        disabled={!isConnected}
                      >
                        {segment.label}
                      </Button>
                    ))}
                  </div>

                  <div className="max-h-[420px] space-y-2 overflow-y-auto rounded-lg border border-border/70 bg-white/60 p-3 scrollbar-thin">
                    {displayEntries.length === 0 && (
                      <div className="text-sm text-muted-foreground">No files listed.</div>
                    )}
                    {displayEntries.map((entry) => {
                      const isDirectory = entry.type === ENTRY_TYPE.DIRECTORY;
                      const isBusy = activeFileAction === entry.path;

                      return (
                        <div
                          key={entry.path}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 bg-white/70 p-3"
                        >
                          <div className="flex items-center gap-3">
                            {isDirectory ? (
                              <Folder className="h-4 w-4 text-secondary" />
                            ) : (
                              <FileDown className="h-4 w-4 text-muted-foreground" />
                            )}
                            <button
                              type="button"
                              className={`text-left text-sm font-medium ${
                                isDirectory ? "text-secondary" : "text-foreground"
                              }`}
                              onClick={() => {
                                if (isDirectory) {
                                  listDirectory(entry.path);
                                }
                              }}
                              disabled={!isDirectory}
                            >
                              {entry.name}
                            </button>
                            {!isDirectory && (
                              <Badge variant="outline" className="font-mono text-xs">
                                {formatFileSize(entry.size)}
                              </Badge>
                            )}
                          </div>
                          {!isDirectory && (
                            <div className="flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleDownloadRaw(entry)}
                                disabled={isBusy}
                              >
                                <FileDown className="h-4 w-4" />
                                Raw
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleDownloadGpx(entry)}
                                disabled={isBusy}
                              >
                                <Map className="h-4 w-4" />
                                GPX
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handlePreviewGpx(entry)}
                                disabled={isBusy}
                              >
                                <Eye className="h-4 w-4" />
                                Preview
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="destructive" size="sm" disabled={isBusy}>
                                    <Trash2 className="h-4 w-4" />
                                    Delete
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Delete file?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This will permanently delete {entry.name}. This action cannot be
                                      undone.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => handleDeleteFile(entry)}>
                                      Delete
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card className="animate-fade-up">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Upload className="h-5 w-5 text-primary" />
                  Local GPZ Converter
                </CardTitle>
                <CardDescription>
                  Drop a .gpz file to convert and preview. Works offline.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                    isDragOver
                      ? "border-primary bg-primary/5"
                      : "border-border/70 bg-white/60 hover:border-primary/50"
                  }`}
                >
                  <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
                  <p className="mb-2 text-sm text-muted-foreground">
                    Drag & drop a .gpz file here
                  </p>
                  <label className="cursor-pointer">
                    <span className="text-sm font-medium text-primary hover:underline">
                      or click to browse
                    </span>
                    <input
                      type="file"
                      accept=".gpz"
                      onChange={handleFileInput}
                      className="hidden"
                    />
                  </label>
                </div>
                {localGpxString && localFileName && (
                  <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 p-3">
                    <span className="text-sm font-medium">{localFileName}</span>
                    <Button variant="outline" size="sm" onClick={handleDownloadLocalGpx}>
                      <Download className="h-4 w-4" />
                      Download GPX
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="animate-fade-up">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Map className="h-5 w-5 text-primary" />
                  GPX Viewer
                </CardTitle>
                <CardDescription>
                  {gpxFileName ? `Previewing ${gpxFileName}` : "Select a file to preview track data."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <gpx-viewer ref={gpxViewerRef} id="gpxViewer"></gpx-viewer>
              </CardContent>
            </Card>
          </div>

          <aside className="order-1 space-y-6 lg:order-2 lg:sticky lg:top-6 self-start">
            <Card className="animate-fade-up">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bluetooth className="h-5 w-5 text-primary" />
                  Connection
                </CardTitle>
                <CardDescription>Pair, wake, and sync with the GPS tracker.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex flex-wrap gap-3">
                  <Button onClick={handleConnect} disabled={!isBluetoothSupported || isConnecting}>
                    <Power className="h-4 w-4" />
                    {isConnected ? "Disconnect" : "Connect"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleQueryStatus}
                    disabled={!isConnected || isConnecting}
                  >
                    <Activity className="h-4 w-4" />
                    Query Status
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={handleAgnss}
                    disabled={!isConnected || isAgnssBusy}
                  >
                    <Satellite className="h-4 w-4" />
                    Download + Send AGNSS
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleGpsWakeup}
                    disabled={!isConnected}
                  >
                    <RefreshCw className="h-4 w-4" />
                    GPS Wakeup
                  </Button>
                </div>

                <div className="grid gap-3">
                  <div className="rounded-lg border border-border/70 bg-white/70 px-4 py-3 text-sm">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Status
                    </div>
                    <div className="mt-1 text-base font-medium text-foreground">{statusMessage}</div>
                  </div>
                  {agnssStatus && (
                    <div className="rounded-lg border border-border/70 bg-white/60 px-4 py-3 text-sm">
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        AGNSS
                      </div>
                      <div className="mt-1 text-sm text-foreground">{agnssStatus}</div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>

        <Card className="mt-6 animate-fade-up">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2">
                  <Terminal className="h-5 w-5 text-primary" />
                  Device Logs
                </CardTitle>
                <CardDescription>Runtime messages and transfer telemetry.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={clearLogs}>
                Clear Logs
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="max-h-[420px] space-y-2 overflow-y-auto rounded-lg border border-border/70 bg-white/70 p-4 font-mono text-xs scrollbar-thin">
              {logEntries.length === 0 && (
                <div className="text-muted-foreground">No logs yet.</div>
              )}
              {logEntries.map((entry) => (
                <div
                  key={entry.id}
                  className={`flex flex-wrap gap-2 ${
                    entry.level === "error"
                      ? "text-destructive"
                      : entry.level === "success"
                        ? "text-emerald-600"
                        : "text-foreground"
                  }`}
                >
                  <Badge
                    variant="outline"
                    className={`text-[10px] uppercase tracking-wide ${
                      entry.level === "error"
                        ? "border-destructive text-destructive"
                        : entry.level === "success"
                          ? "border-emerald-500 text-emerald-600"
                          : "border-muted text-muted-foreground"
                    }`}
                  >
                    {entry.level.toUpperCase()}
                  </Badge>
                  <span className="text-muted-foreground">[{entry.time}]</span>
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

