/**
 * AGNSS 数据获取模块
 * 用于从服务器下载星历数据
 */

class AGNSSDataFetcher {
  constructor() {
    this.baseUrl = 'https://agnss-server.mgt.workers.dev/api/download';
  }

  /**
   * 从服务器下载星历数据
   * @param {string} filename - 文件名，如 'gps_bds.eph'
   * @param {string} dir - 目录，如 '/'
   * @returns {Promise<ArrayBuffer>} 下载的数据
   */
  async downloadEphemeris(filename = 'gps_bds.eph', dir = '/') {
    // 使用用户指定的 API URL
    const url = `https://agnss-server.mgt.workers.dev/api/cached`;

    try {
      console.log(`正在从 ${url} 下载星历数据...`);

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP错误: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      console.log(`下载完成，数据大小: ${arrayBuffer.byteLength} 字节`);

      return arrayBuffer;

    } catch (error) {
      console.error('下载星历数据失败:', error);
      throw error;
    }
  }

  /**
   * 将 ArrayBuffer 转换为 Uint8Array
   * @param {ArrayBuffer} buffer 
   * @returns {Uint8Array}
   */
  arrayBufferToUint8Array(buffer) {
    return new Uint8Array(buffer);
  }

  /**
   * 将数据保存到本地文件
   * @param {ArrayBuffer} data 
   * @param {string} filename 
   */
  async saveToFile(data, filename) {
    if (typeof window !== 'undefined') {
      // 浏览器环境
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      // Node.js环境
      const fs = require('fs').promises;
      const buffer = Buffer.from(data);
      await fs.writeFile(filename, buffer);
      console.log(`数据已保存到: ${filename}`);
    }
  }

  /**
   * 打印数据的十六进制表示（用于调试）
   * @param {ArrayBuffer} data 
   * @param {number} maxBytes - 最多显示的字节数
   */
  printHexDump(data, maxBytes = 256) {
    const uint8Array = new Uint8Array(data);
    const bytesToShow = Math.min(uint8Array.length, maxBytes);

    console.log('数据十六进制表示:');
    for (let i = 0; i < bytesToShow; i += 16) {
      const chunk = uint8Array.slice(i, i + 16);
      const hex = Array.from(chunk)
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
      const ascii = Array.from(chunk)
        .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
        .join('');
      console.log(`${i.toString(16).padStart(8, '0')}: ${hex.padEnd(47)} |${ascii}|`);
    }

    if (uint8Array.length > maxBytes) {
      console.log(`... (还有 ${uint8Array.length - maxBytes} 字节)`);
    }
  }
}

// 导出模块
export default AGNSSDataFetcher;