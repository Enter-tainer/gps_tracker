import { CONSTANTS, ENTRY_TYPE } from "../constants";
import { bytesToHex } from "../utils/helpers";
import type { FileEntry, SysInfo } from "../types/ble";
import type { Logger } from "../hooks/useLogger";

type ConnectionChangedCallback = (isConnected: boolean, deviceName?: string) => void;

type ListDirPromise = {
  resolve: (entries: FileEntry[]) => void;
  reject: (error: Error) => void;
  path: string;
  onEntry?: (name: string, type: number, size: number | null, entryPath: string) => void;
  onEmpty?: () => void;
};

type OpenFilePromise = {
  resolve: (result: { filePath: string; fileSize: number }) => void;
  reject: (error: Error) => void;
  filePath: string;
};

type ReadChunkPromise = {
  resolve: (result: { actualBytesRead: number; data: Uint8Array }) => void;
  reject: (error: Error) => void;
};

type VoidPromise = {
  resolve: () => void;
  reject: (error: Error) => void;
};

type PromiseMap = {
  listDir: ListDirPromise | null;
  openFile: OpenFilePromise | null;
  readChunk: ReadChunkPromise | null;
  closeFile: VoidPromise | null;
  deleteFile: VoidPromise | null;
  getSysInfo: { resolve: (info: SysInfo) => void; reject: (error: Error) => void } | null;
  startAgnssWrite: VoidPromise | null;
  writeAgnssChunk: VoidPromise | null;
  endAgnssWrite: VoidPromise | null;
  gpsWakeup: VoidPromise | null;
};

