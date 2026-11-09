import cors from "cors";
import express from "express";
import { Pool } from "pg";
import { timingSafeEqual } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 4010);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");

type ArchivedAsset = {
  fileName?: string;
  mimeType?: string;
  archiveKey?: string;
  archiveBucket?: string;
  archiveEndpoint?: string;
  archiveProvider?: string;
};

let archiveCredentialsPromise: Promise<{
  accessKeyId: string;
  secretAccessKey: string;
}> | null = null;

function getArchiveCredentials(): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
}> {
  if (!archiveCredentialsPromise) {
    const accessKeyPath =
      process.env.STUDYBOX_S3_ACCESS_KEY_FILE ?? "/home/studybox/accesskey";
    const secretKeyPath =
      process.env.STUDYBOX_S3_SECRET_KEY_FILE ?? "/home/studybox/secretkey";

    archiveCredentialsPromise = Promise.all([
      readFile(accessKeyPath, "utf8"),
      readFile(secretKeyPath, "utf8"),
    ]).then(([accessKeyId, secretAccessKey]) => ({
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
    }));
  }

  return archiveCredentialsPromise;
}

function safeDownloadName(fileName: string) {
  return fileName.replace(/[\r\n"\\]/g, "_");
}

async function getArchiveDownloadUrl(asset: ArchivedAsset) {
  if (
    asset.archiveProvider !== "s3" ||
    !asset.archiveEndpoint ||
    !asset.archiveBucket ||
    !asset.archiveKey
  ) {
    return null;
  }

  const credentials = await getArchiveCredentials();
  const client = new S3Client({
    endpoint: asset.archiveEndpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials,
  });
  const fileName = safeDownloadName(asset.fileName ?? "studybox-recording");

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: asset.archiveBucket,
      Key: asset.archiveKey,
      ResponseContentDisposition: `attachment; filename="${fileName}"`,
      ...(asset.mimeType ? { ResponseContentType: asset.mimeType } : {}),
    }),
    { expiresIn: 900 }
  );
}
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/library", express.static(publicDir, { index: "library.html" }));

app.get("/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ ok: true });
  } catch (error) {
    response.status(503).json({ ok: false, error: error instanceof Error ? error.message : "Database unavailable" });
  }
});

