import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PendingSessionWrapup {
  version: 1;
  recordingIds: string[];
  createdAt: string;
  updatedAt: string;
}

export class SessionWrapupStore {
  private state?: PendingSessionWrapup;

  constructor(private readonly path: string) {}

  async load(): Promise<PendingSessionWrapup | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<PendingSessionWrapup>;
      const recordingIds = Array.isArray(parsed.recordingIds)
        ? [...new Set(parsed.recordingIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))]
        : [];
      if (parsed.version !== 1 || !recordingIds.length) {
        this.state = undefined;
        return undefined;
      }
      this.state = {
        version: 1,
        recordingIds,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
      };
      return this.get();
    } catch {
      this.state = undefined;
      return undefined;
    }
  }

  get(): PendingSessionWrapup | undefined {
    return this.state ? { ...this.state, recordingIds: [...this.state.recordingIds] } : undefined;
  }

  async save(recordingIds: string[]): Promise<PendingSessionWrapup | undefined> {
    const normalized = [...new Set(recordingIds.map((id) => id.trim()).filter(Boolean))];
    if (!normalized.length) {
      await this.clear();
      return undefined;
    }
    const now = new Date().toISOString();
    this.state = {
      version: 1,
      recordingIds: normalized,
      createdAt: this.state?.createdAt ?? now,
      updatedAt: now
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporaryPath, JSON.stringify(this.state, null, 2));
    await rename(temporaryPath, this.path);
    return this.get();
  }

  async clear(): Promise<void> {
    this.state = undefined;
    await unlink(this.path).catch(() => undefined);
  }
}
