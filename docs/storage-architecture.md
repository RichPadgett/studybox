# StudyBox Storage Architecture

## Local StudyBox SSD

The 2 TB SSD is the primary working store for the searchable knowledge base:

```text
/var/lib/studybox/
  recordings/       local processing copies
  library/          SQLite database, transcript files, chunks, and indexes
  backup-bundles/   pending upload work
```

SQLite stores meeting metadata, transcript chunk text for FTS5 search, markers, entities, relationships, job state, file UUIDs, hashes, and remote media references. Full transcripts remain human-readable files such as `transcript.txt`; the database stores their paths rather than one large transcript field.

Embeddings may be stored locally on the SSD when semantic search is enabled. They are optional and can be regenerated from the archived transcript chunks.

## Hetzner Object Storage

Hetzner S3-compatible Object Storage is the long-term archive for large downloadable media. The bucket should remain private. StudyBox should issue temporary signed download URLs through its API.

Recommended object keys:

```text
studybox-media/
  2026/09/05/<recording-uuid>/
    audio/<source-file-uuid>.wav
    audio/final.mp3
    video/<source-file-uuid>.mp4
    metadata.json
```

The UUID prevents collisions when two recordings have the same date or title. The SHA-256 hash stored in SQLite verifies uploads and detects duplicate source files.

## Database Model

Use a separate media asset record instead of hardcoding only `audio_object_key` and `video_object_key` columns:

```text
media_assets
  id
  meeting_id
  file_uuid
  kind             audio | video | other
  object_key
  mime_type
  size_bytes
  sha256
  status           pending | uploaded | missing | expired
  uploaded_at
```

This supports multiple audio formats, video revisions, future assets, and re-uploads without changing the meeting model.

## Processing and Retention

The Pi keeps local media while it is needed for processing, verification, or recent recovery. After a verified Object Storage upload, local video may be removed according to the configured retention policy. Transcripts, SQLite data, metadata, and search indexes should remain on the SSD.

AI processing runs only when StudyBox is not in a live Zoom meeting. Jobs pause on network failure or reboot and resume later. Media upload and transcript generation are independent jobs.

## User Access

The `/library` page searches local or synchronized metadata and opens a meeting detail page. Downloads go through the StudyBox API, which checks group access and returns a short-lived signed S3 URL. The bucket itself is never made public.

The media layer should use an application interface such as `MediaStore`, allowing Hetzner S3 storage to be replaced later without changing meeting, transcript, or search models.
