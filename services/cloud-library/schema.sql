CREATE TABLE IF NOT EXISTS library_recordings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  recorded_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  source_file_sha256 TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending',
  visibility TEXT NOT NULL DEFAULT 'public',
  searchable_text TEXT NOT NULL DEFAULT '',
  audio_asset JSONB,
  zoom_asset JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transcript_chunks (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES library_recordings(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  start_seconds NUMERIC NOT NULL,
  end_seconds NUMERIC,
  text TEXT,
  audio_asset JSONB,
  UNIQUE(recording_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS transcript_markers (
  id BIGSERIAL PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES library_recordings(id) ON DELETE CASCADE,
  timestamp_seconds NUMERIC NOT NULL,
  label TEXT NOT NULL,
  scripture TEXT,
  kind TEXT
);

CREATE INDEX IF NOT EXISTS library_recordings_recorded_at_idx ON library_recordings (recorded_at DESC);
CREATE INDEX IF NOT EXISTS transcript_chunks_recording_idx ON transcript_chunks (recording_id, chunk_index);
CREATE INDEX IF NOT EXISTS transcript_markers_recording_idx ON transcript_markers (recording_id, timestamp_seconds);
CREATE INDEX IF NOT EXISTS library_recordings_search_idx ON library_recordings USING GIN (to_tsvector('simple', searchable_text));
