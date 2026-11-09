import assert from "node:assert/strict";
import test from "node:test";
import type { Recording } from "@studybox/shared";
import { matchZoomRecording } from "./zoomRecordingMatcher.js";

const recording = (id: string, startedAt: string, endedAt: string): Recording => ({
  id,
  title: id,
  startedAt,
  endedAt,
  durationSeconds: (Date.parse(endedAt) - Date.parse(startedAt)) / 1000,
  sizeBytes: 1
});

test("matches the full Zoom meeting that encloses the room recording", () => {
  const result = matchZoomRecording(
    { startedAt: "2026-09-30T18:40:09Z", durationSeconds: 77 * 60 },
    [recording("today", "2026-09-30T19:05:46.126Z", "2026-09-30T19:57:43.623Z")]
  );
  assert.equal(result.status, "matched");
  if (result.status === "matched") assert.equal(result.match.recording.id, "today");
});

test("rejects an accidental 18-second Zoom reconnect", () => {
  const result = matchZoomRecording(
    { startedAt: "2026-09-30T19:58:59Z", durationSeconds: 18.35 },
    [recording("today", "2026-09-30T19:05:46.126Z", "2026-09-30T19:57:43.623Z")]
  );
  assert.equal(result.status, "rejected");
});

test("matches when Zoom overlaps at least half of the room recording", () => {
  const result = matchZoomRecording(
    { startedAt: "2026-09-30T19:25:00Z", durationSeconds: 35 * 60 },
    [recording("partial-zoom", "2026-09-30T19:00:00Z", "2026-09-30T20:00:00Z")]
  );
  assert.equal(result.status, "matched");
});

test("does not match when Zoom overlaps less than half of the room recording", () => {
  const result = matchZoomRecording(
    { startedAt: "2026-09-30T19:35:00Z", durationSeconds: 25 * 60 },
    [recording("too-short", "2026-09-30T19:00:00Z", "2026-09-30T20:00:00Z")]
  );
  assert.equal(result.status, "waiting");
});

test("waits when the room recording has not finalized", () => {
  const result = matchZoomRecording(
    { startedAt: "2026-09-30T18:40:09Z", durationSeconds: 77 * 60 },
    [],
    true
  );
  assert.equal(result.status, "waiting");
});

test("refuses two similarly plausible room recordings", () => {
  const result = matchZoomRecording(
    { startedAt: "2026-09-30T18:40:00Z", durationSeconds: 80 * 60 },
    [
      recording("part-one", "2026-09-30T18:50:00Z", "2026-09-30T19:20:00Z"),
      recording("part-two", "2026-09-30T18:51:00Z", "2026-09-30T19:21:00Z")
    ]
  );
  assert.equal(result.status, "ambiguous");
});
