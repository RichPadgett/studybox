import cors from "cors";
import express from "express";
import { Pool } from "pg";
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

app.get("/api/library", async (request, response, next) => {
  try {
    const query = String(request.query.q ?? "").trim();
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 30)));
    const offset = Math.max(0, Number(request.query.offset ?? 0));
    const result = query
      ? await pool.query(
          `SELECT id, title, description, recorded_at, duration_seconds, transcript_status,
                  audio_asset, zoom_asset, ts_headline('simple', searchable_text, websearch_to_tsquery('simple', $1)) AS match_preview
             FROM library_recordings
            WHERE searchable_text @@ websearch_to_tsquery('simple', $1)
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
