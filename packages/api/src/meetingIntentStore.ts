import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { projectPath } from "./paths.js";

export interface MeetingIntent {
  desiredLive: boolean;
  meetingNumber: string;
  requestedAt?: string;
  updatedAt: string;
}

export class MeetingIntentStore {
  private readonly path = process.env.STUDYBOX_MEETING_INTENT_PATH?.trim()
    || projectPath("data", "meeting-intent.json");

  async load(meetingNumber: string, maxAgeMs: number): Promise<MeetingIntent> {
    try {
      const intent = JSON.parse(await readFile(this.path, "utf8")) as MeetingIntent;
      const ageMs = Date.now() - Date.parse(intent.updatedAt);
      if (!intent.desiredLive || intent.meetingNumber !== meetingNumber || !Number.isFinite(ageMs) || ageMs > maxAgeMs) {
        return this.save(false, meetingNumber);
      }
      return intent;
    } catch {
      return this.save(false, meetingNumber);
    }
  }

  async save(desiredLive: boolean, meetingNumber: string, requestedAt?: string): Promise<MeetingIntent> {
    const intent: MeetingIntent = {
      desiredLive,
      meetingNumber,
      requestedAt: desiredLive ? requestedAt ?? new Date().toISOString() : undefined,
      updatedAt: new Date().toISOString()
    };
    const temporaryPath = `${this.path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(intent, null, 2));
    await rename(temporaryPath, this.path);
    return intent;
  }
}
