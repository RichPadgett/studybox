import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { PodcastService, PodcastState, Recording, RecordingAssetKind, RecordingDownload } from "@studybox/shared";

export class MockPodcastService implements PodcastService {
  private state: PodcastState = {
    status: "idle",
    audioReady: true,
    audioLastEvent: "Mock microphone ready",
    elapsedSeconds: 0,
    recordings: [],
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
      downloadMimeType: "audio/wav",
      expiresAt: retentionDate(this.state.activeRecording.startedAt, 35),
      assets: createRecordingAssets({
        startedAt: this.state.activeRecording.startedAt,
        fileName: formatRecordingFileName(this.state.activeRecording.startedAt),
        mimeType: "audio/wav",
        sizeBytes: Math.max(1, durationSeconds) * 21_000,
        retentionDays: 35
      })
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
    return this.getRecordingAssetDownload(recordingId, "audio");
  }

  async getRecordingAssetDownload(recordingId: string, assetKind: RecordingAssetKind): Promise<RecordingDownload | undefined> {
    const recording = this.state.recordings.find((candidate) => candidate.id === recordingId);
    if (!recording) {
      return undefined;
    }
    if (assetKind !== "audio") {
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

export interface LocalPodcastServiceOptions {
  recordingsDir: string;
  manifestPath: string;
  arecordPath?: string;
  captureWrapperPath?: string;
  retentionDays?: number;
  device?: string;
  captureSourcePattern?: string;
  format?: string;
  sampleRate?: number;
  channels?: number;
  captureDeviceResolver?: () => string;
  onAudioReadinessChange?: () => void;
}

interface RecordingManifestEntry extends Recording {
  filePath: string;
}

export class LocalPodcastService implements PodcastService {
  private state: PodcastState = {
    status: "idle",
    elapsedSeconds: 0,
    recordings: [],
    lastEvent: "Local podcast recorder ready"
  };
  private process?: ChildProcess;
  private activeFilePath?: string;
  private activeRecording?: RecordingManifestEntry;
  private recordings: RecordingManifestEntry[] = [];
  private startedAtMs?: number;
  private elapsedBeforePause = 0;
  private audioWaitTimer?: NodeJS.Timeout;
  private audioHealthTimer?: NodeJS.Timeout;
  private captureDevice?: string;
  private audioFailureCount = 0;

  constructor(private readonly options: LocalPodcastServiceOptions) {}

  async load(): Promise<void> {
    await mkdir(this.options.recordingsDir, { recursive: true });
    await mkdir(dirname(this.options.manifestPath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.options.manifestPath, "utf8")) as { recordings?: RecordingManifestEntry[] };
      this.recordings = Array.isArray(parsed.recordings) ? parsed.recordings : [];
      this.state = {
        ...this.state,
        recordings: this.recordings,
        lastEvent: "Local podcast recorder loaded"
      };
    } catch {
      await this.saveManifest();
    }
    this.captureDevice = this.options.captureDeviceResolver?.() ?? this.options.device ?? "default";
    await this.refreshAudioReadiness();
    this.audioHealthTimer = setInterval(() => {
      void this.refreshAudioReadiness();
    }, 3000);
    this.audioHealthTimer.unref();
  }

  getState(): PodcastState {
    return {
      ...this.state,
      activeRecording: this.activeRecording,
      recordings: this.recordings,
      elapsedSeconds: this.currentElapsedSeconds()
    };
  }

  async startRecording(): Promise<PodcastState> {
    if (this.process || this.activeRecording) {
      return this.getState();
    }

    await mkdir(this.options.recordingsDir, { recursive: true });
    const startedAt = new Date().toISOString();
    const fileName = formatRecordingFileName(startedAt);
    const filePath = join(this.options.recordingsDir, fileName);
    const recording: RecordingManifestEntry = {
      id: `rec-${Date.now()}`,
      title: formatRecordingTitle(startedAt),
      startedAt,
      durationSeconds: 0,
      sizeBytes: 0,
      downloadFileName: fileName,
      downloadMimeType: "audio/wav",
      filePath,
      expiresAt: retentionDate(startedAt, this.options.retentionDays ?? 35),
      assets: createRecordingAssets({
        startedAt,
        fileName,
        mimeType: "audio/wav",
        filePath,
        sizeBytes: 0,
        retentionDays: this.options.retentionDays ?? 35
      })
    };

    this.activeRecording = recording;
    this.elapsedBeforePause = 0;
    this.activeFilePath = filePath;
    this.captureDevice = this.options.captureDeviceResolver?.() ?? this.options.device ?? "default";
    await this.refreshAudioReadiness();
    if (this.state.audioReady !== true) {
      this.state = {
        ...this.state,
        status: "waitingForAudio",
        activeRecording: recording,
        elapsedSeconds: 0,
        lastEvent: "Waiting for DJI audio"
      };
      this.startAudioWaitLoop();
      return this.getState();
    }

    await this.startCaptureProcess(fileName);
    return this.getState();
  }

  async pauseRecording(): Promise<PodcastState> {
    if (this.state.status !== "recording" || !this.process) {
      return this.getState();
    }

    this.elapsedBeforePause = this.currentElapsedSeconds();
    this.startedAtMs = undefined;
    this.process.kill("SIGSTOP");
    this.state = {
      ...this.state,
      status: "paused",
      elapsedSeconds: this.elapsedBeforePause,
      lastEvent: "Recording paused"
    };
    return this.getState();
  }

  async resumeRecording(): Promise<PodcastState> {
    if (this.state.status !== "paused" || !this.process) {
      return this.getState();
    }

    this.startedAtMs = Date.now();
    this.process.kill("SIGCONT");
    this.state = {
      ...this.state,
      status: "recording",
      lastEvent: "Recording resumed"
    };
    return this.getState();
  }

  async stopRecording(): Promise<PodcastState> {
    if (!this.activeRecording) {
      return this.getState();
    }

    const activeRecording = this.activeRecording;
    const activeFilePath = this.activeFilePath;
    const process = this.process;
    this.stopAudioWaitLoop();
    if (this.state.status === "waitingForAudio" && !process) {
      if (activeFilePath) {
        await unlink(activeFilePath).catch(() => undefined);
      }
      this.activeRecording = undefined;
      this.activeFilePath = undefined;
      this.startedAtMs = undefined;
      this.elapsedBeforePause = 0;
      this.state = {
        ...this.state,
        status: "idle",
        activeRecording: undefined,
        elapsedSeconds: 0,
        lastEvent: "Recording cancelled: DJI audio unavailable"
      };
      return this.getState();
    }
    if (process) {
      if (this.state.status === "paused") {
        process.kill("SIGCONT");
      }
      this.state = {
        ...this.state,
        status: "stopping",
        lastEvent: "Recording stopping"
      };
      await stopProcess(process);
    }

    const durationSeconds = this.currentElapsedSeconds();
    const sizeBytes = activeFilePath ? await fileSize(activeFilePath) : 0;
    const completed: RecordingManifestEntry = {
      ...activeRecording,
      endedAt: new Date().toISOString(),
      durationSeconds,
      sizeBytes,
      assets: createRecordingAssets({
        startedAt: activeRecording.startedAt,
        fileName: activeRecording.downloadFileName ?? formatRecordingFileName(activeRecording.startedAt),
        mimeType: activeRecording.downloadMimeType ?? "audio/wav",
        filePath: activeRecording.filePath,
        sizeBytes,
        retentionDays: this.options.retentionDays ?? 35,
        zoomAsset: activeRecording.assets?.find((asset) => asset.kind === "zoom")
      })
    };

    this.recordings = [completed, ...this.recordings];
    this.activeRecording = undefined;
    this.activeFilePath = undefined;
    this.process = undefined;
    this.startedAtMs = undefined;
    this.elapsedBeforePause = 0;
    await this.saveManifest();
    this.state = {
      ...this.state,
      status: "idle",
      activeRecording: undefined,
      elapsedSeconds: 0,
      recordings: this.recordings,
      lastEvent: `Recording stopped: ${completed.downloadFileName ?? completed.id}`
    };
    return this.getState();
  }

  private startAudioWaitLoop(): void {
    this.stopAudioWaitLoop();
    this.audioWaitTimer = setInterval(() => {
      void this.tryStartWaitingCapture();
    }, 2000);
    this.audioWaitTimer.unref();
  }

  private stopAudioWaitLoop(): void {
    if (this.audioWaitTimer) {
      clearInterval(this.audioWaitTimer);
      this.audioWaitTimer = undefined;
    }
  }

  private async tryStartWaitingCapture(): Promise<void> {
    if (this.state.status !== "waitingForAudio" || !this.activeRecording) {
      this.stopAudioWaitLoop();
      return;
    }
    if (!(await this.isCaptureDeviceAvailable())) {
      return;
    }
    this.stopAudioWaitLoop();
    await this.startCaptureProcess(this.activeRecording.downloadFileName ?? formatRecordingFileName(this.activeRecording.startedAt));
  }

  private async isCaptureDeviceAvailable(): Promise<boolean> {
    const captureDevice = this.captureDevice ?? this.options.device ?? "default";
    if (captureDevice === "pulse") {
      return this.isPulseCaptureDeviceAvailable();
    }

    const recorderCommand = this.options.arecordPath ?? "arecord";
    const args = [
      "-D", captureDevice,
      "--dump-hw-params",
      "-f", this.options.format ?? "S16_LE",
      "-r", String(this.options.sampleRate ?? 48000),
      "-c", String(this.options.channels ?? 2),
      "/dev/null"
    ];
    return await new Promise<boolean>((resolve) => {
      const probe = this.options.captureWrapperPath
        ? spawn(this.options.captureWrapperPath, ["--", recorderCommand, ...args], { detached: true, stdio: "ignore" })
        : spawn(recorderCommand, args, { detached: true, stdio: "ignore" });
      const timeout = setTimeout(() => {
        if (probe.pid) {
          try {
            process.kill(-probe.pid, "SIGKILL");
          } catch {
            probe.kill("SIGKILL");
          }
        }
        resolve(false);
      }, 5000);
      probe.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      probe.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code === 0);
      });
    });
  }

  private async isPulseCaptureDeviceAvailable(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const probe = spawn("pactl", ["list", "short", "sources"], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      const timeout = setTimeout(() => {
        probe.kill("SIGKILL");
        resolve(false);
      }, 5000);
      probe.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      probe.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      probe.once("close", (code) => {
        clearTimeout(timeout);
        const sourcePattern = this.options.captureSourcePattern ?? "DJI";
        resolve(code === 0 && output.split("\n").some((line) => line.includes("alsa_input.") && line.toLowerCase().includes(sourcePattern.toLowerCase())));
      });
    });
  }

  private async refreshAudioReadiness(): Promise<void> {
    const previousReady = this.state.audioReady;
    const detected = await this.isCaptureDeviceAvailable();
    this.audioFailureCount = detected ? 0 : this.audioFailureCount + 1;
    const ready = detected || (this.state.audioReady === true && this.audioFailureCount < 3);
    const audioLastEvent = ready ? "DJI microphone receiver ready" : "DJI microphone receiver not detected";
    this.state = {
      ...this.state,
      audioReady: ready,
      audioLastCheckedAt: new Date().toISOString(),
      audioLastEvent,
      ...(this.state.status === "idle" ? { lastEvent: audioLastEvent } : {})
    };
    if (previousReady !== ready) {
      this.options.onAudioReadinessChange?.();
    }
  }

  private async startCaptureProcess(fileName: string): Promise<void> {
    if (!this.activeRecording || this.process) {
      return;
    }
    const filePath = this.activeFilePath;
    if (!filePath) {
      return;
    }
    const args = [
      "-D", this.captureDevice ?? this.options.device ?? "default",
      "-f", this.options.format ?? "S16_LE",
      "-r", String(this.options.sampleRate ?? 48000),
      "-c", String(this.options.channels ?? 2),
      filePath
    ];
    const recorderCommand = this.options.arecordPath ?? "arecord";
    const recorderProcess = this.options.captureWrapperPath
      ? spawn(this.options.captureWrapperPath, ["--", recorderCommand, ...args], { stdio: ["ignore", "pipe", "pipe"] })
      : spawn(recorderCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = recorderProcess;
    this.startedAtMs = Date.now();
    this.state = {
      ...this.state,
      status: "recording",
      activeRecording: this.activeRecording,
      elapsedSeconds: this.elapsedBeforePause,
      lastEvent: `Recording started: ${fileName}`
    };

    const earlyExit = new Promise<boolean>((resolve) => {
      recorderProcess.once("exit", () => resolve(true));
    });

    recorderProcess.once("exit", async (code, signal) => {
      if (this.state.status === "recording" || this.state.status === "paused") {
        const elapsedSeconds = this.currentElapsedSeconds();
        const partialSizeBytes = this.activeFilePath ? await fileSize(this.activeFilePath) : 0;
        this.startedAtMs = undefined;
        this.elapsedBeforePause = elapsedSeconds;
        const preservedPartial = partialSizeBytes > 44;
        this.state = {
          ...this.state,
          status: preservedPartial ? "error" : "waitingForAudio",
          activeRecording: this.activeRecording,
          elapsedSeconds,
          lastEvent: preservedPartial
            ? `Recording stopped unexpectedly; partial audio preserved (${partialSizeBytes} bytes)`
            : `Waiting for DJI audio after recorder exit (${signal ?? code ?? "unknown"})`
        };
        if (!preservedPartial) {
          this.startAudioWaitLoop();
        }
      }
      this.process = undefined;
    });

    recorderProcess.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.state = { ...this.state, lastEvent: message.slice(0, 160) };
      }
    });

    await Promise.race([earlyExit, sleep(250).then(() => false)]);
  }

  async listRecordings(): Promise<Recording[]> {
    return this.recordings;
  }

  async getRecordingDownload(recordingId: string): Promise<RecordingDownload | undefined> {
    return this.getRecordingAssetDownload(recordingId, "audio");
  }

  async getRecordingAssetDownload(recordingId: string, assetKind: RecordingAssetKind): Promise<RecordingDownload | undefined> {
    const recording = this.recordings.find((candidate) => candidate.id === recordingId);
    if (!recording) {
      return undefined;
    }
    const asset = getRecordingAsset(recording, assetKind);
    if (!asset?.filePath || asset.status !== "available") {
      return undefined;
    }

    return {
      recording,
      fileName: asset.fileName ?? recording.downloadFileName ?? formatRecordingFileName(recording.startedAt),
      mimeType: asset.mimeType ?? recording.downloadMimeType ?? "audio/wav",
      contentBase64: (await readFile(asset.filePath)).toString("base64")
    };
  }

  private currentElapsedSeconds(): number {
    if (!this.startedAtMs) {
      return this.elapsedBeforePause;
    }

    return this.elapsedBeforePause + Math.floor((Date.now() - this.startedAtMs) / 1000);
  }

  private async saveManifest(): Promise<void> {
    await mkdir(dirname(this.options.manifestPath), { recursive: true });
    await writeFile(this.options.manifestPath, JSON.stringify({ recordings: this.recordings }, null, 2));
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

function retentionDate(startedAt: string, retentionDays: number): string {
  return new Date(new Date(startedAt).getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

function createRecordingAssets(input: {
  startedAt: string;
  fileName: string;
  mimeType: string;
  filePath?: string;
  sizeBytes: number;
  retentionDays: number;
  zoomAsset?: NonNullable<Recording["assets"]>[number];
}): NonNullable<Recording["assets"]> {
  const availableUntil = retentionDate(input.startedAt, input.retentionDays);
  return [
    {
      kind: "audio",
      label: "Room audio",
      status: "available",
      fileName: input.fileName,
      mimeType: input.mimeType,
      filePath: input.filePath,
      sizeBytes: input.sizeBytes,
      availableUntil
    },
    input.zoomAsset ?? {
      kind: "zoom",
      label: "Zoom recording",
      status: "pending",
      availableUntil
    }
  ];
}

function getRecordingAsset(recording: RecordingManifestEntry, assetKind: RecordingAssetKind): NonNullable<Recording["assets"]>[number] | undefined {
  const asset = recording.assets?.find((candidate) => candidate.kind === assetKind);
  if (asset) {
    return asset;
  }
  if (assetKind === "audio" && recording.filePath) {
    return {
      kind: "audio",
      label: "Room audio",
      status: "available",
      fileName: recording.downloadFileName ?? formatRecordingFileName(recording.startedAt),
      mimeType: recording.downloadMimeType ?? "audio/wav",
      filePath: recording.filePath,
      sizeBytes: recording.sizeBytes,
      availableUntil: recording.expiresAt
    };
  }
  return undefined;
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

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
      resolve();
    }, 5000);
    process.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    process.kill("SIGINT");
  });
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}
