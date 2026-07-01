import { appendFileSync, statSync, renameSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  readonly path: string;
  debug(component: string, message: string, data?: Record<string, unknown>): void;
  info(component: string, message: string, data?: Record<string, unknown>): void;
  warn(component: string, message: string, data?: Record<string, unknown>): void;
  error(component: string, message: string, data?: Record<string, unknown>): void;
  tail(n: number): string[];
}

function fmtVal(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const clean = String(s).replace(/[\r\n]+/g, ' ');
  return /[\s"]/.test(clean) ? `"${clean.replace(/"/g, "'")}"` : clean;
}

export function formatLine(
  ts: string, level: LogLevel, component: string, message: string, data?: Record<string, unknown>,
): string {
  const parts = [ts, level.toUpperCase(), component, message.replace(/[\r\n]+/g, ' ')];
  if (data) for (const [k, v] of Object.entries(data)) parts.push(`${k}=${fmtVal(v)}`);
  return parts.join(' ');
}

export interface LoggerOptions { maxBytes?: number; echo?: boolean; }

export function createLogger(path: string, opts: LoggerOptions = {}): Logger {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const echo = opts.echo ?? true;
  mkdirSync(dirname(path), { recursive: true });

  const write = (level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void => {
    const line = formatLine(new Date().toISOString(), level, component, message, data);
    try {
      if (existsSync(path) && statSync(path).size >= maxBytes) renameSync(path, path + '.1');
      appendFileSync(path, line + '\n');
    } catch { /* logging must never throw into the app */ }
    if (echo) (level === 'error' ? console.error : console.log)(line);
  };

  return {
    path,
    debug: (c, m, d) => write('debug', c, m, d),
    info: (c, m, d) => write('info', c, m, d),
    warn: (c, m, d) => write('warn', c, m, d),
    error: (c, m, d) => write('error', c, m, d),
    tail(n: number): string[] {
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
      return lines.slice(-n);
    },
  };
}
