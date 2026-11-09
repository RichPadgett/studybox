import { createHash } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { S3ZoomArchive } from "/opt/studybox/services/podcast/dist/index.js";
import { TranscriptLibraryService } from "/opt/studybox/services/transcripts/dist/index.js";

const recordingId = process.argv[2];
const zoomPath = process.argv[3];
if (!recordingId || !zoomPath) throw new Error("Usage: recover-recording-assets.mjs <recording-id> <zoom-file>");

const manifestPath = "/var/lib/studybox/recordings/manifest.json";
const libraryRoot = "/var/lib/studybox/library";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const recording = manifest.recordings?.find((candidate) => candidate.id === recordingId);
if (!recording) throw new Error(`Recording not found: ${recordingId}`);

const zoomInfo = await stat(zoomPath);
const zoomMetadata = await new S3ZoomArchive().upload(recording, zoomPath);
if (!zoomMetadata) throw new Error("S3 archive is not configured");
recording.assets = [
  ...(recording.assets ?? []).filter((asset) => asset.kind !== "zoom"),
  {
    kind: "zoom",
    label: "Zoom recording",
    status: "available",
    fileName: zoomPath.split("/").at(-1),
    mimeType: "video/mp4",
    filePath: zoomPath,
    sizeBytes: zoomInfo.size,
    ...zoomMetadata
  }
];
const temporaryManifest = `${manifestPath}.recovery-${process.pid}`;
await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2));
await rename(temporaryManifest, manifestPath);

const audioPath = recording.filePath;
const library = new TranscriptLibraryService({
  rootDir: libraryRoot,
  chunkSeconds: Number(process.env.STUDYBOX_TRANSCRIPT_CHUNK_SECONDS ?? 600),
  ffmpegPath: process.env.STUDYBOX_FFMPEG_PATH ?? "/usr/bin/ffmpeg",
  apiKey: process.env.OPENAI_API_KEY,
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL,
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL
});
await library.load();
if (!library.getDocument(recordingId)) {
  await library.enqueue(recording, audioPath);
  while (true) {
    const job = library.getJob(recordingId);
    if (job && ["completed", "failed"].includes(job.status)) {
      if (job.status === "failed") throw new Error(job.error ?? "Transcription failed");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

const sha256 = createHash("sha256");
for await (const chunk of (await import("node:fs")).createReadStream(zoomPath)) sha256.update(chunk);
console.log(JSON.stringify({ recordingId, transcript: library.getJob(recordingId), zoom: { ...zoomMetadata, sizeBytes: zoomInfo.size, sha256: sha256.digest("hex") } }, null, 2));
