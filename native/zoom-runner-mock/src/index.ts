#!/usr/bin/env node
import { createInterface } from "node:readline";
import type { MeetingState, Participant, ZoomRunnerCommand, ZoomRunnerEvent, ZoomRunnerResponse } from "@studybox/shared";

const initialParticipants: Participant[] = [
  { id: "runner-p1", displayName: "Runner Mary", status: "joined", audioState: "muted", joinedAt: new Date().toISOString() },
  { id: "runner-p2", displayName: "Runner David", status: "raised-hand", audioState: "muted", joinedAt: new Date().toISOString() }
];

const initialWaitingRoom: Participant[] = [
  { id: "runner-w1", displayName: "Runner Robert", status: "waiting" }
];

let state: MeetingState = {
  status: "idle",
  title: "Weekly Bible Study",
  moderationMode: "moderated",
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
      activeSpeaker: undefined,
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

  if (command.type === "allowParticipantToSpeak") {
    const participant = state.participants.find((item) => item.id === command.participantId);
    if (participant) {
      const speaker: Participant = {
        ...participant,
        status: "joined",
        audioState: "allowed-to-speak"
      };
      state = {
        ...state,
        participants: state.participants.map((item) => item.id === command.participantId ? speaker : item),
        raisedHands: state.raisedHands.filter((item) => item.id !== command.participantId),
        activeSpeaker: speaker,
        lastEvent: `${participant.displayName} allowed to speak by mock runner`
      };
      emit({ type: "meeting.state", state });
    }
    return { id: command.id, ok: true, state };
  }

  if (command.type === "muteParticipant") {
    const participant = state.participants.find((item) => item.id === command.participantId);
    state = {
      ...state,
      participants: state.participants.map((item) => item.id === command.participantId ? { ...item, audioState: "muted" } : item),
      activeSpeaker: state.activeSpeaker?.id === command.participantId ? undefined : state.activeSpeaker,
      lastEvent: participant ? `${participant.displayName} muted by mock runner` : "Participant muted by mock runner"
    };
    emit({ type: "meeting.state", state });
    return { id: command.id, ok: true, state };
  }

  if (command.type === "setModerationMode") {
    state = {
      ...state,
      moderationMode: command.mode,
      participants: state.participants.map((participant) => ({
        ...participant,
        audioState: command.mode === "open" || participant.trustedSpeaker ? "allowed-to-speak" : "muted"
      })),
      activeSpeaker: undefined,
      lastEvent: `Moderation mode set to ${command.mode} by mock runner`
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
