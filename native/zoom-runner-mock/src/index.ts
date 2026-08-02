#!/usr/bin/env node
import { createInterface } from "node:readline";
import type { MeetingState, Participant, ZoomRunnerCommand, ZoomRunnerEvent, ZoomRunnerResponse } from "@studybox/shared";

const initialParticipants: Participant[] = [
  { id: "runner-p1", displayName: "Runner Mary", status: "joined", joinedAt: new Date().toISOString() },
  { id: "runner-p2", displayName: "Runner David", status: "raised-hand", joinedAt: new Date().toISOString() }
];

const initialWaitingRoom: Participant[] = [
  { id: "runner-w1", displayName: "Runner Robert", status: "waiting" }
];

let state: MeetingState = {
  status: "idle",
  title: "Weekly Bible Study",
  participants: [],
  waitingRoom: [],
  raisedHands: [],
  lastEvent: "Mock Zoom runner ready"
};

emit({ type: "ready", state });

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  void handleLine(line);
});

async function handleLine(line: string): Promise<void> {
  let command: ZoomRunnerCommand;
  try {
    command = JSON.parse(line) as ZoomRunnerCommand;
  } catch {
    emit({ type: "error", message: "Invalid JSON command" });
    return;
  }

  try {
    const response = await execute(command);
    writeResponse(response);
  } catch (error) {
    writeResponse({
      id: command.id,
      ok: false,
      error: error instanceof Error ? error.message : "Unknown runner error",
      state
    });
  }
}

async function execute(command: ZoomRunnerCommand): Promise<ZoomRunnerResponse> {
  if (command.type === "startMeeting") {
    const participants = [...initialParticipants];
    state = {
      ...state,
      status: "live",
      meetingId: "runner-mock-2026-weekly",
      startedAt: new Date().toISOString(),
      participants,
      waitingRoom: [...initialWaitingRoom],
      raisedHands: participants.filter((participant) => participant.status === "raised-hand"),
      lastEvent: "Mock runner started meeting"
    };
    emit({ type: "meeting.state", state });
    return { id: command.id, ok: true, state };
  }

  if (command.type === "endMeeting") {
    state = {
      ...state,
      status: "idle",
      meetingId: undefined,
      startedAt: undefined,
      participants: [],
      waitingRoom: [],
      raisedHands: [],
      lastEvent: "Mock runner ended meeting"
    };
    emit({ type: "meeting.state", state });
    return { id: command.id, ok: true, state };
  }

  if (command.type === "admitParticipant") {
    const participant = state.waitingRoom.find((item) => item.id === command.participantId);
    if (participant) {
      const admitted: Participant = { ...participant, status: "joined", joinedAt: new Date().toISOString() };
      state = {
        ...state,
        participants: [...state.participants, admitted],
        waitingRoom: state.waitingRoom.filter((item) => item.id !== command.participantId),
        lastEvent: `${participant.displayName} admitted by mock runner`
      };
      emit({ type: "meeting.state", state });
    }
    return { id: command.id, ok: true, state };
  }

  if (command.type === "dismissRaisedHand") {
    state = {
      ...state,
      participants: state.participants.map((participant) =>
        participant.id === command.participantId ? { ...participant, status: "joined" } : participant
      ),
      raisedHands: state.raisedHands.filter((participant) => participant.id !== command.participantId),
      lastEvent: "Raised hand dismissed by mock runner"
    };
    emit({ type: "meeting.state", state });
    return { id: command.id, ok: true, state };
  }

  return { id: command.id, ok: true, state };
}

function writeResponse(response: ZoomRunnerResponse): void {
  process.stdout.write(`${JSON.stringify({ kind: "response", ...response })}\n`);
}

function emit(event: ZoomRunnerEvent): void {
  process.stdout.write(`${JSON.stringify({ kind: "event", ...event })}\n`);
}
