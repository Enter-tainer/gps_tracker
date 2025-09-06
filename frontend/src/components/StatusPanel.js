/**
 * 状态面板组件
 * 负责显示设备连接状态和系统信息
 */
import { UI_ELEMENTS } from '../utils/constants.js';
import { getElement } from '../utils/helpers.js';

/**
 * 初始化状态面板组件
 * @param {Object} bleService - 蓝牙服务
 * @param {Object} logger - 日志服务
 * @returns {Object} 状态面板接口
 */
export function initStatusPanel(bleService, logger) {
  // 获取相关DOM元素
  const statusDiv = getElement(UI_ELEMENTS.STATUS_DIV);
  const connectButton = getElement(UI_ELEMENTS.CONNECT_BUTTON);
  const sysInfoButton = getElement(UI_ELEMENTS.SYS_INFO_BUTTON);
  const agnssButton = getElement(UI_ELEMENTS.AGNSS_BUTTON);
  const agnssStatus = getElement(UI_ELEMENTS.AGNSS_STATUS);
  
  // 创建GPS唤醒按钮
  const gpsWakeupButton = document.createElement('button');
  gpsWakeupButton.id = 'gpsWakeupButton';
  gpsWakeupButton.className = 'btn btn-warning';
  gpsWakeupButton.textContent = '唤醒GPS';
  gpsWakeupButton.disabled = true;
  gpsWakeupButton.style.marginLeft = '10px';
  
  // 初始化连接按钮事件
  if (connectButton) {
    connectButton.onclick = () => {
      if (bleService.isConnected()) {
        bleService.disconnect();
      } else {
        bleService.connect();
      }
    };
  }

  // 初始化GPS唤醒按钮事件
  gpsWakeupButton.onclick = async () => {
    gpsWakeupButton.disabled = true;
    gpsWakeupButton.textContent = '唤醒中...';
    
    try {
      await bleService.triggerGpsWakeup();
      logger.log('GPS唤醒命令发送成功');
      
      // 短暂显示成功状态
      gpsWakeupButton.textContent = '唤醒成功!';
      gpsWakeupButton.className = 'btn btn-success';
      
      // 2秒后恢复原状
      setTimeout(() => {
        gpsWakeupButton.textContent = '唤醒GPS';
        gpsWakeupButton.className = 'btn btn-warning';
        gpsWakeupButton.disabled = false;
      }, 2000);
      
    } catch (error) {
      logger.error(`GPS唤醒失败: ${error}`);
      
      // 显示错误状态
      gpsWakeupButton.textContent = '唤醒失败';
      gpsWakeupButton.className = 'btn btn-danger';
      
      // 2秒后恢复原状
      setTimeout(() => {
        gpsWakeupButton.textContent = '唤醒GPS';
        gpsWakeupButton.className = 'btn btn-warning';
        gpsWakeupButton.disabled = false;
      }, 2000);
    }
  };

  // 初始化系统信息查询按钮事件
  if (sysInfoButton) {
    sysInfoButton.onclick = async () => {
      const errorDiv = getElement('sysinfo-error');
      sysInfoButton.disabled = true;
      sysInfoButton.textContent = '查询中...';
      
      if (errorDiv) {
        errorDiv.innerText = '';
      }
      
      try {
        const info = await bleService.getSysInfo();
        updateSysInfoCard(info);
      } catch (e) {
        updateSysInfoCard(null);
        if (errorDiv) {
          errorDiv.innerText = '查询失败: ' + e;
        }
        logger.error(`查询系统信息失败: ${e}`);
      } finally {
        sysInfoButton.disabled = false;
        sysInfoButton.textContent = 'Query Status';
      }
    };
  }

  /**
   * 更新连接状态显示
   * @param {boolean} isConnected - 是否已连接
   * @param {string} deviceName - 设备名称
   */
  function updateConnectionStatus(isConnected, deviceName = '') {
    if (connectButton) {
      connectButton.textContent = isConnected ? 'Disconnect' : 'Connect to Device';
    }
    
    if (statusDiv) {
      statusDiv.textContent = isConnected ? `Connected to ${deviceName || 'device'}` : 'Disconnected';
    }
    
    // 启用或禁用相关按钮
    if (sysInfoButton) {
      sysInfoButton.disabled = !isConnected;
    }
    
    if (agnssButton) {
      agnssButton.disabled = !isConnected;
    }
    
    // 启用或禁用目录列表按钮
    const listDirButton = document.getElementById(UI_ELEMENTS.LIST_DIR_BUTTON);
    if (listDirButton) {
      listDirButton.disabled = !isConnected;
    }
    
    // 启用或禁用GPS唤醒按钮
    gpsWakeupButton.disabled = !isConnected;
  }

  /**
   * 更新系统信息卡片
   * @param {Object} info - 系统信息对象
   */
  function updateSysInfoCard(info) {
    const gpsStateMap = ['初始化中', "搜索中", "已关机", "已定位", "分析静止状态", "传输AGNSS数据中"];
    const yesNo = v => v ? '是' : '否';
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.innerText = val;
    };
    
    if (!info) {
      [
        'latitude', 'longitude', 'altitude', 'satellites', 'hdop', 
        'speed', 'course', 'date', 'time', 'locationValid', 
        'dateTimeValid', 'batteryVoltage', 'gpsState'
      ].forEach(id => set('sysinfo-' + id, '-'));
      return;
    }
    
    set('sysinfo-latitude', info.latitude.toFixed(7) + '°');
    set('sysinfo-longitude', info.longitude.toFixed(7) + '°');
    set('sysinfo-altitude', info.altitude.toFixed(1) + 'm');
    set('sysinfo-satellites', info.satellites);
    set('sysinfo-hdop', info.hdop.toFixed(2));
    set('sysinfo-speed', info.speed.toFixed(2) + 'km/h');
    set('sysinfo-course', info.course.toFixed(2) + '°');
    set('sysinfo-date', `${info.year}-${String(info.month).padStart(2, '0')}-${String(info.day).padStart(2, '0')}`);
    set('sysinfo-time', `${String(info.hour).padStart(2, '0')}:${String(info.minute).padStart(2, '0')}:${String(info.second).padStart(2, '0')}`);
    set('sysinfo-locationValid', yesNo(info.locationValid));
    set('sysinfo-dateTimeValid', yesNo(info.dateTimeValid));
    set('sysinfo-batteryVoltage', info.batteryVoltage.toFixed(2) + 'V');
    set('sysinfo-gpsState', gpsStateMap[info.gpsState] || info.gpsState);
  }

  /**
   * 更新AGNSS状态
   * @param {string} status - 状态信息
   * @param {boolean} isVisible - 是否显示状态栏
   */
  function updateAgnssStatus(status, isVisible = true) {
    if (agnssStatus) {
      agnssStatus.style.display = isVisible ? 'block' : 'none';
      agnssStatus.textContent = `AGNSS Status: ${status}`;
    }
  }

  // 监听蓝牙连接状态变化
  bleService.onConnectionChanged((isConnected, deviceName) => {
    updateConnectionStatus(isConnected, deviceName);
    
    // 断开连接时清除系统信息
    if (!isConnected) {
      updateSysInfoCard(null);
    }
  });

  // 初始化状态显示
  updateConnectionStatus(false);
  updateSysInfoCard(null);
  
  // 将GPS唤醒按钮添加到页面
  if (sysInfoButton && sysInfoButton.parentNode) {
    sysInfoButton.parentNode.appendChild(gpsWakeupButton);
  }
  
  // 返回状态面板接口
  return {
    updateConnectionStatus,
    updateSysInfoCard,
    updateAgnssStatus
  };
}

export default initStatusPanel;