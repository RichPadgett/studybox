import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { MeetingState } from "@studybox/shared";
import {
  CalendarEventsSender,
  meetingTransitionEvent,
  signCalendarEvent,
  signedHeaders,
  type CalendarEventsConfig,
  type CalendarLogInput,
  type CalendarState
} from "./calendarEvents.js";

const SECRET = "test-secret";

function config(overrides: Partial<CalendarEventsConfig> = {}): CalendarEventsConfig {
  return {
    url: "http://receiver.test/events",
    secret: SECRET,
    publicUrl: "",
    heartbeatMs: 60_000,
    retryDelaysMs: [5_000, 15_000, 60_000],
    giveUpMs: 10 * 60_000,
    staleHeartbeatMs: 2 * 60_000,
    requestTimeoutMs: 1_000,
    watchMs: 2_000,
    tunnelCheckMs: 10_000,
    ...overrides
  };
}

function state(status: MeetingState["status"] = "idle", time = "12:00"): CalendarState {
  return {
    meeting: { status, title: "Sabbath Study" },
    settings: {
      schedule: { dayOfWeek: "Saturday", time, timezone: "America/Chicago", autoStartMeeting: true, autoStartRecording: false },
      zoom: { meetingNumber: "123", passcode: "pw", joinUrl: "https://zoom.us/j/123", displayName: "StudyBox" }
    } as CalendarState["settings"]
  };
}

/** Tests drive the sender directly (start() would also queue studybox.online and set timers).
 * A sender with a fake clock, fake sleep (advances the clock) and scripted fetch responses. */
function harness(responses: Array<number | "network">, current: () => CalendarState = () => state()) {
  let clock = 1_800_000_000_000;
  const requests: Array<{ headers: Record<string, string>; body: string }> = [];
  const logs: CalendarLogInput[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    requests.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
    const next = responses.length > 0 ? responses.shift()! : 204;
    if (next === "network") throw new Error("connect ECONNREFUSED");
    return new Response(null, { status: next });
  }) as typeof fetch;
  const sender = new CalendarEventsSender({
    config: config(),
    getState: current,
    log: async (input) => { logs.push(input); },
    fetch: fakeFetch,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });
  return { sender, requests, logs, elapsed: () => clock - 1_800_000_000_000 };
}

test("signature is sha256=<hex HMAC of '<timestamp>.<raw body>'>", () => {
  const body = JSON.stringify({ event: "heartbeat" });
  const expected = createHmac("sha256", SECRET).update(`1800000000.${body}`).digest("hex");
  assert.equal(signCalendarEvent(SECRET, 1800000000, body), `sha256=${expected}`);

  const headers = signedHeaders(SECRET, body, 1_800_000_000_999);
  assert.equal(headers["X-StudyBox-Timestamp"], "1800000000");
  assert.equal(headers["X-StudyBox-Signature"], `sha256=${expected}`);
  assert.equal(headers["Content-Type"], "application/json");
});

test("meeting events fire on real transitions only", () => {
  assert.equal(meetingTransitionEvent("idle", "starting"), "meeting.starting");
  assert.equal(meetingTransitionEvent("starting", "live"), "meeting.live");
  assert.equal(meetingTransitionEvent("idle", "live"), "meeting.live");
  assert.equal(meetingTransitionEvent("live", "ending"), "meeting.ended");
  assert.equal(meetingTransitionEvent("ending", "idle"), undefined);
  assert.equal(meetingTransitionEvent("live", "error"), "meeting.ended");
  assert.equal(meetingTransitionEvent("live", "live"), undefined);
  assert.equal(meetingTransitionEvent("idle", "idle"), undefined);
  assert.equal(meetingTransitionEvent("live", "starting"), undefined);
});

