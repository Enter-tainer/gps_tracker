/**
 * 蓝牙服务模块
 * 负责处理与设备的蓝牙通信
 */
import { CONSTANTS, UI_ELEMENTS } from '../utils/constants.js';
import { bytesToHex, getElement } from '../utils/helpers.js';

/**
 * 初始化蓝牙服务
 * @param {Object} logger - 日志服务对象
 * @returns {Object} 蓝牙服务接口
 */
export function initBleService(logger) {
  // 蓝牙状态变量
  let bleDevice = null;
  let uartService = null;
  let txCharacteristic = null;
  let rxCharacteristic = null;
  let isConnected = false;
  let mtuSize = CONSTANTS.DEFAULT_MTU_SIZE;
  
  // 获取UI元素
  const connectButton = getElement(UI_ELEMENTS.CONNECT_BUTTON);
  const statusDiv = getElement(UI_ELEMENTS.STATUS_DIV);
  
  // 存储当前协议请求的Promise解析器
  let currentPromises = {
    listDir: null,
    openFile: null,
    readChunk: null,
    closeFile: null,
    deleteFile: null,
    getSysInfo: null,
    startAgnssWrite: null,
    writeAgnssChunk: null,
    endAgnssWrite: null
  };
  
  // 存储目录列表条目
  let listDirEntries = [];
  
  // 连接状态变更回调函数
  let connectionChangedCallback = null;

  /**
   * 连接到BLE设备
   */
  async function connect() {
    if (isConnected) {
      logger.error('Already connected to a device');
      return;
    }
    
    try {
      logger.log('Requesting Bluetooth device...');
      
      bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [CONSTANTS.BLE.UART_SERVICE_UUID] }],
      });
      
      logger.log(`Connecting to ${bleDevice.name || `ID: ${bleDevice.id}`}...`);
      if (statusDiv) statusDiv.textContent = `Connecting to ${bleDevice.name}...`;
      
      const server = await bleDevice.gatt.connect();
      logger.log('Connected to GATT Server.');
      
      uartService = await server.getPrimaryService(CONSTANTS.BLE.UART_SERVICE_UUID);
      logger.log('UART Service obtained.');
      
      txCharacteristic = await uartService.getCharacteristic(CONSTANTS.BLE.UART_TX_CHARACTERISTIC_UUID);
      logger.log('TX Characteristic obtained.');
      
      rxCharacteristic = await uartService.getCharacteristic(CONSTANTS.BLE.UART_RX_CHARACTERISTIC_UUID);
      logger.log('RX Characteristic obtained.');
      
      await rxCharacteristic.startNotifications();
      rxCharacteristic.addEventListener('characteristicvaluechanged', handleRxData);
      logger.log('Notifications started.');

      mtuSize = bleDevice.gatt.mtu || 247; // 更现实的默认值（如果可用）
      logger.log(`Assumed/Reported MTU: ${mtuSize} bytes.`);

      isConnected = true;
      
      if (connectButton) connectButton.textContent = 'Disconnect';
      if (statusDiv) statusDiv.textContent = `Connected to ${bleDevice.name || bleDevice.id}`;
      
      // 监听断开连接事件
      bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
      
      // 触发连接状态变更回调
      if (connectionChangedCallback) {
        connectionChangedCallback(true, bleDevice.name || bleDevice.id);
      }
      
      // 启用目录列表按钮
      const listDirButton = document.getElementById(UI_ELEMENTS.LIST_DIR_BUTTON);
      if (listDirButton) {
        listDirButton.disabled = false;
        
        // 自动列出根目录
        setTimeout(() => {
          listDirButton.click();
        }, 500);
      }
      
      return true;
    } catch (error) {
      logger.error(`Error connecting: ${error.message}`);
      console.error("Connection Error:", error);
      
      if (statusDiv) statusDiv.textContent = `Error: ${error.message.substring(0, 50)}...`;
      if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
      
      return false;
    }
  }

  /**
   * 断开BLE连接
   */
  function disconnect() {
    if (bleDevice && bleDevice.gatt.connected) {
      logger.log('Disconnecting...');
      bleDevice.gatt.disconnect();
    } else {
      onDisconnected();
    }
  }

  /**
   * 处理断开连接事件
   */
  function onDisconnected() {
    logger.log('Device disconnected.');
    
    isConnected = false;
    if (connectButton) connectButton.textContent = 'Connect to Device';
    if (statusDiv) statusDiv.textContent = 'Disconnected';
    
    rxCharacteristic = null; 
    txCharacteristic = null; 
    uartService = null; 
    bleDevice = null;
    
    // 清理所有未完成的promise，防止内存泄漏
    Object.keys(currentPromises).forEach(key => {
      if (currentPromises[key] && currentPromises[key].reject) {
        currentPromises[key].reject(new Error('Device disconnected'));
      }
      currentPromises[key] = null;
    });
    
    // 触发连接状态变更回调
    if (connectionChangedCallback) {
      connectionChangedCallback(false);
    }
  }

  /**
   * 发送数据到BLE设备
   * @param {ArrayBuffer} data - 要发送的数据
   */
  async function sendBleData(data) {
    if (!txCharacteristic || !isConnected) {
      logger.error('Error: TX Characteristic not available or not connected.');
      return Promise.reject(new Error('Not connected or TX characteristic not available'));
    }
    
    try {
      // 使用无响应写入以获得更高吞吐量
      await txCharacteristic.writeValueWithoutResponse(data);
      logger.log(`Sent ${data.byteLength} bytes: ${bytesToHex(new Uint8Array(data))}`);
      return true;
    } catch (error) {
      logger.error(`Error sending data: ${error}`);
      return Promise.reject(error);
    }
  }

  /**
   * 处理接收到的BLE数据
   * @param {Event} event - 特征值变更事件
   */
  function handleRxData(event) {
    const value = event.target.value; // DataView
    const dataArray = new Uint8Array(value.buffer);
    logger.log(`Received ${dataArray.byteLength} bytes: ${bytesToHex(dataArray)}`);

    if (dataArray.length < 2) {
      logger.error("Error: RX data too short for Payload Len.");
      return;
    }
    
    const payloadLen = value.getUint16(0, true);
    const payload = new DataView(value.buffer, 2, payloadLen);
    logger.log(`Parsed RX Payload Len: ${payloadLen}`);

    // --- GET_SYS_INFO 响应处理 ---
    if (currentPromises.getSysInfo && payloadLen === CONSTANTS.SYSINFO_PAYLOAD_LEN) {
      try {
        const info = parseSysInfoPayload(payload);
        currentPromises.getSysInfo.resolve(info);
      } catch (e) {
        currentPromises.getSysInfo.reject(e);
      }
      currentPromises.getSysInfo = null;
      return;
    }

    // --- LIST_DIR 响应处理 ---
    if (currentPromises.listDir) {
      handleListDirResponse(payload, payloadLen);
      return;
    }
    
    // --- OPEN_FILE 响应处理 ---
    if (currentPromises.openFile) {
      const promise = currentPromises.openFile;
      currentPromises.openFile = null;
      
      if (payloadLen === 4 && payload.byteLength === 4) {
        const fileSize = payload.getUint32(0, true);
        logger.log(`OPEN_FILE_RSP for ${promise.filePath}: Success, File Size = ${fileSize} bytes.`);
        promise.resolve({ filePath: promise.filePath, fileSize });
      } else if (payloadLen === 0) {
        logger.error(`OPEN_FILE_RSP for ${promise.filePath}: Failed to open file.`);
        promise.reject(`Failed to open file: ${promise.filePath}`);
      } else {
        logger.error(`OPEN_FILE_RSP for ${promise.filePath}: Unexpected payload length ${payloadLen}.`);
        promise.reject(`OPEN_FILE_RSP unexpected payload for ${promise.filePath}`);
      }
      return;
    }
    
    // --- READ_CHUNK 响应处理 ---
    if (currentPromises.readChunk) {
      const promise = currentPromises.readChunk;
      currentPromises.readChunk = null;
      
      if (payloadLen >= 2 && payload.byteLength >= 2) {
        const actualBytesRead = payload.getUint16(0, true);
        logger.log(`READ_CHUNK_RSP: Actual Bytes Read = ${actualBytesRead}`);
        
        if (actualBytesRead > 0) {
          if (payload.byteLength >= 2 + actualBytesRead) {
            const fileData = new Uint8Array(payload.buffer, payload.byteOffset + 2, actualBytesRead);
            promise.resolve({ actualBytesRead, data: fileData });
          } else {
            logger.error("READ_CHUNK_RSP: actualBytesRead > 0 but payload too short for data.");
            promise.reject("READ_CHUNK_RSP: inconsistent payload for data");
          }
        } else {
          promise.resolve({ actualBytesRead: 0, data: new Uint8Array(0) });
        }
      } else {
        logger.error("READ_CHUNK_RSP: Payload too short for 'Actual Bytes Read'.");
        promise.reject("READ_CHUNK_RSP: payload too short");
      }
      return;
    }
    
    // --- CLOSE_FILE 响应处理 ---
    if (currentPromises.closeFile) {
      const promise = currentPromises.closeFile;
      currentPromises.closeFile = null;
      
      if (payloadLen === 0) {
        logger.log("CLOSE_FILE_RSP: File closed successfully.");
        promise.resolve();
      } else {
        logger.error(`CLOSE_FILE_RSP: Unexpected payload length ${payloadLen}. Assuming closed.`);
        promise.resolve();
      }
      return;
    }
    
    // --- DELETE_FILE 响应处理 ---
    if (currentPromises.deleteFile) {
      const promise = currentPromises.deleteFile;
      currentPromises.deleteFile = null;
      
      if (payloadLen === 0) {
        logger.log(`DELETE_FILE_RSP for ${promise.filePath}: File deleted successfully.`);
        promise.resolve();
      } else {
        logger.error(`DELETE_FILE_RSP for ${promise.filePath}: Unexpected payload length ${payloadLen}.`);
        promise.reject('Delete failed or not permitted');
      }
      return;
    }
    
    // --- AGNSS 响应处理 ---
    if (currentPromises.startAgnssWrite) {
      const promise = currentPromises.startAgnssWrite;
      currentPromises.startAgnssWrite = null;
      
      if (payloadLen === 0) {
        logger.log("START_AGNSS_WRITE_RSP: Device ready to receive AGNSS data.");
        promise.resolve();
      } else {
        logger.error(`START_AGNSS_WRITE_RSP: Unexpected payload length ${payloadLen}.`);
        promise.reject(new Error('START_AGNSS_WRITE failed'));
      }
      return;
    }
    
    if (currentPromises.writeAgnssChunk) {
      const promise = currentPromises.writeAgnssChunk;
      currentPromises.writeAgnssChunk = null;
      
      if (payloadLen === 0) {
        logger.log("WRITE_AGNSS_CHUNK_RSP: Chunk written successfully.");
        promise.resolve();
      } else {
        logger.error(`WRITE_AGNSS_CHUNK_RSP: Unexpected payload length ${payloadLen}.`);
        promise.reject(new Error('WRITE_AGNSS_CHUNK failed'));
      }
      return;
    }
    
    if (currentPromises.endAgnssWrite) {
      const promise = currentPromises.endAgnssWrite;
      currentPromises.endAgnssWrite = null;
      
      if (payloadLen === 0) {
        logger.log("END_AGNSS_WRITE_RSP: AGNSS data transfer completed successfully.");
        promise.resolve();
      } else {
        logger.error(`END_AGNSS_WRITE_RSP: Unexpected payload length ${payloadLen}.`);
        promise.reject(new Error('END_AGNSS_WRITE failed'));
      }
      return;
    }
    
    logger.error("Received data, but no matching command promise was found. Ignoring.");
  }

  /**
   * 处理列目录响应
   * @param {DataView} payload - 响应负载
   * @param {number} payloadLen - 负载长度
   */
  function handleListDirResponse(payload, payloadLen) {
    const promise = currentPromises.listDir;

    if (payloadLen === 0) {
      logger.error("LIST_DIR_RSP: Empty payload or error for path: " + promise.path);
      if (promise.reject) promise.reject("Empty LIST_DIR_RSP");
      currentPromises.listDir = null;
      return;
    }
    
    if (payloadLen === 1 && payload.byteLength >= 1 && payload.getUint8(0) === 0x00) {
      logger.log(`LIST_DIR_RSP for ${promise.path}: No more entries (or empty directory). Listing complete.`);
      if (listDirEntries.length === 0) {
        if (promise.onEmpty) promise.onEmpty();
      }
      if (promise.resolve) promise.resolve(listDirEntries);
      currentPromises.listDir = null;
      return;
    }
    
    if (payload.byteLength < 3) { // Min: More Flag (1) + Entry Type (1) + Name Length (1)
      logger.error(`LIST_DIR_RSP for ${promise.path}: Payload too short (${payload.byteLength}B) for minimal entry.`);
      if (promise.reject) promise.reject("LIST_DIR_RSP too short");
      currentPromises.listDir = null;
      return;
    }

    let offset = 0;
    const moreFlag = payload.getUint8(offset); offset++;
    const entryType = payload.getUint8(offset); offset++;
    const nameLength = payload.getUint8(offset); offset++;

    if (offset + nameLength > payload.byteLength) {
      logger.error(`LIST_DIR_RSP for ${promise.path}: Name length (${nameLength}) exceeds payload bounds (${payload.byteLength - offset} available).`);
      if (promise.reject) promise.reject("LIST_DIR_RSP name length error");
      currentPromises.listDir = null;
      return;
    }
    
    const nameBytes = new Uint8Array(payload.buffer, payload.byteOffset + offset, nameLength);
    const name = new TextDecoder().decode(nameBytes);
    offset += nameLength;
    
    logger.log(`LIST_DIR_RSP: Path=${promise.path}, More=${moreFlag}, Type=${entryType}, Name=${name}`);

    let fileSize = null;
    if (entryType === CONSTANTS.ENTRY_TYPE.FILE) {
      if (offset + 4 <= payload.byteLength) {
        fileSize = payload.getUint32(offset, true);
        logger.log(`  File Size: ${fileSize}`);
      } else { 
        logger.error(`LIST_DIR_RSP for ${promise.path}: File entry '${name}', but file size is missing or payload too short.`); 
      }
    }
    
    // 构造条目的完整路径
    const entryFullPath = (promise.path === '/' ? '/' : promise.path + '/') + name;
    const sanitizedPath = entryFullPath.replace(/\/\//g, '/');
    
    // 添加到条目列表
    listDirEntries.push({ 
      name, 
      type: entryType, 
      size: fileSize, 
      path: sanitizedPath
    });
    
    // 调用条目回调（如果有）
    if (promise.onEntry) {
      promise.onEntry(name, entryType, fileSize, sanitizedPath);
    }

    if (moreFlag === 0x00) {
      logger.log(`LIST_DIR_RSP for ${promise.path}: No more entries. Listing complete.`);
      if (promise.resolve) promise.resolve(listDirEntries);
      currentPromises.listDir = null;
    } else {
      logger.log(`LIST_DIR_RSP for ${promise.path}: More entries exist, requesting next...`);
      // 重新发送 LIST_DIR 请求相同目录
      sendListDirCommand(promise.path);
    }
  }

  /**
   * 发送列目录命令
   * @param {string} path - 要列出的目录路径
   */
  async function sendListDirCommand(path) {
    let pLengthForPayload;
    let pathBytesForPayload;
    
    if (path === "/") { 
      pLengthForPayload = 0; 
      pathBytesForPayload = new Uint8Array(0); 
    } else { 
      pathBytesForPayload = new TextEncoder().encode(path); 
      pLengthForPayload = pathBytesForPayload.byteLength; 
    }

    const cmdPayloadLength = 1 + pLengthForPayload;
    const buffer = new ArrayBuffer(1 + 2 + cmdPayloadLength);
    const view = new DataView(buffer);
    
    let o = 0;
    view.setUint8(o, CONSTANTS.CMD_ID.LIST_DIR); o++;
    view.setUint16(o, cmdPayloadLength, true); o += 2;
    view.setUint8(o, pLengthForPayload); o++;
    
    if (pLengthForPayload > 0) {
      new Uint8Array(buffer, o).set(pathBytesForPayload);
    }
    
    return sendBleData(buffer);
  }

  /**
   * 解析系统信息负载
   * @param {DataView} payload - 响应负载
   * @returns {Object} 系统信息对象
   */
  function parseSysInfoPayload(payload) {
    let offset = 0;
    
    function getFloat32() { 
      const v = payload.getFloat32(offset, true); 
      offset += 4; 
      return v; 
    }
    
    function getFloat64() { 
      const v = payload.getFloat64(offset, true); 
      offset += 8; 
      return v; 
    }
    
    function getUint32() { 
      const v = payload.getUint32(offset, true); 
      offset += 4; 
      return v; 
    }
    
    function getUint16() { 
      const v = payload.getUint16(offset, true); 
      offset += 2; 
      return v; 
    }
    
    function getUint8() { 
      const v = payload.getUint8(offset); 
      offset += 1; 
      return v; 
    }
    
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
      gpsState: getUint8(),
    };
  }

  // --- 公开的API方法 ---

  /**
   * 获取系统信息
   * @returns {Promise<Object>} 系统信息对象
   */
  async function getSysInfo() {
    if (!isConnected) {
      return Promise.reject(new Error('Not connected'));
    }
    
    try {
      const payloadLength = 0;
      const buffer = new ArrayBuffer(1 + 2);
      const view = new DataView(buffer);
      
      view.setUint8(0, CONSTANTS.CMD_ID.GET_SYS_INFO);
      view.setUint16(1, payloadLength, true);
      
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (currentPromises.getSysInfo) {
            currentPromises.getSysInfo = null;
            reject(new Error('Timeout waiting for system info response'));
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
        
        sendBleData(buffer).catch(error => {
          clearTimeout(timeoutId);
          currentPromises.getSysInfo = null;
          reject(error);
        });
      });
    } catch (e) {
      logger.error('Failed to get system info: ' + e);
      return Promise.reject(e);
    }
  }

  /**
   * 列出目录内容
   * @param {string} path - 目录路径 
   * @param {Function} onEntry - 可选的条目回调函数
   * @param {Function} onEmpty - 可选的空目录回调函数
   * @returns {Promise<Array>} 条目数组
   */
  async function listDirectory(path, onEntry, onEmpty) {
    if (!isConnected) {
      return Promise.reject(new Error('Not connected'));
    }
    
    listDirEntries = []; // 重置条目列表
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.listDir) {
          currentPromises.listDir = null;
          reject(new Error('Timeout waiting for directory listing'));
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
      
      sendListDirCommand(path).catch(error => {
        clearTimeout(timeoutId);
        currentPromises.listDir = null;
        reject(error);
      });
    });
  }

  /**
   * 打开文件
   * @param {string} filePath - 文件路径
   * @returns {Promise<Object>} 包含文件大小的对象
   */
  async function openFile(filePath) {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }
    
    logger.log(`Opening file: ${filePath}...`);
    
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.openFile) {
          currentPromises.openFile = null;
          reject(new Error('Timeout waiting for file open response'));
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
      const payloadLength = 1 + pathBytes.byteLength; // File Path Length (1B) + File Path string
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);
      
      let offset = 0;
      view.setUint8(offset, CONSTANTS.CMD_ID.OPEN_FILE); offset++;
      view.setUint16(offset, payloadLength, true); offset += 2;
      view.setUint8(offset, pathBytes.byteLength); offset++;
      new Uint8Array(buffer, offset).set(pathBytes);
      
      try {
        await sendBleData(buffer);
      } catch (error) {
        clearTimeout(timeoutId);
        currentPromises.openFile = null;
        reject(error);
      }
    });
  }

  /**
   * 读取文件块
   * @param {number} offset - 文件偏移量
   * @param {number} bytesToRead - 要读取的字节数
   * @returns {Promise<Object>} 包含读取数据的对象
   */
  async function readFileChunk(offset, bytesToRead) {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }
    
    logger.log(`Reading chunk: offset=${offset}, length=${bytesToRead}`);
    
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.readChunk) {
          currentPromises.readChunk = null;
          reject(new Error('Timeout waiting for read chunk response'));
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
      
      const payloadLength = 4 + 2; // Offset (4B) + Bytes to Read (2B)
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);
      
      let idx = 0;
      view.setUint8(idx, CONSTANTS.CMD_ID.READ_CHUNK); idx++;
      view.setUint16(idx, payloadLength, true); idx += 2;
      view.setUint32(idx, offset, true); idx += 4;
      view.setUint16(idx, bytesToRead, true);
      
      try {
        await sendBleData(buffer);
      } catch (error) {
        clearTimeout(timeoutId);
        currentPromises.readChunk = null;
        reject(error);
      }
    });
  }

  /**
   * 关闭文件
   * @returns {Promise<void>}
   */
  async function closeFile() {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }
    
    logger.log(`Closing file...`);
    
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.closeFile) {
          currentPromises.closeFile = null;
          resolve(); // 即使超时也尝试解析，因为关闭操作相对不敏感
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
      
      try {
        await sendBleData(buffer);
      } catch (error) {
        clearTimeout(timeoutId);
        currentPromises.closeFile = null;
        reject(error);
      }
    });
  }

  /**
   * 删除文件
   * @param {string} filePath - 文件路径
   * @returns {Promise<void>}
   */
  async function deleteFile(filePath) {
    if (!isConnected) {
      return Promise.reject(new Error('Not connected'));
    }
    
    logger.log(`Sending DELETE_FILE for: ${filePath}`);
    
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.deleteFile) {
          currentPromises.deleteFile = null;
          reject(new Error('Timeout waiting for delete response'));
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
        },
        filePath
      };
      
      const pathBytes = new TextEncoder().encode(filePath);
      const payloadLength = 1 + pathBytes.byteLength;
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);
      
      let offset = 0;
      view.setUint8(offset, CONSTANTS.CMD_ID.DELETE_FILE); offset++;
      view.setUint16(offset, payloadLength, true); offset += 2;
      view.setUint8(offset, pathBytes.byteLength); offset++;
      new Uint8Array(buffer, offset).set(pathBytes);
      
      try {
        await sendBleData(buffer);
      } catch (error) {
        clearTimeout(timeoutId);
        currentPromises.deleteFile = null;
        reject(error);
      }
    });
  }

  /**
   * 设置连接状态变更回调
   * @param {Function} callback - 回调函数
   */
  function onConnectionChanged(callback) {
    connectionChangedCallback = callback;
  }

  /**
   * 获取连接状态
   * @returns {boolean} 是否已连接
   */
  function getConnectionStatus() {
    return isConnected;
  }

  /**
   * 获取MTU大小
   * @returns {number} MTU大小（字节）
   */
  function getMtuSize() {
    return mtuSize;
  }

  // --- AGNSS 相关方法 ---
  
  /**
   * 开始AGNSS写入
   * @returns {Promise<void>}
   */
  async function startAgnssWrite() {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }
    
    logger.log(`Starting AGNSS write...`);
    
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.startAgnssWrite) {
          currentPromises.startAgnssWrite = null;
          reject(new Error('Timeout waiting for START_AGNSS_WRITE response'));
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
      
      try {
        await sendBleData(buffer);
      } catch (error) {
        clearTimeout(timeoutId);
        currentPromises.startAgnssWrite = null;
        reject(error);
      }
    });
  }

  /**
   * 写入AGNSS数据块
   * @param {Uint8Array} chunkData - 数据块
   * @returns {Promise<void>}
   */
  async function writeAgnssChunk(chunkData) {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }
    
    const chunkSize = chunkData.byteLength;
    logger.log(`Writing AGNSS chunk of ${chunkSize} bytes...`);
    
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.writeAgnssChunk) {
          currentPromises.writeAgnssChunk = null;
          reject(new Error('Timeout waiting for WRITE_AGNSS_CHUNK response'));
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

      const payloadLength = 2 + chunkSize; // Chunk Size (2B) + Data
      const buffer = new ArrayBuffer(1 + 2 + payloadLength);
      const view = new DataView(buffer);
      let offset = 0;

      view.setUint8(offset, CONSTANTS.CMD_ID.WRITE_AGNSS_CHUNK); offset++;
      view.setUint16(offset, payloadLength, true); offset += 2;
      view.setUint16(offset, chunkSize, true); offset += 2;
      new Uint8Array(buffer, offset).set(new Uint8Array(chunkData));

      try {
        await sendBleData(buffer);
      } catch (error) {
        clearTimeout(timeoutId);
        currentPromises.writeAgnssChunk = null;
        reject(error);
      }
    });
  }

  /**
   * 结束AGNSS写入
   * @returns {Promise<void>}
   */
  async function endAgnssWrite() {
    if (!isConnected) {
      return Promise.reject(new Error("Not connected"));
    }
    
    logger.log(`Ending AGNSS write...`);
    
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (currentPromises.endAgnssWrite) {
          currentPromises.endAgnssWrite = null;
          reject(new Error('Timeout waiting for END_AGNSS_WRITE response'));
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
      
      try {
        await sendBleData(buffer);
      } catch (error) {
        clearTimeout(timeoutId);
        currentPromises.endAgnssWrite = null;
        reject(error);
      }
    });
  }

  // 返回蓝牙服务接口
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
    endAgnssWrite
  };
}

export default initBleService;
