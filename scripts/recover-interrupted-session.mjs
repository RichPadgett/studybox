import { execFile } from "node:child_process";
import { link, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { S3ZoomArchive } from "/opt/studybox/services/podcast/dist/index.js";

const execFileAsync = promisify(execFile);
const [sessionId, zoomPath] = process.argv.slice(2);
if (!/^rec-[0-9]+$/.test(sessionId ?? "") || !zoomPath) {
  throw new Error("Usage: recover-interrupted-session.mjs rec-<timestamp> <zoom-mp4>");
}

const root = process.env.STUDYBOX_DATA_ROOT ?? "/var/lib/studybox";
const recordingsDir = join(root, "recordings");
const manifestPath = join(recordingsDir, "manifest.json");
const segmentDir = join(recordingsDir, `.segments-${sessionId}`);
const segmentPaths = [join(segmentDir, "segment-001.wav"), join(segmentDir, "segment-002.wav")];
await Promise.all([...segmentPaths, zoomPath].map((path) => stat(path)));

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const existingIds = new Set((manifest.recordings ?? []).map((recording) => recording.id));
const sessionStartedAt = new Date(Number(sessionId.slice(4))).toISOString();
const segments = [];
for (let index = 0; index < segmentPaths.length; index += 1) {
  const sourcePath = segmentPaths[index];
  const info = await stat(sourcePath);
  const durationSeconds = await mediaDuration(sourcePath);
  const startedAt = index === 0
    ? sessionStartedAt
    : new Date(Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs - durationSeconds * 1000).toISOString();
  const id = `${sessionId}-part-${index + 1}`;
  const date = new Date(startedAt).toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
  const fileName = `bible-study-${startedAt.slice(0, 10)}-part-${index + 1}.wav`;
  const filePath = join(recordingsDir, fileName);
  await mkdir(recordingsDir, { recursive: true });
  try {
    await link(sourcePath, filePath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  segments.push({
    id,
    title: `Bible Study ${date} - Part ${index + 1}`,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + durationSeconds * 1000).toISOString(),
    durationSeconds: Math.round(durationSeconds),
    sizeBytes: info.size,
    downloadFileName: fileName,
    downloadMimeType: "audio/wav",
    filePath,
    assets: [{
      kind: "audio",
      label: `Room audio - Part ${index + 1} of ${segmentPaths.length}`,
      status: "available",
      fileName,
      mimeType: "audio/wav",
      filePath,
      sizeBytes: info.size
    }]
  });
}

if (segments.some((recording) => existingIds.has(recording.id))) {
  throw new Error(`Recovery entries already exist for ${sessionId}`);
}

const zoomInfo = await stat(zoomPath);
const archive = await new S3ZoomArchive().upload(segments[0], zoomPath);
if (!archive) throw new Error("S3 archive is not configured");
const zoomAsset = {
  kind: "zoom",
  label: "Zoom recording - complete session",
  status: "available",
  fileName: basename(zoomPath),
  mimeType: "video/mp4",
  sizeBytes: zoomInfo.size,
  ...archive
};
for (const recording of segments) recording.assets.push({ ...zoomAsset });

const backupPath = `${manifestPath}.before-recovery-${Date.now()}`;
await writeFile(backupPath, JSON.stringify(manifest, null, 2));
manifest.recordings = [...segments, ...(manifest.recordings ?? [])];
const temporaryManifest = `${manifestPath}.recovery-${process.pid}`;
await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2));
await rename(temporaryManifest, manifestPath);

const queuePath = join(root, "zoom-cloud", "queue.json");
const queue = JSON.parse(await readFile(queuePath, "utf8"));
const queueJob = (queue.jobs ?? []).find((job) => job.localPath === zoomPath || zoomPath.includes(job.file?.id ?? "__missing__"));
if (queueJob) {
  queueJob.recordingId = segments[0].id;
  queueJob.status = "pending";
  queueJob.attempts = 0;
  queueJob.error = undefined;
  queueJob.nextAttemptAt = new Date().toISOString();
  queueJob.updatedAt = new Date().toISOString();
  const temporaryQueue = `${queuePath}.recovery-${process.pid}`;
  await writeFile(temporaryQueue, JSON.stringify(queue, null, 2));
  await rename(temporaryQueue, queuePath);
}

console.log(JSON.stringify({
  sessionId,
  recordings: segments.map(({ id, title, startedAt, endedAt, durationSeconds, filePath }) => ({ id, title, startedAt, endedAt, durationSeconds, filePath })),
  zoom: { ...archive, fileName: basename(zoomPath), sizeBytes: zoomInfo.size },
  queueJob: queueJob?.id,
  manifestBackup: backupPath
}, null, 2));

async function mediaDuration(path) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not determine media duration: ${path}`);
  return duration;
}
