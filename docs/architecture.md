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
