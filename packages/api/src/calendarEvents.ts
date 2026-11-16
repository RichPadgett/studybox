import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import type { LogLevel, LogResult, MeetingState, StudyBoxSettings } from "@studybox/shared";
import { loadDotEnv, readEnv } from "./zoomConfig.js";

// Signed events StudyBox pushes to the church calendar (enochscalendar.com) so
// its Sabbath banner and phone notifications change the moment the meeting does.
// Contract: POST JSON, X-StudyBox-Timestamp (unix seconds) and
// X-StudyBox-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>.

export type CalendarEventName =
  | "studybox.online"
  | "heartbeat"
  | "meeting.starting"
  | "meeting.live"
  | "meeting.ended"
  | "schedule.updated"
  | "studybox.offline";

export interface CalendarEventBody {
  eventId: string;
  event: CalendarEventName;
  occurredAt: string;
  meeting: { status: MeetingState["status"]; title: string };
  schedule: { dayOfWeek: string; time: string; timezone: string };
  zoom: { joinUrl: string; meetingNumber: string; passcode: string };
}

export interface CalendarEventsConfig {
  url: string;
  secret?: string;
  /** Public StudyBox URL; studybox.online waits until it answers through the tunnel. Empty skips the check. */
  publicUrl?: string;
  heartbeatMs: number;
  /** Backoff between attempts; the last value repeats until giveUpMs. */
  retryDelaysMs: number[];
  giveUpMs: number;
  /** A queued heartbeat older than this is dropped instead of sent. */
  staleHeartbeatMs: number;
  requestTimeoutMs: number;
  /** How often the sender re-reads meeting and settings state to catch changes made outside syncMeetingState. */
  watchMs: number;
  tunnelCheckMs: number;
}

export const defaultCalendarEventsUrl = "https://enochscalendar.com/api/shabbat/studybox-events";

export function getCalendarEventsConfig(): CalendarEventsConfig {
  loadDotEnv();
  const publicUrl = process.env.STUDYBOX_PUBLIC_URL === undefined
    ? "https://studybox.enochscalendar.com/"
    : readEnv("STUDYBOX_PUBLIC_URL");
  return {
    url: readEnv("STUDYBOX_CALENDAR_EVENTS_URL") ?? defaultCalendarEventsUrl,
    secret: readEnv("STUDYBOX_CALENDAR_EVENTS_SECRET"),
    publicUrl,
    heartbeatMs: Number(readEnv("STUDYBOX_CALENDAR_HEARTBEAT_MS") ?? 60_000),
    retryDelaysMs: [5_000, 15_000, 60_000],
    giveUpMs: 10 * 60_000,
    staleHeartbeatMs: 2 * 60_000,
    requestTimeoutMs: 10_000,
    watchMs: 2_000,
    tunnelCheckMs: 10_000
  };
}

