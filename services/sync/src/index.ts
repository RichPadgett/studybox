import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BackupBundle, BackupSyncService, BackupSyncState, LogEntry, Recording, RecordingDownload } from "@studybox/shared";

export interface MockBackupSyncServiceOptions {
  queuePath: string;
  bundleDir: string;
  target: string;
  mode?: BackupSyncState["mode"];
}

export class MockBackupSyncService implements BackupSyncService {
  private state: BackupSyncState;

  constructor(private readonly options: MockBackupSyncServiceOptions) {
    this.state = emptyState(options.target, options.mode ?? "mock");
  }

  async load(): Promise<BackupSyncState> {
    try {
      const raw = await readFile(this.options.queuePath, "utf8");
      this.state = normalizeState(JSON.parse(raw) as BackupSyncState, this.options.target, this.options.mode ?? "mock");
    } catch {
      this.state = emptyState(this.options.target, this.options.mode ?? "mock");
      await this.save();
    }

    return this.state;
  }

  getState(): BackupSyncState {
    return {
      ...this.state,
      bundles: this.state.bundles.slice(0, 25)
    };
  }

  async createBundle(input: {
    recording: Recording;
    download: RecordingDownload;
    logs: LogEntry[];
    meetingEndedAt: string;
  }): Promise<BackupBundle> {
    const existing = this.state.bundles.find((bundle) => bundle.recordingId === input.recording.id);
    if (existing) {
      return existing;
    }

    const createdAt = new Date().toISOString();
    const bundle: BackupBundle = {
      id: `bundle-${input.recording.id}-${Date.now()}`,
      recordingId: input.recording.id,
      recordingTitle: input.recording.title,
      fileName: input.download.fileName,
      meetingEndedAt: input.meetingEndedAt,
      recordingStartedAt: input.recording.startedAt,
      recordingEndedAt: input.recording.endedAt ?? createdAt,
      createdAt,
      status: "pending",
      target: this.options.target,
      logEntryCount: input.logs.length
    };

    await this.writeBundleFiles(bundle, input.download, input.logs);
    this.state = recalculate({
      ...this.state,
      bundles: [bundle, ...this.state.bundles],
      lastEvent: `Backup bundle queued: ${input.download.fileName}`
    });
    await this.save();
    return bundle;
  }

  async syncPending(): Promise<BackupSyncState> {
    const now = new Date().toISOString();
    const bundles = this.state.bundles.map((bundle) => {
      if (bundle.status !== "pending" && bundle.status !== "failed") {
        return bundle;
      }

      return {
        ...bundle,
        status: "uploaded" as const,
        lastAttemptAt: now,
        uploadedAt: now,
        error: undefined
      };
    });

    this.state = recalculate({
      ...this.state,
      bundles,
      lastEvent: "Pending backup bundles synced to mock Hetzner repo"
    });
    await this.save();
    return this.getState();
  }

  private async writeBundleFiles(bundle: BackupBundle, download: RecordingDownload, logs: LogEntry[]): Promise<void> {
    const bundlePath = join(this.options.bundleDir, bundle.id);
    await mkdir(bundlePath, { recursive: true });
    await writeFile(join(bundlePath, "manifest.json"), JSON.stringify(bundle, null, 2));
    await writeFile(join(bundlePath, "audit-log.json"), JSON.stringify(logs, null, 2));
    await writeFile(join(bundlePath, download.fileName), Buffer.from(download.contentBase64, "base64"));
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.options.queuePath), { recursive: true });
    await writeFile(this.options.queuePath, JSON.stringify(this.state, null, 2));
  }
}

function emptyState(target: string, mode: BackupSyncState["mode"]): BackupSyncState {
  return {
    mode,
    target,
    pendingCount: 0,
    uploadedCount: 0,
    failedCount: 0,
    bundles: [],
    lastEvent: "Backup sync ready"
  };
}

function normalizeState(state: BackupSyncState, target: string, mode: BackupSyncState["mode"]): BackupSyncState {
  return recalculate({
    ...state,
    mode,
    target,
    bundles: state.bundles ?? []
  });
}

function recalculate(state: BackupSyncState): BackupSyncState {
  return {
    ...state,
    pendingCount: state.bundles.filter((bundle) => bundle.status === "pending" || bundle.status === "uploading").length,
    uploadedCount: state.bundles.filter((bundle) => bundle.status === "uploaded").length,
    failedCount: state.bundles.filter((bundle) => bundle.status === "failed").length
  };
}
