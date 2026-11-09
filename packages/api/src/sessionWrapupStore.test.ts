import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionWrapupStore } from "./sessionWrapupStore.js";

test("session wrap-up IDs survive restart until explicitly cleared", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studybox-wrapup-"));
  const path = join(directory, "session-wrapup.json");
  try {
    const first = new SessionWrapupStore(path);
    await first.save(["rec-1-part-1", "rec-1-part-2", "rec-1-part-2"]);
    assert.deepEqual(first.get()?.recordingIds, ["rec-1-part-1", "rec-1-part-2"]);

    const second = new SessionWrapupStore(path);
    assert.deepEqual((await second.load())?.recordingIds, ["rec-1-part-1", "rec-1-part-2"]);
    await second.clear();
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
