import type { MeetingModerationMode, MeetingService, MeetingState, Participant } from "@studybox/shared";

const initialParticipants: Participant[] = [
  { id: "p1", displayName: "Mary Johnson", status: "joined", audioState: "muted", joinedAt: new Date().toISOString() },
  { id: "p2", displayName: "David Lee", status: "joined", audioState: "muted", joinedAt: new Date().toISOString() },
  { id: "p3", displayName: "Anna Smith", status: "raised-hand", audioState: "muted", joinedAt: new Date().toISOString() }
];

const initialWaitingRoom: Participant[] = [
  { id: "w1", displayName: "Robert Garcia", status: "waiting" }
];

export class MockMeetingService implements MeetingService {
  private state: MeetingState = {
    status: "idle",
    title: "Weekly Bible Study",
    moderationMode: "moderated",
    participants: [],
    waitingRoom: [],
    raisedHands: [],
    lastEvent: "Meeting service ready"
  };

  getState(): MeetingState {
    return this.state;
  }

  async startMeeting(): Promise<MeetingState> {
    const participants = [...initialParticipants];
    this.state = {
      ...this.state,
      status: "live",
      meetingId: "mock-2026-weekly",
      startedAt: new Date().toISOString(),
      participants,
      waitingRoom: [...initialWaitingRoom],
      raisedHands: participants.filter((participant) => participant.status === "raised-hand"),
      lastEvent: "Mock Zoom meeting started"
    };
    return this.state;
  }

  async endMeeting(): Promise<MeetingState> {
    this.state = {
      ...this.state,
      status: "idle",
      meetingId: undefined,
      startedAt: undefined,
      participants: [],
      waitingRoom: [],
      raisedHands: [],
      activeSpeaker: undefined,
      lastEvent: "Meeting ended"
    };
    return this.state;
  }

  async admitParticipant(participantId: string): Promise<MeetingState> {
    const participant = this.state.waitingRoom.find((item) => item.id === participantId);
    if (!participant) {
      return this.state;
    }

    const admitted: Participant = {
      ...participant,
      status: "joined",
      audioState: this.state.moderationMode === "open" ? "allowed-to-speak" : "muted",
      joinedAt: new Date().toISOString()
    };

    this.state = {
      ...this.state,
      participants: [...this.state.participants, admitted],
      waitingRoom: this.state.waitingRoom.filter((item) => item.id !== participantId),
      lastEvent: `${participant.displayName} admitted from waiting room`
    };
    return this.state;
  }

  async dismissRaisedHand(participantId: string): Promise<MeetingState> {
    this.state = {
      ...this.state,
      participants: this.state.participants.map((participant) =>
        participant.id === participantId ? { ...participant, status: "joined" } : participant
      ),
      raisedHands: this.state.raisedHands.filter((participant) => participant.id !== participantId),
      lastEvent: "Raised hand dismissed"
    };
    return this.state;
  }

  async allowParticipantToSpeak(participantId: string): Promise<MeetingState> {
    const participant = this.state.participants.find((item) => item.id === participantId);
    if (!participant) {
      return this.state;
    }

    const speaker: Participant = {
      ...participant,
      status: "joined",
      audioState: "allowed-to-speak"
    };

    this.state = {
      ...this.state,
      participants: this.state.participants.map((item) => item.id === participantId ? speaker : { ...item, audioState: item.audioState === "speaking" ? "muted" : item.audioState }),
      raisedHands: this.state.raisedHands.filter((item) => item.id !== participantId),
      activeSpeaker: speaker,
      lastEvent: `${participant.displayName} allowed to speak`
    };
    return this.state;
  }

  async muteParticipant(participantId: string): Promise<MeetingState> {
    const participant = this.state.participants.find((item) => item.id === participantId);
    this.state = {
      ...this.state,
      participants: this.state.participants.map((item) => item.id === participantId ? { ...item, audioState: "muted" } : item),
      activeSpeaker: this.state.activeSpeaker?.id === participantId ? undefined : this.state.activeSpeaker,
      lastEvent: participant ? `${participant.displayName} muted` : "Participant muted"
    };
    return this.state;
  }

  async setModerationMode(mode: MeetingModerationMode): Promise<MeetingState> {
    this.state = {
      ...this.state,
      moderationMode: mode,
      participants: this.state.participants.map((participant) => ({
        ...participant,
        audioState: mode === "open" || participant.trustedSpeaker ? "allowed-to-speak" : "muted"
      })),
      activeSpeaker: undefined,
      lastEvent: `Moderation mode set to ${mode}`
    };
    return this.state;
  }
}

export interface ZoomMeetingRunnerClient {
  startMeeting(): Promise<void>;
  endMeeting(): Promise<void>;
  admitParticipant(participantId: string): Promise<void>;
  dismissRaisedHand(participantId: string): Promise<void>;
  allowParticipantToSpeak(participantId: string): Promise<void>;
  muteParticipant(participantId: string): Promise<void>;
  setModerationMode(mode: MeetingModerationMode): Promise<void>;
  getState(): Promise<MeetingState>;
}

export class ZoomMeetingService implements MeetingService {
  private state: MeetingState = {
    status: "idle",
    title: "Weekly Bible Study",
    moderationMode: "moderated",
    participants: [],
    waitingRoom: [],
    raisedHands: [],
    lastEvent: "Zoom runner adapter initialized"
  };

  constructor(private readonly runner: ZoomMeetingRunnerClient) {}

  getState(): MeetingState {
    return this.state;
  }

  async startMeeting(): Promise<MeetingState> {
    this.state = {
      ...this.state,
      status: "starting",
      lastEvent: "Starting Zoom meeting through runner"
    };
    await this.runner.startMeeting();
    return this.refreshState();
  }

  async endMeeting(): Promise<MeetingState> {
    this.state = {
      ...this.state,
      status: "ending",
      lastEvent: "Ending Zoom meeting through runner"
    };
    await this.runner.endMeeting();
    return this.refreshState();
  }

  async admitParticipant(participantId: string): Promise<MeetingState> {
    await this.runner.admitParticipant(participantId);
    return this.refreshState();
  }

  async dismissRaisedHand(participantId: string): Promise<MeetingState> {
    await this.runner.dismissRaisedHand(participantId);
    return this.refreshState();
  }

  async allowParticipantToSpeak(participantId: string): Promise<MeetingState> {
    await this.runner.allowParticipantToSpeak(participantId);
    return this.refreshState();
  }

  async muteParticipant(participantId: string): Promise<MeetingState> {
    await this.runner.muteParticipant(participantId);
    return this.refreshState();
  }

  async setModerationMode(mode: MeetingModerationMode): Promise<MeetingState> {
    await this.runner.setModerationMode(mode);
    return this.refreshState();
  }

  private async refreshState(): Promise<MeetingState> {
    this.state = await this.runner.getState();
    return this.state;
  }
}

export class MissingZoomRunnerClient implements ZoomMeetingRunnerClient {
  async startMeeting(): Promise<void> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async endMeeting(): Promise<void> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async admitParticipant(_participantId: string): Promise<void> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async dismissRaisedHand(_participantId: string): Promise<void> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async allowParticipantToSpeak(_participantId: string): Promise<void> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async muteParticipant(_participantId: string): Promise<void> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async setModerationMode(_mode: MeetingModerationMode): Promise<void> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async getState(): Promise<MeetingState> {
    return {
      status: "error",
      title: "Weekly Bible Study",
      moderationMode: "moderated",
      participants: [],
      waitingRoom: [],
      raisedHands: [],
      lastEvent: "Zoom runner missing"
    };
  }
}
