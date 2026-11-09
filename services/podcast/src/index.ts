import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { PodcastService, PodcastState, Recording, RecordingAssetKind, RecordingDownload } from "@studybox/shared";
import { S3ZoomArchive } from "./s3Archive.js";
export { S3ZoomArchive } from "./s3Archive.js";

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

  async getRecordingAssetUrl(_recordingId: string, _assetKind: RecordingAssetKind): Promise<string | undefined> {
    return undefined;
  }

  async setZoomRecordingAsset(_recordingId: string | string[], _filePath: string, _archive = true): Promise<PodcastState> {
    return this.getState();
  }

  async setRecordingTitle(recordingId: string, title: string): Promise<PodcastState> {
    const recording = this.state.recordings.find((candidate) => candidate.id === recordingId);
    if (recording) recording.title = title;
    return this.getState();
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
  s3Archive?: S3ZoomArchive;
}

interface RecordingManifestEntry extends Recording {
  filePath: string;
}

interface ActiveRecordingRecovery {
  version: 1;
  phase: "recording" | "paused" | "finalizing";
  recording: RecordingManifestEntry;
  activeFilePath: string;
  segmentDirPath: string;
  segmentPaths: string[];
  segmentStartedAts?: string[];
  segmentPauseDurationsMs?: number[];
  elapsedSeconds: number;
  updatedAt: string;
}

export class LocalPodcastService implements PodcastService {
  private state: PodcastState = {
    status: "idle",
    audioReady: false,
    audioLastEvent: "Checking for DJI microphone receiver",
    elapsedSeconds: 0,
    recordings: [],
    lastEvent: "Local podcast recorder ready"
  };
  private process?: ChildProcess;
  private activeFilePath?: string;
  private activeSegmentPath?: string;
  private segmentDirPath?: string;
  private segmentPaths: string[] = [];
  private segmentStartedAts: string[] = [];
  private segmentPauseDurationsMs: number[] = [];
  private segmentNumber = 0;
  private pausedAtMs?: number;
  private pendingPauseDurationMs = 0;
  private pendingSegmentStartedAt?: string;
  private expectedProcessExits = new Set<ChildProcess>();
  private activeRecording?: RecordingManifestEntry;
  private recordings: RecordingManifestEntry[] = [];
  private startedAtMs?: number;
  private elapsedBeforePause = 0;
  private audioWaitTimer?: NodeJS.Timeout;
  private audioHealthTimer?: NodeJS.Timeout;
  private captureDevice?: string;
  private audioFailureCount = 0;
  private audioReadinessGeneration = 0;
  private audioReadinessRefresh?: Promise<void>;
  private audioProbeLastResult?: string;
  private recoveredFinalization = false;
  private recoveredRecordingIds: string[] = [];

  constructor(private readonly options: LocalPodcastServiceOptions) {}

