import assert from "node:assert/strict";
import test from "node:test";
import type { MeetingModerationMode, MeetingState, ZoomRunnerStartMeetingPayload } from "@studybox/shared";
import { ZoomMeetingService, type ZoomMeetingRunnerClient } from "./index.js";

class TestRunner implements ZoomMeetingRunnerClient {
  failState = false;
  failStart = false;
  state: MeetingState = baseState("idle");

  async startMeeting(_payload?: ZoomRunnerStartMeetingPayload): Promise<void> {
    if (this.failStart) throw new Error("temporary start failure");
    this.state = baseState("live");
  }
  async reset(): Promise<void> {}
  async endMeeting(): Promise<void> { this.state = baseState("idle"); }
  async admitParticipant(_participantId: string): Promise<void> {}
  async dismissRaisedHand(_participantId: string): Promise<void> {}
  async allowParticipantToSpeak(_participantId: string): Promise<void> {}
  async muteParticipant(_participantId: string): Promise<void> {}
  async makeParticipantHost(_participantId: string): Promise<void> {}
  async allowScreenShare(): Promise<void> {}
  async setParticipantPodcastInclusion(_participantId: string, _included: boolean): Promise<void> {}
  async setModerationMode(_mode: MeetingModerationMode): Promise<void> {}
  async startZoomRecording(_recordingDirectory: string): Promise<string | undefined> { return undefined; }
  async stopZoomRecording(): Promise<string | undefined> { return undefined; }
  async syncState(): Promise<MeetingState> { return this.getState(); }
  async getState(): Promise<MeetingState> {
    if (this.failState) throw new Error("runner timeout");
    return this.state;
  }
}

test("idle runner checks become terminal only after the configured failure limit", async () => {
  const runner = new TestRunner();
  const service = new ZoomMeetingService(runner, undefined, { idleSyncFailureLimit: 3 });
  runner.failState = true;

  assert.equal((await service.syncState()).status, "idle");
  assert.equal((await service.syncState()).status, "idle");
  const terminal = await service.syncState();
  assert.equal(terminal.status, "error");
  assert.equal(terminal.reconnecting, false);
});

test("active runner timeouts remain graceful reconnecting states", async () => {
  const runner = new TestRunner();
  runner.state = baseState("live");
  const service = new ZoomMeetingService(runner, undefined, { idleSyncFailureLimit: 2 });
  assert.equal((await service.syncState()).status, "live");
  runner.failState = true;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await service.syncState();
    assert.equal(state.status, "starting");
    assert.equal(state.reconnecting, true);
  }
});

test("a failed start stays transient until the appliance marks it terminal", async () => {
  const runner = new TestRunner();
  runner.failStart = true;
  const service = new ZoomMeetingService(runner);

  await assert.rejects(service.startMeeting(), /temporary start failure/);
  assert.equal(service.getState().status, "starting");
  assert.equal(service.getState().reconnecting, true);

  service.markTerminalError("Zoom start exhausted retries");
  assert.equal(service.getState().status, "error");
  assert.equal(service.getState().reconnecting, false);
});

function baseState(status: MeetingState["status"]): MeetingState {
  return {
    status,
    title: "Weekly & Appointed Assembly's",
    moderationMode: "moderated",
    participants: [],
    lobbyRequests: [],
    waitingRoom: [],
    raisedHands: [],
    lastEvent: `State ${status}`
  };
}
