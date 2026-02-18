import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Default log directory: ~/.cclsp/logs */
const DEFAULT_LOG_DIR = join(homedir(), '.cclsp', 'logs');
const DEFAULT_LOG_FILE = join(DEFAULT_LOG_DIR, 'cclsp.log');

/** Max log file size before rotation (5 MB) */
const MAX_LOG_SIZE = 5 * 1024 * 1024;
/** Number of rotated files to keep */
const MAX_ROTATED_FILES = 3;
/** Check file size every N writes to avoid stat() on every line */
const ROTATION_CHECK_INTERVAL = 200;

class Logger {
  private logFile: string | null = null;
  private minLevel: LogLevel = 'info';
  private initialized = false;
  private writeCount = 0;

  /**
   * Initialize file-based logging.
   * Call once at startup.
   *
   * Log file location (in priority order):
   *   1. CCLSP_LOG_FILE env var — explicit path
   *   2. CCLSP_LOG=1 env var   — use default ~/.cclsp/logs/cclsp.log
   *   3. Default               — always log to ~/.cclsp/logs/cclsp.log
   *
   * Set CCLSP_LOG=0 to disable file logging entirely.
   * Set CCLSP_LOG_LEVEL to debug/info/warn/error (default: info).
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Determine log level first
    const level = process.env.CCLSP_LOG_LEVEL;
    if (level && level in LOG_LEVEL_PRIORITY) {
      this.minLevel = level as LogLevel;
    }

    // Check if logging is explicitly disabled
    if (process.env.CCLSP_LOG === '0') {
      return;
    }

    // Determine log file path
    const logFile = process.env.CCLSP_LOG_FILE || DEFAULT_LOG_FILE;

    try {
      mkdirSync(dirname(logFile), { recursive: true });
      // Rotate if the existing file is too large
      this.rotateIfNeeded(logFile);
      // Append a session separator instead of truncating
      appendFileSync(
        logFile,
        `\n${'='.repeat(80)}\n[${new Date().toISOString()}] New session (pid=${process.pid})\n${'='.repeat(80)}\n`
      );
      this.logFile = logFile;
      this.info('logger', `Logging to file: ${logFile}`);
    } catch (error) {
      process.stderr.write(`[cclsp] Failed to open log file ${logFile}: ${error}\n`);
    }
  }

  /**
   * Rotate log files if the current one exceeds MAX_LOG_SIZE.
   * Keeps up to MAX_ROTATED_FILES old logs:
   *   cclsp.log → cclsp.log.1 → cclsp.log.2 → cclsp.log.3 → deleted
   */
  private rotateIfNeeded(logFile: string): void {
    try {
      if (!existsSync(logFile)) return;
      const stats = statSync(logFile);
      if (stats.size < MAX_LOG_SIZE) return;

      // Shift existing rotated files: .3 → deleted, .2 → .3, .1 → .2
      for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
        const from = i === 1 ? logFile : `${logFile}.${i - 1}`;
        const to = `${logFile}.${i}`;
        if (existsSync(from)) {
          try {
            renameSync(from, to);
          } catch {
            // Best effort — if rename fails, continue
          }
        }
      }

      // Start fresh
      writeFileSync(logFile, '');
    } catch {
      // Best effort rotation — don't block startup
    }
  }

  /** Max length for a single log line (chars). Longer lines are truncated. */
  private static readonly MAX_LINE_LENGTH = 8000;

  private safeStringify(data: unknown): string {
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data);
    } catch {
      return `[unserializable: ${typeof data}]`;
    }
  }

  private write(level: LogLevel, component: string, message: string, data?: unknown): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${component}]`;
    const dataStr = data !== undefined ? ` ${this.safeStringify(data)}` : '';
    let line = `${prefix} ${message}${dataStr}\n`;

    // Truncate excessively long lines to prevent log file bloat
    if (line.length > Logger.MAX_LINE_LENGTH) {
      line = `${line.substring(0, Logger.MAX_LINE_LENGTH - 15)}… [truncated]\n`;
    }

    // Always write to stderr
    process.stderr.write(line);

    // Write to file if configured
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, line);
        // Periodically check if rotation is needed
        this.writeCount++;
        if (this.writeCount >= ROTATION_CHECK_INTERVAL) {
          this.writeCount = 0;
          this.rotateIfNeeded(this.logFile);
        }
      } catch {
        // Silently ignore file write errors to avoid cascading failures
      }
    }
  }

  debug(component: string, message: string, data?: unknown): void {
    this.write('debug', component, message, data);
  }

  info(component: string, message: string, data?: unknown): void {
    this.write('info', component, message, data);
  }

  warn(component: string, message: string, data?: unknown): void {
    this.write('warn', component, message, data);
  }

  error(component: string, message: string, data?: unknown): void {
    this.write('error', component, message, data);
  }
}

export const logger = new Logger();
