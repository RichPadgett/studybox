import { TranscriptLibraryService } from "/opt/studybox/services/transcripts/dist/index.js";

const audioPath = process.argv[2] ?? "/home/studybox/ShabbatSep5.m4a";
const recording = {
  id: "sim-shabbat-sep5",
  title: "Daniel & Revelation 13: The Beasts, the Ten Kingdoms & This Generation",
  startedAt: "2026-09-05T12:00:00.000Z",
  durationSeconds: 8986,
  sizeBytes: 99514041,
  filePath: audioPath
};

const library = new TranscriptLibraryService({
  rootDir: process.env.STUDYBOX_LIBRARY_DIR ?? "/var/lib/studybox/library",
  chunkSeconds: Number(process.env.STUDYBOX_TRANSCRIPT_CHUNK_SECONDS ?? 600),
  ffmpegPath: process.env.STUDYBOX_FFMPEG_PATH ?? "/usr/bin/ffmpeg",
  apiKey: process.env.OPENAI_API_KEY,
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL,
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL
});

await library.load();
const job = await library.enqueue(recording, audioPath);
console.log(JSON.stringify({ job, library: library.getState() }, null, 2));
await new Promise(() => undefined);
