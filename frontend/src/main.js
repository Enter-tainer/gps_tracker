// 导入服务和组件
import { initBleService } from './services/BleService.js';
import { initFileService } from './services/FileService.js';
import { initStatusPanel } from './components/StatusPanel.js';
import { initFileExplorer } from './components/FileExplorer.js';
import { initLogger } from './components/Logger.js';
import { initAgnssService } from './services/AgnssService.js';
import { CONSTANTS } from './utils/constants.js';

// 导入 GPXViewer 组件
import 'gpx_viewer';

// 导入 AGNSS 模块（确保全局可用）
import { processAGNSSData, getBrowserLocation } from './modules/agnss/CasicAgnssProcessor.js';

// 初始化所有服务和组件
document.addEventListener('DOMContentLoaded', () => {
  console.log('Initializing application...');

  // 检查 Web Bluetooth 支持
  if (!navigator.bluetooth) {
    console.error("Web Bluetooth API is not available in this browser.");
    document.getElementById('status').textContent = "Web Bluetooth not supported.";
    document.getElementById('connectButton').disabled = true;
    return;
  }

  // 初始化日志组件
  const logger = initLogger();
  
  // 初始化蓝牙服务
  const bleService = initBleService(logger);
  
  // 初始化文件服务
  const fileService = initFileService(bleService, logger);
  
  // 初始化状态面板
  const statusPanel = initStatusPanel(bleService, logger);
  
  // 初始化文件浏览器
  const fileExplorer = initFileExplorer(fileService, logger);
  
  // 初始化 AGNSS 服务
  const agnssService = initAgnssService(bleService, logger);
  
  // 将 AGNSS 处理函数暴露给全局
  window.processAGNSSData = processAGNSSData;
  window.getBrowserLocation = getBrowserLocation;
  
  // 记录初始化完成
  logger.log("Page loaded. Ready to connect.");
});