# StudyBox Architecture

StudyBox is currently scaffolded as a mock-first TypeScript monorepo. The Raspberry Pi, Zoom SDK, GPIO, OLED, buttons, LEDs, and audio capture are represented by interfaces and mock implementations so the appliance workflow can be developed before hardware is available.

## Workspaces

- `packages/shared`: domain types and service/HAL interfaces.
- `packages/api`: Express API that composes services and hardware abstractions.
- `packages/web`: React/Vite web interface.
- `services/meeting`: meeting service implementations. Currently `MockMeetingService`.
- `services/podcast`: podcast recording service implementations. Currently `MockPodcastService`.
- `services/scheduler`: schedule persistence and automation boundary. Currently `MockSchedulerService`.
- `hal/*`: hardware abstraction packages with mock implementations and Raspberry Pi placeholders.

## Runtime Flow

The React app talks only to the Express API. The API owns service orchestration, settings persistence, OLED page state, mock buttons, and LED status calculation.

The UI never imports GPIO, OLED, Zoom, podcast, or scheduler implementations directly. That separation is intentional: real ARM64 hardware and Zoom work should replace implementations behind existing interfaces rather than changing UI behavior.

## Hardware State

The snapshot includes a hardware state model for the appliance surface: OLED, PAGE button, ACTION/RGB ring button, REC LED, and audio devices/routes. Each component reports implementation mode, health, connected state, and last event. During development these values are mock-backed; on the Pi the same shape should be populated by real HAL implementations without changing the web UI.

## Recording Lifecycle

Podcast recording is independent from the Zoom meeting lifecycle. A single Zoom meeting may contain multiple audio recording sessions.

Within one recording session, pause and resume continue writing to the same logical audio file. The recording is not available for download until the operator finishes it. Finishing a recording closes that file and adds it to the Recordings page. The next start creates a new audio file, even if the Zoom meeting is still live.

The web admin downloads recordings through the API. The UI should never read local audio files directly; the real recorder should replace the mock download implementation behind `PodcastService`.

## Audit Logs And Remote Sync

StudyBox keeps a local persisted audit log under `data/`. The log records appliance actions such as admin login, meeting controls, recording controls, download requests, settings saves, button actions, and Zoom webhook activity.

When remote sync is added, the Pi should continue operating locally during the meeting and upload finalized session bundles afterward. A bundle should include the completed mixed-audio recording, the audit log entries for that recording session, and metadata such as start time, end time, duration, and file name. Uploads should use a retry queue so travel, unplugging, or a network change does not interrupt the meeting or lose the session package.

The current implementation includes the local queue and a transport boundary. When the Zoom meeting is stopped and the recording is finished, StudyBox writes a session bundle under `STUDYBOX_BACKUP_DIR`, records queue state in `STUDYBOX_BACKUP_QUEUE_PATH`, and syncs pending bundles. Local development defaults to mock sync under `data/backup-bundles/`; Hetzner should store received bundles under `/srv/studybox-backups`; the Pi should later use `/var/lib/studybox/backups` as its local queue before pushing to Hetzner.

For the Pi, set `STUDYBOX_BACKUP_MODE=rsync` and provide `STUDYBOX_BACKUP_HOST`, `STUDYBOX_BACKUP_USER`, `STUDYBOX_BACKUP_REMOTE_DIR`, `STUDYBOX_BACKUP_SSH_KEY`, and optionally `STUDYBOX_BACKUP_PORT`. The rsync uploader uses `rsync -az --partial` over SSH and marks bundles failed instead of blocking meeting controls when the network is unavailable.

The API runs a background backup retry loop controlled by `STUDYBOX_BACKUP_RETRY_SECONDS`. Retries are skipped while a meeting is live or a recording is active so upload work does not compete with Zoom or audio capture.

## Development

```bash
npm install
npm run dev
```

`npm run dev` starts:

- Express API on `http://localhost:4000`
- Vite web UI on `http://localhost:5173`
- mock HAL
- mock meeting service
- mock podcast service

Local settings persist to `data/settings.json`, which is ignored by Git.

## Zoom Integration Notes

Milestone 1 deliberately avoids Zoom integration. The future Zoom implementation should start in `services/meeting` by adding a concrete class that satisfies `MeetingService`.

The API and UI should continue using the shared `MeetingService` contract. Any SDK-specific concerns, credentials, meeting signatures, native process handling, or ARM64 differences should stay inside the real meeting service package or an adapter owned by it.