test("repeated syncs of the same status send one event each", async () => {
  let current = state("idle");
  const { sender, requests } = harness([], () => current);
  for (const status of ["idle", "starting", "starting", "live", "live", "live", "ending", "idle", "idle"] as const) {
    current = state(status);
    sender.noteMeeting(current.meeting);
  }
  await sender.flush();
  sender.stop();
  const events = requests.map((request) => JSON.parse(request.body).event);
  assert.deepEqual(events, ["meeting.starting", "meeting.live", "meeting.ended"]);
  const ended = JSON.parse(requests[2]!.body);
  assert.equal(ended.zoom.passcode, "pw");
  assert.equal(ended.schedule.dayOfWeek, "Saturday");
  assert.match(ended.eventId, /^[0-9a-f-]{36}$/);
});

test("schedule.updated is sent when the schedule changes", async () => {
  let current = state("idle", "12:00");
  const { sender, requests } = harness([], () => current);
  sender.observe();
  current = state("idle", "11:00");
  sender.observe();
  sender.observe();
  await sender.flush();
  sender.stop();
  assert.deepEqual(requests.map((request) => JSON.parse(request.body).event), ["schedule.updated"]);
  assert.equal(JSON.parse(requests[0]!.body).schedule.time, "11:00");
});

test("retries network errors and 5xx with 5s, 15s, 60s backoff, then succeeds", async () => {
  const { sender, requests, logs, elapsed } = harness(["network", 503, 502, 200]);
  sender.enqueue("meeting.live", state("live"));
  await sender.flush();
  sender.stop();
  assert.equal(requests.length, 4);
  assert.equal(elapsed(), 5_000 + 15_000 + 60_000);
  // Every attempt carries the same event id (the receiver dedupes on it).
  assert.equal(new Set(requests.map((request) => JSON.parse(request.body).eventId)).size, 1);
  assert.equal(logs.filter((log) => log.result === "failure").length, 1);
  assert.ok(logs.some((log) => log.result === "success" && log.action === "calendar-events.meeting.live"));
});

test("gives up after about 10 minutes and moves on", async () => {
  const { sender, requests, logs, elapsed } = harness(Array(50).fill(503));
  sender.enqueue("meeting.live", state("live"));
  await sender.flush();
  sender.stop();
  assert.ok(elapsed() <= 10 * 60_000, `waited ${elapsed()}ms`);
  assert.ok(requests.length >= 10 && requests.length <= 13, `${requests.length} attempts`);
  assert.equal(sender.pending().length, 0);
  assert.ok(logs.some((log) => log.level === "error" && /gave up/.test(log.message)));
});

test("4xx is not retried", async () => {
  const { sender, requests, logs } = harness([401]);
  sender.enqueue("meeting.starting", state("starting"));
  await sender.flush();
  sender.stop();
  assert.equal(requests.length, 1);
  assert.ok(logs.some((log) => log.level === "error" && /HTTP 401/.test(log.message)));
});

test("only the newest heartbeat is kept in the queue", async () => {
  const { sender } = harness([]);
  // Not started, but enabled: enqueue directly while a send is "in flight".
  sender.enqueue("meeting.live", state("live"));
  sender.enqueue("heartbeat");
  sender.enqueue("heartbeat");
  sender.enqueue("heartbeat");
  const queued = sender.pending().map((body) => body.event);
  assert.equal(queued.filter((event) => event === "heartbeat").length, 1);
  await sender.flush();
  sender.stop();
});

test("without a secret nothing is sent and one line is logged", async () => {
  const requests: string[] = [];
  const logs: CalendarLogInput[] = [];
  const sender = new CalendarEventsSender({
    config: config({ secret: undefined }),
    getState: () => state(),
    log: async (input) => { logs.push(input); },
    fetch: (async (url: string) => { requests.push(url); return new Response(null, { status: 204 }); }) as typeof fetch
  });
  await sender.start();
  sender.noteMeeting({ status: "live", title: "x" });
  sender.enqueue("heartbeat");
  await sender.flush();
  sender.stop();
  assert.equal(requests.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.action, "calendar-events.disabled");
});
