import type { PodcastService, PodcastState, Recording, RecordingDownload } from "@studybox/shared";

const previousRecordingStartedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

export class MockPodcastService implements PodcastService {
  private state: PodcastState = {
    status: "idle",
    elapsedSeconds: 0,
    recordings: [
      {
        id: "rec-001",
        title: formatRecordingTitle(previousRecordingStartedAt),
        startedAt: previousRecordingStartedAt,
        endedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 4_200_000).toISOString(),
        durationSeconds: 4200,
        sizeBytes: 86_500_000,
        downloadFileName: formatRecordingFileName(previousRecordingStartedAt),
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

    const startedAt = new Date().toISOString();
    const recording: Recording = {
      id: `rec-${Date.now()}`,
      title: formatRecordingTitle(startedAt),
      startedAt,
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
      downloadFileName: formatRecordingFileName(this.state.activeRecording.startedAt),
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
      fileName: recording.downloadFileName ?? formatRecordingFileName(recording.startedAt),
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

function formatRecordingTitle(startedAt: string): string {
  const date = new Date(startedAt);
  const datePart = date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
  const timePart = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });
  return `Bible Study ${datePart} ${timePart}`;
}

function formatRecordingFileName(startedAt: string): string {
  const date = new Date(startedAt);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `bible-study-${year}-${month}-${day}-${hour}-${minute}.wav`;
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
