import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BackupBundle, BackupSyncService, BackupSyncState, LogEntry, Recording, RecordingDownload } from "@studybox/shared";

export interface MockBackupSyncServiceOptions {
  queuePath: string;
  bundleDir: string;
  target: string;
  mode?: BackupSyncState["mode"];
  rsync?: {
    host?: string;
    user?: string;
    remoteDir?: string;
    sshKeyPath?: string;
    port?: number;
  };
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
    const bundles: BackupBundle[] = [];
    for (const bundle of this.state.bundles) {
      if (bundle.status !== "pending" && bundle.status !== "failed") {
        bundles.push(bundle);
        continue;
      }

      const uploading = {
        ...bundle,
        status: "uploading" as const,
        lastAttemptAt: new Date().toISOString(),
        error: undefined
      };
      this.state = recalculate({ ...this.state, bundles: replaceBundle(this.state.bundles, uploading) });
      await this.save();

      bundles.push(await this.uploadBundle(uploading));
    }

    this.state = recalculate({
      ...this.state,
      bundles,
      lastEvent: this.options.mode === "rsync"
        ? "Pending backup bundles synced with rsync"
        : "Pending backup bundles synced to mock Hetzner repo"
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

  private async uploadBundle(bundle: BackupBundle): Promise<BackupBundle> {
    if (this.options.mode !== "rsync") {
      return markUploaded(bundle);
    }

    try {
      await runRsync({
        sourceDir: join(this.options.bundleDir, bundle.id),
        host: requireConfig(this.options.rsync?.host, "STUDYBOX_BACKUP_HOST"),
        user: requireConfig(this.options.rsync?.user, "STUDYBOX_BACKUP_USER"),
        remoteDir: requireConfig(this.options.rsync?.remoteDir, "STUDYBOX_BACKUP_REMOTE_DIR"),
        sshKeyPath: this.options.rsync?.sshKeyPath,
        port: this.options.rsync?.port
      });
      return markUploaded(bundle);
    } catch (error) {
      return {
        ...bundle,
        status: "failed",
        error: error instanceof Error ? error.message : "Backup upload failed"
      };
    }
  }
}

interface RsyncInput {
  sourceDir: string;
  host: string;
  user: string;
  remoteDir: string;
  sshKeyPath?: string;
  port?: number;
}

async function runRsync(input: RsyncInput): Promise<void> {
  const sshArgs = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
  if (input.sshKeyPath) {
    sshArgs.push("-i", input.sshKeyPath);
  }
  if (input.port) {
    sshArgs.push("-p", input.port.toString());
  }

  const args = [
    "-az",
    "--partial",
    "--delete",
    "-e",
    sshArgs.join(" "),
    `${input.sourceDir}/`,
    `${input.user}@${input.host}:${trimTrailingSlash(input.remoteDir)}/${input.sourceDir.split("/").at(-1)}/`
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("rsync", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `rsync exited with code ${code ?? "unknown"}`));
    });
  });
}

function requireConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for rsync backup mode`);
  }
  return value;
}

function markUploaded(bundle: BackupBundle): BackupBundle {
  const now = new Date().toISOString();
  return {
    ...bundle,
    status: "uploaded",
    lastAttemptAt: bundle.lastAttemptAt ?? now,
    uploadedAt: now,
    error: undefined
  };
}

function replaceBundle(bundles: BackupBundle[], replacement: BackupBundle): BackupBundle[] {
  return bundles.map((bundle) => bundle.id === replacement.id ? replacement : bundle);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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
