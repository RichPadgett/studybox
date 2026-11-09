import type { Recording } from "@studybox/shared";

export interface ZoomRecordingInterval {
  startedAt: string;
  durationSeconds: number;
}

export interface ZoomRecordingMatch {
  recording: Recording;
  score: number;
  overlapSeconds: number;
  coverage: number;
  leadSeconds: number;
  endLagSeconds: number;
}

export type ZoomRecordingMatchResult =
  | { status: "matched"; match: ZoomRecordingMatch }
  | { status: "ambiguous"; matches: ZoomRecordingMatch[] }
  | { status: "rejected"; reason: string }
  | { status: "waiting"; reason: string };

const MINIMUM_ZOOM_SECONDS = 60;
const MINIMUM_AUDIO_COVERAGE = 0.5;
const AMBIGUOUS_SCORE_DELTA = 5;

export function matchZoomRecording(
  zoom: ZoomRecordingInterval,
  recordings: Recording[],
  hasActiveRecording = false
): ZoomRecordingMatchResult {
  const zoomStartedAt = Date.parse(zoom.startedAt);
  if (!Number.isFinite(zoomStartedAt) || !Number.isFinite(zoom.durationSeconds) || zoom.durationSeconds <= 0) {
    return { status: "rejected", reason: "Zoom recording timing is invalid" };
  }
  if (zoom.durationSeconds < MINIMUM_ZOOM_SECONDS) {
    return {
      status: "rejected",
      reason: `Zoom recording is only ${Math.round(zoom.durationSeconds)} seconds and is not a full meeting candidate`
    };
  }

  const zoomEndedAt = zoomStartedAt + zoom.durationSeconds * 1000;
  const matches = recordings
    .filter((recording) => recording.endedAt && !recording.assets?.some((asset) => asset.kind === "zoom" && asset.archiveProvider === "s3"))
    .map((recording) => scoreRecording(recording, zoomStartedAt, zoomEndedAt, zoom.durationSeconds))
    .filter((match): match is ZoomRecordingMatch => Boolean(match))
    .sort((left, right) => right.score - left.score);

  if (!matches.length) {
    return {
      status: "waiting",
      reason: hasActiveRecording
        ? "The matching room recording is still active"
        : "No finalized room recording is covered by this Zoom recording yet"
    };
  }
  if (matches[1] && matches[0].score - matches[1].score < AMBIGUOUS_SCORE_DELTA) {
    return { status: "ambiguous", matches: matches.slice(0, 2) };
  }
  return { status: "matched", match: matches[0] };
}

function scoreRecording(
  recording: Recording,
  zoomStartedAt: number,
  zoomEndedAt: number,
  zoomDurationSeconds: number
): ZoomRecordingMatch | undefined {
  const audioStartedAt = Date.parse(recording.startedAt);
  const audioEndedAt = Date.parse(recording.endedAt ?? "");
  const audioSpanSeconds = (audioEndedAt - audioStartedAt) / 1000;
  if (!Number.isFinite(audioStartedAt) || !Number.isFinite(audioEndedAt) || audioSpanSeconds <= 0) return undefined;

  const overlapSeconds = Math.max(0, Math.min(audioEndedAt, zoomEndedAt) - Math.max(audioStartedAt, zoomStartedAt)) / 1000;
  const coverage = overlapSeconds / audioSpanSeconds;
  const leadSeconds = (audioStartedAt - zoomStartedAt) / 1000;
  const endLagSeconds = (zoomEndedAt - audioEndedAt) / 1000;
  if (coverage < MINIMUM_AUDIO_COVERAGE) return undefined;
  if (zoomDurationSeconds < Math.max(MINIMUM_ZOOM_SECONDS, audioSpanSeconds * MINIMUM_AUDIO_COVERAGE)) return undefined;

  const leadScore = 15 * proximityScore(leadSeconds, 10 * 60, 80 * 60);
  const endScore = 10 * proximityScore(endLagSeconds, 2 * 60, 60 * 60);
  const durationScore = 5 * Math.min(1, zoomDurationSeconds / audioSpanSeconds);
  return {
    recording,
    score: coverage * 70 + leadScore + endScore + durationScore,
    overlapSeconds,
    coverage,
    leadSeconds,
    endLagSeconds
  };
}

function proximityScore(value: number, ideal: number, range: number): number {
  return Math.max(0, 1 - Math.abs(value - ideal) / range);
}
