import { useCallback, useMemo, useState } from "react";
import { getTimeString } from "../utils/helpers";

export type LogLevel = "info" | "error" | "success";

export type LogEntry = {
  id: string;
  time: string;
  message: string;
  level: LogLevel;
};

export type Logger = {
  log: (message: string) => void;
  error: (message: string) => void;
  success: (message: string) => void;
};

const createId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function useLogger(maxEntries = 320) {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  const append = useCallback(
    (message: string, level: LogLevel = "info") => {
      const entry: LogEntry = {
        id: createId(),
        time: getTimeString(),
        message,
        level
      };

      const prefix = `[${entry.time}] ${entry.level.toUpperCase()}:`;
      if (typeof console !== "undefined") {
        if (entry.level === "error") {
          console.error(prefix, entry.message);
        } else if (entry.level === "success") {
          console.info(prefix, entry.message);
        } else {
          console.log(prefix, entry.message);
        }
      }

      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > maxEntries ? next.slice(-maxEntries) : next;
      });
    },
    [maxEntries]
  );

  const logger = useMemo<Logger>(
    () => ({
      log: (message) => append(message, "info"),
      error: (message) => append(message, "error"),
      success: (message) => append(message, "success")
    }),
    [append]
  );

  const clear = useCallback(() => setEntries([]), []);

  return { entries, logger, clear };
}

