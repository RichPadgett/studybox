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
  private resetInFlight?: Promise<void>;
  private readonly expectedExits = new WeakSet<ChildProcessWithoutNullStreams>();
  private state: MeetingState = {
    status: "idle",
    title: "Weekly & Appointed Assembly's",
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

  async reset(): Promise<void> {
    if (this.resetInFlight) return this.resetInFlight;
    this.resetInFlight = this.resetOnce().finally(() => {
      this.resetInFlight = undefined;
    });
    return this.resetInFlight;
  }

  private async resetOnce(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = undefined;
      return;
    }

    this.expectedExits.add(child);
    this.state = {
      ...this.state,
      status: "starting",
      reconnecting: true,
      lastEvent: "Restarting Zoom runner"
    };

    await new Promise<void>((resolve, reject) => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        clearTimeout(forceTimer);
        clearTimeout(giveUpTimer);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3_000);
      const giveUpTimer = setTimeout(() => {
        if (completed) return;
        completed = true;
        clearTimeout(forceTimer);
        reject(new Error("Zoom runner did not stop during reconnect reset"));
      }, 5_000);
      forceTimer.unref();
      giveUpTimer.unref();
      child.once("exit", finish);
      if (!child.kill("SIGTERM")) finish();
    });

    if (this.child === child) this.child = undefined;
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

  async makeParticipantHost(participantId: string): Promise<void> {
    await this.send({ id: createId(), type: "makeHost", participantId });
  }

  async allowScreenShare(): Promise<void> {
    await this.send({ id: createId(), type: "allowScreenShare" });
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

  private async send(command: ZoomRunnerCommand): Promise<MeetingState> {
    if (this.resetInFlight) await this.resetInFlight;
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

    const child = spawn(isAbsolute(this.command) ? this.command : projectPath(this.command), this.args, {
      cwd: process.env.ZOOM_RUNNER_CWD?.trim() || projectPath(),
      env: process.env
    });
    this.child = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      console.error(`[zoom-runner] ${message}`);
      this.state = {
        ...this.state,
        lastEvent: `Runner stderr: ${message}`
      };
    });

    child.once("error", (error) => {
      console.error(`[zoom-runner] process error: ${error.message}`);
      this.state = {
        ...this.state,
        status: "error",
        lastEvent: `Zoom runner error: ${error.message}`
      };
    });

    child.on("exit", (code, signal) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Zoom runner exited with code ${code ?? "unknown"}`));
      }
      this.pending.clear();
      if (this.child === child) this.child = undefined;
      const expected = this.expectedExits.has(child);
      console.error(`[zoom-runner] exited code=${code ?? "unknown"} signal=${signal ?? "none"} expected=${expected}`);
      this.state = {
        ...this.state,
        status: expected ? "starting" : "error",
        reconnecting: expected,
        lastEvent: expected
          ? "Zoom runner stopped for reconnect"
          : `Zoom runner exited with code ${code ?? "unknown"}`
      };
    });

    return child;
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
      // Keep the user-facing meeting name owned by StudyBox even when the
      // native runner reports its own default title.
      title: "Weekly & Appointed Assembly's",
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
