import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Recording } from "@studybox/shared";
import { MockBackupSyncService } from "./index.js";

test("backup packaging copies audio from disk without base64 buffering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studybox-backup-"));
  try {
    const sourcePath = join(directory, "part-1.wav");
    const contents = Buffer.alloc(1024 * 1024, 0x5a);
    await writeFile(sourcePath, contents);
    const recording: Recording = {
      id: "rec-test-part-1",
      title: "Test Part 1",
      startedAt: "2026-11-08T18:00:00.000Z",
      endedAt: "2026-11-08T19:00:00.000Z",
      durationSeconds: 3600,
      sizeBytes: contents.length,
      filePath: sourcePath
    };
    const service = new MockBackupSyncService({
      queuePath: join(directory, "queue.json"),
      bundleDir: join(directory, "bundles"),
      target: "test:backup"
    });
    await service.load();
    const bundle = await service.createBundle({
      recording,
      source: { filePath: sourcePath, fileName: "part-1.wav", mimeType: "audio/wav" },
      logs: [],
      meetingEndedAt: recording.endedAt!
    });

    assert.equal(bundle.status, "pending");
    const bundledAudioPath = join(directory, "bundles", bundle.id, "part-1.wav");
    assert.deepEqual(await readFile(bundledAudioPath), contents);

    const queuePath = join(directory, "queue.json");
    const interrupted = JSON.parse(await readFile(queuePath, "utf8"));
    interrupted.bundles[0].status = "zipping";
    await writeFile(queuePath, JSON.stringify(interrupted));
    await unlink(bundledAudioPath);
    const replacementContents = Buffer.alloc(1024 * 1024, 0x33);
    await writeFile(sourcePath, replacementContents);
    const restarted = new MockBackupSyncService({
      queuePath,
      bundleDir: join(directory, "bundles"),
      target: "test:backup"
    });
    assert.equal((await restarted.load()).bundles[0]?.status, "zipping");
    const rebuilt = await restarted.createBundle({
      recording,
      source: { filePath: sourcePath, fileName: "part-1.wav", mimeType: "audio/wav" },
      logs: [],
      meetingEndedAt: recording.endedAt!
    });
    assert.equal(rebuilt.status, "pending");
    assert.deepEqual(await readFile(bundledAudioPath), replacementContents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
