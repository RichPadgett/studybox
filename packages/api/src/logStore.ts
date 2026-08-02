import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogEntry, LogLevel, LogResult, LogSource } from "@studybox/shared";
import { projectPath } from "./paths.js";

export interface AuditLogInput {
  source: LogSource;
  level: LogLevel;
  message: string;
  action?: string;
  actor?: string;
  result?: LogResult;
  details?: Record<string, string | number | boolean | undefined>;
}

const logPath = projectPath("data", "audit-log.json");
const maxStoredEntries = 500;

export class LogStore {
  private logs: LogEntry[] = [];

  async load(): Promise<LogEntry[]> {
    try {
      const raw = await readFile(logPath, "utf8");
      this.logs = (JSON.parse(raw) as LogEntry[]).slice(0, maxStoredEntries);
    } catch {
      this.logs = [];
      await this.save();
    }

    return this.logs;
  }

  get(limit = 100): LogEntry[] {
    return this.logs.slice(0, limit);
  }

  async append(input: AuditLogInput): Promise<LogEntry> {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(),
      ...input
    };

    this.logs = [entry, ...this.logs].slice(0, maxStoredEntries);
    await this.save();
    return entry;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, JSON.stringify(this.logs, null, 2));
  }
}
