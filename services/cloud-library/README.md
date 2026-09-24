# StudyBox Cloud Library

This service is the cloud-facing index for StudyBox recordings. PostgreSQL stores searchable metadata, transcript chunks, and markers. Large audio/video files remain in object storage; `audio_asset` and `zoom_asset` contain the provider, object key, checksum, and download metadata.

Required environment:

```text
DATABASE_URL=postgres://studybox_library:...@127.0.0.1:5432/studybox_library
PORT=4010
```

Apply `schema.sql` before starting the service. The Pi sync worker should upsert completed recordings after local finalization and after each verified media upload.
