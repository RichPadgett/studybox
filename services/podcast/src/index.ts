import type { PodcastService, PodcastState, Recording } from "@studybox/shared";

export class MockPodcastService implements PodcastService {
  private state: PodcastState = {
    status: "idle",
    elapsedSeconds: 0,
    recordings: [
      {
        id: "rec-001",
        title: "Bible Study - Previous Week",
        startedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        endedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 4_200_000).toISOString(),
        durationSeconds: 4200,
        sizeBytes: 86_500_000
      }
    ],
    lastEvent: "Podcast service ready"
  };

  private startedAtMs?: number;
  private elapsedBeforePause = 0;

  getState(): PodcastState {
    return {
      ...this.state,
      elapsedSeconds: this.currentElapsedSeconds()
    };
  }

  async startRecording(): Promise<PodcastState> {
    const recording: Recording = {
      id: `rec-${Date.now()}`,
      title: "Bible Study Recording",
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
      sizeBytes: 0
    };

    this.startedAtMs = Date.now();
    this.elapsedBeforePause = 0;
    this.state = {
      ...this.state,
      status: "recording",
      activeRecording: recording,
      elapsedSeconds: 0,
      lastEvent: "Recording started"
    };
    return this.getState();
  }

  async pauseRecording(): Promise<PodcastState> {
    if (this.state.status !== "recording") {
      return this.getState();
    }

    this.elapsedBeforePause = this.currentElapsedSeconds();
    this.startedAtMs = undefined;
    this.state = {
      ...this.state,
      status: "paused",
      elapsedSeconds: this.elapsedBeforePause,
      lastEvent: "Recording paused"
    };
    return this.getState();
  }

  async resumeRecording(): Promise<PodcastState> {
    if (this.state.status !== "paused") {
      return this.getState();
    }

    this.startedAtMs = Date.now();
    this.state = {
      ...this.state,
      status: "recording",
      lastEvent: "Recording resumed"
    };
    return this.getState();
  }

  async stopRecording(): Promise<PodcastState> {
    if (!this.state.activeRecording) {
      return this.getState();
    }

    const durationSeconds = this.currentElapsedSeconds();
    const completed: Recording = {
      ...this.state.activeRecording,
      endedAt: new Date().toISOString(),
      durationSeconds,
      sizeBytes: Math.max(1, durationSeconds) * 21_000
    };

    this.startedAtMs = undefined;
    this.elapsedBeforePause = 0;
    this.state = {
      ...this.state,
      status: "idle",
      activeRecording: undefined,
      elapsedSeconds: 0,
      recordings: [completed, ...this.state.recordings],
      lastEvent: "Recording stopped"
    };
    return this.getState();
  }

  async listRecordings(): Promise<Recording[]> {
    return this.state.recordings;
  }

  private currentElapsedSeconds(): number {
    if (!this.startedAtMs) {
      return this.elapsedBeforePause;
    }

    return this.elapsedBeforePause + Math.floor((Date.now() - this.startedAtMs) / 1000);
  }
}
