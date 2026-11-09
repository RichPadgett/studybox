import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ZoomCloudRecordingStatus } from "@studybox/shared";
import type { ZoomOAuthTokenSet } from "./zoomOAuthStore.js";
import { ZoomOAuthStore } from "./zoomOAuthStore.js";
import { ZoomOAuthClient } from "./zoomOAuthClient.js";
import type { ZoomConfig } from "./zoomConfig.js";
import type { ZoomWebhookBody } from "./zoomWebhook.js";

interface ZoomRecordingFile {
  id?: string;
  file_type?: string;
  file_size?: number;
  recording_type?: string;
  download_url?: string;
}

interface ZoomRecordingObject {
  id?: string | number;
  uuid?: string;
  topic?: string;
  start_time?: string;
  duration?: number;
  recording_files?: ZoomRecordingFile[];
}

interface CloudRecordingJob {
  id: string;
  meetingId: string;
  meetingUuid: string;
  topic?: string;
  startedAt: string;
  file: ZoomRecordingFile;
  downloadToken?: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  recordingId?: string;
  localPath?: string;
  nextAttemptAt?: string;
}

interface QueueFile { jobs: CloudRecordingJob[] }

export interface ZoomCloudRecordingCallbacks {
  attach(startedAt: string, filePath: string): Promise<string>;
  hasLocalRecording(startedAt: string, durationSeconds?: number): Promise<boolean>;
  enabled(): boolean;
  audit(action: string, result: "success" | "failure", message: string, details?: Record<string, string | number | boolean | undefined>): Promise<void>;
}

interface PendingMatchError extends Error { name: "ZoomRecordingMatchPendingError" }
interface RejectedMatchError extends Error { name: "ZoomRecordingMatchRejectedError" }

