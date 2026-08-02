import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { MeetingModerationMode, MeetingState, ZoomRunnerCommand, ZoomRunnerResponse } from "@studybox/shared";
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
    waitingRoom: [],
    raisedHands: [],
    lastEvent: "Zoom runner process client initialized"
  };
  private readonly pending = new Map<string, PendingCommand>();

  constructor(private readonly command: string, private readonly args: string[] = []) {}

  async startMeeting(): Promise<void> {
    await this.send({ id: createId(), type: "startMeeting" });
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

  async setModerationMode(mode: MeetingModerationMode): Promise<void> {
    await this.send({ id: createId(), type: "setModerationMode", mode });
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
      }, 5000);

      this.pending.set(command.id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child;
    }

    this.child = spawn(this.command, this.args, {
      cwd: projectPath(),
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
      this.state = message.state;
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
      this.state = message.state;
    }

    if (message.ok) {
      pending.resolve(this.state);
    } else {
      pending.reject(new Error(message.error));
    }
  }
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRunnerMessage(value: unknown): value is ({ kind: "response" } & ZoomRunnerResponse) | { kind: "event"; state?: MeetingState } {
  return typeof value === "object" && value !== null && "kind" in value;
}