export function createBleService(logger: Logger) {
  let bleDevice: BluetoothDevice | null = null;
  let uartService: BluetoothRemoteGATTService | null = null;
  let txCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  let rxCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  let isConnected = false;
  let mtuSize = CONSTANTS.DEFAULT_MTU_SIZE;

  let listDirEntries: FileEntry[] = [];
  let connectionChangedCallback: ConnectionChangedCallback | null = null;

  const currentPromises: PromiseMap = {
    listDir: null,
    openFile: null,
    readChunk: null,
    closeFile: null,
    deleteFile: null,
    getSysInfo: null,
    startAgnssWrite: null,
    writeAgnssChunk: null,
    endAgnssWrite: null,
    gpsWakeup: null
  };

  async function connect() {
    if (isConnected) {
      logger.error("Already connected to a device");
      return false;
    }

    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth API is not available in this browser.");
    }

    try {
      logger.log("Requesting Bluetooth device...");

      bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [CONSTANTS.BLE.UART_SERVICE_UUID] }]
      });

      logger.log(`Connecting to ${bleDevice.name || `ID: ${bleDevice.id}`}...`);

      const server = await bleDevice.gatt?.connect();
      if (!server) {
        throw new Error("Failed to connect to GATT server.");
      }

      uartService = await server.getPrimaryService(CONSTANTS.BLE.UART_SERVICE_UUID);
      logger.log("UART Service obtained.");

      txCharacteristic = await uartService.getCharacteristic(
        CONSTANTS.BLE.UART_TX_CHARACTERISTIC_UUID
      );
      logger.log("TX Characteristic obtained.");

      rxCharacteristic = await uartService.getCharacteristic(
        CONSTANTS.BLE.UART_RX_CHARACTERISTIC_UUID
      );
      logger.log("RX Characteristic obtained.");

      await rxCharacteristic.startNotifications();
      rxCharacteristic.addEventListener("characteristicvaluechanged", handleRxData);
      logger.log("Notifications started.");

      const gatt = server as BluetoothRemoteGATTServer & { mtu?: number };
      mtuSize = gatt.mtu ?? 247;
      logger.log(`Assumed/Reported MTU: ${mtuSize} bytes.`);

      isConnected = true;

      bleDevice.addEventListener("gattserverdisconnected", onDisconnected);

      if (connectionChangedCallback) {
        connectionChangedCallback(true, bleDevice.name || bleDevice.id);
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error connecting: ${message}`);
      console.error("Connection Error:", error);

      if (bleDevice && bleDevice.gatt?.connected) {
        bleDevice.gatt.disconnect();
      }

      return false;
    }
  }

  function disconnect() {
    if (bleDevice && bleDevice.gatt?.connected) {
      logger.log("Disconnecting...");
      bleDevice.gatt.disconnect();
    } else {
      onDisconnected();
    }
  }

  function onDisconnected() {
    logger.log("Device disconnected.");

    isConnected = false;
    rxCharacteristic = null;
    txCharacteristic = null;
    uartService = null;
    bleDevice = null;

    Object.keys(currentPromises).forEach((key) => {
      const promise = currentPromises[key as keyof PromiseMap];
      if (promise && "reject" in promise) {
        promise.reject(new Error("Device disconnected"));
      }
      currentPromises[key as keyof PromiseMap] = null;
    });

    if (connectionChangedCallback) {
      connectionChangedCallback(false);
    }
  }

  async function sendBleData(data: ArrayBuffer) {
    if (!txCharacteristic || !isConnected) {
      logger.error("TX characteristic not available or not connected.");
      return Promise.reject(new Error("Not connected or TX characteristic not available"));
    }

    try {
      if ("writeValueWithoutResponse" in txCharacteristic) {
        await txCharacteristic.writeValueWithoutResponse(data);
      } else {
        await txCharacteristic.writeValue(data);
      }
      logger.log(`Sent ${data.byteLength} bytes: ${bytesToHex(new Uint8Array(data))}`);
      return true;
    } catch (error) {
      logger.error(`Error sending data: ${error}`);
      return Promise.reject(error);
    }
  }

  function handleRxData(event: Event) {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) {
      logger.error("RX data missing value.");
      return;
    }

    const dataArray = new Uint8Array(value.buffer);
    logger.log(`Received ${dataArray.byteLength} bytes: ${bytesToHex(dataArray)}`);

    if (dataArray.length < 2) {
      logger.error("RX data too short for payload length.");
      return;
    }

    const payloadLen = value.getUint16(0, true);
    if (2 + payloadLen > value.byteLength) {
      logger.error(`RX payload length ${payloadLen} exceeds packet size.`);
      return;
    }
    const payload = new DataView(value.buffer, 2, payloadLen);
    logger.log(`Parsed RX payload length: ${payloadLen}`);

    if (currentPromises.getSysInfo && payloadLen === CONSTANTS.SYSINFO_PAYLOAD_LEN) {
      try {
        const info = parseSysInfoPayload(payload);
        currentPromises.getSysInfo.resolve(info);
      } catch (error) {
        const message = error instanceof Error ? error : new Error(String(error));
        currentPromises.getSysInfo.reject(message);
      }
      currentPromises.getSysInfo = null;
      return;
    }

    if (currentPromises.listDir) {
      handleListDirResponse(payload, payloadLen);
      return;
    }

    if (currentPromises.openFile) {
      const promise = currentPromises.openFile;
      currentPromises.openFile = null;

      if (payloadLen === 4 && payload.byteLength === 4) {
        const fileSize = payload.getUint32(0, true);
        logger.log(`OPEN_FILE_RSP for ${promise.filePath}: success, file size = ${fileSize} bytes.`);
        promise.resolve({ filePath: promise.filePath, fileSize });
      } else if (payloadLen === 0) {
        logger.error(`OPEN_FILE_RSP for ${promise.filePath}: failed to open file.`);
        promise.reject(new Error(`Failed to open file: ${promise.filePath}`));
      } else {
        logger.error(`OPEN_FILE_RSP for ${promise.filePath}: unexpected payload length ${payloadLen}.`);
        promise.reject(new Error(`OPEN_FILE_RSP unexpected payload for ${promise.filePath}`));
      }
      return;
    }

    if (currentPromises.readChunk) {
      const promise = currentPromises.readChunk;
      currentPromises.readChunk = null;

      if (payloadLen >= 2 && payload.byteLength >= 2) {
        const actualBytesRead = payload.getUint16(0, true);
        logger.log(`READ_CHUNK_RSP: actual bytes read = ${actualBytesRead}`);

        if (actualBytesRead > 0) {
          if (payload.byteLength >= 2 + actualBytesRead) {
            const fileData = new Uint8Array(
              payload.buffer,
              payload.byteOffset + 2,
              actualBytesRead
            );
            promise.resolve({ actualBytesRead, data: fileData });
          } else {
            logger.error("READ_CHUNK_RSP: payload too short for data.");
            promise.reject(new Error("READ_CHUNK_RSP: inconsistent payload for data"));
          }
        } else {
          promise.resolve({ actualBytesRead: 0, data: new Uint8Array(0) });
        }
      } else {
        logger.error("READ_CHUNK_RSP: payload too short for actual bytes read.");
        promise.reject(new Error("READ_CHUNK_RSP: payload too short"));
      }
      return;
    }

    if (currentPromises.closeFile) {
      const promise = currentPromises.closeFile;
      currentPromises.closeFile = null;

      if (payloadLen === 0) {
        logger.log("CLOSE_FILE_RSP: file closed successfully.");
        promise.resolve();
      } else {
        logger.error(`CLOSE_FILE_RSP: unexpected payload length ${payloadLen}. Assuming closed.`);
        promise.resolve();
      }
      return;
    }

    if (currentPromises.deleteFile) {
      const promise = currentPromises.deleteFile;
      currentPromises.deleteFile = null;

      if (payloadLen === 0) {
        logger.log("DELETE_FILE_RSP: file deleted successfully.");
        promise.resolve();
      } else {
        logger.error(`DELETE_FILE_RSP: unexpected payload length ${payloadLen}.`);
        promise.reject(new Error("Delete failed or not permitted"));
      }
      return;
    }

    if (currentPromises.startAgnssWrite) {
      const promise = currentPromises.startAgnssWrite;
      currentPromises.startAgnssWrite = null;

      if (payloadLen === 0) {
        logger.log("START_AGNSS_WRITE_RSP: device ready to receive AGNSS data.");
        promise.resolve();
      } else {
        logger.error(`START_AGNSS_WRITE_RSP: unexpected payload length ${payloadLen}.`);
        promise.reject(new Error("START_AGNSS_WRITE failed"));
      }
      return;
    }

    if (currentPromises.writeAgnssChunk) {
      const promise = currentPromises.writeAgnssChunk;
      currentPromises.writeAgnssChunk = null;

      if (payloadLen === 0) {
        logger.log("WRITE_AGNSS_CHUNK_RSP: chunk written successfully.");
        promise.resolve();
      } else {
        logger.error(`WRITE_AGNSS_CHUNK_RSP: unexpected payload length ${payloadLen}.`);
        promise.reject(new Error("WRITE_AGNSS_CHUNK failed"));
      }
      return;
    }

    if (currentPromises.endAgnssWrite) {
      const promise = currentPromises.endAgnssWrite;
      currentPromises.endAgnssWrite = null;

      if (payloadLen === 0) {
        logger.log("END_AGNSS_WRITE_RSP: AGNSS transfer completed successfully.");
        promise.resolve();
      } else {
        logger.error(`END_AGNSS_WRITE_RSP: unexpected payload length ${payloadLen}.`);
        promise.reject(new Error("END_AGNSS_WRITE failed"));
      }
      return;
    }

    if (currentPromises.gpsWakeup) {
      const promise = currentPromises.gpsWakeup;
      currentPromises.gpsWakeup = null;

      if (payloadLen === 0) {
        logger.log("GPS_WAKEUP_RSP: GPS wakeup executed successfully.");
        promise.resolve();
      } else {
        logger.error(`GPS_WAKEUP_RSP: unexpected payload length ${payloadLen}.`);
        promise.reject(new Error("GPS wakeup failed"));
      }
      return;
    }

    logger.error("Received data but no matching command promise was found.");
  }

  function handleListDirResponse(payload: DataView, payloadLen: number) {
    const promise = currentPromises.listDir;
    if (!promise) {
      return;
    }

    if (payloadLen === 0) {
      logger.error(`LIST_DIR_RSP: empty payload or error for path ${promise.path}`);
      promise.reject(new Error("Empty LIST_DIR_RSP"));
      currentPromises.listDir = null;
      return;
    }

    if (payloadLen === 1 && payload.byteLength >= 1 && payload.getUint8(0) === 0x00) {
      logger.log(`LIST_DIR_RSP for ${promise.path}: no more entries.`);
      if (listDirEntries.length === 0 && promise.onEmpty) {
        promise.onEmpty();
      }
      promise.resolve(listDirEntries);
      currentPromises.listDir = null;
      return;
    }

    if (payload.byteLength < 3) {
      logger.error(`LIST_DIR_RSP: payload too short (${payload.byteLength}B).`);
      promise.reject(new Error("LIST_DIR_RSP too short"));
      currentPromises.listDir = null;
      return;
    }

    let offset = 0;
    const moreFlag = payload.getUint8(offset++);
    const entryType = payload.getUint8(offset++);
    const nameLength = payload.getUint8(offset++);

    if (offset + nameLength > payload.byteLength) {
      logger.error(
        `LIST_DIR_RSP: name length ${nameLength} exceeds payload bounds (${payload.byteLength - offset}).`
      );
      promise.reject(new Error("LIST_DIR_RSP name length error"));
      currentPromises.listDir = null;
      return;
    }

    const nameBytes = new Uint8Array(payload.buffer, payload.byteOffset + offset, nameLength);
    const name = new TextDecoder().decode(nameBytes);
    offset += nameLength;

    logger.log(`LIST_DIR_RSP: Path=${promise.path}, More=${moreFlag}, Type=${entryType}, Name=${name}`);

    let fileSize: number | null = null;
    if (entryType === ENTRY_TYPE.FILE) {
      if (offset + 4 <= payload.byteLength) {
        fileSize = payload.getUint32(offset, true);
        logger.log(`  File Size: ${fileSize}`);
      } else {
        logger.error(`LIST_DIR_RSP: file entry '${name}' missing file size.`);
      }
    }

    const entryFullPath = (promise.path === "/" ? "/" : `${promise.path}/`) + name;
    const sanitizedPath = entryFullPath.replace(/\/\//g, "/");

    listDirEntries.push({
      name,
      type: entryType === ENTRY_TYPE.DIRECTORY ? ENTRY_TYPE.DIRECTORY : ENTRY_TYPE.FILE,
      size: fileSize,
      path: sanitizedPath
    });

    if (promise.onEntry) {
      promise.onEntry(name, entryType, fileSize, sanitizedPath);
    }

    if (moreFlag === 0x00) {
      logger.log(`LIST_DIR_RSP for ${promise.path}: no more entries.`);
      promise.resolve(listDirEntries);
      currentPromises.listDir = null;
    } else {
      logger.log(`LIST_DIR_RSP for ${promise.path}: more entries exist, requesting next...`);
      sendListDirCommand(promise.path);
    }
  }

  async function sendListDirCommand(path: string) {
    let pathLengthForPayload = 0;
    let pathBytesForPayload = new Uint8Array(0);

    if (path !== "/") {
      pathBytesForPayload = new TextEncoder().encode(path);
      pathLengthForPayload = pathBytesForPayload.byteLength;
    }

    const cmdPayloadLength = 1 + pathLengthForPayload;
    const buffer = new ArrayBuffer(1 + 2 + cmdPayloadLength);
    const view = new DataView(buffer);

    let offset = 0;
    view.setUint8(offset++, CONSTANTS.CMD_ID.LIST_DIR);
    view.setUint16(offset, cmdPayloadLength, true);
    offset += 2;
    view.setUint8(offset++, pathLengthForPayload);

    if (pathLengthForPayload > 0) {
      new Uint8Array(buffer, offset).set(pathBytesForPayload);
    }

    return sendBleData(buffer);
  }

  function parseSysInfoPayload(payload: DataView): SysInfo {
    let offset = 0;

    const getFloat32 = () => {
      const value = payload.getFloat32(offset, true);
      offset += 4;
      return value;
    };

    const getFloat64 = () => {
      const value = payload.getFloat64(offset, true);
      offset += 8;
      return value;
    };

    const getUint32 = () => {
      const value = payload.getUint32(offset, true);
      offset += 4;
      return value;
    };

    const getUint16 = () => {
      const value = payload.getUint16(offset, true);
      offset += 2;
      return value;
    };

    const getUint8 = () => {
      const value = payload.getUint8(offset);
      offset += 1;
      return value;
    };

    return {
      latitude: getFloat64(),
      longitude: getFloat64(),
      altitude: getFloat32(),
      satellites: getUint32(),
      hdop: getFloat32(),
      speed: getFloat32(),
      course: getFloat32(),
      year: getUint16(),
      month: getUint8(),
      day: getUint8(),
      hour: getUint8(),
      minute: getUint8(),
      second: getUint8(),
      locationValid: getUint8(),
      dateTimeValid: getUint8(),
      batteryVoltage: getFloat32(),
      gpsState: getUint8()
    };
  }

  async function getSysInfo() {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }

    const payloadLength = 0;
    const buffer = new ArrayBuffer(1 + 2);
    const view = new DataView(buffer);

    view.setUint8(0, CONSTANTS.CMD_ID.GET_SYS_INFO);
    view.setUint16(1, payloadLength, true);

    return new Promise<SysInfo>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.getSysInfo) {
          currentPromises.getSysInfo = null;
          reject(new Error("Timeout waiting for system info response"));
        }
      }, 5000);

      currentPromises.getSysInfo = {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      };

      sendBleData(buffer).catch((error) => {
        clearTimeout(timeoutId);
        currentPromises.getSysInfo = null;
        reject(error as Error);
      });
    });
  }

  async function listDirectory(
    path: string,
    onEntry?: (name: string, type: number, size: number | null, entryPath: string) => void,
    onEmpty?: () => void
  ) {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }

    listDirEntries = [];

    return new Promise<FileEntry[]>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.listDir) {
          currentPromises.listDir = null;
          reject(new Error("Timeout waiting for directory listing"));
        }
      }, 10000);

      currentPromises.listDir = {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        path,
        onEntry,
        onEmpty
      };

      sendListDirCommand(path).catch((error) => {
        clearTimeout(timeoutId);
        currentPromises.listDir = null;
        reject(error as Error);
      });
    });
  }

  async function openFile(filePath: string) {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }

    logger.log(`Opening file: ${filePath}...`);

    return new Promise<{ filePath: string; fileSize: number }>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.openFile) {
          currentPromises.openFile = null;
          reject(new Error("Timeout waiting for file open response"));
        }
      }, 5000);

      currentPromises.openFile = {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        filePath
      };

      const pathBytes = new TextEncoder().encode(filePath);
      const payloadLength = 1 + pathBytes.byteLength;
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);

      let offset = 0;
      view.setUint8(offset++, CONSTANTS.CMD_ID.OPEN_FILE);
      view.setUint16(offset, payloadLength, true);
      offset += 2;
      view.setUint8(offset++, pathBytes.byteLength);
      new Uint8Array(buffer, offset).set(pathBytes);

      sendBleData(buffer).catch((error) => {
        clearTimeout(timeoutId);
        currentPromises.openFile = null;
        reject(error as Error);
      });
    });
  }

  async function readFileChunk(offsetValue: number, bytesToRead: number) {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }

    logger.log(`Reading chunk: offset=${offsetValue}, length=${bytesToRead}`);

    return new Promise<{ actualBytesRead: number; data: Uint8Array }>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.readChunk) {
          currentPromises.readChunk = null;
          reject(new Error("Timeout waiting for read chunk response"));
        }
      }, 10000);

      currentPromises.readChunk = {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      };

      const payloadLength = 4 + 2;
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);

      let idx = 0;
      view.setUint8(idx++, CONSTANTS.CMD_ID.READ_CHUNK);
      view.setUint16(idx, payloadLength, true);
      idx += 2;
      view.setUint32(idx, offsetValue, true);
      idx += 4;
      view.setUint16(idx, bytesToRead, true);

      sendBleData(buffer).catch((error) => {
        clearTimeout(timeoutId);
        currentPromises.readChunk = null;
        reject(error as Error);
      });
    });
  }

  async function closeFile() {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }

    logger.log("Closing file...");

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.closeFile) {
          currentPromises.closeFile = null;
          resolve();
        }
      }, 3000);

      currentPromises.closeFile = {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      };

      const payloadLength = 0;
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);

      view.setUint8(0, CONSTANTS.CMD_ID.CLOSE_FILE);
      view.setUint16(1, payloadLength, true);

      sendBleData(buffer).catch((error) => {
        clearTimeout(timeoutId);
        currentPromises.closeFile = null;
        reject(error as Error);
      });
    });
  }

  async function deleteFile(filePath: string) {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }

    logger.log(`Sending DELETE_FILE for: ${filePath}`);

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.deleteFile) {
          currentPromises.deleteFile = null;
          reject(new Error("Timeout waiting for delete response"));
        }
      }, 3000);

      currentPromises.deleteFile = {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      };

      const pathBytes = new TextEncoder().encode(filePath);
      const payloadLength = 1 + pathBytes.byteLength;
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);

      let offset = 0;
      view.setUint8(offset++, CONSTANTS.CMD_ID.DELETE_FILE);
      view.setUint16(offset, payloadLength, true);
      offset += 2;
      view.setUint8(offset++, pathBytes.byteLength);
      new Uint8Array(buffer, offset).set(pathBytes);

      sendBleData(buffer).catch((error) => {
        clearTimeout(timeoutId);
        currentPromises.deleteFile = null;
        reject(error as Error);
      });
    });
  }

  function onConnectionChanged(callback: ConnectionChangedCallback) {
    connectionChangedCallback = callback;
  }

  function getConnectionStatus() {
    return isConnected;
  }

  function getMtuSize() {
    return mtuSize;
  }

  async function triggerGpsWakeup() {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }

    logger.log("Triggering GPS wakeup...");

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.gpsWakeup) {
          currentPromises.gpsWakeup = null;
          reject(new Error("Timeout waiting for GPS wakeup response"));
        }
      }, 5000);

      currentPromises.gpsWakeup = {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      };

      const payloadLength = 0;
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);

      view.setUint8(0, CONSTANTS.CMD_ID.GPS_WAKEUP);
      view.setUint16(1, payloadLength, true);

      sendBleData(buffer).catch((error) => {
        clearTimeout(timeoutId);
        currentPromises.gpsWakeup = null;
        reject(error as Error);
      });
    });
  }

  async function startAgnssWrite() {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }

    logger.log("Starting AGNSS write...");

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.startAgnssWrite) {
          currentPromises.startAgnssWrite = null;
          reject(new Error("Timeout waiting for START_AGNSS_WRITE response"));
        }
      }, 10000);

      currentPromises.startAgnssWrite = {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      };

      const payloadLength = 0;
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);

      view.setUint8(0, CONSTANTS.CMD_ID.START_AGNSS_WRITE);
      view.setUint16(1, payloadLength, true);

      sendBleData(buffer).catch((error) => {
        clearTimeout(timeoutId);
        currentPromises.startAgnssWrite = null;
        reject(error as Error);
      });
    });
  }

  async function writeAgnssChunk(chunkData: Uint8Array) {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }

    const chunkSize = chunkData.byteLength;
    logger.log(`Writing AGNSS chunk of ${chunkSize} bytes...`);

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.writeAgnssChunk) {
          currentPromises.writeAgnssChunk = null;
          reject(new Error("Timeout waiting for WRITE_AGNSS_CHUNK response"));
        }
      }, 10000);

      currentPromises.writeAgnssChunk = {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      };

      const payloadLength = 2 + chunkSize;
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);
      let offset = 0;

      view.setUint8(offset++, CONSTANTS.CMD_ID.WRITE_AGNSS_CHUNK);
      view.setUint16(offset, payloadLength, true);
      offset += 2;
      view.setUint16(offset, chunkSize, true);
      offset += 2;
      new Uint8Array(buffer, offset).set(chunkData);

      sendBleData(buffer).catch((error) => {
        clearTimeout(timeoutId);
        currentPromises.writeAgnssChunk = null;
        reject(error as Error);
      });
    });
  }

  async function endAgnssWrite() {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }

    logger.log("Ending AGNSS write...");

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.endAgnssWrite) {
          currentPromises.endAgnssWrite = null;
          reject(new Error("Timeout waiting for END_AGNSS_WRITE response"));
        }
      }, 10000);

      currentPromises.endAgnssWrite = {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      };

      const payloadLength = 0;
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);

      view.setUint8(0, CONSTANTS.CMD_ID.END_AGNSS_WRITE);
      view.setUint16(1, payloadLength, true);

      sendBleData(buffer).catch((error) => {
        clearTimeout(timeoutId);
        currentPromises.endAgnssWrite = null;
        reject(error as Error);
      });
    });
  }

  return {
    connect,
    disconnect,
    isConnected: getConnectionStatus,
    getMtuSize,
    onConnectionChanged,
    getSysInfo,
    listDirectory,
    openFile,
    readFileChunk,
    closeFile,
    deleteFile,
    startAgnssWrite,
    writeAgnssChunk,
    endAgnssWrite,
    triggerGpsWakeup
  };
}

export default createBleService;

