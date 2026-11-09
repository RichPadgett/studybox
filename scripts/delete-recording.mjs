import { createRequire } from "node:module";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const { DeleteObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const recordingId = process.argv[2];
if (!recordingId || !/^rec-[0-9]+(?:-part-[0-9]+)?$/.test(recordingId)) throw new Error("Usage: delete-recording.mjs rec-<timestamp>[-part-<number>]");

const root = process.env.STUDYBOX_DATA_ROOT ?? "/var/lib/studybox";
const manifestPath = join(root, "recordings", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const recording = (manifest.recordings ?? []).find((candidate) => candidate.id === recordingId);
if (!recording) throw new Error(`Recording not found: ${recordingId}`);
if (recording.endedAt === undefined) throw new Error("Refusing to delete an active recording");

const filePaths = new Set([
  recording.filePath,
  ...(recording.assets ?? []).map((asset) => asset.filePath)
].filter(Boolean));
manifest.recordings = manifest.recordings.filter((candidate) => candidate.id !== recordingId);
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

const queuePath = join(root, "backup-queue.json");
const queue = JSON.parse(await readFile(queuePath, "utf8").catch(() => "{}"));
const removedBundles = (queue.bundles ?? []).filter((bundle) => bundle.recordingId === recordingId);
queue.bundles = (queue.bundles ?? []).filter((bundle) => bundle.recordingId !== recordingId);
await writeFile(queuePath, JSON.stringify(queue, null, 2));

for (const path of filePaths) await rm(path, { force: true });
for (const bundle of removedBundles) await rm(join(root, "backups", bundle.id), { recursive: true, force: true });
for (const directory of [
  join(root, "library", recordingId),
  join(root, "cloud-sync", "bundles", recordingId)
]) await rm(directory, { recursive: true, force: true });

const sqlite3 = require("sqlite3");
const database = new sqlite3.Database(join(root, "library", "studybox.db"));
await run(database, "BEGIN TRANSACTION");
try {
  for (const table of ["jobs", "documents", "chunks", "markers", "entities", "entity_occurrences", "entity_relationships", "transcript_fts"]) {
    await run(database, `DELETE FROM ${table} WHERE recording_id = ?`, recordingId);
  }
  await run(database, "COMMIT");
} catch (error) {
  await run(database, "ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await close(database);
}

const remainingArchiveKeys = new Set((manifest.recordings ?? []).flatMap((candidate) =>
  (candidate.assets ?? [])
    .filter((asset) => asset.archiveProvider === "s3" && asset.archiveBucket && asset.archiveKey)
    .map((asset) => `${asset.archiveBucket}/${asset.archiveKey}`)
));
const zoomObjects = (recording.assets ?? []).filter((asset) => asset.archiveProvider === "s3"
  && asset.archiveBucket
  && asset.archiveKey
  && !remainingArchiveKeys.has(`${asset.archiveBucket}/${asset.archiveKey}`));
if (zoomObjects.length) {
  const [accessKeyId, secretAccessKey, bucketFile] = await Promise.all([
    readFile(process.env.STUDYBOX_S3_ACCESS_KEY_FILE ?? "/home/studybox/accesskey", "utf8"),
    readFile(process.env.STUDYBOX_S3_SECRET_KEY_FILE ?? "/home/studybox/secretkey", "utf8"),
    readFile(process.env.STUDYBOX_S3_BUCKET_FILE ?? "/home/studybox/bucket", "utf8")
  ]);
  const [, endpointLine] = bucketFile.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const client = new S3Client({
    endpoint: endpointLine.startsWith("http") ? endpointLine : `https://${endpointLine}`,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() }
  });
  for (const asset of zoomObjects) await client.send(new DeleteObjectCommand({ Bucket: asset.archiveBucket, Key: asset.archiveKey }));
}

const cloudQueuePath = join(root, "zoom-cloud", "queue.json");
const cloudQueue = JSON.parse(await readFile(cloudQueuePath, "utf8").catch(() => "{}"));
cloudQueue.jobs = (cloudQueue.jobs ?? []).filter((job) => job.recordingId !== recordingId);
await writeFile(cloudQueuePath, JSON.stringify(cloudQueue, null, 2));
console.log(JSON.stringify({ recordingId, deletedLocalFiles: [...filePaths], deletedS3Objects: zoomObjects.map((asset) => `${asset.archiveBucket}/${asset.archiveKey}`) }, null, 2));

function run(database, sql, ...params) {
  return new Promise((resolve, reject) => database.run(sql, params, (error) => error ? reject(error) : resolve()));
}

function close(database) {
  return new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
}
