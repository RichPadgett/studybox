import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { TranscriptLibraryService } from "./index.js";

test("SQLite transcript search returns relevant chunk and Scripture context", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "studybox-transcript-test-"));
  const transcriptPath = join(rootDir, "recording", "transcript.txt");
  await mkdir(join(rootDir, "recording"), { recursive: true });
  await writeFile(transcriptPath, "[00:20:00] Daniel 7 and Revelation 13 are compared in the first-century timeline.");

  const first = new TranscriptLibraryService({ rootDir });
  await first.load();
  await seed(first, transcriptPath);

  const library = new TranscriptLibraryService({ rootDir });
  await library.load();

  const results = await library.search("Daniel Revelation");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.recordingId, "recording-1");
  assert.equal(results[0]?.timestampLabel, "20:00");
  assert.match(results[0]?.snippet ?? "", /Daniel 7/);
  assert.equal(results[0]?.scripture, "Daniel 7:1-14");
});

test("search requires all terms and respects result limits", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "studybox-transcript-test-"));
  const transcriptPath = join(rootDir, "recording", "transcript.txt");
  await mkdir(join(rootDir, "recording"), { recursive: true });
  await writeFile(transcriptPath, "[00:10:00] Vespasian and the ten kingdoms are discussed.");
  const first = new TranscriptLibraryService({ rootDir });
  await first.load();
  await seed(first, transcriptPath, "Vespasian and the ten kingdoms are discussed.", 600, "Vespasian and the ten kingdoms", undefined);
  const library = new TranscriptLibraryService({ rootDir });
  await library.load();

  assert.equal((await library.search("Vespasian kingdoms", 1)).length, 1);
  assert.equal((await library.search("Vespasian Babylon", 1)).length, 0);
  assert.equal((await library.search("Vespasian", 0)).length, 0);
});

async function seed(library: TranscriptLibraryService, transcriptPath: string, text = "Daniel 7 and Revelation 13 are compared in the first-century timeline.", startSeconds = 1200, label = "Daniel 7 and Revelation 13", scripture = "Daniel 7:1-14"): Promise<void> {
  const dbPath = join(library.getState().rootDir, "studybox.db");
  const db = await open(dbPath);
  await run(db, "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "recording-1", "recording-uuid-1", "audio-uuid-1", "sha256-1", "Daniel and Revelation", "A study of prophecy", transcriptPath, "completed", "2026-09-05T12:00:00.000Z", "2026-09-05T12:30:00.000Z", null);
  await run(db, "INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "recording-1-chunk-0", "chunk-uuid-1", "recording-1", 0, startSeconds, startSeconds + 600, "chunk-000.m4a", text, "transcribed", null);
  await run(db, "INSERT INTO transcript_fts VALUES (?, ?, ?)", "recording-1-chunk-0", "recording-1", text);
  await run(db, "INSERT INTO markers (recording_id, timestamp_seconds, label, scripture, kind) VALUES (?, ?, ?, ?, ?)", "recording-1", startSeconds, label, scripture, "major");
  await close(db);
}

function open(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, (error) => error ? reject(error) : resolve(db));
  });
}

function run(db: sqlite3.Database, sql: string, ...params: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}
