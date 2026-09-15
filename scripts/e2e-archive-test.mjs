import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalPodcastService, S3ZoomArchive } from "@studybox/podcast";
import { MockBackupSyncService } from "@studybox/sync";
import { TranscriptLibraryService } from "@studybox/transcripts";

const recordingsDir = process.env.STUDYBOX_RECORDINGS_DIR ?? "/var/lib/studybox/recordings";
const manifestPath = process.env.STUDYBOX_RECORDINGS_MANIFEST ?? join(recordingsDir, "manifest.json");
const libraryDir = process.env.STUDYBOX_LIBRARY_DIR ?? "/var/lib/studybox/library";
const backupQueuePath = process.env.STUDYBOX_BACKUP_QUEUE_PATH ?? "/var/lib/studybox/backup-queue.json";
const backupDir = process.env.STUDYBOX_BACKUP_DIR ?? "/var/lib/studybox/backups";
const sourcePath = process.env.STUDYBOX_TEST_SOURCE ?? join(recordingsDir, "bible-study-2026-08-26-23-06.wav");
const startedAt = "2026-09-15T19:00:00.000Z";
const recordingId = `rec-e2e-lorem-${Date.now()}`;
const title = "E2E Archive Test - Lorem Ipsum Meeting";
const testAudioName = `${recordingId}.wav`;
const testZoomName = `${recordingId}.mp4`;
const audioPath = join(recordingsDir, testAudioName);
const zoomPath = join(recordingsDir, testZoomName);

const source = await stat(sourcePath);
await writeFile(audioPath, await readFile(sourcePath));
await writeFile(zoomPath, await readFile(sourcePath));

const recording = {
  id: recordingId,
  title,
  startedAt,
  endedAt: "2026-09-15T19:12:00.000Z",
  durationSeconds: 720,
  sizeBytes: source.size,
  downloadFileName: testAudioName,
  downloadMimeType: "audio/wav",
  filePath: audioPath,
  assets: [
    { kind: "audio", label: "Room audio", status: "available", fileName: testAudioName, mimeType: "audio/wav", filePath: audioPath, sizeBytes: source.size },
    { kind: "zoom", label: "Zoom recording", status: "pending", fileName: testZoomName, mimeType: "video/mp4", filePath: zoomPath, sizeBytes: source.size }
  ]
};

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.recordings = [recording, ...(manifest.recordings ?? []).filter((item) => item.id !== recordingId)];
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

const podcast = new LocalPodcastService({
  recordingsDir,
  manifestPath,
  retentionDays: 0,
  s3Archive: new S3ZoomArchive()
});
await podcast.load();
await podcast.setZoomRecordingAsset(recordingId, zoomPath);

const transcriptWorkDir = join(libraryDir, recordingId);
await mkdir(transcriptWorkDir, { recursive: true });
const fullText = [
  "Lorem ipsum dolor sit amet. This synthetic meeting verifies the StudyBox archive pipeline.",
  "The room recording is saved locally, the Zoom asset is archived to object storage, and the meeting bundle is copied to the temporary Hetzner backup.",
  "This test document is intentionally synthetic and can be removed after verification."
].join("\n\n");
const transcriptPath = join(transcriptWorkDir, "transcript.txt");
await writeFile(transcriptPath, fullText);
await writeFile(join(transcriptWorkDir, testAudioName), await readFile(audioPath));
await writeFile(join(transcriptWorkDir, `${recordingId}-chunk-0.json`), JSON.stringify({
  id: `${recordingId}-chunk-0`,
  fileUuid: randomUUID(),
  index: 0,
  startSeconds: 0,
  endSeconds: 720,
  audioFileName: testAudioName,
  text: fullText,
  status: "transcribed"
}, null, 2));
const library = new TranscriptLibraryService({ rootDir: libraryDir });
await library.load();
await library.recoverTranscript({ ...recording }, audioPath);

const backup = new MockBackupSyncService({
  queuePath: backupQueuePath,
  bundleDir: backupDir,
  target: process.env.STUDYBOX_BACKUP_REPO ?? "hetzner:studybox-backup",
  mode: "rsync",
  rsync: {
    host: process.env.STUDYBOX_BACKUP_HOST,
    user: process.env.STUDYBOX_BACKUP_USER,
    remoteDir: process.env.STUDYBOX_BACKUP_REMOTE_DIR,
    stageRemoteDir: process.env.STUDYBOX_BACKUP_STAGE_REMOTE_DIR,
    sshKeyPath: process.env.STUDYBOX_BACKUP_SSH_KEY,
    port: process.env.STUDYBOX_BACKUP_PORT ? Number(process.env.STUDYBOX_BACKUP_PORT) : undefined
  }
});
await backup.load();
const audioBase64 = (await readFile(audioPath)).toString("base64");
await backup.createBundle({
  recording,
  download: { recording, fileName: testAudioName, mimeType: "audio/wav", contentBase64: audioBase64 },
  logs: [{ id: randomUUID(), timestamp: new Date().toISOString(), source: "system", level: "info", action: "e2e.archive-test", result: "success", message: "Synthetic Lorem ipsum archive test" }],
  meetingEndedAt: recording.endedAt
});
const backupState = await backup.syncPending();
const updated = (await podcast.listRecordings()).find((item) => item.id === recordingId);
const zoomAsset = updated?.assets?.find((asset) => asset.kind === "zoom");
const audioHash = createHash("sha256").update(await readFile(audioPath)).digest("hex");
console.log(JSON.stringify({
  recordingId,
  title,
  localAudio: { path: audioPath, bytes: source.size, sha256: audioHash },
  zoom: { localPath: zoomPath, status: zoomAsset?.status, archiveProvider: zoomAsset?.archiveProvider, archiveBucket: zoomAsset?.archiveBucket, archiveKey: zoomAsset?.archiveKey, archiveSha256: zoomAsset?.archiveSha256 },
  library: { document: library.getDocument(recordingId)?.title, status: library.getDocument(recordingId)?.status, chunks: library.getDocument(recordingId)?.chunks.length },
  backup: { status: backupState.bundles.find((bundle) => bundle.recordingId === recordingId)?.status, bundleId: backupState.bundles.find((bundle) => bundle.recordingId === recordingId)?.id, lastEvent: backupState.lastEvent }
}, null, 2));
