import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { TranscriptLibraryService } from "/opt/studybox/services/transcripts/dist/index.js";

const inputDir = process.argv[2] ?? "/home/studybox/spotify-import";
const libraryRoot = process.env.STUDYBOX_LIBRARY_DIR ?? "/var/lib/studybox/library";
const historyPath = process.env.STUDYBOX_IMPORT_HISTORY ?? join(libraryRoot, "media-import-history.jsonl");
const supported = new Set([".m4a", ".mp4", ".mp3", ".wav"]);

const history = new Map();
try {
  for (const line of (await readFile(historyPath, "utf8")).split("\n").filter(Boolean)) {
    const item = JSON.parse(line);
    if (item.sha256) history.set(item.sha256, item);
  }
} catch {}

const library = new TranscriptLibraryService({
  rootDir: libraryRoot,
  chunkSeconds: Number(process.env.STUDYBOX_TRANSCRIPT_CHUNK_SECONDS ?? 600),
  ffmpegPath: process.env.STUDYBOX_FFMPEG_PATH ?? "/usr/bin/ffmpeg",
  apiKey: process.env.OPENAI_API_KEY,
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL,
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL
});
await library.load();

let recovered = 0;
for (const fileName of (await readdir(inputDir)).filter((name) => supported.has(extname(name).toLowerCase())).sort()) {
  const filePath = join(inputDir, fileName);
  const fileStat = await stat(filePath);
  const sha256 = await streamHash(filePath);
  const recordingId = `import-${sha256.slice(0, 32)}`;
  const recording = {
    id: recordingId,
    title: basename(fileName, extname(fileName)),
    startedAt: new Date(fileStat.mtimeMs).toISOString(),
    durationSeconds: 0,
    sizeBytes: fileStat.size,
    filePath
  };
  if (await library.recoverTranscript(recording, filePath)) {
    await appendFile(historyPath, `${JSON.stringify({ status: "completed", recordingId, fileName, sha256, recovered: true, at: new Date().toISOString() })}\n`);
    recovered += 1;
    console.log(`RECOVER ${fileName}`);
  }
}
console.log(JSON.stringify({ recovered, historyPath }, null, 2));

async function streamHash(filePath) {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
