/**
 * 文件服务模块
 * 负责文件系统操作，如列目录、读取文件等
 */
import { UI_ELEMENTS, CONSTANTS } from '../utils/constants.js';
import { getElement, formatFileSize } from '../utils/helpers.js';
import { createGpsDecoder } from './GpsDecoder.js';
import { createGpxConverter } from './GpxConverter.js';

/**
 * 初始化文件服务
 * @param {Object} bleService - 蓝牙服务
 * @param {Object} logger - 日志服务
 * @returns {Object} 文件服务接口
 */
export function initFileService(bleService, logger) {
  // 创建GPS解码器和GPX转换器
  const gpsDecoder = createGpsDecoder();
  const gpxConverter = createGpxConverter(logger);
  
  // 获取UI元素
  const fileListDiv = getElement(UI_ELEMENTS.FILE_LIST_DIV);
  const statusDiv = getElement(UI_ELEMENTS.STATUS_DIV);
  const listDirButton = getElement(UI_ELEMENTS.LIST_DIR_BUTTON);
  const currentPathInput = getElement(UI_ELEMENTS.CURRENT_PATH_INPUT);

  /**
   * 清空文件列表
   */
  function clearFileList() {
    if (fileListDiv) {
      fileListDiv.innerHTML = '';
    }
  }

  /**
   * 添加文件条目到列表
   * @param {string} name - 文件名
   * @param {number} type - 条目类型（文件/目录）
   * @param {number} size - 文件大小（仅对文件有效）
   * @param {string} path - 条目路径
   */
  function addFileEntry(name, type, size, path) {
    if (!fileListDiv) return;
    
    const entryDiv = document.createElement('div');
    entryDiv.className = 'file-entry';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';

    if (type === CONSTANTS.ENTRY_TYPE.DIRECTORY) {
      nameSpan.textContent = `${name} (Dir)`;
      nameSpan.className += ' dir-item-name';
      nameSpan.title = `Click to navigate to ${name}`;
      nameSpan.onclick = () => navigateToDirectory(path, name);
      entryDiv.appendChild(nameSpan);
    } else { // File
      nameSpan.textContent = `${name} (${formatFileSize(size)})`;
      nameSpan.className += ' file-item-name';
      entryDiv.appendChild(nameSpan);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'file-actions';

      const downloadRawButton = document.createElement('button');
      downloadRawButton.textContent = 'Download Raw';
      downloadRawButton.className = 'action-button';
      downloadRawButton.onclick = () => downloadFile(path, name, size);
      actionsDiv.appendChild(downloadRawButton);

      const downloadGpxButton = document.createElement('button');
      downloadGpxButton.textContent = 'Download as GPX';
      downloadGpxButton.className = 'action-button';
      const previewGpxButton = document.createElement('button');
      previewGpxButton.textContent = 'Preview GPX';
      previewGpxButton.className = 'action-button';
      downloadGpxButton.onclick = () => downloadAndConvertToGpx(path, name, size, true);
      previewGpxButton.onclick = () => downloadAndConvertToGpx(path, name, size, false);
      actionsDiv.appendChild(downloadGpxButton);
      actionsDiv.appendChild(previewGpxButton);

      // 添加删除按钮
      const deleteButton = document.createElement('button');
      deleteButton.textContent = 'Delete';
      deleteButton.className = 'action-button';
      deleteButton.style.backgroundColor = '#dc3545';
      deleteButton.style.color = 'white';
      deleteButton.onclick = async () => {
        if (!confirm(`Are you sure you want to delete file: ${name}?`)) return;
        if (!confirm(`Double check: Delete file "${name}"? This cannot be undone!`)) return;
        try {
          await deleteFile(path);
          logger.log(`File deleted: ${name}`);
          await listDirectory(currentPathInput.value);
        } catch (e) {
          logger.error(`Delete failed: ${e}`);
        }
      };
      actionsDiv.appendChild(deleteButton);

      entryDiv.appendChild(actionsDiv);
    }
    fileListDiv.appendChild(entryDiv);
  }

  /**
   * 导航到目录
   * @param {string} currentFullPath - 当前完整路径
   * @param {string} dirNameClicked - 点击的目录名
   */
  function navigateToDirectory(currentFullPath, dirNameClicked) {
    let newPath;
    if (dirNameClicked === "..") {
      if (currentFullPath === "/" || !currentFullPath.includes('/')) {
        newPath = "/";
      } else {
        // currentFullPath 已经是 ".." 条目的父目录路径
        newPath = currentFullPath;
      }
    } else {
      newPath = currentFullPath;
    }
    
    newPath = newPath.replace(/\/\//g, '/'); // 规范化路径
    if (newPath !== "/" && newPath.endsWith("/")) newPath = newPath.slice(0, -1); // 移除末尾斜杠（除了根目录）
    if (newPath === "") newPath = "/";

    if (currentPathInput) {
      currentPathInput.value = newPath;
    }
    
    listDirectory(newPath);
  }

  /**
   * 列出目录内容
   * @param {string} path - 要列出的目录路径
   * @returns {Promise<Array>} 目录条目数组
   */
  async function listDirectory(path) {
    if (!bleService.isConnected()) {
      logger.error("Cannot list directory: Not connected.");
      return Promise.reject("Not connected");
    }
    
    if (currentPathInput) {
      currentPathInput.value = path;
    }
    
    clearFileList();
    if (path !== "/") { // 添加 ".." 条目用于向上导航（根目录除外）
      addFileEntry("..", CONSTANTS.ENTRY_TYPE.DIRECTORY, null, path.substring(0, path.lastIndexOf('/')) || "/");
    }
    
    logger.log(`Listing directory: ${path}...`);
    if (listDirButton) listDirButton.disabled = true;
    
    try {
      // 调用蓝牙服务的列目录方法，传入回调函数
      const entries = await bleService.listDirectory(
        path,
        // 每接收到一个条目时的回调
        (name, type, size, entryPath) => {
          addFileEntry(name, type, size, entryPath);
        },
        // 目录为空时的回调
        () => {
          if (fileListDiv) {
            fileListDiv.innerHTML += `<div>Directory is empty or no entries found.</div>`;
          }
        }
      );
      
      return entries;
    } catch (error) {
      logger.error(`Error listing directory: ${error}`);
      return Promise.reject(error);
    } finally {
      if (listDirButton) listDirButton.disabled = false;
    }
  }

  /**
   * 下载文件核心逻辑
   * @param {string} filePath - 文件路径
   * @param {string} fileName - 文件名
   * @param {number} expectedSize - 预期文件大小
   * @returns {Promise<ArrayBuffer>} 文件数据
   */
  async function downloadFileCore(filePath, fileName, expectedSize) {
    if (!bleService.isConnected()) {
      logger.error("Cannot download: Not connected.");
      return Promise.reject(new Error("Not connected"));
    }
    
    logger.log(`Starting raw download for: ${filePath} (Size: ${expectedSize} bytes)`);
    if (listDirButton) listDirButton.disabled = true;
    
    try {
      const { fileSize: openedFileSize } = await bleService.openFile(filePath);
      let effectiveFileSize = openedFileSize;
      
      if (expectedSize !== null && openedFileSize !== expectedSize) {
        logger.log(`Warning: Opened file size (${openedFileSize}) differs from listed size (${expectedSize}). Using opened size.`);
      } else if (expectedSize !== null) {
        effectiveFileSize = expectedSize; // 如果一致则使用列出的大小
      }
      
      logger.log(`File opened: ${filePath}, Effective Size: ${effectiveFileSize} bytes.`);

      let receivedBytes = 0;
      const fileChunks = [];
      // 计算请求块大小（考虑MTU限制）
      const mtuSize = bleService.getMtuSize();
      const CHUNK_SIZE_TO_REQUEST = Math.max(16, Math.min(251, mtuSize - 10));
      logger.log(`Requesting chunks of size: ${CHUNK_SIZE_TO_REQUEST}`);

      while (receivedBytes < effectiveFileSize) {
        const bytesToRead = Math.min(CHUNK_SIZE_TO_REQUEST, effectiveFileSize - receivedBytes);
        if (bytesToRead <= 0) break;

        if (statusDiv) {
          statusDiv.textContent = `Downloading ${fileName}: ${Math.round((receivedBytes / effectiveFileSize) * 100)}%`;
        }
        
        const { actualBytesRead, data } = await bleService.readFileChunk(receivedBytes, bytesToRead);

        if (actualBytesRead > 0 && data) {
          fileChunks.push(data);
          receivedBytes += actualBytesRead;
          logger.log(`Downloaded ${receivedBytes} / ${effectiveFileSize} bytes...`);
        } else {
          logger.log("Reached EOF or read error (actualBytesRead is 0 or no data).");
          if (receivedBytes < effectiveFileSize) {
            logger.error(`Warning: Download ended prematurely. Expected ${effectiveFileSize}, got ${receivedBytes}.`);
          }
          break;
        }
      }
      
      if (statusDiv) {
        statusDiv.textContent = `Downloaded ${fileName}: ${Math.round((receivedBytes / effectiveFileSize) * 100)}% Complete.`;
      }

      if (fileChunks.length > 0) {
        const totalReceived = fileChunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
        if (totalReceived !== receivedBytes) { // 完整性检查
          logger.error(`Internal Mismatch: receivedBytes=${receivedBytes}, chunksTotal=${totalReceived}`);
        }
        
        // 合并数据块
        const finalBuffer = new Uint8Array(totalReceived);
        let currentOffset = 0;
        for (const chunk of fileChunks) {
          finalBuffer.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), currentOffset);
          currentOffset += chunk.byteLength;
        }
        
        return finalBuffer.buffer;
      } else if (effectiveFileSize === 0 && receivedBytes === 0) {
        logger.log("Downloaded an empty file successfully.");
        return new ArrayBuffer(0);
      }
      else {
        throw new Error(`Download failed or file empty. Received ${receivedBytes} of ${effectiveFileSize} bytes.`);
      }

    } catch (error) {
      logger.error(`Error during raw download of ${filePath}: ${error}`);
      if (statusDiv) statusDiv.textContent = `Error downloading ${filePath}`;
      throw error;
    } finally {
      try {
        await bleService.closeFile();
        logger.log("File closed after raw download attempt for " + filePath);
      } catch (closeError) {
        logger.error(`Error closing file after raw download of ${filePath}: ${closeError}`);
      }
      
      if (listDirButton) listDirButton.disabled = false;
      if (statusDiv && bleService.isConnected()) {
        statusDiv.textContent = `Connected to device`;
      }
    }
  }

  /**
   * 下载原始文件
   * @param {string} filePath - 文件路径
   * @param {string} fileName - 文件名
   * @param {number} expectedSize - 预期文件大小
   */
  async function downloadFile(filePath, fileName, expectedSize) {
    try {
      const rawFileBuffer = await downloadFileCore(filePath, fileName, expectedSize);
      if (rawFileBuffer) {
        const fileBlob = new Blob([rawFileBuffer]);
        const downloadUrl = URL.createObjectURL(fileBlob);
        const a = document.createElement('a');
        
        a.href = downloadUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        
        URL.revokeObjectURL(downloadUrl);
        a.remove();
        
        logger.log(`Raw file "${fileName}" saved.`);
        if (statusDiv) statusDiv.textContent = `Saved ${fileName}`;
      }
    } catch (error) {
      logger.error(`Overall download process for ${fileName} failed: ${error}`);
    }
  }

  /**
   * 下载并转换为GPX
   * @param {string} filePath - 文件路径
   * @param {string} fileName - 文件名
   * @param {number} expectedSize - 预期文件大小
   * @param {boolean} download - 是否下载（true）或预览（false）
   */
  async function downloadAndConvertToGpx(filePath, fileName, expectedSize, download) {
    try {
      if (statusDiv) {
        statusDiv.textContent = `Downloading ${fileName} for GPX conversion...`;
      }
      
      const rawFileBuffer = await downloadFileCore(filePath, fileName, expectedSize);
      if (!rawFileBuffer) {
        logger.error(`GPX Conversion: Failed to download raw data for ${fileName}.`);
        if (statusDiv) statusDiv.textContent = `GPX conversion failed for ${fileName}.`;
        return;
      }
      
      // 解码为轨迹点
      const points = gpsDecoder.decode(rawFileBuffer);
      if (!points || points.length === 0) {
        logger.error(`GPX Conversion: No valid points decoded for ${fileName}.`);
        if (statusDiv) statusDiv.textContent = `No valid points for GPX conversion in ${fileName}.`;
        return;
      }
      
      // 转为GPX字符串
      const gpxString = gpxConverter.pointsToGpxString(points, fileName);
      if (!gpxString) {
        logger.error(`GPX Conversion: Failed to convert points to GPX for ${fileName}.`);
        if (statusDiv) statusDiv.textContent = `GPX conversion failed for ${fileName}.`;
        return;
      }
      
      if (download) {
        // 下载GPX
        gpxConverter.saveGpxFile(gpxString, fileName);
      } else {
        // 预览GPX
        gpxConverter.displayGpx(gpxString, fileName);
      }
    } catch (e) {
      logger.error(`GPX conversion/preview failed: ${e}`);
      if (statusDiv) statusDiv.textContent = `GPX conversion/preview failed: ${e}`;
    }
  }

  /**
   * 删除文件
   * @param {string} filePath - 文件路径
   * @returns {Promise<void>}
   */
  async function deleteFile(filePath) {
    return bleService.deleteFile(filePath);
  }

  // 初始化事件绑定
  if (listDirButton) {
    listDirButton.onclick = () => {
      const path = currentPathInput ? currentPathInput.value : '/';
      listDirectory(path);
    };
  }

  // 返回文件服务接口
  return {
    listDirectory,
    downloadFile,
    downloadAndConvertToGpx,
    deleteFile
  };
}

export default initFileService;
