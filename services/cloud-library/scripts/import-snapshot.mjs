import fs from "node:fs/promises";
import process from "node:process";
import { Client } from "pg";

const snapshotPath = process.argv[2] ?? "snapshot.json";
const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const recordings = Array.isArray(snapshot.podcast?.recordings) ? snapshot.podcast.recordings : [];
const documents = Array.isArray(snapshot.library?.documents) ? snapshot.library.documents : [];
const documentsByRecording = new Map(documents.map((document) => [document.recordingId, document]));
const recordingsById = new Map(
  recordings
    .map((recording) => [recording?.id ?? recording?.recordingId, recording])
    .filter(([recordingId]) => Boolean(recordingId))
);
const recordingIds = new Set([...recordingsById.keys(), ...documentsByRecording.keys()].filter(Boolean));

await client.query("BEGIN");
try {
  for (const recordingId of recordingIds) {
    const recording = recordingsById.get(recordingId);
    const document = documentsByRecording.get(recordingId);
    const chunks = Array.isArray(document?.chunks) ? document.chunks : [];
    const searchable = [recording?.title, document?.title, document?.description, ...chunks.map((chunk) => chunk.text ?? ""), ...(document?.markers ?? []).map((marker) => marker.label)].filter(Boolean).join(" ");
    const audio = recording?.assets?.find((asset) => asset.kind === "audio") ?? document?.audioAsset;
    const zoom = recording?.assets?.find((asset) => asset.kind === "zoom") ?? document?.zoomAsset;
    await client.query(`
      INSERT INTO library_recordings
        (id, title, description, recorded_at, duration_seconds, source_file_sha256, transcript_status, visibility, searchable_text, audio_asset, zoom_asset, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'public',$8,$9,$10,now())
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
        recorded_at=EXCLUDED.recorded_at, duration_seconds=EXCLUDED.duration_seconds,
        source_file_sha256=EXCLUDED.source_file_sha256, transcript_status=EXCLUDED.transcript_status,
        searchable_text=EXCLUDED.searchable_text,
        audio_asset=COALESCE(EXCLUDED.audio_asset, library_recordings.audio_asset),
        zoom_asset=COALESCE(EXCLUDED.zoom_asset, library_recordings.zoom_asset), updated_at=now()`,
      [recordingId, document?.title || recording?.title || "Untitled teaching", document?.description ?? null, recording?.startedAt ?? document?.recordedAt ?? null, recording?.durationSeconds ?? null, document?.sourceFileSha256 ?? null, document?.status ?? "pending", searchable, audio ? JSON.stringify(audio) : null, zoom ? JSON.stringify(zoom) : null]
    );
    await client.query("DELETE FROM transcript_chunks WHERE recording_id = $1", [recordingId]);
    await client.query("DELETE FROM transcript_markers WHERE recording_id = $1", [recordingId]);
    for (const chunk of chunks) {
      await client.query(`INSERT INTO transcript_chunks (id, recording_id, chunk_index, start_seconds, end_seconds, text, audio_asset) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [chunk.id, recordingId, chunk.index, chunk.startSeconds ?? 0, chunk.endSeconds ?? null, chunk.text ?? null, audio ? JSON.stringify({ ...audio, chunkIndex: chunk.index }) : null]);
    }
    for (const marker of document?.markers ?? []) {
      await client.query(`INSERT INTO transcript_markers (recording_id, timestamp_seconds, label, scripture, kind) VALUES ($1,$2,$3,$4,$5)`, [recordingId, marker.timestampSeconds, marker.label, marker.scripture ?? marker["scripture?"] ?? null, marker.kind ?? null]);
    }
  }
  await client.query("COMMIT");
  console.log(`Imported ${recordingIds.size} library records from ${recordings.length} recordings and ${documents.length} transcript documents`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