  async load(): Promise<void> {
    await mkdir(this.options.recordingsDir, { recursive: true });
    await mkdir(dirname(this.options.manifestPath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.options.manifestPath, "utf8")) as { recordings?: RecordingManifestEntry[] };
      this.recordings = Array.isArray(parsed.recordings) ? parsed.recordings.map((recording) => ({
        ...recording,
        expiresAt: undefined,
        assets: recording.assets?.map((asset) => ({ ...asset, availableUntil: undefined }))
      })) : [];
      this.state = {
        ...this.state,
        recordings: this.recordings,
        lastEvent: "Local podcast recorder loaded"
      };
    } catch {
      await this.saveManifest();
    }
    await this.recoverInterruptedFinalization();
    this.captureDevice = this.options.captureDeviceResolver?.() ?? this.options.device ?? "default";
    await this.refreshAudioReadiness();
    this.audioHealthTimer = setInterval(() => {
      void this.refreshAudioReadiness().catch((error: unknown) => {
        console.error("Podcast audio readiness refresh failed", error);
      });
    }, 3000);
    this.audioHealthTimer.unref();
  }

  getState(): PodcastState {
    return {
      ...this.state,
      activeRecording: this.activeRecording,
      recordings: this.recordings,
      elapsedSeconds: this.currentElapsedSeconds(),
      audioFailureCount: this.audioFailureCount,
      audioCaptureDevice: this.captureDevice,
      audioRecorderPid: this.process?.pid
      ,audioProbeLastResult: this.audioProbeLastResult,
      recoveredFinalization: this.recoveredFinalization,
      recoveredRecordingIds: this.recoveredRecordingIds
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
    this.segmentDirPath = join(this.options.recordingsDir, `.segments-${recording.id}`);
    this.segmentPaths = [];
    this.segmentStartedAts = [];
    this.segmentPauseDurationsMs = [];
    this.segmentNumber = 0;
    this.pausedAtMs = undefined;
    this.pendingPauseDurationMs = 0;
    this.pendingSegmentStartedAt = startedAt;
    this.captureDevice = this.options.captureDeviceResolver?.() ?? this.options.device ?? "default";
    this.state = {
      ...this.state,
      status: "waitingForAudio",
      activeRecording: recording,
      elapsedSeconds: 0,
      lastEvent: "Connecting DJI audio"
    };
    await this.startNextSegment();
    await this.saveActiveRecovery("recording");
    if (this.state.status === "waitingForAudio" && this.activeRecording) {
      this.startAudioWaitLoop();
    }
    return this.getState();
  }

  async pauseRecording(): Promise<PodcastState> {
    if (this.state.status !== "recording" || !this.process) {
      return this.getState();
    }

    this.elapsedBeforePause = this.currentElapsedSeconds();
    this.startedAtMs = undefined;
    this.pausedAtMs = Date.now();
    this.state = {
      ...this.state,
      status: "paused",
      elapsedSeconds: this.elapsedBeforePause,
      lastEvent: "Recording paused"
    };
    const process = this.process;
    this.expectedProcessExits.add(process);
    await stopProcess(process);
    // The stop helper resolves from the child's exit event. Clear the process
    // defensively here as well so an immediate resume cannot see the old
    // recorder and silently skip creating the next segment.
    if (this.process === process) {
      this.process = undefined;
    }
    await this.saveActiveRecovery("paused");
    return this.getState();
  }

  async resumeRecording(): Promise<PodcastState> {
    if (this.state.status !== "paused") {
      return this.getState();
    }

    const resumedAtMs = Date.now();
    this.pendingPauseDurationMs = this.pausedAtMs ? Math.max(0, resumedAtMs - this.pausedAtMs) : 0;
    this.pendingSegmentStartedAt = new Date(resumedAtMs).toISOString();
    this.pausedAtMs = undefined;
    await this.startNextSegment();
    // startCaptureProcess owns the transition to recording. If the microphone
    // was not producing PCM yet it leaves us in waitingForAudio and schedules
    // a retry; do not overwrite that state with a false "recording" status.
    if (this.process) {
      this.state = {
        ...this.state,
        lastEvent: "Recording resumed"
      };
      await this.saveActiveRecovery("recording");
    }
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
      if (this.segmentDirPath) {
        await rm(this.segmentDirPath, { recursive: true, force: true });
      }
      this.activeRecording = undefined;
      this.activeFilePath = undefined;
      this.activeSegmentPath = undefined;
      this.segmentDirPath = undefined;
      this.segmentPaths = [];
      this.segmentStartedAts = [];
      this.segmentPauseDurationsMs = [];
      this.segmentNumber = 0;
      this.pausedAtMs = undefined;
      this.pendingPauseDurationMs = 0;
      this.pendingSegmentStartedAt = undefined;
      this.startedAtMs = undefined;
      this.elapsedBeforePause = 0;
      this.state = {
        ...this.state,
        status: "idle",
        activeRecording: undefined,
        elapsedSeconds: 0,
        lastEvent: "Recording cancelled: DJI audio unavailable"
      };
      await this.clearActiveRecovery();
      return this.getState();
    }
    if (process) {
      this.state = {
        ...this.state,
        status: "stopping",
        lastEvent: "Recording stopping"
      };
      this.expectedProcessExits.add(process);
      await stopProcess(process);
    }

    const durationSeconds = this.currentElapsedSeconds();
    this.elapsedBeforePause = durationSeconds;
    this.startedAtMs = undefined;
    await this.saveActiveRecovery("finalizing");

    const completed = await this.finalizeSegmentRecordings(activeRecording, activeFilePath, new Date().toISOString());
    this.recordings = [...completed, ...this.recordings];
    this.activeRecording = undefined;
    this.activeFilePath = undefined;
    this.activeSegmentPath = undefined;
    const segmentDirPath = this.segmentDirPath;
    this.segmentDirPath = undefined;
    this.segmentPaths = [];
    this.segmentStartedAts = [];
    this.segmentPauseDurationsMs = [];
    this.segmentNumber = 0;
    this.process = undefined;
    this.startedAtMs = undefined;
    this.elapsedBeforePause = 0;
    this.pausedAtMs = undefined;
    this.pendingPauseDurationMs = 0;
    this.pendingSegmentStartedAt = undefined;
    await this.saveManifest();
    await this.clearActiveRecovery();
    this.state = {
      ...this.state,
      status: "idle",
      activeRecording: undefined,
      elapsedSeconds: 0,
      recordings: this.recordings,
      lastEvent: completed.length > 1
        ? `Recording stopped: ${completed.length} parts created after long pause`
        : `Recording stopped: ${completed[0]?.downloadFileName ?? activeRecording.id}`
    };
    if (segmentDirPath) await rm(segmentDirPath, { recursive: true, force: true });
    return this.getState();
  }

  private startAudioWaitLoop(): void {
    this.stopAudioWaitLoop();
    this.audioWaitTimer = setInterval(() => {
      void this.tryStartWaitingCapture().catch((error: unknown) => {
        console.error("Podcast waiting-for-audio retry failed", error);
        this.state = {
          ...this.state,
          status: "error",
          lastEvent: `Audio retry failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240)
        };
        this.stopAudioWaitLoop();
      });
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
    this.stopAudioWaitLoop();
    await this.startNextSegment();
    if (this.state.status === "waitingForAudio" && this.activeRecording) {
      this.startAudioWaitLoop();
    }
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
      const probe = spawn("pactl", ["list", "short", "sources"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: this.pulseEnvironment()
      });
      let output = "";
      let errorOutput = "";
      const timeout = setTimeout(() => {
        probe.kill("SIGKILL");
        resolve(false);
      }, 5000);
      probe.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      probe.stderr?.on("data", (chunk: Buffer) => {
        errorOutput += chunk.toString("utf8");
      });
      probe.once("error", () => {
        clearTimeout(timeout);
        this.audioProbeLastResult = "pactl spawn error";
        resolve(false);
      });
      probe.once("close", (code) => {
        clearTimeout(timeout);
        const sourcePattern = this.options.captureSourcePattern ?? "DJI";
        const matched = output.split("\n").some((line) => line.includes("alsa_input.") && line.toLowerCase().includes(sourcePattern.toLowerCase()));
        this.audioProbeLastResult = `pactl exit=${code} matched=${matched} output=${output.replace(/\s+/g, " ").trim().slice(0, 220)}${errorOutput.trim() ? ` stderr=${errorOutput.trim().slice(0, 120)}` : ""}`;
        resolve(code === 0 && matched);
      });
    });
  }

  private refreshAudioReadiness(): Promise<void> {
    if (this.audioReadinessRefresh) {
      return this.audioReadinessRefresh;
    }

    const refresh = this.updateAudioReadiness();
    let trackedRefresh: Promise<void>;
    trackedRefresh = refresh.finally(() => {
      if (this.audioReadinessRefresh === trackedRefresh) {
        this.audioReadinessRefresh = undefined;
      }
    });
    this.audioReadinessRefresh = trackedRefresh;
    return trackedRefresh;
  }

  private async updateAudioReadiness(): Promise<void> {
    if (this.state.status === "recording" || this.state.status === "paused" || this.state.status === "stopping") {
      return;
    }
    const generation = ++this.audioReadinessGeneration;
    const previousReady = this.state.audioReady;
    const detected = await this.isCaptureDeviceAvailable();
    if (generation !== this.audioReadinessGeneration) {
      return;
    }
    this.audioFailureCount = detected ? 0 : this.audioFailureCount + 1;
    const ready = detected || (this.state.audioReady === true && this.audioFailureCount < 3);
    const audioLastEvent = ready
      ? "DJI microphone receiver ready"
      : `DJI microphone receiver not detected (capture device: ${this.captureDevice ?? this.options.device ?? "default"})`;
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

  private async startNextSegment(): Promise<void> {
    if (!this.activeRecording || this.process || !this.segmentDirPath) return;
    await mkdir(this.segmentDirPath, { recursive: true });
    this.segmentNumber += 1;
    const segmentPath = join(this.segmentDirPath, `segment-${String(this.segmentNumber).padStart(3, "0")}.wav`);
    this.segmentPaths.push(segmentPath);
    this.segmentStartedAts.push(this.pendingSegmentStartedAt ?? new Date().toISOString());
    this.segmentPauseDurationsMs.push(this.segmentPaths.length === 1 ? 0 : this.pendingPauseDurationMs);
    this.activeSegmentPath = segmentPath;
    await this.saveActiveRecovery(this.state.status === "paused" ? "paused" : "recording");
    await this.startCaptureProcess(segmentPath.split("/").at(-1) ?? segmentPath);
    if (this.process && this.activeSegmentPath === segmentPath) {
      this.pendingPauseDurationMs = 0;
      this.pendingSegmentStartedAt = undefined;
    }
  }

  private async startCaptureProcess(fileName: string): Promise<void> {
    if (!this.activeRecording || this.process) {
      return;
    }
    const filePath = this.activeSegmentPath;
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
    const captureEnvironment = this.captureDevice === "pulse" ? this.pulseEnvironment() : undefined;
    const recorderProcess = this.options.captureWrapperPath
      ? spawn(this.options.captureWrapperPath, ["--", recorderCommand, ...args], { stdio: ["ignore", "pipe", "pipe"], env: captureEnvironment })
      : spawn(recorderCommand, args, { stdio: ["ignore", "pipe", "pipe"], env: captureEnvironment });
    this.process = recorderProcess;
    this.audioFailureCount = 0;
    this.startedAtMs = Date.now();
    this.state = {
      ...this.state,
      status: "recording",
      activeRecording: this.activeRecording,
      elapsedSeconds: this.elapsedBeforePause,
      lastEvent: `Recording started: ${fileName}`
    };

    let resolveExitHandled!: () => void;
    const exitHandled = new Promise<void>((resolve) => {
      resolveExitHandled = resolve;
    });
    const earlyExit = new Promise<boolean>((resolve) => {
      recorderProcess.once("exit", () => resolve(true));
    });

    recorderProcess.once("exit", async (code, signal) => {
      try {
        const expectedExit = this.expectedProcessExits.delete(recorderProcess);
        if (expectedExit) {
          this.process = undefined;
          return;
        }
        if (this.state.status === "recording" || this.state.status === "paused") {
          const elapsedSeconds = this.currentElapsedSeconds();
          const partialSizeBytes = this.activeSegmentPath ? await fileSize(this.activeSegmentPath) : 0;
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
      } catch (error) {
        this.process = undefined;
        this.state = {
          ...this.state,
          status: "error",
          lastEvent: `Recorder cleanup failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240)
        };
        console.error("Podcast recorder exit handling failed", error);
      } finally {
        resolveExitHandled();
      }
    });

    recorderProcess.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.state = { ...this.state, lastEvent: message.slice(0, 160) };
      }
    });

    const exitedEarly = await Promise.race([earlyExit, sleep(250).then(() => false)]);
    if (exitedEarly) {
      await exitHandled;
      return;
    }

    // A PulseAudio client can stay alive while receiving no PCM during device
    // startup. Do not advertise a recording until the WAV contains audio.
    await sleep(1000);
    if (await fileSize(filePath) <= 44) {
      this.expectedProcessExits.add(recorderProcess);
      await stopProcess(recorderProcess);
      const failedIndex = this.segmentPaths.indexOf(filePath);
      if (failedIndex >= 0) {
        this.segmentPaths.splice(failedIndex, 1);
        this.segmentStartedAts.splice(failedIndex, 1);
        this.segmentPauseDurationsMs.splice(failedIndex, 1);
      }
      this.activeSegmentPath = undefined;
      this.state = {
        ...this.state,
        status: "waitingForAudio",
        lastEvent: "Waiting for DJI audio"
      };
      this.startAudioWaitLoop();
      return;
    }

    const wasAudioReady = this.state.audioReady === true;
    this.audioFailureCount = 0;
    this.state = {
      ...this.state,
      audioReady: true,
      audioLastCheckedAt: new Date().toISOString(),
      audioLastEvent: "DJI microphone receiver ready"
    };
    if (!wasAudioReady) {
      this.options.onAudioReadinessChange?.();
    }
  }

  private pulseEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "/run/user/1000",
      PULSE_SERVER: process.env.PULSE_SERVER ?? "unix:/run/user/1000/pulse/native"
    };
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

  async setZoomRecordingAsset(recordingId: string | string[], filePath: string, archive = true): Promise<PodcastState> {
    const recordingIds = Array.isArray(recordingId) ? recordingId : [recordingId];
    const recordings = recordingIds
      .map((id) => this.recordings.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is RecordingManifestEntry => Boolean(candidate));
    if (!recordings.length) {
      return this.getState();
    }
    const info = await stat(filePath);
    const archiveMetadata = archive && this.options.s3Archive ? await this.options.s3Archive.upload(recordings[0], filePath).catch((error: unknown) => {
      console.error(`S3 Zoom archive upload failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }) : undefined;
    const removeLocalAfterArchive = Boolean(archiveMetadata) && process.env.STUDYBOX_S3_KEEP_LOCAL_ZOOM !== "true";
    const zoomAsset = {
      kind: "zoom" as const,
      label: "Zoom recording",
      status: "available" as const,
      fileName: filePath.split("/").at(-1) ?? `${recordings[0].id}.mp4`,
      mimeType: "video/mp4",
      filePath: removeLocalAfterArchive ? undefined : filePath,
      sizeBytes: info.size,
      availableUntil: undefined,
      ...archiveMetadata
    };
    for (const recording of recordings) {
      const audioLabel = recording.assets?.find((asset) => asset.kind === "audio")?.label;
      recording.assets = createRecordingAssets({
        startedAt: recording.startedAt,
        fileName: recording.downloadFileName ?? formatRecordingFileName(recording.startedAt),
        mimeType: recording.downloadMimeType ?? "audio/wav",
        filePath: recording.filePath,
        sizeBytes: recording.sizeBytes,
        retentionDays: this.options.retentionDays ?? 35,
        zoomAsset: { ...zoomAsset, label: recordings.length > 1 ? "Zoom recording - complete session" : zoomAsset.label }
      });
      const audioAsset = recording.assets.find((asset) => asset.kind === "audio");
      if (audioAsset && audioLabel) audioAsset.label = audioLabel;
    }
    await this.saveManifest();
    if (removeLocalAfterArchive) {
      await unlink(filePath).catch(() => undefined);
    }
    return this.getState();
  }

  async setRecordingTitle(recordingId: string, title: string): Promise<PodcastState> {
    const recording = this.recordings.find((candidate) => candidate.id === recordingId);
    if (!recording) return this.getState();
    recording.title = title;
    await this.saveManifest();
    return this.getState();
  }

  async getRecordingAssetUrl(recordingId: string, assetKind: RecordingAssetKind): Promise<string | undefined> {
    const recording = this.recordings.find((candidate) => candidate.id === recordingId);
    const asset = recording?.assets?.find((candidate) => candidate.kind === assetKind);
    if (!recording || !asset?.archiveBucket || !asset.archiveKey || !this.options.s3Archive) return undefined;
    return this.options.s3Archive.signedUrl(asset.archiveBucket, asset.archiveKey, titleDownloadFileName(recording.title, assetKind, asset.fileName));
  }

  private currentElapsedSeconds(): number {
    if (!this.startedAtMs) {
      return this.elapsedBeforePause;
    }

    return this.elapsedBeforePause + Math.floor((Date.now() - this.startedAtMs) / 1000);
  }

  private async saveManifest(): Promise<void> {
    await mkdir(dirname(this.options.manifestPath), { recursive: true });
    const temporaryPath = `${this.options.manifestPath}.tmp-${process.pid}`;
    await writeFile(temporaryPath, JSON.stringify({ recordings: this.recordings }, null, 2));
    await rename(temporaryPath, this.options.manifestPath);
  }

  private recoveryPath(): string {
    return join(this.options.recordingsDir, ".active-recording.json");
  }

  private async saveActiveRecovery(phase: ActiveRecordingRecovery["phase"]): Promise<void> {
    if (!this.activeRecording || !this.activeFilePath || !this.segmentDirPath) return;
    const recovery: ActiveRecordingRecovery = {
      version: 1,
      phase,
      recording: this.activeRecording,
      activeFilePath: this.activeFilePath,
      segmentDirPath: this.segmentDirPath,
      segmentPaths: [...this.segmentPaths],
      segmentStartedAts: [...this.segmentStartedAts],
      segmentPauseDurationsMs: [...this.segmentPauseDurationsMs],
      elapsedSeconds: this.currentElapsedSeconds(),
      updatedAt: new Date().toISOString()
    };
    const recoveryPath = this.recoveryPath();
    const temporaryPath = `${recoveryPath}.tmp-${process.pid}`;
    await writeFile(temporaryPath, JSON.stringify(recovery, null, 2));
    await rename(temporaryPath, recoveryPath);
  }

  private async clearActiveRecovery(): Promise<void> {
    await unlink(this.recoveryPath()).catch(() => undefined);
  }

  private async recoverInterruptedFinalization(): Promise<void> {
    let recovery: ActiveRecordingRecovery;
    try {
      recovery = JSON.parse(await readFile(this.recoveryPath(), "utf8")) as ActiveRecordingRecovery;
    } catch {
      return;
    }
    if (recovery.version !== 1 || recovery.phase !== "finalizing" || !recovery.recording?.id) return;
    const segmentPaths = recovery.segmentPaths.filter(Boolean);
    if (!segmentPaths.length) return;
    this.segmentPaths = segmentPaths;
    this.segmentStartedAts = recovery.segmentStartedAts?.length === segmentPaths.length
      ? [...recovery.segmentStartedAts]
      : segmentPaths.map((_path, index) => index === 0 ? recovery.recording.startedAt : recovery.updatedAt);
    this.segmentPauseDurationsMs = recovery.segmentPauseDurationsMs?.length === segmentPaths.length
      ? [...recovery.segmentPauseDurationsMs]
      : segmentPaths.map(() => 0);
    const completed = await this.finalizeSegmentRecordings(recovery.recording, recovery.activeFilePath, recovery.updatedAt);
    const completedIds = new Set(completed.map((recording) => recording.id));
    this.recordings = [...completed, ...this.recordings.filter((recording) => !completedIds.has(recording.id) && recording.id !== recovery.recording.id)];
    await this.saveManifest();
    await this.clearActiveRecovery();
    await rm(recovery.segmentDirPath, { recursive: true, force: true });
    this.recoveredFinalization = true;
    this.recoveredRecordingIds = completed.map((recording) => recording.id);
    this.state = {
      ...this.state,
      recordings: this.recordings,
      lastEvent: `Recovered interrupted recording: ${completed.length} recording${completed.length === 1 ? "" : "s"}`
    };
  }

  private async finalizeSegmentRecordings(
    activeRecording: RecordingManifestEntry,
    activeFilePath: string | undefined,
    stoppedAt: string
  ): Promise<RecordingManifestEntry[]> {
    if (!this.segmentPaths.length) return [];
    const thresholdSeconds = Math.max(60, Number(process.env.STUDYBOX_RECORDING_PART_PAUSE_SECONDS ?? 300));
    const groups = groupRecordingSegments(this.segmentPaths, this.segmentPauseDurationsMs, thresholdSeconds);
    if (groups.length === 1) {
      if (!activeFilePath) throw new Error("Recording output path is unavailable");
      await mergeWavSegments(this.segmentPaths, activeFilePath);
      const sizeBytes = await fileSize(activeFilePath);
      const durationSeconds = await wavDurationSeconds(activeFilePath);
      return [{
        ...activeRecording,
        endedAt: stoppedAt,
        durationSeconds: Math.round(durationSeconds),
        sizeBytes,
        assets: createRecordingAssets({
          startedAt: activeRecording.startedAt,
          fileName: activeRecording.downloadFileName ?? formatRecordingFileName(activeRecording.startedAt),
          mimeType: activeRecording.downloadMimeType ?? "audio/wav",
          filePath: activeFilePath,
          sizeBytes,
          retentionDays: this.options.retentionDays ?? 35,
          zoomAsset: activeRecording.assets?.find((asset) => asset.kind === "zoom")
        })
      }];
    }

    const completed: RecordingManifestEntry[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const partNumber = index + 1;
      const group = groups[index];
      const startedAt = this.segmentStartedAts[group.firstIndex] ?? activeRecording.startedAt;
      const fileName = formatPartRecordingFileName(startedAt, partNumber);
      const filePath = join(this.options.recordingsDir, fileName);
      await mergeWavSegments(group.paths, filePath);
      const sizeBytes = await fileSize(filePath);
      const durationSeconds = await wavDurationSeconds(filePath);
      const assets = createRecordingAssets({
        startedAt,
        fileName,
        mimeType: "audio/wav",
        filePath,
        sizeBytes,
        retentionDays: this.options.retentionDays ?? 35,
        zoomAsset: activeRecording.assets?.find((asset) => asset.kind === "zoom")
      });
      const audioAsset = assets.find((asset) => asset.kind === "audio");
      if (audioAsset) audioAsset.label = `Room audio - Part ${partNumber} of ${groups.length}`;
      const zoomAsset = assets.find((asset) => asset.kind === "zoom");
      if (zoomAsset) zoomAsset.label = "Zoom recording - complete session";
      completed.push({
        ...activeRecording,
        id: `${activeRecording.id}-part-${partNumber}`,
        title: `${formatRecordingTitle(startedAt)} (Part ${partNumber})`,
        startedAt,
        endedAt: new Date(Date.parse(startedAt) + durationSeconds * 1000).toISOString(),
        durationSeconds: Math.round(durationSeconds),
        sizeBytes,
        downloadFileName: fileName,
        downloadMimeType: "audio/wav",
        filePath,
        expiresAt: retentionDate(startedAt, this.options.retentionDays ?? 35),
        assets
      });
    }
    return completed;
  }
}

export function groupRecordingSegments(
  segmentPaths: string[],
  pauseDurationsMs: number[],
  thresholdSeconds = 300
): Array<{ paths: string[]; firstIndex: number }> {
  const thresholdMs = Math.max(1, thresholdSeconds) * 1000;
  const groups: Array<{ paths: string[]; firstIndex: number }> = [];
  for (let index = 0; index < segmentPaths.length; index += 1) {
    if (index === 0 || (pauseDurationsMs[index] ?? 0) >= thresholdMs) {
      groups.push({ paths: [], firstIndex: index });
    }
    groups.at(-1)!.paths.push(segmentPaths[index]);
  }
  return groups;
}

function titleDownloadFileName(title: string, assetKind: RecordingAssetKind, originalFileName?: string): string {
  const extension = originalFileName?.split(".").at(-1)?.toLowerCase() ?? (assetKind === "zoom" ? "mp4" : "wav");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "bible-study";
  return `${slug}-${assetKind}.${extension}`;
}

async function mergeWavSegments(segmentPaths: string[], outputPath: string): Promise<void> {
  if (segmentPaths.length === 0) return;
  const chunks = await Promise.all(segmentPaths.map(inspectWavDataChunk));
  const first = await open(segmentPaths[0], "r");
  const header = Buffer.alloc(chunks[0].dataStart);
  try {
    await first.read(header, 0, header.length, 0);
  } finally {
    await first.close();
  }
  const dataSize = chunks.reduce((total, chunk) => total + chunk.dataSize, 0);
  if (dataSize > 0xffffffff - header.length) throw new Error("Merged WAV exceeds the RIFF size limit");
  header.writeUInt32LE(header.length + dataSize - 8, 4);
  header.writeUInt32LE(dataSize, chunks[0].dataStart - 4);

  const temporaryPath = `${outputPath}.merging-${process.pid}`;
  const output = await open(temporaryPath, "w");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    await output.write(header);
    for (let index = 0; index < segmentPaths.length; index += 1) {
      const input = await open(segmentPaths[index], "r");
      let position = chunks[index].dataStart;
      let remaining = chunks[index].dataSize;
      try {
        while (remaining > 0) {
          const length = Math.min(buffer.length, remaining);
          const { bytesRead } = await input.read(buffer, 0, length, position);
          if (!bytesRead) throw new Error(`Unexpected end of WAV segment: ${segmentPaths[index]}`);
          await output.write(buffer, 0, bytesRead);
          position += bytesRead;
          remaining -= bytesRead;
        }
      } finally {
        await input.close();
      }
    }
    await output.sync();
  } catch (error) {
    await output.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await output.close();
  await rename(temporaryPath, outputPath);
}

async function inspectWavDataChunk(path: string): Promise<{ dataStart: number; dataSize: number; byteRate: number }> {
  const input = await open(path, "r");
  try {
    const info = await input.stat();
    const riff = Buffer.alloc(12);
    if ((await input.read(riff, 0, riff.length, 0)).bytesRead !== riff.length
      || riff.toString("ascii", 0, 4) !== "RIFF"
      || riff.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("Audio segment is not a RIFF/WAVE file");
    }
    let offset = 12;
    let byteRate = 0;
    const chunkHeader = Buffer.alloc(8);
    while (offset + 8 <= info.size) {
      if ((await input.read(chunkHeader, 0, 8, offset)).bytesRead !== 8) break;
      const chunkSize = chunkHeader.readUInt32LE(4);
      const dataStart = offset + 8;
      if (chunkHeader.toString("ascii", 0, 4) === "fmt " && chunkSize >= 12) {
        const format = Buffer.alloc(Math.min(chunkSize, 16));
        if ((await input.read(format, 0, format.length, dataStart)).bytesRead === format.length) {
          byteRate = format.readUInt32LE(8);
        }
      }
      if (chunkHeader.toString("ascii", 0, 4) === "data") {
        if (!byteRate) throw new Error("Audio segment WAV format has no byte rate");
        return { dataStart, dataSize: Math.min(chunkSize, info.size - dataStart), byteRate };
      }
      offset = dataStart + chunkSize + (chunkSize % 2);
    }
  } finally {
    await input.close();
  }
  throw new Error("Audio segment has no data chunk");
}

async function wavDurationSeconds(path: string): Promise<number> {
  const chunk = await inspectWavDataChunk(path);
  return chunk.dataSize / chunk.byteRate;
}

function findWavDataChunk(buffer: Buffer): { dataStart: number; dataEnd: number } {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Audio segment is not a RIFF/WAVE file");
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (buffer.toString("ascii", offset, offset + 4) === "data") {
      return { dataStart, dataEnd: Math.min(dataEnd, buffer.length) };
    }
    offset = dataEnd + (chunkSize % 2);
  }
  throw new Error("Audio segment has no data chunk");
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

function formatPartRecordingFileName(startedAt: string, partNumber: number): string {
  const date = new Date(startedAt);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `bible-study-${year}-${month}-${day}-part-${partNumber}.wav`;
}

function retentionDate(startedAt: string, retentionDays: number): string | undefined {
  return retentionDays > 0 ? new Date(new Date(startedAt).getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString() : undefined;
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
