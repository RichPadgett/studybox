# Zoom Runner Protocol

The StudyBox API controls Zoom through a child process. The process communicates with newline-delimited JSON over stdin/stdout.

This protocol is implemented today by `native/zoom-runner-mock`. The future ARM64 C++ Meeting SDK runner should implement the same protocol.

## Environment

Use mock runner mode:

```bash
ZOOM_MEETING_MODE=runner
ZOOM_RUNNER_COMMAND=node
ZOOM_RUNNER_ARGS=./native/zoom-runner-mock/dist/index.js
```

Use native runner mode:

```bash
ZOOM_MEETING_MODE=runner
ZOOM_RUNNER_PATH=./native/zoom-runner/build/studybox-zoom-runner
ZOOM_RUNNER_COMMAND=./native/zoom-runner/build/studybox-zoom-runner
ZOOM_RUNNER_ARGS=
```

Use pure in-process mock mode:

```bash
ZOOM_MEETING_MODE=mock
```

## Commands

The API writes one command per line to runner stdin.

```json
{"id":"1","type":"startMeeting","meetingNumber":"1234567890","password":"123456","displayName":"StudyBox","sdkJwt":"...","zak":"..."}
{"id":"2","type":"endMeeting"}
{"id":"3","type":"admitParticipant","participantId":"runner-w1"}
{"id":"4","type":"dismissRaisedHand","participantId":"runner-p2"}
{"id":"5","type":"getState"}
```

## Responses

The runner writes one response per line to stdout.

```json
{"kind":"response","id":"1","ok":true,"state":{"status":"live"}}
{"kind":"response","id":"2","ok":false,"error":"Zoom SDK auth failed"}
```

## Events

The runner may emit events independently of responses.

```json
{"kind":"event","type":"ready","state":{"status":"idle"}}
{"kind":"event","type":"meeting.state","state":{"status":"live"}}
{"kind":"event","type":"log","level":"info","message":"Zoom SDK initialized"}
{"kind":"event","type":"error","message":"Zoom SDK disconnected"}
```

## Native C++ Runner

The C++ ARM64 runner in `native/zoom-runner`:

- read commands from stdin
- write responses and events to stdout
- write diagnostics to stderr
- never print secrets or tokens
- receives SDK JWT/ZAK through the `startMeeting` command payload
- map Zoom SDK callbacks into `meeting.state` events

The default build uses a stub adapter that validates the payload and reports that the Zoom SDK is not linked. The SDK adapter is enabled later with:

```bash
cd native/zoom-runner
mkdir -p build
cd build
cmake .. -DSTUDYBOX_ENABLE_ZOOM_SDK=ON -DZOOM_SDK_ROOT=/opt/zoom/meeting-sdk-linux-arm64
cmake --build .
```
