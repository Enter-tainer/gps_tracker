export default class AGNSSDataFetcher {
  baseUrl: string;

  constructor() {
    this.baseUrl = "https://agnss.mgt.moe/api/download";
  }

  async downloadEphemeris(filename = "gps_bds.eph", dir = "/") {
    const url = "https://agnss.mgt.moe/api/cached";

    try {
      console.log(`Downloading ephemeris from ${url}...`);

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      console.log(`Download complete: ${arrayBuffer.byteLength} bytes.`);

      return arrayBuffer;
    } catch (error) {
      console.error("Failed to download ephemeris:", error);
      throw error;
    }
  }

  arrayBufferToUint8Array(buffer: ArrayBuffer) {
    return new Uint8Array(buffer);
  }

  async saveToFile(data: ArrayBuffer, filename: string) {
    if (typeof window !== "undefined") {
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      throw new Error(`saveToFile is not supported outside the browser (attempted ${filename}).`);
    }
  }

  printHexDump(data: ArrayBuffer, maxBytes = 256) {
    const uint8Array = new Uint8Array(data);
    const bytesToShow = Math.min(uint8Array.length, maxBytes);

    console.log("Hex dump:");
    for (let i = 0; i < bytesToShow; i += 16) {
      const chunk = uint8Array.slice(i, i + 16);
      const hex = Array.from(chunk)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      const ascii = Array.from(chunk)
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : "."))
        .join("");
      console.log(`${i.toString(16).padStart(8, "0")}: ${hex.padEnd(47)} |${ascii}|`);
    }

    if (uint8Array.length > maxBytes) {
      console.log(`... (${uint8Array.length - maxBytes} more bytes)`);
    }
  }
}

