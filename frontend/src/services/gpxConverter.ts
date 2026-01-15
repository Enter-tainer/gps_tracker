import type { Logger } from "../hooks/useLogger";
import type { GpsPoint } from "./gpsDecoder";

export type GpxPreviewer = (gpxString: string, fileName: string) => void;

export function createGpxConverter(logger: Logger, previewer?: GpxPreviewer) {
  function pointsToGpxString(points: GpsPoint[], fileName: string) {
    if (!points || points.length === 0) {
      logger.error("No points to convert to GPX.");
      return null;
    }

    const title = fileName.replace(/\.[^/.]+$/, "");

    let gpx = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n`;
    gpx += `<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n`;
    gpx += `  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd"\n`;
    gpx += `  version="1.1" creator="MGT GPS">\n`;
    gpx += `  <metadata>\n`;
    gpx += `    <name>${title}</name>\n`;
    gpx += `    <time>${new Date(points[0].timestamp * 1000).toISOString()}</time>\n`;
    gpx += `  </metadata>\n`;
    gpx += `  <trk>\n`;
    gpx += `    <name>${title}</name>\n`;
    gpx += `    <trkseg>\n`;

    for (const point of points) {
      const lat = point.latitude_scaled_1e5 / 100000.0;
      const lon = point.longitude_scaled_1e5 / 100000.0;
      const ele = point.altitude_m_scaled_1e1 / 10.0;
      const time = new Date(point.timestamp * 1000).toISOString();

      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        logger.error(`Skipping invalid point in GPX: Lat ${lat}, Lon ${lon}`);
        continue;
      }

      gpx += `      <trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}">\n`;
      gpx += `        <ele>${ele.toFixed(1)}</ele>\n`;
      gpx += `        <time>${time}</time>\n`;
      gpx += `      </trkpt>\n`;
    }

    gpx += `    </trkseg>\n`;
    gpx += `  </trk>\n`;
    gpx += `</gpx>`;

    return gpx;
  }

  function displayGpx(gpxString: string, fileName: string) {
    if (!previewer) {
      logger.error("GPX previewer is not available.");
      return;
    }

    previewer(gpxString, fileName);
  }

  function saveGpxFile(gpxString: string, fileName: string) {
    const blob = new Blob([gpxString], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = `${fileName.replace(/\.[^/.]+$/, "")}.gpx`;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);

    logger.log(`GPX file downloaded: ${fileName}`);
  }

  return {
    pointsToGpxString,
    displayGpx,
    saveGpxFile
  };
}

export default createGpxConverter;

