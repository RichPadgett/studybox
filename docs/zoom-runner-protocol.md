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

Use pure in-process mock mode:

```bash
ZOOM_MEETING_MODE=mock
```

## Commands

The API writes one command per line to runner stdin.

```json
{"id":"1","type":"startMeeting"}
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

## Future C++ Runner

The C++ ARM64 runner should:

- read commands from stdin
- write responses and events to stdout
- write diagnostics to stderr
- never print secrets or tokens
- fetch its SDK JWT/ZAK from the API or receive them through a command payload
- map Zoom SDK callbacks into `meeting.state` events
