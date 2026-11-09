import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(join(process.cwd(), "package.json"));
const { HeadObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const apiBase = process.env.STUDYBOX_LOCAL_API ?? "http://127.0.0.1:4000";
const cloudSyncUrl = process.env.STUDYBOX_CLOUD_SYNC_URL ?? "https://enochscalendar.com/api/library/sync";
const workRoot = process.env.STUDYBOX_CLOUD_SYNC_DIR ?? "/var/lib/studybox/cloud-sync";
const statePath = join(workRoot, "state.json");
const ffmpeg = process.env.STUDYBOX_FFMPEG_PATH ?? "/usr/bin/ffmpeg";
const syncToken = (process.env.STUDYBOX_CLOUD_SYNC_TOKEN
  ?? await readFile(process.env.STUDYBOX_CLOUD_SYNC_TOKEN_FILE ?? "/home/studybox/cloud-sync-token", "utf8")).trim();
const adminPin = process.env.STUDYBOX_ADMIN_PIN ?? await dotenvValue("/opt/studybox/.env", "STUDYBOX_ADMIN_PIN") ?? "364364";
const s3 = await s3Config();
const client = new S3Client({ endpoint: s3.endpoint, region: "us-east-1", forcePathStyle: true, credentials: s3.credentials });
const state = JSON.parse(await readFile(statePath, "utf8").catch(() => '{"documents":{}}'));
state.documents ??= {};
state.publications ??= {};
const requestedIdIndex = process.argv.indexOf("--recording-id");
const requestedId = requestedIdIndex >= 0 ? process.argv[requestedIdIndex + 1] : undefined;

if (!requestedId) {
  console.log("No explicit publication requested; leaving local library unchanged.");
  process.exit(0);
}

await mkdir(workRoot, { recursive: true });
const adminSession = await jsonFetch(`${apiBase}/api/admin/login`, { method: "POST", body: JSON.stringify({ pin: adminPin }), headers: { "Content-Type": "application/json" } });
const headers = { Authorization: `Bearer ${adminSession.token}` };
const [{ documents }, snapshot] = await Promise.all([
  jsonFetch(`${apiBase}/api/library/export`, { headers }),
  jsonFetch(`${apiBase}/api/snapshot`)
]);
const recordings = new Map((snapshot.podcast?.recordings ?? []).map((recording) => [recording.id, recording]));
const document = documents.find((candidate) => candidate.status === "completed" && candidate.recordingId === requestedId);
if (!document) throw new Error(`Completed transcript not found for publication: ${requestedId}`);

state.publications[requestedId] = {
  status: "publishing",
  title: document.title,
  startedAt: new Date().toISOString()
};
await saveState();

try {
  const previous = state.documents[document.recordingId];
  const recording = recordings.get(document.recordingId);
  const currentZoom = recording?.assets?.find((asset) => asset.kind === "zoom" && (asset.archiveKey || asset.filePath));
  const zoomSignature = currentZoom ? [currentZoom.archiveProvider ?? "", currentZoom.archiveKey ?? "", currentZoom.filePath ?? "", currentZoom.sizeBytes ?? ""].join("|") : "";
  // Zoom cloud recordings can arrive after the transcript/audio document has
  // already been synced. Re-run the record when that asset changes so the
  // public library receives its zoom_asset metadata and download link.
  const bundleDir = join(workRoot, "bundles", document.recordingId);
  await mkdir(bundleDir, { recursive: true });
  const audioPath = await fullAudioPath(document, recording, bundleDir);
  await copyFile(document.fullTextPath, join(bundleDir, "transcript.txt")).catch(() => undefined);
  const audioAsset = await uploadAsset(document, audioPath, "audio", previous?.audioAsset);
  let zoomAsset = recording?.assets?.find((asset) => asset.kind === "zoom" && asset.archiveKey);
  const localZoom = recording?.assets?.find((asset) => asset.kind === "zoom" && asset.filePath)?.filePath;
  if (localZoom) {
    await copyFile(localZoom, join(bundleDir, basename(localZoom))).catch(() => undefined);
    zoomAsset ??= await uploadAsset(document, localZoom, "zoom", previous?.zoomAsset);
  }
  const cloudRecording = {
    ...(recording ?? {}),
    id: document.recordingId,
    title: document.title ?? recording?.title ?? "Untitled teaching",
    startedAt: recording?.startedAt ?? document.recordedAt ?? document.createdAt,
    durationSeconds: recording?.durationSeconds || await mediaDuration(audioPath),
    assets: [audioAsset, ...(zoomAsset ? [zoomAsset] : [])]
  };
  const payload = { recording: cloudRecording, document: { ...document, audioAsset, zoomAsset }, audioAsset, zoomAsset };
  await writeFile(join(bundleDir, "metadata.json"), JSON.stringify(payload, null, 2));
  await jsonFetch(cloudSyncUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncToken}` },
    body: JSON.stringify(payload)
  });
  const publishedAt = new Date().toISOString();
  state.documents[document.recordingId] = { updatedAt: document.updatedAt, syncedAt: publishedAt, zoomSignature, audioAsset, zoomAsset };
  state.publications[document.recordingId] = { status: "published", title: document.title, publishedAt };
  await saveState();
  console.log(`Synced ${document.recordingId}: ${document.title}`);
} catch (error) {
  state.publications[document.recordingId] = {
    status: "failed",
    title: document.title,
    error: error instanceof Error ? error.message : String(error),
    failedAt: new Date().toISOString()
  };
  await saveState();
  throw error;
}

async function saveState() {
  const temporaryPath = `${statePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2));
  await rename(temporaryPath, statePath);
}

