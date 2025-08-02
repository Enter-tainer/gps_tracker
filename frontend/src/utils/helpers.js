/**
 * 通用辅助函数
 */

/**
 * 将字节数组转换为十六进制字符串表示
 * @param {Uint8Array} bytes - 要转换的字节数组
 * @returns {string} - 十六进制字符串
 */
export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
}

/**
 * 创建带有指定属性的DOM元素
 * @param {string} tag - 元素标签名
 * @param {Object} props - 元素属性
 * @param {string|Node} [content] - 文本内容或子节点
 * @returns {HTMLElement} - 创建的DOM元素
 */
export function createElement(tag, props = {}, content) {
  const element = document.createElement(tag);
  
  // 设置属性
  for (const [key, value] of Object.entries(props)) {
    if (key === 'style' && typeof value === 'object') {
      Object.assign(element.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.substring(2).toLowerCase(), value);
    } else {
      element[key] = value;
    }
  }
  
  // 设置内容
  if (content) {
    if (typeof content === 'string') {
      element.textContent = content;
    } else {
      element.appendChild(content);
    }
  }
  
  return element;
}

/**
 * 格式化时间戳为本地时间字符串
 * @returns {string} 格式化的时间字符串
 */
export function getTimeString() {
  return new Date().toLocaleTimeString();
}

/**
 * 安全地获取DOM元素，如果不存在则记录错误
 * @param {string} id - 元素ID
 * @returns {HTMLElement|null} - DOM元素或null
 */
export function getElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    console.error(`Element with ID '${id}' not found`);
  }
  return element;
}

/**
 * 智能格式化文件大小，自动转换为合适的单位
 * @param {number|null|undefined} bytes - 文件大小（字节）
 * @returns {string} - 格式化后的文件大小字符串
 */
export function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || bytes < 0) {
    return 'N/A';
  }

  // 定义单位
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  
  // 处理0字节的情况
  if (bytes === 0) {
    return '0 B';
  }

  // 计算合适的单位
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  // 确保不会超出单位范围
  const unitIndex = Math.min(i, units.length - 1);
  
  // 计算数值并保留合适的小数位
  const size = bytes / Math.pow(k, unitIndex);
  
  // 根据大小决定小数位精度
  let precision;
  if (unitIndex === 0) {
    precision = 0; // 字节不需要小数位
  } else if (unitIndex >= 3) {
    precision = 1; // GB及以上保留1位小数
  } else {
    precision = 2; // KB和MB保留2位小数
  }
  
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}