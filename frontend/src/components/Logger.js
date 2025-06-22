/**
 * 日志组件模块
 * 负责记录应用程序消息并显示在UI上
 */
import { UI_ELEMENTS } from '../utils/constants.js';
import { getTimeString, getElement } from '../utils/helpers.js';

/**
 * 初始化日志组件
 * @returns {Object} 日志组件接口
 */
export function initLogger() {
  const messagesDiv = getElement(UI_ELEMENTS.MESSAGES_DIV);
  
  /**
   * 记录消息
   * @param {string} message - 要记录的消息
   * @param {boolean} isError - 是否为错误消息
   */
  function log(message, isError = false) {
    const time = getTimeString();
    
    if (messagesDiv) {
      messagesDiv.innerHTML += `<div style="${isError ? 'color:red;' : ''}">[${time}] ${message}</div>`;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
    
    if (isError) {
      console.error(`[Log] ${message}`);
    } else {
      console.log(`[Log] ${message}`);
    }
  }

  /**
   * 清除日志
   */
  function clear() {
    if (messagesDiv) {
      messagesDiv.innerHTML = '';
    }
  }

  // 返回日志组件接口
  return {
    log,
    error: (message) => log(message, true),
    clear
  };
}

export default initLogger;