# StudyBox Transcript Library

StudyBox treats transcription as a post-recording job. Recording and Zoom finalization finish first; the AI work runs afterward and can retry across a reboot.

Each completed audio recording produces this directory:

```text
/var/lib/studybox/library/<recording-id>/
  chunk-000.m4a
  <recording-id>-chunk-0.json
  chunk-001.m4a
  <recording-id>-chunk-1.json
  transcript.txt
  studybox.db
```

`transcript.txt` is the durable, human-readable archive. The per-chunk JSON files retain chunk boundaries and AI output for inspection. `studybox.db` stores the job queue, metadata, searchable chunk text, Scripture markers, entities, occurrences, and cross-references. The full transcript is referenced by path and is not stored as one large database field.

The default chunk size is ten minutes. This gives predictable chapter anchors even when the transcription API does not provide word timestamps. AI analysis generates a title, description, and sorted markers, with Scripture references only when supported by the transcript.

## API

All routes require the existing StudyBox admin session:

```text
GET /api/library
GET /api/library/search?q=Daniel%20seven
GET /api/library/<recording-id>
```

The search endpoint searches every archived transcript chunk and returns the recording, timestamp, snippet, and nearest generated Scripture marker. The document endpoint returns the generated metadata and full transcript.

## Storage

Keep the operating system on the Pi boot media and mount an SSD at `/var/lib/studybox`. A 1 TB SSD is enough for a large audio library and transcript archive. Two TB is preferable if Zoom video is retained for many months, because video will consume substantially more space than text or compressed audio.

Before mounting the SSD, the default paths continue to work under `/var/lib/studybox`. After mounting, set `STUDYBOX_LIBRARY_DIR` and `STUDYBOX_RECORDINGS_DIR` to directories on the SSD and restart `studybox-api`.

The library is separate from the Hetzner backup bundles. That is intentional: local transcripts remain searchable even when a backup upload is delayed, while the existing backup process can be extended later to include the library directory. Back up `studybox.db` together with the transcript directories so the index and source files remain consistent.
