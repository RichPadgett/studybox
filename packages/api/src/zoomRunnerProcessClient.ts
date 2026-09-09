import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import type { MeetingModerationMode, MeetingState, ZoomRunnerCommand, ZoomRunnerResponse, ZoomRunnerStartMeetingPayload } from "@studybox/shared";
import type { ZoomMeetingRunnerClient } from "@studybox/meeting";
import { projectPath } from "./paths.js";

interface PendingCommand {
  resolve: (state: MeetingState) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class ZoomRunnerProcessClient implements ZoomMeetingRunnerClient {
  private child?: ChildProcessWithoutNullStreams;
  private state: MeetingState = {
    status: "idle",
    title: "Weekly Bible Study",
    moderationMode: "moderated",
    participants: [],
    lobbyRequests: [],
    waitingRoom: [],
    raisedHands: [],
    lastEvent: "Zoom runner process client initialized"
  };
  private readonly pending = new Map<string, PendingCommand>();

  constructor(private readonly command: string, private readonly args: string[] = []) {}

  async startMeeting(payload?: ZoomRunnerStartMeetingPayload): Promise<void> {
    await this.send({ id: createId(), type: "startMeeting", ...payload });
  }

  async endMeeting(): Promise<void> {
    await this.send({ id: createId(), type: "endMeeting" });
  }

  async admitParticipant(participantId: string): Promise<void> {
    await this.send({ id: createId(), type: "admitParticipant", participantId });
  }

  async dismissRaisedHand(participantId: string): Promise<void> {
    await this.send({ id: createId(), type: "dismissRaisedHand", participantId });
  }

  async allowParticipantToSpeak(participantId: string): Promise<void> {
    await this.send({ id: createId(), type: "allowParticipantToSpeak", participantId });
  }

  async muteParticipant(participantId: string): Promise<void> {
    await this.send({ id: createId(), type: "muteParticipant", participantId });
  }

  async setParticipantPodcastInclusion(participantId: string, included: boolean): Promise<void> {
    await this.send({ id: createId(), type: "setParticipantPodcastInclusion", participantId, included });
  }

  async setModerationMode(mode: MeetingModerationMode): Promise<void> {
    await this.send({ id: createId(), type: "setModerationMode", mode });
  }

  async startZoomRecording(recordingDirectory: string): Promise<string | undefined> {
    const state = await this.send({ id: createId(), type: "startZoomRecording", recordingDirectory });
    return state.lastEvent?.startsWith("Zoom local recording started") ? recordingDirectory : undefined;
  }

  async stopZoomRecording(): Promise<string | undefined> {
    const state = await this.send({ id: createId(), type: "stopZoomRecording" });
    return state.lastEvent?.startsWith("Zoom local recording stopped") ? state.lastEvent.slice("Zoom local recording stopped: ".length) : undefined;
  }

  async syncState(): Promise<MeetingState> {
    return this.getState();
  }

  async getState(): Promise<MeetingState> {
    return this.send({ id: createId(), type: "getState" });
  }

  private send(command: ZoomRunnerCommand): Promise<MeetingState> {
    const child = this.ensureStarted();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error(`Zoom runner command timed out: ${command.type}`));
      }, command.type === "startMeeting" ? 30_000 : 5_000);

      this.pending.set(command.id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child;
    }

    this.child = spawn(isAbsolute(this.command) ? this.command : projectPath(this.command), this.args, {
      cwd: process.env.ZOOM_RUNNER_CWD?.trim() || projectPath(),
      env: process.env
    });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.state = {
        ...this.state,
        lastEvent: `Runner stderr: ${chunk.toString("utf8").trim()}`
      };
    });

    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Zoom runner exited with code ${code ?? "unknown"}`));
      }
      this.pending.clear();
      this.child = undefined;
      this.state = {
        ...this.state,
        status: "error",
        lastEvent: `Zoom runner exited with code ${code ?? "unknown"}`
      };
    });

    return this.child;
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.state = {
        ...this.state,
        lastEvent: "Runner emitted invalid JSON"
      };
      return;
    }

    if (!isRunnerMessage(message)) {
      return;
    }

    if (message.kind === "event" && "state" in message && message.state) {
      this.state = this.mergeRunnerState(message.state);
      return;
    }

    if (message.kind !== "response") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.state) {
      this.state = this.mergeRunnerState(message.state);
    }

    if (message.ok) {
      pending.resolve(this.state);
    } else {
      pending.reject(new Error(message.error));
    }
  }

  private mergeRunnerState(runnerState: MeetingState): MeetingState {
    return {
      ...runnerState,
      lobbyRequests: this.state.lobbyRequests
    };
  }
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRunnerMessage(value: unknown): value is ({ kind: "response" } & ZoomRunnerResponse) | { kind: "event"; state?: MeetingState } {
  return typeof value === "object" && value !== null && "kind" in value;
}
