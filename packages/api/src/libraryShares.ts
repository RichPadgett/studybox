import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface LibraryShareRecord {
  token: string;
  recordingId: string;
  createdAt: string;
}

export class LibraryShareStore {
  private records: LibraryShareRecord[] = [];

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      this.records = JSON.parse(await readFile(this.filePath, "utf8")) as LibraryShareRecord[];
    } catch {
      this.records = [];
    }
  }

  async create(recordingId: string): Promise<LibraryShareRecord> {
    const record = { token: randomBytes(24).toString("base64url"), recordingId, createdAt: new Date().toISOString() };
    this.records = [record, ...this.records.filter((candidate) => candidate.recordingId !== recordingId)];
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.records, null, 2));
    return record;
  }

  get(token: string): LibraryShareRecord | undefined {
    return this.records.find((record) => record.token === token);
  }
}
