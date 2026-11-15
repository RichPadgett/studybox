import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Participant } from "@studybox/shared";
import { projectPath } from "./paths.js";

export interface AttendanceEntry {
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AttendanceRecord {
  /** Local date of the study, e.g. "2026-11-21". */
  date: string;
  meetingId?: string;
  updatedAt: string;
  people: AttendanceEntry[];
}

/** Names StudyBox uses for itself in Zoom; never counted as attendance. */
const SELF_NAMES = /^studybox\b/i;

/**
 * Everyone seen in the Zoom meeting during a study, including people who left
 * early. One JSON file per study date under data/attendance/.
 */
export class AttendanceStore {
  private readonly directory = process.env.STUDYBOX_ATTENDANCE_DIR?.trim() || projectPath("data", "attendance");
  private record?: AttendanceRecord;
  private lastWriteMs = 0;

  constructor(private readonly timeZone: () => string) {}

  async observe(participants: Participant[], meetingId: string | undefined, now = new Date()): Promise<void> {
    const date = localDate(now, this.timeZone());
    if (this.record?.date !== date) this.record = (await this.load(date)) ?? { date, meetingId, updatedAt: now.toISOString(), people: [] };
    const record = this.record;
    if (meetingId) record.meetingId = meetingId;

    let added = false;
    const nowIso = now.toISOString();
    for (const participant of participants) {
      const name = participant.displayName.trim();
      if (!name || SELF_NAMES.test(name)) continue;
      const existing = record.people.find((entry) => entry.name === name);
      if (existing) {
        existing.lastSeenAt = nowIso;
      } else {
        record.people.push({ name, firstSeenAt: nowIso, lastSeenAt: nowIso });
        added = true;
      }
    }
    record.updatedAt = nowIso;
    // Write right away when someone new appears; otherwise refresh "last seen" once a minute.
    if (added || now.getTime() - this.lastWriteMs > 60_000) await this.save(record, now.getTime());
  }

  async get(date?: string): Promise<AttendanceRecord | undefined> {
    if (!date) {
      const files = (await readdir(this.directory).catch(() => [] as string[])).filter((file) => file.endsWith(".json")).sort();
      date = files.at(-1)?.replace(/\.json$/, "");
      if (!date) return undefined;
    }
    if (this.record?.date === date) return this.record;
    return this.load(date);
  }

  private async load(date: string): Promise<AttendanceRecord | undefined> {
    try {
      return JSON.parse(await readFile(join(this.directory, `${date}.json`), "utf8")) as AttendanceRecord;
    } catch {
      return undefined;
    }
  }

  private async save(record: AttendanceRecord, nowMs: number): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${record.date}.json`);
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify(record, null, 2));
    await rename(temporary, path);
    this.lastWriteMs = nowMs;
  }
}

function localDate(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
