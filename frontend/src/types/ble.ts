export type EntryType = 0 | 1;

export type FileEntry = {
  name: string;
  type: EntryType;
  size: number | null;
  path: string;
};

export type SysInfo = {
  latitude: number;
  longitude: number;
  altitude: number;
  satellites: number;
  hdop: number;
  speed: number;
  course: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  locationValid: number;
  dateTimeValid: number;
  batteryVoltage: number;
  gpsState: number;
  keepAliveRemainingS?: number;
  version?: number;
  batteryPercent?: number;
  isStationary?: number;
  temperatureC?: number;
  pressurePa?: number;
};

