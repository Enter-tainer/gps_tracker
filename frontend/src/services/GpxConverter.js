/**
 * GPX 转换器服务
 * 负责将 GPS 轨迹点转换为 GPX 格式
 */
import { getElement } from '../utils/helpers.js';
import { UI_ELEMENTS } from '../utils/constants.js';

/**
 * 创建 GPX 转换器
 * @param {Object} logger - 日志服务
 * @returns {Object} GPX 转换器接口
 */
export function createGpxConverter(logger) {
  const gpxViewer = getElement(UI_ELEMENTS.GPX_VIEWER);

  /**
   * 将 GPS 轨迹点转换为 GPX 字符串
   * @param {Array} points - GPS 轨迹点数组
   * @param {string} fileName - 文件名，用于设置轨迹名称
   * @returns {string|null} GPX 格式字符串或 null（转换失败）
   */
  function pointsToGpxString(points, fileName) {
    if (!points || points.length === 0) {
      logger.error("No points to convert to GPX.");
      return null;
    }

    let gpx = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd"
    version="1.1" creator="MGT GPS">
  <metadata>
    <n>${fileName.replace(/\.[^/.]+$/, "")}</n>
    <time>${new Date(points[0].timestamp * 1000).toISOString()}</time>
  </metadata>
  <trk>
    <n>${fileName.replace(/\.[^/.]+$/, "")}</n>
    <trkseg>\n`;

    for (const point of points) {
      const lat = point.latitude_scaled_1e5 / 100000.0;
      const lon = point.longitude_scaled_1e5 / 100000.0;
      const ele = point.altitude_m_scaled_1e1 / 10.0;
      const time = new Date(point.timestamp * 1000).toISOString();

      // 基本坐标验证
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        logger.error(`Skipping invalid point in GPX: Lat ${lat}, Lon ${lon}`);
        continue;
      }

      gpx += `      <trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}">\n`;
      gpx += `        <ele>${ele.toFixed(1)}</ele>\n`;
      gpx += `        <time>${time}</time>\n`;
      gpx += `      </trkpt>\n`;
    }

    gpx += `    </trkseg>
  </trk>
</gpx>`;

    return gpx;
  }

  /**
   * 显示 GPX 轨迹
   * @param {string} gpxString - GPX 格式字符串
   * @param {string} fileName - 文件名
   */
  function displayGpx(gpxString, fileName) {
    if (!gpxViewer) {
      logger.error("GPX Viewer element not found");
      return;
    }
    
    if (typeof gpxViewer.setGpx === 'function') {
      gpxViewer.setGpx(gpxString);
      logger.log(`GPX loaded in viewer: ${fileName}`);
    } else {
      logger.error('gpx-viewer element not found or setGpx not available.');
    }
  }

  /**
   * 保存 GPX 轨迹为文件
   * @param {string} gpxString - GPX 格式字符串
   * @param {string} fileName - 文件名
   */
  function saveGpxFile(gpxString, fileName) {
    const blob = new Blob([gpxString], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    a.href = url;
    a.download = fileName.replace(/\.[^/.]+$/, '') + '.gpx';
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => { 
      document.body.removeChild(a); 
      URL.revokeObjectURL(url); 
    }, 100);
    
    logger.log(`GPX file downloaded: ${fileName}`);
  }

  // 返回 GPX 转换器接口
  return {
    pointsToGpxString,
    displayGpx,
    saveGpxFile
  };
}

export default createGpxConverter;