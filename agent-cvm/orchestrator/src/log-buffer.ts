/**
 * Log ring buffer — captures console output for diagnostic analysis.
 *
 * Circular buffer (200 entries) that intercepts console.log/error/warn
 * and copies output while preserving original behavior.
 */

export interface LogEntry {
  timestamp: number;
  level: 'log' | 'warn' | 'error';
  message: string;
}

const DEFAULT_CAPACITY = 200;

export class LogRingBuffer {
  private entries: LogEntry[] = [];
  private capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  push(entry: LogEntry): void {
    if (this.entries.length >= this.capacity) {
      this.entries.shift();
    }
    this.entries.push(entry);
  }

  getAll(): LogEntry[] {
    return [...this.entries];
  }

  /** Get entries within a time window (ms from now) */
  getRecent(windowMs: number): LogEntry[] {
    const cutoff = Date.now() - windowMs;
    return this.entries.filter((e) => e.timestamp >= cutoff);
  }

  /** Format entries as a readable string */
  format(entries?: LogEntry[]): string {
    const list = entries ?? this.entries;
    if (list.length === 0) return '(no log entries)';
    return list
      .map((e) => {
        const ts = new Date(e.timestamp).toISOString();
        return `[${ts}] [${e.level.toUpperCase()}] ${e.message}`;
      })
      .join('\n');
  }

  clear(): void {
    this.entries = [];
  }
}

/** Singleton buffer used by the orchestrator */
export const logBuffer = new LogRingBuffer();

/** Install monkey-patches on console.log/warn/error to capture output */
export function installLogCapture(): void {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  function capture(level: LogEntry['level'], origFn: typeof console.log, args: unknown[]): void {
    const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logBuffer.push({ timestamp: Date.now(), level, message });
    origFn.apply(console, args);
  }

  console.log = (...args: unknown[]) => capture('log', origLog, args);
  console.warn = (...args: unknown[]) => capture('warn', origWarn, args);
  console.error = (...args: unknown[]) => capture('error', origError, args);
}
