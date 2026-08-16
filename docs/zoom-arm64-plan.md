# Zoom ARM64 Implementation Plan

StudyBox targets the Zoom Meeting SDK for Linux ARM64 on Raspberry Pi 5. The TypeScript app remains the controller; the Zoom SDK should run in a native Linux process because the SDK is C++ and ships as Linux `.so` libraries.

## Current Project Additions

- `.env.example` defines Zoom credential and runner environment variables.
- `packages/api/src/zoomConfig.ts` reads Zoom env safely and exposes readiness without secrets.
- `packages/api/src/zoomSdkJwt.ts` creates the Meeting SDK JWT with Client ID and Client Secret.
- `services/meeting/src/index.ts` now includes `ZoomMeetingService`, `ZoomMeetingRunnerClient`, and `MissingZoomRunnerClient`.
- `native/zoom-runner` now builds a C++ StudyBox runner process that speaks the JSON-line runner protocol. Its default adapter validates host-start payloads and reports that the Zoom SDK is not linked yet.
- API endpoints:
  - `GET /api/zoom/status`
  - `POST /api/zoom/sdk-jwt`

The default meeting mode remains `mock`.

## Environment

Local `.env` should contain:

```bash
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=
ZOOM_REDIRECT_URI=https://studybox.enochscalendar.com/zoom/oauth/callback
ZOOM_ACCOUNT_ID=
ZOOM_WEBHOOK_SECRET_TOKEN=
ZOOM_MEETING_MODE=mock
ZOOM_SDK_ARCH=linux-arm64
ZOOM_RUNNER_PATH=./native/zoom-runner/build/studybox-zoom-runner
ZOOM_RUNNER_COMMAND=./native/zoom-runner/build/studybox-zoom-runner
ZOOM_RUNNER_ARGS=
```

Switch to the real runner later with:

```bash
ZOOM_MEETING_MODE=runner
```

## Native Runner Boundary

The future runner should satisfy the `ZoomMeetingRunnerClient` behavior over a local IPC protocol. The first implementation should use newline-delimited JSON over stdin/stdout because it is easy for Node/systemd to supervise.

Initial commands:

```json
{"id":"1","type":"startMeeting"}
{"id":"2","type":"endMeeting"}
{"id":"3","type":"admitParticipant","participantId":"12345"}
{"id":"4","type":"dismissRaisedHand","participantId":"12345"}
{"id":"5","type":"getState"}
```

Initial events:

```json
{"type":"meeting.status","status":"live"}
{"type":"participant.joined","participant":{"id":"12345","displayName":"Jane"}}
{"type":"waitingRoom.joined","participant":{"id":"12345","displayName":"Jane"}}
{"type":"raisedHand.changed","participantId":"12345","raised":true}
{"type":"error","message":"..."}
```

## ARM64 Validation Steps

1. Copy `zoom-meeting-sdk-linux_arm64-*` to the Pi.
2. Install Zoom Linux SDK dependencies from the headless sample Dockerfile as native apt packages.
3. Build the native runner stub with `npm run build -w @studybox/zoom-runner`.
4. Build the native runner with CMake against the ARM64 SDK.
5. Confirm SDK authentication using `POST /api/zoom/sdk-jwt`.
6. Confirm host ZAK retrieval using `GET /api/zoom/zak/status`.
7. Start or join a test meeting.
8. Confirm audio device selection with the DJI Mic receiver.
9. Confirm waiting room and participant callbacks.
10. Run the runner under systemd and verify restart behavior.

## Design Constraints

- React never receives Zoom secrets.
- React never talks to the native runner directly.
- The API owns Zoom JWT generation and runner supervision.
- The native runner owns all direct Meeting SDK calls.
- The mock meeting service remains available for development without hardware.
