import type { PodcastService, PodcastState, Recording, RecordingDownload } from "@studybox/shared";

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
        sizeBytes: 86_500_000,
        downloadFileName: "bible-study-previous-week.wav",
        downloadMimeType: "audio/wav"
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
    if (this.state.activeRecording) {
      return this.getState();
    }

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
      sizeBytes: Math.max(1, durationSeconds) * 21_000,
      downloadFileName: `${slugify(this.state.activeRecording.title)}-${new Date().toISOString().slice(0, 10)}.wav`,
      downloadMimeType: "audio/wav"
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

  async getRecordingDownload(recordingId: string): Promise<RecordingDownload | undefined> {
    const recording = this.state.recordings.find((candidate) => candidate.id === recordingId);
    if (!recording) {
      return undefined;
    }

    return {
      recording,
      fileName: recording.downloadFileName ?? `${slugify(recording.title)}.wav`,
      mimeType: recording.downloadMimeType ?? "audio/wav",
      contentBase64: createSilentWavBase64()
    };
  }

  private currentElapsedSeconds(): number {
    if (!this.startedAtMs) {
      return this.elapsedBeforePause;
    }

    return this.elapsedBeforePause + Math.floor((Date.now() - this.startedAtMs) / 1000);
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "recording";
}

function createSilentWavBase64(): string {
  const sampleRate = 8000;
  const durationSeconds = 1;
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = sampleRate * durationSeconds * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer.toString("base64");
}
