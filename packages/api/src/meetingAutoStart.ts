import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MeetingSchedule } from "@studybox/shared";
import { projectPath } from "./paths.js";

const weekdays: MeetingSchedule["dayOfWeek"][] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface ScheduledOccurrence {
  /** Local calendar date of the scheduled meeting, e.g. "2026-11-21". */
  key: string;
  /** Minutes since the scheduled start; negative before it. */
  minutesFromStart: number;
}

export interface AutoStartWindow {
  /** Join Zoom this many minutes before the scheduled time. */
  leadMinutes: number;
  /** Keep trying to start for this long after the scheduled time (covers late Wi-Fi). */
  graceMinutes: number;
}

/**
 * Returns the scheduled meeting occurrence `now` falls inside, or undefined.
 * The window is [start - lead, start + grace] in the schedule's own time zone.
 */
export function findScheduledOccurrence(now: Date, schedule: MeetingSchedule, window: AutoStartWindow): ScheduledOccurrence | undefined {
  const [hour, minute] = schedule.time.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  // Check today and tomorrow (local) so a lead window that starts before midnight still matches.
  for (const dayOffset of [0, 1]) {
    const local = localParts(new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000), schedule.timezone);
    if (!local || weekdays[local.weekday] !== schedule.dayOfWeek) continue;
    const nowLocal = localParts(now, schedule.timezone);
    if (!nowLocal) return undefined;
    const nowMinutes = nowLocal.hour * 60 + nowLocal.minute + dayOffset * -24 * 60;
    const minutesFromStart = nowMinutes - (hour * 60 + minute);
    if (minutesFromStart >= -window.leadMinutes && minutesFromStart <= window.graceMinutes) {
      return { key: local.date, minutesFromStart };
    }
  }
  return undefined;
}

function localParts(date: Date, timeZone: string): { date: string; weekday: number; hour: number; minute: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const weekday = weekdays.indexOf(get("weekday") as MeetingSchedule["dayOfWeek"]);
    const hour = Number(get("hour"));
    const minute = Number(get("minute"));
    if (weekday < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
    return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday, hour, minute };
  } catch {
    return undefined;
  }
}

/** What auto-start has already done for one scheduled occurrence. Persisted so a reboot mid-study does not repeat it. */
export interface AutoStartRecord {
  occurrence: string;
  meetingRequestedAt?: string;
  lastMeetingAttemptAt?: string;
  meetingLiveAt?: string;
  recordingStartedAt?: string;
  /** Set when someone ends the meeting or stops the recording by hand; auto-start then leaves it alone. */
  meetingSuppressed?: boolean;
  recordingSuppressed?: boolean;
}

export class AutoStartStore {
  private record?: AutoStartRecord;
  private readonly path = process.env.STUDYBOX_AUTO_START_STATE_PATH?.trim() || projectPath("data", "auto-start-state.json");

  async load(): Promise<void> {
    try {
      this.record = JSON.parse(await readFile(this.path, "utf8")) as AutoStartRecord;
    } catch {
      this.record = undefined;
    }
  }

  get(occurrence: string): AutoStartRecord {
    if (this.record?.occurrence !== occurrence) this.record = { occurrence };
    return this.record;
  }

  current(): AutoStartRecord | undefined {
    return this.record;
  }

  async update(occurrence: string, changes: Partial<AutoStartRecord>): Promise<AutoStartRecord> {
    this.record = { ...this.get(occurrence), ...changes, occurrence };
    const temporaryPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(this.record, null, 2));
    await rename(temporaryPath, this.path);
    return this.record;
  }
}

export type AutoStartAction = "start-meeting" | "start-recording" | "none";

export interface AutoStartInputs {
  schedule: MeetingSchedule;
  occurrence: ScheduledOccurrence;
  record: AutoStartRecord;
  meetingStatus: string;
  meetingDesiredLive: boolean;
  podcastStatus: string;
  nowMs: number;
  /** Minimum gap between Zoom start attempts. */
  meetingRetryMs: number;
  /** Start room recording this long after the scheduled time even if Zoom is not live yet. */
  recordingFallbackMinutes: number;
}

/** Pure decision for one auto-start tick; the appliance carries it out. */
export function decideAutoStart(input: AutoStartInputs): AutoStartAction {
  const { schedule, occurrence, record } = input;
  const meetingLive = input.meetingStatus === "live";

  if (schedule.autoStartMeeting && !record.meetingSuppressed && !meetingLive && !record.meetingLiveAt) {
    const busy = input.meetingDesiredLive && input.meetingStatus !== "error" && input.meetingStatus !== "idle";
    const lastAttempt = record.lastMeetingAttemptAt ? Date.parse(record.lastMeetingAttemptAt) : 0;
    if (!busy && input.nowMs - lastAttempt >= input.meetingRetryMs) return "start-meeting";
  }

  if (schedule.autoStartRecording && !record.recordingSuppressed && !record.recordingStartedAt && input.podcastStatus === "idle") {
    const zoomReady = !schedule.autoStartMeeting || meetingLive || Boolean(record.meetingLiveAt);
    if (occurrence.minutesFromStart >= 0 && (zoomReady || occurrence.minutesFromStart >= input.recordingFallbackMinutes)) {
      return "start-recording";
    }
  }

  return "none";
}