/** `sha256=<hex>` over "<timestamp>.<raw body>". */
export function signCalendarEvent(secret: string, timestamp: number | string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function signedHeaders(secret: string, rawBody: string, nowMs = Date.now()): Record<string, string> {
  const timestamp = Math.floor(nowMs / 1000);
  return {
    "Content-Type": "application/json",
    "X-StudyBox-Timestamp": String(timestamp),
    "X-StudyBox-Signature": signCalendarEvent(secret, timestamp, rawBody)
  };
}

const activeStatuses = new Set<MeetingState["status"]>(["starting", "live"]);

/**
 * The event for a real status change, or undefined when nothing the calendar
 * cares about changed. "ending", "idle" or "error" after starting/live is the
 * end; ending -> idle afterwards does not repeat it.
 */
export function meetingTransitionEvent(
  previous: MeetingState["status"] | undefined,
  current: MeetingState["status"]
): CalendarEventName | undefined {
  if (previous === current) return undefined;
  if (current === "starting") return previous === "live" ? undefined : "meeting.starting";
  if (current === "live") return "meeting.live";
  if (previous && activeStatuses.has(previous)) return "meeting.ended";
  return undefined;
}

export interface CalendarState {
  meeting: Pick<MeetingState, "status" | "title">;
  settings: Pick<StudyBoxSettings, "schedule" | "zoom">;
}

export interface CalendarLogInput {
  level: LogLevel;
  action: string;
  result?: LogResult;
  message: string;
  details?: Record<string, string | number | boolean | undefined>;
}

interface QueuedEvent {
  body: CalendarEventBody;
  raw: string;
  queuedAt: number;
  attempts: number;
}

export interface CalendarEventsDeps {
  config: CalendarEventsConfig;
  getState: () => CalendarState;
  log: (input: CalendarLogInput) => Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const maxQueue = 50;

export class CalendarEventsSender {
  private readonly config: CalendarEventsConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: QueuedEvent[] = [];
  private draining?: Promise<void>;
  private lastMeetingStatus?: MeetingState["status"];
  private lastScheduleKey?: string;
  private onlineSent = false;
  private onlineQueued = false;
  private heartbeatFailing = false;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private tunnelTimer?: NodeJS.Timeout;

  constructor(private readonly deps: CalendarEventsDeps) {
    this.config = deps.config;
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
  }

  get enabled(): boolean {
    return Boolean(this.config.secret);
  }

  /** Events waiting to be delivered (for tests and diagnostics). */
  pending(): CalendarEventBody[] {
    return this.queue.map((item) => item.body);
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      await this.safeLog({
        level: "info",
        action: "calendar-events.disabled",
        message: "Calendar events off: STUDYBOX_CALENDAR_EVENTS_SECRET is not set"
      });
      return;
    }
    const state = this.deps.getState();
    this.lastMeetingStatus = state.meeting.status;
    this.lastScheduleKey = scheduleKey(state.settings);
    void this.waitForTunnelThenOnline();
    this.every(this.config.heartbeatMs, () => {
      if (this.onlineSent) {
        // Report any status change first, so a heartbeat never says "live" before meeting.live.
        this.observe();
        this.enqueue("heartbeat");
      } else if (this.onlineQueued && !this.queue.some((item) => item.body.event === "studybox.online")) {
        // studybox.online gave up (calendar unreachable for 10 minutes): try it again.
        this.enqueue("studybox.online");
      }
    });
    this.every(this.config.watchMs, () => this.observe());
    process.prependOnceListener("SIGTERM", () => this.onSignal("SIGTERM", 143));
    process.prependOnceListener("SIGINT", () => this.onSignal("SIGINT", 130));
    await this.safeLog({
      level: "info",
      action: "calendar-events.start",
      message: `Calendar events on: ${this.config.url}`
    });
  }

  /** Compares current meeting and schedule state with what the calendar last heard. */
  observe(state: CalendarState = this.deps.getState()): void {
    if (!this.enabled || this.stopped) return;
    const status = state.meeting.status;
    const transition = meetingTransitionEvent(this.lastMeetingStatus, status);
    this.lastMeetingStatus = status;
    if (transition) this.enqueue(transition, state);
    const key = scheduleKey(state.settings);
    if (this.lastScheduleKey !== undefined && key !== this.lastScheduleKey) {
      this.enqueue("schedule.updated", state);
    }
    this.lastScheduleKey = key;
  }

  noteMeeting(meeting: Pick<MeetingState, "status" | "title">): void {
    this.observe({ ...this.deps.getState(), meeting });
  }

  enqueue(event: CalendarEventName, state: CalendarState = this.deps.getState()): CalendarEventBody | undefined {
    if (!this.enabled || this.stopped) return undefined;
    const body = buildBody(event, state, this.now());
    const raw = JSON.stringify(body);
    if (event === "heartbeat") {
      // Only the newest heartbeat matters.
      this.queue = this.queue.filter((item) => item.body.event !== "heartbeat");
    }
    if (event === "studybox.online") this.onlineQueued = true;
    this.queue.push({ body, raw, queuedAt: this.now(), attempts: 0 });
    while (this.queue.length > maxQueue) {
      const heartbeat = this.queue.findIndex((item) => item.body.event === "heartbeat");
      this.queue.splice(heartbeat >= 0 ? heartbeat : 0, 1);
    }
    this.kick();
    return body;
  }

  /** Resolves when the queue is empty (or every item gave up). */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Stops timers. Pending events are dropped. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    if (this.tunnelTimer) clearTimeout(this.tunnelTimer);
    this.timers = [];
  }

  /**
   * Best-effort studybox.offline on shutdown. The HAL signal handlers call
   * process.exit synchronously, so this sends with a blocking curl.
   */
  sendOfflineSync(timeoutMs = 4_000): boolean {
    if (!this.enabled) return false;
    const raw = JSON.stringify(buildBody("studybox.offline", this.deps.getState(), this.now()));
    const headers = signedHeaders(this.config.secret!, raw, this.now());
    const args = ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-X", "POST"];
    for (const [name, value] of Object.entries(headers)) args.push("-H", `${name}: ${value}`);
    args.push("--data-binary", "@-", this.config.url);
    const result = spawnSync("curl", args, { input: raw, timeout: timeoutMs + 1_000, encoding: "utf8" });
    const ok = /^2\d\d$/.test(result.stdout?.trim() ?? "");
    console.log(`StudyBox calendar-events studybox.offline ${ok ? "sent" : `not sent (${result.stdout?.trim() || result.error?.message || "no response"})`}`);
    return ok;
  }

  private onSignal(signal: NodeJS.Signals, code: number): void {
    this.stop();
    try {
      this.sendOfflineSync();
    } catch (error) {
      console.error("StudyBox calendar-events offline send failed", error);
    }
    // Adding a listener removed Node's default exit; restore it when nobody else will exit.
    if (process.listenerCount(signal) === 0) process.exit(code);
  }

  private every(ms: number, fn: () => void): void {
    const timer = setInterval(() => {
      try {
        fn();
      } catch (error) {
        console.error("StudyBox calendar-events timer failed", error);
      }
    }, ms);
    timer.unref();
    this.timers.push(timer);
  }

  private async waitForTunnelThenOnline(): Promise<void> {
    if (this.stopped) return;
    if (await this.tunnelReachable()) {
      this.enqueue("studybox.online");
      return;
    }
    this.tunnelTimer = setTimeout(() => void this.waitForTunnelThenOnline(), this.config.tunnelCheckMs);
    this.tunnelTimer.unref();
  }

  private async tunnelReachable(): Promise<boolean> {
    if (!this.config.publicUrl) return true;
    try {
      const response = await this.fetchImpl(this.config.publicUrl, {
        method: "GET",
        signal: AbortSignal.timeout(this.config.requestTimeoutMs)
      });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
    });
  }

  private async drain(): Promise<void> {
    // Strictly in order, so the calendar never hears "live" before "starting".
    while (this.queue.length > 0 && !this.stopped) {
      const item = this.queue[0];
      if (item.body.event === "heartbeat" && this.now() - item.queuedAt > this.config.staleHeartbeatMs) {
        this.queue.shift();
        continue;
      }
      const outcome = await this.attempt(item);
      if (outcome === "retry") {
        const elapsed = this.now() - item.queuedAt;
        const delay = this.config.retryDelaysMs[Math.min(item.attempts - 1, this.config.retryDelaysMs.length - 1)];
        if (elapsed + delay <= this.config.giveUpMs) {
          await this.sleep(delay);
          continue;
        }
        await this.safeLog({
          level: "error",
          action: `calendar-events.${item.body.event}`,
          result: "failure",
          message: `Calendar never received ${item.body.event}; gave up after ${item.attempts} attempts`,
          details: { eventId: item.body.eventId, attempts: item.attempts }
        });
      }
      if (this.queue[0] === item) this.queue.shift();
    }
  }

  private async attempt(item: QueuedEvent): Promise<"sent" | "rejected" | "retry"> {
    item.attempts += 1;
    const event = item.body.event;
    let status: number | undefined;
    let error: string | undefined;
    try {
      const response = await this.fetchImpl(this.config.url, {
        method: "POST",
        headers: signedHeaders(this.config.secret!, item.raw, this.now()),
        body: item.raw,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs)
      });
      status = response.status;
      await response.body?.cancel().catch(() => undefined);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    const details = { eventId: item.body.eventId, attempt: item.attempts, status, meetingStatus: item.body.meeting.status };
    if (status !== undefined && status >= 200 && status < 300) {
      if (event === "studybox.online") this.onlineSent = true;
      // Heartbeats every minute would flood the 500-entry audit log: log them only when delivery recovers.
      if (event !== "heartbeat" || this.heartbeatFailing) {
        await this.safeLog({ level: "info", action: `calendar-events.${event}`, result: "success", message: `Calendar received ${event}`, details });
      }
      if (event === "heartbeat") this.heartbeatFailing = false;
      return "sent";
    }
    // One log line when heartbeats start failing, not one a minute (the audit log keeps 500 entries).
    const firstHeartbeatFailure = event === "heartbeat" && !this.heartbeatFailing;
    if (event === "heartbeat") this.heartbeatFailing = true;
    const retryable = status === undefined || status >= 500 || status === 429;
    if (!retryable) {
      if (event !== "heartbeat" || firstHeartbeatFailure) await this.safeLog({
        level: "error",
        action: `calendar-events.${event}`,
        result: "failure",
        message: `Calendar rejected ${event} with HTTP ${status}`,
        details
      });
      if (event === "studybox.online") this.onlineSent = true; // A rejection will not change on retry; keep heartbeating.
      return "rejected";
    }
    // Log the first failure only; the give-up (or a later success) is logged too.
    if (item.attempts === 1 && (event !== "heartbeat" || firstHeartbeatFailure)) {
      await this.safeLog({
        level: "warn",
        action: `calendar-events.${event}`,
        result: "failure",
        message: `Calendar did not receive ${event} (${error ?? `HTTP ${status}`}); retrying`,
        details: { ...details, error }
      });
    }
    return "retry";
  }

  private async safeLog(input: CalendarLogInput): Promise<void> {
    try {
      await this.deps.log(input);
    } catch (error) {
      console.error("StudyBox calendar-events log failed", error);
    }
  }
}

function buildBody(event: CalendarEventName, state: CalendarState, nowMs: number): CalendarEventBody {
  const { schedule, zoom } = state.settings;
  return {
    eventId: randomUUID(),
    event,
    occurredAt: new Date(nowMs).toISOString(),
    meeting: { status: state.meeting.status, title: state.meeting.title },
    schedule: { dayOfWeek: schedule.dayOfWeek, time: schedule.time, timezone: schedule.timezone },
    zoom: { joinUrl: zoom.joinUrl ?? "", meetingNumber: zoom.meetingNumber ?? "", passcode: zoom.passcode ?? "" }
  };
}

function scheduleKey(settings: CalendarState["settings"]): string {
  const { schedule, zoom } = settings;
  return JSON.stringify([schedule.dayOfWeek, schedule.time, schedule.timezone, zoom.joinUrl ?? "", zoom.meetingNumber ?? "", zoom.passcode ?? ""]);
}
