import assert from "node:assert/strict";
import test from "node:test";
import type { MeetingSchedule } from "@studybox/shared";
import { decideAutoStart, findScheduledOccurrence, type AutoStartInputs } from "./meetingAutoStart.js";

const schedule: MeetingSchedule = {
  dayOfWeek: "Saturday",
  time: "11:00",
  timezone: "America/Chicago",
  autoStartMeeting: true,
  autoStartRecording: true
};
const window = { leadMinutes: 10, graceMinutes: 180 };

test("matches Saturday 10:50-14:00 Central and keys it by local date", () => {
  // 2026-11-21 is a Saturday; Central is UTC-6 in November.
  assert.deepEqual(findScheduledOccurrence(new Date("2026-11-21T16:50:00Z"), schedule, window), { key: "2026-11-21", minutesFromStart: -10 });
  assert.equal(findScheduledOccurrence(new Date("2026-11-21T17:00:00Z"), schedule, window)?.minutesFromStart, 0);
  assert.equal(findScheduledOccurrence(new Date("2026-11-21T20:00:00Z"), schedule, window)?.minutesFromStart, 180);
});

test("is outside the window before the lead time, after the grace period, and on other days", () => {
  assert.equal(findScheduledOccurrence(new Date("2026-11-21T16:49:00Z"), schedule, window), undefined);
  assert.equal(findScheduledOccurrence(new Date("2026-11-21T20:01:00Z"), schedule, window), undefined);
  assert.equal(findScheduledOccurrence(new Date("2026-11-20T17:00:00Z"), schedule, window), undefined);
});

test("follows daylight saving time", () => {
  // 2026-06-06 is a Saturday; Central is UTC-5 in June.
  assert.equal(findScheduledOccurrence(new Date("2026-06-06T16:00:00Z"), schedule, window)?.minutesFromStart, 0);
});

test("still starts when the box comes online late, like 2026-11-14 (online 10:59 CT)", () => {
  assert.equal(findScheduledOccurrence(new Date("2026-11-14T17:59:00Z"), schedule, window)?.minutesFromStart, 59);
});

const base = (overrides: Partial<AutoStartInputs> = {}): AutoStartInputs => ({
  schedule,
  occurrence: { key: "2026-11-21", minutesFromStart: -10 },
  record: { occurrence: "2026-11-21" },
  meetingStatus: "idle",
  meetingDesiredLive: false,
  podcastStatus: "idle",
  nowMs: Date.parse("2026-11-21T16:50:00Z"),
  meetingRetryMs: 120_000,
  recordingFallbackMinutes: 5,
  ...overrides
});

test("starts Zoom at the lead time", () => {
  assert.equal(decideAutoStart(base()), "start-meeting");
});

test("does not start Zoom again while a start is in progress, or before the retry gap", () => {
  assert.equal(decideAutoStart(base({ meetingStatus: "starting", meetingDesiredLive: true })), "none");
  assert.equal(decideAutoStart(base({ record: { occurrence: "2026-11-21", lastMeetingAttemptAt: "2026-11-21T16:49:00Z" } })), "none");
  assert.equal(decideAutoStart(base({ record: { occurrence: "2026-11-21", lastMeetingAttemptAt: "2026-11-21T16:47:00Z" } })), "start-meeting");
});

test("retries Zoom after the supervisor gives up with an error", () => {
  assert.equal(decideAutoStart(base({ meetingStatus: "error", meetingDesiredLive: true, record: { occurrence: "2026-11-21", lastMeetingAttemptAt: "2026-11-21T16:40:00Z" } })), "start-meeting");
});

test("never restarts Zoom after it was live or after someone ended it", () => {
  assert.equal(decideAutoStart(base({ record: { occurrence: "2026-11-21", meetingLiveAt: "2026-11-21T16:52:00Z" }, occurrence: { key: "2026-11-21", minutesFromStart: -5 } })), "none");
  assert.equal(decideAutoStart(base({ record: { occurrence: "2026-11-21", meetingSuppressed: true }, occurrence: { key: "2026-11-21", minutesFromStart: -5 } })), "none");
});

test("starts the recording at the scheduled time once Zoom is live", () => {
  assert.equal(decideAutoStart(base({ meetingStatus: "live", occurrence: { key: "2026-11-21", minutesFromStart: -2 } })), "none");
  assert.equal(decideAutoStart(base({ meetingStatus: "live", occurrence: { key: "2026-11-21", minutesFromStart: 0 } })), "start-recording");
});

test("starts the recording anyway when Zoom is still not live 5 minutes in", () => {
  const notLive = { meetingStatus: "starting", meetingDesiredLive: true };
  assert.equal(decideAutoStart(base({ ...notLive, occurrence: { key: "2026-11-21", minutesFromStart: 4 } })), "none");
  assert.equal(decideAutoStart(base({ ...notLive, occurrence: { key: "2026-11-21", minutesFromStart: 5 } })), "start-recording");
});

test("never restarts a recording that was started or stopped this occurrence", () => {
  const live = { meetingStatus: "live", occurrence: { key: "2026-11-21", minutesFromStart: 30 } };
  assert.equal(decideAutoStart(base({ ...live, record: { occurrence: "2026-11-21", meetingLiveAt: "x", recordingStartedAt: "x" } })), "none");
  assert.equal(decideAutoStart(base({ ...live, record: { occurrence: "2026-11-21", meetingLiveAt: "x", recordingSuppressed: true } })), "none");
  assert.equal(decideAutoStart(base({ ...live, podcastStatus: "recording", record: { occurrence: "2026-11-21", meetingLiveAt: "x" } })), "none");
});

test("respects the auto-start switches", () => {
  assert.equal(decideAutoStart(base({ schedule: { ...schedule, autoStartMeeting: false, autoStartRecording: false } })), "none");
  assert.equal(decideAutoStart(base({ schedule: { ...schedule, autoStartMeeting: false }, occurrence: { key: "2026-11-21", minutesFromStart: 0 } })), "start-recording");
});
