import type { MeetingModerationMode, MeetingService, MeetingState, Participant, ZoomRunnerStartMeetingPayload } from "@studybox/shared";

export class MockMeetingService implements MeetingService {
  private state: MeetingState = {
    status: "idle",
    title: "Weekly Bible Study",
    moderationMode: "moderated",
    participants: [],
    lobbyRequests: [],
    waitingRoom: [],
    raisedHands: [],
    lastEvent: "Meeting service ready"
  };

  getState(): MeetingState {
    return this.state;
  }

  async syncState(): Promise<MeetingState> {
    return this.state;
  }

  async requestParticipantJoin(displayName: string): Promise<Participant> {
    const normalizedName = displayName.trim().slice(0, 80);
    if (!normalizedName) {
      throw new Error("Display name is required");
    }

    const participant: Participant = {
      id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      displayName: normalizedName,
      status: "waiting"
    };

    this.state = {
      ...this.state,
      lobbyRequests: [...this.state.lobbyRequests, participant],
      lastEvent: `${participant.displayName} entered the StudyBox lobby`
    };

    return participant;
  }

  async startMeeting(): Promise<MeetingState> {
    this.state = {
      ...this.state,
      status: "live",
      meetingId: "studybox-local-session",
      startedAt: new Date().toISOString(),
      lastEvent: "Meeting marked live; Zoom moderation sync is not connected yet"
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
      lobbyRequests: [],
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
      throw new Error("Participant is not in the Zoom waiting room yet. Ask them to open the Zoom join link first.");
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
      audioState: "allowed-to-speak",
      includedInPodcast: false
    };

    this.state = {
      ...this.state,
      participants: this.state.participants.map((item) => item.id === participantId ? speaker : {
        ...item,
        audioState: item.audioState === "allowed-to-speak" || item.audioState === "speaking" ? "muted" : item.audioState,
        includedInPodcast: false
      }),
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
      participants: this.state.participants.map((item) => item.id === participantId ? { ...item, audioState: "muted", includedInPodcast: false } : item),
      activeSpeaker: this.state.activeSpeaker?.id === participantId ? undefined : this.state.activeSpeaker,
      lastEvent: participant ? `${participant.displayName} muted` : "Participant muted"
    };
    return this.state;
  }

  async makeParticipantHost(participantId: string): Promise<MeetingState> {
    const participant = this.state.participants.find((item) => item.id === participantId);
    this.state = { ...this.state, lastEvent: participant ? `${participant.displayName} is now host` : "Participant is now host" };
    return this.state;
  }

  async setParticipantPodcastInclusion(participantId: string, included: boolean): Promise<MeetingState> {
    const participant = this.state.participants.find((item) => item.id === participantId);
    if (!participant) {
      return this.state;
    }

    this.state = {
      ...this.state,
      participants: this.state.participants.map((item) => item.id === participantId ? { ...item, includedInPodcast: included } : item),
      activeSpeaker: this.state.activeSpeaker?.id === participantId ? { ...this.state.activeSpeaker, includedInPodcast: included } : this.state.activeSpeaker,
      lastEvent: included ? `${participant.displayName} included in podcast mix` : `${participant.displayName} excluded from podcast mix`
    };
    return this.state;
  }

  async setModerationMode(mode: MeetingModerationMode): Promise<MeetingState> {
    this.state = {
      ...this.state,
      moderationMode: mode,
      participants: this.state.participants.map((participant) => ({
        ...participant,
        audioState: mode === "open" || participant.trustedSpeaker ? "allowed-to-speak" : "muted",
        includedInPodcast: false
      })),
      activeSpeaker: undefined,
      lastEvent: `Moderation mode set to ${mode}`
    };
    return this.state;
  }

  async startZoomRecording(_recordingDirectory: string): Promise<void> {}

  async stopZoomRecording(): Promise<string | undefined> {
    return undefined;
  }
}

export interface ZoomMeetingRunnerClient {
  startMeeting(payload?: ZoomRunnerStartMeetingPayload): Promise<void>;
  endMeeting(): Promise<void>;
  admitParticipant(participantId: string): Promise<void>;
  dismissRaisedHand(participantId: string): Promise<void>;
  allowParticipantToSpeak(participantId: string): Promise<void>;
  muteParticipant(participantId: string): Promise<void>;
  makeParticipantHost(participantId: string): Promise<void>;
  setParticipantPodcastInclusion(participantId: string, included: boolean): Promise<void>;
  setModerationMode(mode: MeetingModerationMode): Promise<void>;
  startZoomRecording(recordingDirectory: string): Promise<string | undefined>;
  stopZoomRecording(): Promise<string | undefined>;
  syncState(): Promise<MeetingState>;
  getState(): Promise<MeetingState>;
}

