/**
 * AGNSS 服务模块
 * 负责下载星历数据并发送给设备
 */
import { UI_ELEMENTS } from '../utils/constants.js';
import { getElement } from '../utils/helpers.js';

/**
 * 初始化 AGNSS 服务
 * @param {Object} bleService - 蓝牙服务
 * @param {Object} logger - 日志服务
 * @returns {Object} AGNSS 服务接口
 */
export function initAgnssService(bleService, logger) {
  const agnssButton = getElement(UI_ELEMENTS.AGNSS_BUTTON);
  const agnssStatus = getElement(UI_ELEMENTS.AGNSS_STATUS);

  /**
   * 更新 AGNSS 状态显示
   * @param {string} status - 状态信息
   * @param {boolean} isVisible - 是否显示状态栏 
   */
  function updateStatus(status, isVisible = true) {
    if (agnssStatus) {
      agnssStatus.style.display = isVisible ? 'block' : 'none';
      agnssStatus.textContent = `AGNSS Status: ${status}`;
    }
  }

  /**
   * 下载并发送 AGNSS 数据
   */
  async function downloadAndSendAgnssData() {
    if (!bleService.isConnected()) {
      logger.error("Cannot send AGNSS data: Not connected.");
      return;
    }

    try {
      // 禁用按钮并显示状态
      if (agnssButton) {
        agnssButton.disabled = true;
        agnssButton.textContent = 'Processing...';
      }
      
      updateStatus('Downloading data...', true);
      logger.log("Starting AGNSS data download and processing...");

      // 调用 AGNSS 数据处理函数
      const result = await window.processAGNSSData();

      if (!result || !Array.isArray(result) || result.length === 0) {
        throw new Error("No AGNSS data received or invalid format");
      }

      logger.log(`Received ${result.length} AGNSS data chunks`);
      updateStatus(`Downloaded ${result.length} chunks, starting transfer...`);

      // 开始 AGNSS 写入
      await bleService.startAgnssWrite();
      logger.log("AGNSS write session started successfully");

      // 计算最大块大小（考虑 MTU 限制）
      const mtuSize = bleService.getMtuSize();
      const maxChunkSize = Math.max(16, Math.min(128, mtuSize - 8));
      logger.log(`Using max chunk size: ${maxChunkSize} bytes`);

      let totalChunks = 0;
      let totalBytes = 0;

      // 逐个发送 AGNSS 数据块
      for (let i = 0; i < result.length; i++) {
        const agnssData = result[i];
        if (!(agnssData instanceof Uint8Array)) {
          logger.error(`Warning: AGNSS data chunk ${i} is not Uint8Array, skipping`);
          continue;
        }

        updateStatus(`Sending chunk ${i + 1}/${result.length}...`);

        // 如果数据块太大，需要分片发送
        let offset = 0;
        while (offset < agnssData.length) {
          const chunkSize = Math.min(maxChunkSize, agnssData.length - offset);
          const chunk = agnssData.slice(offset, offset + chunkSize);

          await bleService.writeAgnssChunk(chunk);
          logger.log(`Sent AGNSS chunk ${totalChunks + 1}: ${chunkSize} bytes`);

          offset += chunkSize;
          totalChunks++;
          totalBytes += chunkSize;

          // 增加延迟以避免过载设备
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      // 结束 AGNSS 写入
      await bleService.endAgnssWrite();

      logger.log(`AGNSS data transfer completed successfully: ${totalChunks} chunks, ${totalBytes} bytes total`);
      updateStatus(`Transfer completed (${totalChunks} chunks, ${totalBytes} bytes)`);

    } catch (error) {
      logger.error(`AGNSS data transfer failed: ${error}`);
      updateStatus(`Transfer failed - ${error.message}`);
    } finally {
      // 恢复按钮状态
      if (agnssButton) {
        agnssButton.disabled = false;
        agnssButton.textContent = 'Download & Send AGNSS';
      }
      
      // 5秒后隐藏状态
      setTimeout(() => {
        updateStatus('Ready', false);
      }, 5000);
    }
  }

  // 绑定 AGNSS 按钮事件
  if (agnssButton) {
    agnssButton.onclick = downloadAndSendAgnssData;
  }

  // 返回 AGNSS 服务接口
  return {
    downloadAndSendAgnssData,
    updateStatus
  };
}

export default initAgnssService;