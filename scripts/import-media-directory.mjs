import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { TranscriptLibraryService } from "/opt/studybox/services/transcripts/dist/index.js";

const inputDir = process.argv[2] ?? "/home/studybox/spotify-import";
const libraryRoot = process.env.STUDYBOX_LIBRARY_DIR ?? "/var/lib/studybox/library";
const historyPath = process.env.STUDYBOX_IMPORT_HISTORY ?? join(libraryRoot, "media-import-history.jsonl");
const supportedExtensions = new Set([".m4a", ".mp4", ".mp3", ".wav"]);

const sha256 = async (filePath) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
};

async function loadHistory() {
  const latest = new Map();
  try {
    const lines = (await readFile(historyPath, "utf8")).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.sha256) latest.set(item.sha256, item);
      } catch {
        // Ignore a damaged history line; the SQLite source hash remains authoritative.
      }
    }
  } catch {
    // The history file is created on the first import.
  }
  return latest;
}

async function recordHistory(entry) {
  await appendFile(historyPath, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForTerminalJob(recordingId) {
  while (true) {
    const job = library.getJob(recordingId);
    if (job && ["completed", "failed"].includes(job.status)) return job;
    await sleep(5000);
  }
}

const library = new TranscriptLibraryService({
  rootDir: libraryRoot,
  chunkSeconds: Number(process.env.STUDYBOX_TRANSCRIPT_CHUNK_SECONDS ?? 600),
  ffmpegPath: process.env.STUDYBOX_FFMPEG_PATH ?? "/usr/bin/ffmpeg",
  apiKey: process.env.OPENAI_API_KEY,
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL,
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL
});

await library.load();
const history = await loadHistory();
const knownHashes = new Set(library.getState().documents.map((document) => document.sourceFileSha256));
const files = (await readdir(inputDir))
  .filter((name) => supportedExtensions.has(extname(name).toLowerCase()))
  .sort();

let queued = 0;
let skipped = 0;
const imported = new Map();
for (const fileName of files) {
  const filePath = join(inputDir, fileName);
  const fileStat = await stat(filePath);
  const sourceFileSha256 = await sha256(filePath);
  const previous = history.get(sourceFileSha256);
  if (knownHashes.has(sourceFileSha256) || previous?.status === "completed") {
    skipped += 1;
    console.log(`SKIP ${fileName} (${previous?.status ?? "already indexed"})`);
    continue;
  }

  const recordingId = `import-${sourceFileSha256.slice(0, 32)}`;
  const recording = {
    id: recordingId,
    title: basename(fileName, extname(fileName)),
    startedAt: new Date(fileStat.mtimeMs).toISOString(),
    durationSeconds: 0,
    sizeBytes: fileStat.size,
    filePath
  };
  imported.set(recordingId, { fileName, sourceFileSha256 });
  await recordHistory({ status: "queued", recordingId, fileName, filePath, sha256: sourceFileSha256 });
  await library.enqueue(recording, filePath);
  queued += 1;
  console.log(`QUEUE ${fileName} -> ${recordingId}`);

  // Keep SQLite writes serialized on the Pi. enqueue() starts processing immediately.
  const job = await waitForTerminalJob(recordingId);
  await recordHistory({ status: job.status, recordingId, fileName, sha256: sourceFileSha256, error: job.error });
  console.log(`${job.status.toUpperCase()} ${fileName}`);
}

console.log(JSON.stringify({ inputDir, files: files.length, queued, skipped, historyPath }, null, 2));

while (true) {
  const jobs = [...imported.keys()].map((recordingId) => library.getJob(recordingId)).filter(Boolean);
  const active = jobs.filter((job) => !["completed", "failed"].includes(job.status));
  if (!active.length) {
    for (const job of jobs) {
      const source = imported.get(job.recordingId);
      if (source) await recordHistory({ status: job.status, recordingId: job.recordingId, fileName: source.fileName, sha256: source.sourceFileSha256, error: job.error });
    }
    break;
  }
  await sleep(5000);
}
