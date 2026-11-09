import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createRequire } from "node:module";

const rootRequire = createRequire(join(process.cwd(), "package.json"));
const transcriptRequire = createRequire(join(process.cwd(), "services/transcripts/package.json"));
let sqlite3;

const apply = process.argv.includes("--apply");
const thresholdSeconds = Number(process.env.STUDYBOX_PRUNE_MIN_SECONDS ?? 1200);
const root = process.env.STUDYBOX_DATA_ROOT ?? "/var/lib/studybox";
const recordingsDir = join(root, "recordings");
const manifestPath = join(recordingsDir, "manifest.json");
const libraryDir = join(root, "library");
const databasePath = join(libraryDir, "studybox.db");
const backupsDir = join(root, "backups");
const queuePath = join(root, "backup-queue.json");
const stamp = new Date().toISOString().replaceAll(":", "-");
const quarantineDir = join(root, "quarantine", `short-recordings-${stamp}`);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const recordings = Array.isArray(manifest.recordings) ? manifest.recordings : [];
const shortIds = new Set(
  recordings
    .filter((recording) => !recording?.id || Number(recording.durationSeconds ?? 0) < thresholdSeconds)
    .map((recording) => recording?.id)
    .filter(Boolean)
);
const s3Objects = recordings.flatMap((recording) =>
  shortIds.has(recording?.id)
    ? (recording.assets ?? [])
        .filter((asset) => asset.archiveProvider === "s3" && asset.archiveBucket && asset.archiveKey)
        .map((asset) => ({ bucket: asset.archiveBucket, key: asset.archiveKey }))
    : []
);

const recordingFiles = await mediaFilesUnder(recordingsDir);
const shortRecordingFiles = recordingFiles.filter((file) => isShortMedia(file.path));
const bundleEntries = await safeReadDir(backupsDir);
const shortBundles = [];
for (const entry of bundleEntries.filter((candidate) => candidate.isDirectory())) {
  const path = join(backupsDir, entry.name);
  const media = await mediaFilesUnder(path);
  if (media.some((file) => isShortMedia(file.path))) shortBundles.push({ name: entry.name, path });
}

sqlite3 = transcriptRequire("sqlite3");
const db = await openDatabase(databasePath);
const shortDocuments = await all(db, "SELECT recording_id, title FROM documents WHERE recording_id LIKE 'rec-%'");
await closeDatabase(db);

console.log(JSON.stringify({
  apply,
  thresholdSeconds,
  shortManifestRecordings: shortIds.size,
  shortRecordingFiles: shortRecordingFiles.map((file) => file.path),
  shortBundles: shortBundles.map((bundle) => bundle.name),
  shortDocuments,
  s3Objects,
  quarantineDir
}, null, 2));

if (!apply) process.exit(0);

await mkdir(quarantineDir, { recursive: true });
await copyFile(manifestPath, join(quarantineDir, "manifest.json.before"));
await copyFile(databasePath, join(quarantineDir, "studybox.db.before"));
await copyFile(queuePath, join(quarantineDir, "backup-queue.json.before")).catch(() => undefined);

const quarantinedRecordings = join(quarantineDir, "recordings");
await mkdir(quarantinedRecordings, { recursive: true });
for (const file of shortRecordingFiles) await rename(file.path, join(quarantinedRecordings, file.name));

const quarantinedBundles = join(quarantineDir, "backups");
await mkdir(quarantinedBundles, { recursive: true });
for (const bundle of shortBundles) await rename(bundle.path, join(quarantinedBundles, bundle.name));

const quarantinedLibrary = join(quarantineDir, "library");
await mkdir(quarantinedLibrary, { recursive: true });
for (const document of shortDocuments) {
  const path = join(libraryDir, document.recording_id);
  await rename(path, join(quarantinedLibrary, document.recording_id)).catch(() => undefined);
}

manifest.recordings = recordings.filter((recording) => recording?.id && !shortIds.has(recording.id));
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

const queue = JSON.parse(await readFile(queuePath, "utf8").catch(() => "{}"));
const shortBundleNames = new Set(shortBundles.map((bundle) => bundle.name));
queue.bundles = (queue.bundles ?? []).filter((bundle) => !shortIds.has(bundle.recordingId) && !shortBundleNames.has(bundle.id));
await writeFile(queuePath, JSON.stringify(queue, null, 2));

const writeDb = await openDatabase(databasePath);
await run(writeDb, "BEGIN TRANSACTION");
try {
  for (const { recording_id: recordingId } of shortDocuments) {
    for (const table of ["jobs", "documents", "chunks", "markers", "entities", "entity_occurrences", "entity_relationships", "transcript_fts"]) {
      await run(writeDb, `DELETE FROM ${table} WHERE recording_id = ?`, recordingId);
    }
  }
  await run(writeDb, "COMMIT");
} catch (error) {
  await run(writeDb, "ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await closeDatabase(writeDb);
}

if (s3Objects.length) {
  const { client, DeleteObjectCommand } = await createS3Client();
  for (const object of s3Objects) {
    await client.send(new DeleteObjectCommand({ Bucket: object.bucket, Key: object.key }));
    console.log(`Deleted S3 object ${object.bucket}/${object.key}`);
  }
}

console.log(`Pruned short recordings; recoverable local copies are in ${quarantineDir}`);

async function mediaFilesUnder(path) {
  const entries = await safeReadDir(path);
  return entries
    .filter((entry) => entry.isFile() && /\.(wav|mp4|m4a)$/i.test(entry.name))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }));
}

function isShortMedia(path) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { encoding: "utf8" });
  const duration = Number(result.stdout.trim());
  return !Number.isFinite(duration) || duration < thresholdSeconds;
}

async function safeReadDir(path) {
  return readdir(path, { withFileTypes: true }).catch(() => []);
}

async function createS3Client() {
  const { DeleteObjectCommand, S3Client } = rootRequire("@aws-sdk/client-s3");
  const [accessKeyId, secretAccessKey, bucketFile] = await Promise.all([
    readFile(process.env.STUDYBOX_S3_ACCESS_KEY_FILE ?? "/home/studybox/accesskey", "utf8"),
    readFile(process.env.STUDYBOX_S3_SECRET_KEY_FILE ?? "/home/studybox/secretkey", "utf8"),
    readFile(process.env.STUDYBOX_S3_BUCKET_FILE ?? "/home/studybox/bucket", "utf8")
  ]);
  const [, endpointLine] = bucketFile.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const endpoint = endpointLine.startsWith("http") ? endpointLine : `https://${endpointLine}`;
  return {
    client: new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() } }),
    DeleteObjectCommand
  };
}

function openDatabase(path) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(path, (error) => error ? reject(error) : resolve(database));
  });
}

function run(database, sql, ...params) {
  return new Promise((resolve, reject) => database.run(sql, params, (error) => error ? reject(error) : resolve()));
}

function all(database, sql, ...params) {
  return new Promise((resolve, reject) => database.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

function closeDatabase(database) {
  return new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
}
