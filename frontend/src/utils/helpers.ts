export function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

export function getTimeString() {
  return new Date().toLocaleTimeString();
}

export function formatFileSize(bytes?: number | null) {
  if (bytes === null || bytes === undefined || bytes < 0) {
    return "N/A";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];

  if (bytes === 0) {
    return "0 B";
  }

  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const unitIndex = Math.min(i, units.length - 1);
  const size = bytes / Math.pow(k, unitIndex);

  let precision = 2;
  if (unitIndex === 0) {
    precision = 0;
  } else if (unitIndex >= 3) {
    precision = 1;
  }

  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