async function fullAudioPath(document, recording, bundleDir) {
  const localAudio = recording?.assets?.find((asset) => asset.kind === "audio" && asset.filePath)?.filePath ?? recording?.filePath;
  if (localAudio) {
    const target = join(bundleDir, basename(localAudio));
    await copyFile(localAudio, target);
    return target;
  }
  const target = join(bundleDir, `${slug(document.title)}.m4a`);
  const listPath = join(bundleDir, "chunks.txt");
  const chunks = document.chunks.map((chunk) => join(dirname(document.fullTextPath), chunk.audioFileName));
  if (!chunks.length) throw new Error(`No audio chunks exist for ${document.recordingId}`);
  await writeFile(listPath, chunks.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
  await run(ffmpeg, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", target]);
  return target;
}

async function uploadAsset(document, path, kind, existingAsset) {
  const info = await stat(path);
  const sha256 = await sha256File(path);
  const extension = basename(path).split(".").at(-1) ?? (kind === "zoom" ? "mp4" : "m4a");
  const date = String(document.recordedAt ?? document.createdAt).slice(0, 10);
  const key = `${kind}/${date}/${document.recordingId}-${slug(document.title)}.${extension}`;
  if (existingAsset?.archiveProvider === "s3"
    && existingAsset.archiveBucket
    && existingAsset.archiveKey
    && existingAsset.archiveSha256 === sha256
    && Number(existingAsset.sizeBytes) === info.size) {
    return existingAsset;
  }
  const existingHead = await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key })).catch((error) => {
    if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  });
  if (existingHead && Number(existingHead.ContentLength) === info.size && existingHead.Metadata?.sha256 === sha256) {
    return archivedAsset(kind, path, extension, info.size, key, sha256, existingHead);
  }
  await new Upload({
    client,
    queueSize: 2,
    partSize: 10 * 1024 * 1024,
    leavePartsOnError: false,
    params: {
      Bucket: s3.bucket, Key: key, Body: createReadStream(path), ContentLength: info.size,
      ContentType: kind === "zoom" ? "video/mp4" : extension === "wav" ? "audio/wav" : "audio/mp4",
      Metadata: { sha256, recordingid: document.recordingId }
    }
  }).done();
  const head = await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }));
  if (Number(head.ContentLength) !== info.size || head.Metadata?.sha256 !== sha256) throw new Error(`S3 verification failed for ${key}`);
  return archivedAsset(kind, path, extension, info.size, key, sha256, head);
}

function archivedAsset(kind, path, extension, sizeBytes, key, sha256, head) {
  return { kind, label: kind === "zoom" ? "Zoom recording" : "Room audio", status: "available", fileName: basename(path), mimeType: kind === "zoom" ? "video/mp4" : extension === "wav" ? "audio/wav" : "audio/mp4", sizeBytes, archiveProvider: "s3", archiveBucket: s3.bucket, archiveKey: key, archiveEndpoint: s3.endpoint, archiveSha256: sha256, archiveEtag: head.ETag?.replaceAll('"', "") };
}

async function s3Config() {
  const [accessKeyId, secretAccessKey, bucketFile] = await Promise.all([
    readFile(process.env.STUDYBOX_S3_ACCESS_KEY_FILE ?? "/home/studybox/accesskey", "utf8"),
    readFile(process.env.STUDYBOX_S3_SECRET_KEY_FILE ?? "/home/studybox/secretkey", "utf8"),
    readFile(process.env.STUDYBOX_S3_BUCKET_FILE ?? "/home/studybox/bucket", "utf8")
  ]);
  const [bucket, endpointLine] = bucketFile.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  return { bucket, endpoint: endpointLine.startsWith("http") ? endpointLine : `https://${endpointLine}`, credentials: { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() } };
}

async function jsonFetch(url, init) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(`${url} failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited ${code}`)));
  });
}

async function mediaDuration(path) {
  let output = "";
  await new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffprobe exited ${code}`)));
  });
  return Math.max(0, Math.round(Number(output.trim()) || 0));
}

function slug(value) { return String(value ?? "studybox-teaching").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "studybox-teaching"; }
async function dotenvValue(path, name) { const text = await readFile(path, "utf8").catch(() => ""); return text.split(/\r?\n/).find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1).trim(); }
