import type { MeetingService, MeetingState, Participant } from "@studybox/shared";

const initialParticipants: Participant[] = [
  { id: "p1", displayName: "Mary Johnson", status: "joined", joinedAt: new Date().toISOString() },
  { id: "p2", displayName: "David Lee", status: "joined", joinedAt: new Date().toISOString() },
  { id: "p3", displayName: "Anna Smith", status: "raised-hand", joinedAt: new Date().toISOString() }
];

const initialWaitingRoom: Participant[] = [
  { id: "w1", displayName: "Robert Garcia", status: "waiting" }
];

export class MockMeetingService implements MeetingService {
  private state: MeetingState = {
    status: "idle",
    title: "Weekly Bible Study",
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
}