export class ZoomMeetingService implements MeetingService {
  private state: MeetingState = {
    status: "idle",
    title: "Weekly Bible Study",
    moderationMode: "moderated",
    participants: [],
    lobbyRequests: [],
    waitingRoom: [],
    raisedHands: [],
    lastEvent: "Zoom runner adapter initialized"
  };

  constructor(
    private readonly runner: ZoomMeetingRunnerClient,
    private readonly getStartPayload?: () => Promise<ZoomRunnerStartMeetingPayload>
  ) {}

  getState(): MeetingState {
    return this.state;
  }

  async syncState(): Promise<MeetingState> {
    return this.refreshState();
  }

  async requestParticipantJoin(displayName: string): Promise<Participant> {
    const normalizedName = displayName.trim().slice(0, 80);
    if (!normalizedName) {
      throw new Error("Display name is required");
    }

    const participant: Participant = {
      id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      displayName: normalizedName,
      status: "waiting"
    };

    this.state = {
      ...this.state,
      lobbyRequests: [...this.state.lobbyRequests, participant],
      lastEvent: `${participant.displayName} entered the StudyBox lobby`
    };

    return participant;
  }

  async startMeeting(): Promise<MeetingState> {
    this.state = {
      ...this.state,
      status: "starting",
      lastEvent: "Starting Zoom meeting through runner"
    };
    await this.runner.startMeeting(this.getStartPayload ? await this.getStartPayload() : undefined);
    return this.refreshState();
  }

  async endMeeting(): Promise<MeetingState> {
    this.state = {
      ...this.state,
      status: "ending",
      lastEvent: "Ending Zoom meeting through runner"
    };
    await this.runner.endMeeting();
    const state = await this.refreshState();
    this.state = {
      ...state,
      lobbyRequests: []
    };
    return this.state;
  }

  async admitParticipant(participantId: string): Promise<MeetingState> {
    const participant = this.state.waitingRoom.find((item) => item.id === participantId);
    if (!participant) {
      throw new Error("Participant is not in the Zoom waiting room yet. Ask them to open the Zoom join link first.");
    }
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

  async makeParticipantHost(participantId: string): Promise<MeetingState> {
    await this.runner.makeParticipantHost(participantId);
    return this.refreshState();
  }

  async setParticipantPodcastInclusion(participantId: string, included: boolean): Promise<MeetingState> {
    await this.runner.setParticipantPodcastInclusion(participantId, included);
    return this.refreshState();
  }

  async setModerationMode(mode: MeetingModerationMode): Promise<MeetingState> {
    await this.runner.setModerationMode(mode);
    return this.refreshState();
  }

  async startZoomRecording(recordingDirectory: string): Promise<void> {
    await this.runner.startZoomRecording(recordingDirectory);
  }

  async stopZoomRecording(): Promise<string | undefined> {
    return this.runner.stopZoomRecording();
  }

  private async refreshState(): Promise<MeetingState> {
    const currentLobbyRequests = this.state.lobbyRequests;
    const runnerState = await this.runner.getState();
    this.state = {
      ...runnerState,
      lobbyRequests: currentLobbyRequests
    };
    return this.state;
  }
}

export class MissingZoomRunnerClient implements ZoomMeetingRunnerClient {
  async startMeeting(_payload?: ZoomRunnerStartMeetingPayload): Promise<void> {
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

  async makeParticipantHost(_participantId: string): Promise<void> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async setParticipantPodcastInclusion(_participantId: string, _included: boolean): Promise<void> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async setModerationMode(_mode: MeetingModerationMode): Promise<void> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async startZoomRecording(_recordingDirectory: string): Promise<string | undefined> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async stopZoomRecording(): Promise<string | undefined> {
    throw new Error("Zoom runner is not available. Build and configure the ARM64 Meeting SDK runner first.");
  }

  async syncState(): Promise<MeetingState> {
    return this.getState();
  }

  async getState(): Promise<MeetingState> {
    return {
      status: "error",
      title: "Weekly Bible Study",
      moderationMode: "moderated",
      participants: [],
      lobbyRequests: [],
      waitingRoom: [],
      raisedHands: [],
      lastEvent: "Zoom runner missing"
    };
  }
}
