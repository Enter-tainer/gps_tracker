import type { Logger } from "../hooks/useLogger";
import type { FileEntry } from "../types/ble";
import { createGpsDecoder } from "./gpsDecoder";
import { createGpxConverter } from "./gpxConverter";
import type { GpxPreviewer } from "./gpxConverter";
import type { createBleService } from "./bleService";

export type BleService = ReturnType<typeof createBleService>;

export type FileServiceOptions = {
  onStatus?: (message: string) => void;
  onPreview?: GpxPreviewer;
};

export function createFileService(
  bleService: BleService,
  logger: Logger,
  options: FileServiceOptions = {}
) {
  const gpsDecoder = createGpsDecoder();
  const gpxConverter = createGpxConverter(logger, options.onPreview);

  const updateStatus = (message: string) => {
    options.onStatus?.(message);
  };

  async function listDirectory(
    path: string,
    onEntry?: (name: string, type: number, size: number | null, entryPath: string) => void,
    onEmpty?: () => void
  ) {
    if (!bleService.isConnected()) {
      logger.error("Cannot list directory: not connected.");
      return Promise.reject(new Error("Not connected"));
    }

    return bleService.listDirectory(path, onEntry, onEmpty);
  }

  async function downloadFileCore(filePath: string, fileName: string, expectedSize: number | null) {
    if (!bleService.isConnected()) {
      logger.error("Cannot download: not connected.");
      return Promise.reject(new Error("Not connected"));
    }

    logger.log(`Starting raw download for: ${filePath} (Size: ${expectedSize ?? "unknown"} bytes)`);

    try {
      const { fileSize: openedFileSize } = await bleService.openFile(filePath);
      let effectiveFileSize = openedFileSize;

      if (expectedSize !== null && openedFileSize !== expectedSize) {
        logger.log(
          `Warning: opened file size (${openedFileSize}) differs from listed size (${expectedSize}). Using opened size.`
        );
      } else if (expectedSize !== null) {
        effectiveFileSize = expectedSize;
      }

      logger.log(`File opened: ${filePath}, Effective Size: ${effectiveFileSize} bytes.`);

      let receivedBytes = 0;
      const fileChunks: Uint8Array[] = [];
      const mtuSize = bleService.getMtuSize();
      const chunkSizeToRequest = Math.max(16, Math.min(251, mtuSize - 10));
      logger.log(`Requesting chunks of size: ${chunkSizeToRequest}`);

      while (receivedBytes < effectiveFileSize) {
        const bytesToRead = Math.min(chunkSizeToRequest, effectiveFileSize - receivedBytes);
        if (bytesToRead <= 0) break;

        const progress = effectiveFileSize > 0 ? (receivedBytes / effectiveFileSize) * 100 : 100;
        updateStatus(`Downloading ${fileName}: ${Math.round(progress)}%`);

        const { actualBytesRead, data } = await bleService.readFileChunk(receivedBytes, bytesToRead);

        if (actualBytesRead > 0 && data) {
          fileChunks.push(data);
          receivedBytes += actualBytesRead;
          logger.log(`Downloaded ${receivedBytes} / ${effectiveFileSize} bytes...`);
        } else {
          logger.log("Reached EOF or read error (actualBytesRead is 0 or no data).");
          if (receivedBytes < effectiveFileSize) {
            logger.error(
              `Warning: download ended prematurely. Expected ${effectiveFileSize}, got ${receivedBytes}.`
            );
          }
          break;
        }
      }

      if (effectiveFileSize > 0) {
        updateStatus(`Downloaded ${fileName}: ${Math.round((receivedBytes / effectiveFileSize) * 100)}% complete.`);
      } else {
        updateStatus(`Downloaded ${fileName}: empty file.`);
      }

      if (fileChunks.length > 0) {
        const totalReceived = fileChunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
        if (totalReceived !== receivedBytes) {
          logger.error(`Internal mismatch: receivedBytes=${receivedBytes}, chunksTotal=${totalReceived}`);
        }

        const finalBuffer = new Uint8Array(totalReceived);
        let currentOffset = 0;
        for (const chunk of fileChunks) {
          finalBuffer.set(chunk, currentOffset);
          currentOffset += chunk.byteLength;
        }

        return finalBuffer.buffer;
      }

      if (effectiveFileSize === 0 && receivedBytes === 0) {
        logger.log("Downloaded an empty file successfully.");
        return new ArrayBuffer(0);
      }

      throw new Error(
        `Download failed or file empty. Received ${receivedBytes} of ${effectiveFileSize} bytes.`
      );
    } catch (error) {
      logger.error(`Error during raw download of ${filePath}: ${error}`);
      updateStatus(`Error downloading ${filePath}`);
      throw error;
    } finally {
      try {
        await bleService.closeFile();
        logger.log(`File closed after raw download attempt for ${filePath}`);
      } catch (closeError) {
        logger.error(`Error closing file after raw download of ${filePath}: ${closeError}`);
      }
    }
  }

  async function downloadFile(filePath: string, fileName: string, expectedSize: number | null) {
    try {
      const rawFileBuffer = await downloadFileCore(filePath, fileName, expectedSize);
      if (rawFileBuffer) {
        const fileBlob = new Blob([rawFileBuffer]);
        const downloadUrl = URL.createObjectURL(fileBlob);
        const a = document.createElement("a");

        a.href = downloadUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();

        URL.revokeObjectURL(downloadUrl);
        a.remove();

        logger.log(`Raw file "${fileName}" saved.`);
        updateStatus(`Saved ${fileName}`);
      }
    } catch (error) {
      logger.error(`Overall download process for ${fileName} failed: ${error}`);
    }
  }

  async function downloadAndConvertToGpx(
    filePath: string,
    fileName: string,
    expectedSize: number | null,
    download: boolean
  ) {
    try {
      updateStatus(`Downloading ${fileName} for GPX conversion...`);

      const rawFileBuffer = await downloadFileCore(filePath, fileName, expectedSize);
      if (!rawFileBuffer) {
        logger.error(`GPX conversion: failed to download raw data for ${fileName}.`);
        updateStatus(`GPX conversion failed for ${fileName}.`);
        return;
      }

      const points = gpsDecoder.decode(rawFileBuffer);
      if (!points || points.length === 0) {
        logger.error(`GPX conversion: no valid points decoded for ${fileName}.`);
        updateStatus(`No valid points for GPX conversion in ${fileName}.`);
        return;
      }

      const gpxString = gpxConverter.pointsToGpxString(points, fileName);
      if (!gpxString) {
        logger.error(`GPX conversion: failed to convert points to GPX for ${fileName}.`);
        updateStatus(`GPX conversion failed for ${fileName}.`);
        return;
      }

      if (download) {
        gpxConverter.saveGpxFile(gpxString, fileName);
      } else {
        gpxConverter.displayGpx(gpxString, fileName);
      }
    } catch (error) {
      logger.error(`GPX conversion/preview failed: ${error}`);
      updateStatus(`GPX conversion/preview failed: ${error}`);
    }
  }

  async function deleteFile(filePath: string) {
    return bleService.deleteFile(filePath);
  }

  return {
    listDirectory,
    downloadFile,
    downloadAndConvertToGpx,
    deleteFile
  };
}

export default createFileService;