export class ZoomCloudRecordingService {
  private jobs: CloudRecordingJob[] = [];
  private processing = false;
  private retryTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ZoomConfig,
    private readonly oauthStore: ZoomOAuthStore,
    private readonly queuePath: string,
    private readonly downloadDir: string,
    private readonly callbacks: ZoomCloudRecordingCallbacks
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.queuePath, "utf8")) as QueueFile;
      this.jobs = Array.isArray(parsed.jobs) ? parsed.jobs.map((job) => job.status === "processing" ? { ...job, status: "pending" } : job) : [];
    } catch {
      await this.save();
    }
    this.retryTimer = setInterval(() => void this.process().catch(console.error), 5 * 60_000);
    this.retryTimer.unref();
    const reconcileTimer = setInterval(() => void this.reconcile().catch(console.error), 5 * 60_000);
    reconcileTimer.unref();
    void this.process().catch(console.error);
    void this.reconcile().catch(console.error);
  }

  getStatus(): ZoomCloudRecordingStatus {
    const active = this.jobs.filter((job) => job.status === "pending" || job.status === "processing");
    const failed = this.jobs.filter((job) => job.status === "failed");
    const recentFailed = failed.filter((job) => Date.now() - Date.parse(job.updatedAt) < 10 * 60_000);
    const completed = this.jobs.filter((job) => job.status === "completed");
    return {
      pending: this.jobs.filter((job) => job.status === "pending").length,
      processing: this.jobs.filter((job) => job.status === "processing").length,
      failed: failed.length,
      completed: completed.length,
      lastEvent: active.length ? `Cloud archive processing (${active.length})` : completed.length ? "Cloud archive verified" : undefined,
      // Old failures remain available in diagnostics, but should not keep
      // reclaiming the OLED after a later meeting archived successfully.
      lastError: recentFailed.at(-1)?.error
    };
  }

  async enqueue(body: ZoomWebhookBody): Promise<boolean> {
    if (body.event !== "recording.completed") return false;
    const object = body.payload?.object as ZoomRecordingObject | undefined;
    const file = selectMp4(object?.recording_files ?? []);
    const meetingUuid = stringValue(object?.uuid);
    const meetingId = stringValue(object?.id);
    const startedAt = stringValue(object?.start_time);
    if (!object || !file?.download_url || !meetingUuid || !meetingId || !startedAt) {
      throw new Error("Zoom recording.completed payload did not contain an MP4 download");
    }
    return this.enqueueFile({ object, file, meetingUuid, meetingId, startedAt, downloadToken: body.download_token ?? body.payload?.download_token });
  }

  async reconcile(): Promise<void> {
    if (!this.callbacks.enabled()) return;
    const token = await this.validToken();
    const today = new Date();
    const from = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const url = new URL(`${token.apiUrl}/v2/users/me/recordings`);
    url.searchParams.set("from", from.toISOString().slice(0, 10));
    url.searchParams.set("to", today.toISOString().slice(0, 10));
    url.searchParams.set("page_size", "100");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!response.ok) throw new Error(`Zoom recording reconciliation failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { meetings?: ZoomRecordingObject[] };
    for (const object of body.meetings ?? []) {
      const meetingUuid = stringValue(object.uuid);
      const meetingId = stringValue(object.id);
      const startedAt = stringValue(object.start_time);
      const file = selectMp4(object.recording_files ?? []);
      const durationSeconds = typeof object.duration === "number" ? object.duration * 60 : undefined;
      if (!meetingUuid || !meetingId || !startedAt || !file?.download_url || !(await this.callbacks.hasLocalRecording(startedAt, durationSeconds))) continue;
      await this.enqueueFile({ object, file, meetingUuid, meetingId, startedAt });
    }
  }

  private async enqueueFile(input: { object: ZoomRecordingObject; file: ZoomRecordingFile; meetingUuid: string; meetingId: string; startedAt: string; downloadToken?: string }): Promise<boolean> {
    const id = `${input.meetingUuid}:${input.file.id ?? input.file.download_url}`;
    if (this.jobs.some((job) => job.id === id)) return true;
    const now = new Date().toISOString();
    this.jobs.push({ id, meetingId: input.meetingId, meetingUuid: input.meetingUuid, topic: stringValue(input.object.topic), startedAt: input.startedAt, file: input.file, downloadToken: input.downloadToken, status: "pending", attempts: 0, createdAt: now, updatedAt: now });
    await this.save();
    void this.process().catch(console.error);
    return true;
  }

  async process(): Promise<void> {
    if (this.processing) return;
    const now = Date.now();
    const job = this.jobs.find((candidate) =>
      (candidate.status === "pending" && (!candidate.nextAttemptAt || Date.parse(candidate.nextAttemptAt) <= now))
      || (candidate.status === "failed" && candidate.attempts < 5 && (!candidate.nextAttemptAt || Date.parse(candidate.nextAttemptAt) <= now))
    );
    if (!job) return;
    this.processing = true;
    job.status = "processing";
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();
    job.error = undefined;
    await this.save();
    let temporaryPath: string | undefined;
    try {
      const token = await this.validToken();
      if (!job.recordingId) {
        if (!job.localPath) {
          await mkdir(this.downloadDir, { recursive: true });
          temporaryPath = join(this.downloadDir, `${safeName(job.meetingId)}-${safeName(job.file.id ?? "recording")}.mp4.part`);
          const finalPath = temporaryPath.slice(0, -5);
          try {
            await download(job.file.download_url!, job.downloadToken ?? token.accessToken, temporaryPath);
          } catch (error) {
            await unlink(temporaryPath).catch(() => undefined);
            const refreshed = await this.fetchRecordingFile(job, token);
            job.file = refreshed.file;
            job.downloadToken = refreshed.downloadToken;
            await this.save();
            await download(job.file.download_url!, job.downloadToken ?? token.accessToken, temporaryPath);
          }
          await rename(temporaryPath, finalPath);
          temporaryPath = undefined;
          job.localPath = finalPath;
          job.updatedAt = new Date().toISOString();
          await this.save();
        }
        job.recordingId = await this.callbacks.attach(job.startedAt, job.localPath);
        job.localPath = undefined;
        job.nextAttemptAt = undefined;
        job.updatedAt = new Date().toISOString();
        await this.save();
      }
      await this.deleteCloudRecording(job, token);
      job.status = "completed";
      job.updatedAt = new Date().toISOString();
      await this.callbacks.audit("zoom.cloudRecording.archived", "success", "Zoom cloud recording archived to S3", { recordingId: job.recordingId, meetingId: job.meetingId });
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = new Date().toISOString();
      if (isPendingMatchError(error) && Date.now() - Date.parse(job.createdAt) < 24 * 60 * 60 * 1000) {
        job.status = "pending";
        job.attempts = Math.max(0, job.attempts - 1);
        job.nextAttemptAt = new Date(Date.now() + 5 * 60_000).toISOString();
      } else {
        job.status = "failed";
        if (isRejectedMatchError(error)) {
          job.attempts = 5;
          job.nextAttemptAt = undefined;
          if (job.localPath) await unlink(job.localPath).catch(() => undefined);
          job.localPath = undefined;
        } else {
          job.nextAttemptAt = new Date(Date.now() + 5 * 60_000).toISOString();
        }
        await this.callbacks.audit("zoom.cloudRecording.archive", "failure", job.error, { meetingId: job.meetingId, attempts: job.attempts });
      }
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    } finally {
      await this.save();
      this.processing = false;
      if (this.jobs.some((candidate) => candidate.status === "pending" && (!candidate.nextAttemptAt || Date.parse(candidate.nextAttemptAt) <= Date.now()))) {
        void this.process().catch(console.error);
      }
    }
  }

  private async validToken(): Promise<ZoomOAuthTokenSet> {
    const current = this.oauthStore.get();
    if (!current) throw new Error("Zoom OAuth is not authorized");
    if (Date.parse(current.expiresAt) > Date.now() + 60_000) return current;
    const refreshed = await new ZoomOAuthClient(this.config).refreshToken(current.refreshToken);
    refreshed.user = current.user;
    return this.oauthStore.save(refreshed);
  }

  private async deleteCloudRecording(job: CloudRecordingJob, token: ZoomOAuthTokenSet): Promise<void> {
    const meetingUuid = encodeURIComponent(encodeURIComponent(job.meetingUuid));
    const response = await fetch(`${token.apiUrl}/v2/meetings/${meetingUuid}/recordings?action=trash`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token.accessToken}` }
    });
    if (!response.ok) throw new Error(`Zoom cloud recording deletion failed (${response.status}): ${await response.text()}`);
  }

  private async fetchRecordingFile(job: CloudRecordingJob, token: ZoomOAuthTokenSet): Promise<{ file: ZoomRecordingFile; downloadToken?: string }> {
    const meetingUuid = encodeURIComponent(encodeURIComponent(job.meetingUuid));
    const response = await fetch(`${token.apiUrl}/v2/meetings/${meetingUuid}/recordings`, {
      headers: { Authorization: `Bearer ${token.accessToken}` }
    });
    if (!response.ok) throw new Error(`Zoom recording metadata refresh failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { recording_files?: ZoomRecordingFile[]; download_access_token?: string };
    const file = body.recording_files?.find((candidate) => candidate.id === job.file.id) ?? selectMp4(body.recording_files ?? []);
    if (!file?.download_url) throw new Error("Zoom recording metadata refresh did not contain the expected MP4");
    return { file, downloadToken: body.download_access_token };
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.queuePath), { recursive: true });
    await writeFile(this.queuePath, JSON.stringify({ jobs: this.jobs }, null, 2));
  }
}

function selectMp4(files: ZoomRecordingFile[]): ZoomRecordingFile | undefined {
  const priorities = ["shared_screen_with_speaker_view", "shared_screen_with_gallery_view", "active_speaker", "gallery_view"];
  return files.filter((file) => file.file_type?.toUpperCase() === "MP4" && file.download_url).sort((left, right) => {
    const sizeDifference = (right.file_size ?? 0) - (left.file_size ?? 0);
    if (sizeDifference) return sizeDifference;
    const leftPriority = priorities.indexOf(left.recording_type ?? "");
    const rightPriority = priorities.indexOf(right.recording_type ?? "");
    const priorityDifference = (leftPriority < 0 ? priorities.length : leftPriority) - (rightPriority < 0 ? priorities.length : rightPriority);
    return priorityDifference;
  })[0];
}

async function download(url: string, accessToken: string, path: string): Promise<void> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Zoom recording download failed (${response.status})`);
  await finished(Readable.fromWeb(response.body as never).pipe(createWriteStream(path, { flags: "wx" })));
}

function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }

function isPendingMatchError(error: unknown): error is PendingMatchError {
  return error instanceof Error && error.name === "ZoomRecordingMatchPendingError";
}

function isRejectedMatchError(error: unknown): error is RejectedMatchError {
  return error instanceof Error && error.name === "ZoomRecordingMatchRejectedError";
}