app.post("/api/library/sync", requireSyncToken, async (request, response, next) => {
  const connection = await pool.connect();
  try {
    const recording = request.body?.recording as Record<string, unknown> | undefined;
    const document = request.body?.document as Record<string, unknown> | undefined;
    const recordingId = stringValue(document?.recordingId) ?? stringValue(recording?.id);
    if (!recordingId || !document) {
      response.status(400).json({ error: "A transcript document with a recordingId is required" });
      return;
    }
    const chunks = Array.isArray(document.chunks) ? document.chunks as Array<Record<string, unknown>> : [];
    const markers = Array.isArray(document.markers) ? document.markers as Array<Record<string, unknown>> : [];
    const entities = Array.isArray(document.entities) ? document.entities as Array<Record<string, unknown>> : [];
    const occurrences = Array.isArray(document.occurrences) ? document.occurrences as Array<Record<string, unknown>> : [];
    const relationships = Array.isArray(document.relationships) ? document.relationships as Array<Record<string, unknown>> : [];
    const inferredDuration = Math.max(0, ...chunks.map((chunk) => Number(chunk.endSeconds ?? chunk.startSeconds ?? 0)));
    const searchable = [recording?.title, document.title, document.description,
      ...chunks.map((chunk) => chunk.text), ...markers.flatMap((marker) => [marker.label, marker.scripture, marker["scripture?"]]),
      ...entities.flatMap((entity) => [entity.canonicalName, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]),
      ...occurrences.flatMap((occurrence) => [occurrence.quote]),
      ...relationships.flatMap((relationship) => [relationship.relationship, relationship.evidence])
    ].filter(Boolean).join(" ");
    const audioAsset = request.body?.audioAsset ?? document.audioAsset ?? (recording?.assets as Array<Record<string, unknown>> | undefined)?.find((asset) => asset.kind === "audio") ?? null;
    const zoomAsset = request.body?.zoomAsset ?? document.zoomAsset ?? (recording?.assets as Array<Record<string, unknown>> | undefined)?.find((asset) => asset.kind === "zoom") ?? null;
    await connection.query("BEGIN");
    await connection.query(`
      INSERT INTO library_recordings
        (id, title, description, recorded_at, duration_seconds, source_file_sha256, transcript_status, visibility, searchable_text, audio_asset, zoom_asset, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'public',$8,$9,$10,now())
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
        recorded_at=EXCLUDED.recorded_at, duration_seconds=COALESCE(EXCLUDED.duration_seconds, library_recordings.duration_seconds),
        source_file_sha256=EXCLUDED.source_file_sha256, transcript_status=EXCLUDED.transcript_status,
        visibility='public', searchable_text=EXCLUDED.searchable_text,
        audio_asset=COALESCE(EXCLUDED.audio_asset, library_recordings.audio_asset),
        zoom_asset=COALESCE(EXCLUDED.zoom_asset, library_recordings.zoom_asset), updated_at=now()`,
      [recordingId, stringValue(document.title) ?? stringValue(recording?.title) ?? "Untitled teaching", stringValue(document.description) ?? null,
        stringValue(recording?.startedAt) ?? stringValue(document.recordedAt) ?? null,
        typeof recording?.durationSeconds === "number" && recording.durationSeconds > 0 ? recording.durationSeconds : inferredDuration || null,
        stringValue(document.sourceFileSha256) ?? null, stringValue(document.status) ?? "completed", searchable,
        audioAsset ? JSON.stringify(audioAsset) : null, zoomAsset ? JSON.stringify(zoomAsset) : null]
    );
    await connection.query("DELETE FROM transcript_chunks WHERE recording_id = $1", [recordingId]);
    await connection.query("DELETE FROM transcript_markers WHERE recording_id = $1", [recordingId]);
    for (const chunk of chunks) {
      await connection.query(
        "INSERT INTO transcript_chunks (id, recording_id, chunk_index, start_seconds, end_seconds, text, audio_asset) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [stringValue(chunk.id), recordingId, Number(chunk.index), Number(chunk.startSeconds ?? 0), chunk.endSeconds == null ? null : Number(chunk.endSeconds), stringValue(chunk.text) ?? null, audioAsset ? JSON.stringify({ ...audioAsset, chunkIndex: chunk.index }) : null]
      );
    }
    for (const marker of markers) {
      await connection.query(
        "INSERT INTO transcript_markers (recording_id, timestamp_seconds, label, scripture, kind) VALUES ($1,$2,$3,$4,$5)",
        [recordingId, Number(marker.timestampSeconds ?? 0), stringValue(marker.label) ?? "Section", stringValue(marker.scripture ?? marker["scripture?"]) ?? null, stringValue(marker.kind) ?? null]
      );
    }
    await connection.query("COMMIT");
    response.json({ ok: true, recordingId, chunks: chunks.length, markers: markers.length });
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    connection.release();
  }
});
app.get("/api/library", async (request, response, next) => {
  try {
    const query = String(request.query.q ?? "").trim();
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 30)));
    const offset = Math.max(0, Number(request.query.offset ?? 0));
    const result = query
      ? await pool.query(
          `SELECT id, title, description, recorded_at, duration_seconds, transcript_status,
                  audio_asset, zoom_asset,
                  ts_headline('simple', left(searchable_text, 12000), websearch_to_tsquery('simple', $1), 'MaxFragments=2,MaxWords=35,MinWords=12') AS match_preview
             FROM library_recordings
            WHERE visibility = 'public'
              AND to_tsvector('simple', searchable_text) @@ websearch_to_tsquery('simple', $1)
            ORDER BY recorded_at DESC NULLS LAST, created_at DESC
            LIMIT $2 OFFSET $3`,
          [query, limit, offset]
        )
      : await pool.query(
          `SELECT id, title, description, recorded_at, duration_seconds, transcript_status,
                  audio_asset, zoom_asset, NULL AS match_preview
             FROM library_recordings
            WHERE visibility = 'public'
            ORDER BY recorded_at DESC NULLS LAST, created_at DESC
            LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
    response.json({ items: result.rows, query, limit, offset });
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/library/:id/assets/:assetKind/download",
  async (request, response, next) => {
    try {
      const assetColumn =
        request.params.assetKind === "zoom"
          ? "zoom_asset"
          : request.params.assetKind === "audio"
            ? "audio_asset"
            : null;

      if (!assetColumn) {
        response.status(404).json({ error: "Recording asset not found" });
        return;
      }

      const result = await pool.query(
        `SELECT ${assetColumn} AS asset
           FROM library_recordings
          WHERE id = $1 AND visibility = 'public'`,
        [request.params.id]
      );
      const asset = result.rows[0]?.asset as ArchivedAsset | null | undefined;
      const archiveUrl = asset ? await getArchiveDownloadUrl(asset) : null;

      if (!archiveUrl) {
        response.status(404).json({ error: "Recording asset not found" });
        return;
      }

      response.redirect(302, archiveUrl);
    } catch (error) {
      next(error);
    }
  }
);

app.get("/api/library/:id", async (request, response, next) => {
  try {
    const recording = await pool.query("SELECT * FROM library_recordings WHERE id = $1", [request.params.id]);
    if (!recording.rowCount) {
      response.status(404).json({ error: "Recording not found" });
      return;
    }
    const [chunks, markers] = await Promise.all([
      pool.query("SELECT id, chunk_index, start_seconds, end_seconds, text, audio_asset FROM transcript_chunks WHERE recording_id = $1 ORDER BY chunk_index", [request.params.id]),
      pool.query("SELECT timestamp_seconds, label, scripture, kind FROM transcript_markers WHERE recording_id = $1 ORDER BY timestamp_seconds", [request.params.id])
    ]);
    response.json({ recording: recording.rows[0], chunks: chunks.rows, markers: markers.rows });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("Cloud library request failed", error);
  response.status(500).json({ error: error instanceof Error ? error.message : "Request failed" });
});

app.listen(port, () => console.log(`StudyBox cloud library listening on ${port}`));

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireSyncToken(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const expected = process.env.STUDYBOX_CLOUD_SYNC_TOKEN?.trim();
  const header = request.header("authorization");
  const actual = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!expected || actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    response.status(401).json({ error: "Cloud library sync authorization required" });
    return;
  }
  next();
}
