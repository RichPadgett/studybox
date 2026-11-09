import { readFileSync, statfsSync } from "node:fs";
import { execFile } from "node:child_process";
import { readdir, stat, writeFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { MockAudioService, UnavailableAudioService } from "@studybox/audio";
import { MockButtonController, RaspberryPiButtonController } from "@studybox/buttons";
import { MockLedController, RaspberryPiLedController } from "@studybox/led";
import { MissingZoomRunnerClient, MockMeetingService, ZoomMeetingService } from "@studybox/meeting";
import { MockOledDisplay, RaspberryPiOledDisplay } from "@studybox/oled";
import { LocalPodcastService, MockPodcastService, S3ZoomArchive } from "@studybox/podcast";
import { MockSchedulerService } from "@studybox/scheduler";
import { MockBackupSyncService } from "@studybox/sync";
import { TranscriptLibraryService } from "@studybox/transcripts";
import type { BackupSyncService, BackupSyncState, ButtonController, HardwareMode, HardwareState, LedColor, LedController, LogEntry, LogLevel, LogResult, LogSource, MeetingSchedule, MeetingService, MeetingState, OledDisplay, OledPage, OledPageId, Participant, PodcastService, RecLedState, RecorderButtonState, Recording, RecordingAssetKind, RecordingDownload, StudyBoxSettings, StudyBoxSnapshot, SystemMetrics, SystemStatus, WatchdogStatus, ZoomButtonState, ZoomCloudRecordingStatus, ZoomLedState } from "@studybox/shared";
import { LogStore } from "./logStore.js";
import { MeetingIntentStore } from "./meetingIntentStore.js";
import { projectPath } from "./paths.js";
import { SessionWrapupStore } from "./sessionWrapupStore.js";
import { SettingsStore } from "./settingsStore.js";
import { getZoomConfig, getZoomRuntimeStatus } from "./zoomConfig.js";
import { ZoomRunnerProcessClient } from "./zoomRunnerProcessClient.js";
import { createZoomSdkJwt } from "./zoomSdkJwt.js";
import { ZoomZakService } from "./zoomZakService.js";
import { matchZoomRecording } from "./zoomRecordingMatcher.js";

const execFileAsync = promisify(execFile);

export interface ActionContext {
  actor?: string;
  source?: LogSource;
}

export interface AuditContext extends ActionContext {
  action?: string;
  details?: Record<string, string | number | boolean | undefined>;
}

export class ZoomRecordingMatchPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoomRecordingMatchPendingError";
  }
}

export class ZoomRecordingMatchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoomRecordingMatchRejectedError";
  }
}

export class StudyBoxAppliance {
  readonly meeting: MeetingService;
  readonly podcast: PodcastService;
  readonly scheduler = new MockSchedulerService();
  readonly backup: BackupSyncService;
  readonly library: TranscriptLibraryService;
  private readonly hardwareMode: HardwareMode = process.env.STUDYBOX_HARDWARE_MODE === "raspberryPi" ? "raspberryPi" : "mock";
  readonly audio = this.hardwareMode === "raspberryPi" ? new UnavailableAudioService() : new MockAudioService();
  private readonly buttonMode: HardwareMode = this.hardwareMode === "raspberryPi" && process.env.STUDYBOX_BUTTON_MODE === "raspberryPi" ? "raspberryPi" : "mock";
  private readonly ledMode: HardwareMode = this.hardwareMode === "raspberryPi" && process.env.STUDYBOX_LED_MODE === "raspberryPi" ? "raspberryPi" : "mock";
  readonly leds: LedController = createLedController(this.ledMode);
  readonly oled: OledDisplay = createOledDisplay(
    this.hardwareMode,
    () => this.meeting.getState(),
    () => this.podcast.getState(),
    () => this.getMetrics(),
    () => this.backup.getState(),
    () => getZoomRuntimeStatus(),
    () => this.cloudRecordingStatusProvider(),
    () => this.getWatchdogStatus()
  );
  readonly buttons: ButtonController = createButtonController(
    this.buttonMode,
    async () => {
      // Advance directly when waking from the screensaver so its pending frame
      // cannot render after the newly selected page.
      this.lastOledActivityAt = Date.now();
      this.oledScreensaverActive = false;
      this.lastPagePressedAt = new Date().toISOString();
      const page = await this.oled.nextPage();
      await this.log({
        source: "button",
        level: "info",
        action: "button.page",
        result: "success",
        message: `Page button selected ${page.title}`,
        details: { pageId: page.id, pageTitle: page.title }
      });
    },
    async () => {
      this.lastActionPressedAt = new Date().toISOString();
      await this.executeCurrentPageAction();
    },
    async (longPress) => {
      await this.wakeOled();
      await this.pressZoomButton(longPress);
    },
    async (longPress) => {
      await this.wakeOled();
      await this.pressRecordingButton(longPress);
    },
    async () => {
      await this.requestWifiSetup();
    }
  );
  private finalizedRecordingIds: string[] = [];
  private lastPagePressedAt?: string;
  private lastActionPressedAt?: string;
  private recordingLedState: RecLedState = "off";
  private zoomLedState: ZoomLedState = "off";
  private backupDoneRenderTimer?: NodeJS.Timeout;
  private buttonNoticeTimer?: NodeJS.Timeout;
  private zoomButtonFailureUntil = 0;
  private recordingButtonFailureUntil = 0;
  private debugHeartbeatTimer?: NodeJS.Timeout;
  private oledScreensaverTimer?: NodeJS.Timeout;
  private oledScreensaverActive = false;
  private oledScreensaverPosition = 0;
  private lastOledActivityAt = Date.now();
  private zoomEndInFlight?: Promise<StudyBoxSnapshot>;
  private cloudRecordingStatusProvider: () => ZoomCloudRecordingStatus = () => ({ pending: 0, processing: 0, failed: 0, completed: 0 });
  private readonly oledScreensaverIdleMs = Number(process.env.STUDYBOX_OLED_SCREENSAVER_IDLE_MS ?? 5 * 60 * 1000);
  private readonly oledScheduleGuardMinutes = Number(process.env.STUDYBOX_OLED_SCHEDULE_GUARD_MINUTES ?? 60);
  private readonly zoomLocalRecordingEnabled = process.env.STUDYBOX_ZOOM_LOCAL_RECORDING_ENABLED !== "false";
  private readonly dashboardViewers = new Map<string, number>();
  private meetingSyncAt = 0;
  private meetingSyncInFlight?: Promise<MeetingState>;
  private meetingStartInFlight?: Promise<StudyBoxSnapshot>;
  private readonly meetingIntentStore = new MeetingIntentStore();
  private meetingDesiredLive = false;
  private meetingIntentRequestedAt?: string;
  private meetingSupervisorTimer?: NodeJS.Timeout;
  private meetingRecoveryInFlight?: Promise<MeetingState>;
  private meetingRecoveryAttempt = 0;
  private meetingRecoveryActive = false;
  private meetingWasLiveForIntent = false;
  private meetingNonLiveSince = 0;
  private meetingNextRecoveryAt = 0;
  private readonly meetingSupervisorIntervalMs = Number(process.env.STUDYBOX_ZOOM_SUPERVISOR_INTERVAL_MS ?? 3_000);
  private readonly meetingReconnectGraceMs = Number(process.env.STUDYBOX_ZOOM_RECONNECT_GRACE_MS ?? 30_000);
  private readonly meetingReconnectMaxDelayMs = Number(process.env.STUDYBOX_ZOOM_RECONNECT_MAX_DELAY_MS ?? 60_000);
  private readonly meetingTerminalRecoveryAttempts = Math.max(2, Number(process.env.STUDYBOX_ZOOM_RECONNECT_TERMINAL_ATTEMPTS ?? 5));
  private readonly meetingInitialConnectGraceMs = Number(process.env.STUDYBOX_ZOOM_INITIAL_CONNECT_GRACE_MS ?? 30_000);
  private readonly meetingIntentMaxAgeMs = Number(process.env.STUDYBOX_ZOOM_INTENT_MAX_AGE_MS ?? 12 * 60 * 60 * 1000);
  private readonly sessionWrapupStore = new SessionWrapupStore(
    process.env.STUDYBOX_SESSION_WRAPUP_PATH ?? "/var/lib/studybox/session-wrapup.json"
  );
  private sessionWrapupInFlight?: Promise<boolean>;
  private sessionWrapupRetryTimer?: NodeJS.Timeout;
  private sessionWrapupRunAgain = false;

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly logStore: LogStore
  ) {
    const zoomConfig = getZoomConfig();
    this.backup = new MockBackupSyncService({
      queuePath: process.env.STUDYBOX_BACKUP_QUEUE_PATH ?? projectPath("data", "backup-queue.json"),
      bundleDir: process.env.STUDYBOX_BACKUP_DIR ?? projectPath("data", "backup-bundles"),
      target: process.env.STUDYBOX_BACKUP_REPO ?? "hetzner:studybox-backup",
      mode: process.env.STUDYBOX_BACKUP_MODE === "rsync" ? "rsync" : "mock",
      onStateChange: () => {
        void this.renderCurrentOledPage().catch((error: unknown) => {
          console.error("OLED backup status render failed", error);
        });
        this.scheduleBackupDoneRender();
      },
      rsync: {
        host: process.env.STUDYBOX_BACKUP_HOST,
        user: process.env.STUDYBOX_BACKUP_USER,
        remoteDir: process.env.STUDYBOX_BACKUP_REMOTE_DIR,
        stageRemoteDir: process.env.STUDYBOX_BACKUP_STAGE_REMOTE_DIR,
        sshKeyPath: process.env.STUDYBOX_BACKUP_SSH_KEY,
        port: process.env.STUDYBOX_BACKUP_PORT ? Number(process.env.STUDYBOX_BACKUP_PORT) : undefined
      }
    });
    this.library = new TranscriptLibraryService({
      rootDir: process.env.STUDYBOX_LIBRARY_DIR ?? "/var/lib/studybox/library",
      chunkSeconds: process.env.STUDYBOX_TRANSCRIPT_CHUNK_SECONDS ? Number(process.env.STUDYBOX_TRANSCRIPT_CHUNK_SECONDS) : 600,
      ffmpegPath: process.env.STUDYBOX_FFMPEG_PATH,
      apiKey: process.env.OPENAI_API_KEY,
      transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL,
      analysisModel: process.env.OPENAI_ANALYSIS_MODEL
    });
    this.meeting = zoomConfig.meetingMode === "runner"
      ? new ZoomMeetingService(
          zoomConfig.runnerCommand
            ? new ZoomRunnerProcessClient(zoomConfig.runnerCommand, zoomConfig.runnerArgs)
            : new MissingZoomRunnerClient(),
          async () => {
            const settings = this.settingsStore.get();
            if (!settings.zoom.meetingNumber.trim()) {
              throw new Error("Zoom meeting number is required before StudyBox can start Zoom.");
            }

            return {
              meetingNumber: settings.zoom.meetingNumber,
              password: settings.zoom.passcode,
              displayName: settings.zoom.displayName || "StudyBox",
              sdkJwt: createZoomSdkJwt(getZoomConfig()),
              zak: await new ZoomZakService().getZak()
            };
          }
        )
      : new MockMeetingService();
    this.podcast = createPodcastService(() => {
      void this.syncHardwareIndicators().catch((error: unknown) => {
        console.error("StudyBox hardware indicator sync failed after audio readiness change", error);
      });
    });
  }

  async initialize(): Promise<void> {
    await this.oled.showWatchdogStatus();
    await this.settingsStore.load();
    await this.logStore.load();
    await this.library.load();
    if ("load" in this.podcast && typeof this.podcast.load === "function") {
      await this.podcast.load();
    }
    await this.sessionWrapupStore.load();
    await this.restoreMeetingIntent();
    await this.backup.load();
    this.startBackgroundRecovery();
    await this.oled.showPage("home");
    await this.syncLeds();
    this.startMeetingSupervisor();
    this.oledScreensaverTimer = setInterval(() => {
      void this.updateOledScreensaver().catch((error: unknown) => {
        console.error("StudyBox OLED screensaver update failed", error);
      });
    }, 30_000);
    this.oledScreensaverTimer.unref();
    const debugIntervalMs = process.env.STUDYBOX_DEBUG_HEARTBEAT_MS
      ? Number(process.env.STUDYBOX_DEBUG_HEARTBEAT_MS)
      : 0;
    if (debugIntervalMs > 0) {
      this.debugHeartbeatTimer = setInterval(() => {
        try {
          this.logDebugHeartbeat();
        } catch (error) {
          console.error("StudyBox debug heartbeat failed", error);
        }
      }, debugIntervalMs);
      this.debugHeartbeatTimer.unref();
      this.logDebugHeartbeat();
    }
    await this.log({
      source: "system",
      level: "info",
      action: "system.initialize",
      result: "success",
      message: `StudyBox appliance initialized (${this.hardwareMode} hardware, ${getZoomRuntimeStatus().mode} meeting mode)`
    });
  }

  setCloudRecordingStatusProvider(provider: () => ZoomCloudRecordingStatus): void {
    this.cloudRecordingStatusProvider = provider;
  }

  private getWatchdogStatus(): WatchdogStatus {
    const statePath = process.env.STUDYBOX_WATCHDOG_STATE_FILE ?? "/var/lib/studybox/watchdog-state";
    const bootPath = process.env.STUDYBOX_WATCHDOG_BOOT_FILE ?? "/var/lib/studybox/watchdog-boot-live";
    const values = new Map<string, string>();
    try {
      for (const line of readFileSync(statePath, "utf8").split(/\r?\n/)) {
        const separator = line.indexOf("=");
        if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
      }
    } catch { /* The OLED reports the watchdog as starting until its state exists. */ }
    const lastCheck = Number(values.get("last_check_at") ?? 0);
    let bootLive = false;
    try {
      bootLive = readFileSync(bootPath, "utf8").trim().length > 0;
    } catch { /* The boot confirmation is not available yet. */ }
    const live = bootLive && Number.isFinite(lastCheck) && Date.now() / 1000 - lastCheck < 120;
    const issues: string[] = [];
    for (const service of ["studybox-api.service", "studybox-web.service", "cloudflared.service"]) {
      if (Number(values.get(`${service}_failures`) ?? 0) > 0) issues.push(`${service.split(".")[0].toUpperCase()} ISSUE`);
    }
    const metrics = this.getMetrics();
    const zoom = getZoomRuntimeStatus();
    if (!metrics.wifiConnected) issues.push("WIFI OFF");
    if (zoom.configured && !zoom.oauth.authorized) issues.push("ZOOM AUTH");
    if (this.meeting.getState().status === "error") issues.push("ZOOM ERROR");
    if (this.meeting.getState().screenSharePolicy === "error") issues.push("ZOOM SHARE");
    if (this.podcast.getState().status === "error") issues.push("AUDIO ERROR");
    return { live, issues, lastCheckAt: lastCheck ? new Date(lastCheck * 1000).toISOString() : undefined };
  }

  private startBackgroundRecovery(): void {
    const recordings = this.podcast.getState().recordings;
    const recoveredIds = new Set([
      ...(this.podcast.getState().recoveredRecordingIds ?? []),
      ...(this.sessionWrapupStore.get()?.recordingIds ?? [])
    ]);
    const persistRecoveredSession = this.sessionWrapupStore.get() || recoveredIds.size === 0
      ? Promise.resolve()
      : this.sessionWrapupStore.save([...recoveredIds]).then(() => undefined);
    void persistRecoveredSession.then(() => Promise.all(recordings
      .filter((recording) => recoveredIds.has(recording.id) && recording.filePath && !this.library.getDocument(recording.id))
      .map((recording) => this.library.enqueue(recording, recording.filePath!))))
      .then(() => this.library.processPending(recordings, (recording) => recording.filePath))
      .then(() => this.startSessionWrapup({ source: "system", actor: "startup-recovery" }))
      .catch((error: unknown) => {
        console.error(`StudyBox background recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  snapshot(viewerId?: string): StudyBoxSnapshot {
    const presence = this.updateDashboardPresence(viewerId);
    return {
      systemStatus: this.getSystemStatus(),
      meeting: this.meeting.getState(),
      zoom: getZoomRuntimeStatus(),
      cloudRecording: this.cloudRecordingStatusProvider(),
      podcast: this.podcast.getState(),
      backup: this.backup.getState(),
      library: this.library.getState(),
      hardware: this.getHardwareState(),
      oled: {
        currentPageId: this.oled.getCurrentPage().id,
        pages: this.oled.getPages()
      },
      metrics: this.getMetrics(),
      presence,
      settings: this.settingsStore.get(),
      logs: this.logStore.get(100)
    };
  }

  async syncMeetingState(): Promise<MeetingState> {
    const now = Date.now();
    if (this.meetingSyncInFlight) return this.meetingSyncInFlight;
    if (now - this.meetingSyncAt < 1000) return this.meeting.getState();

    this.meetingSyncInFlight = this.syncMeetingStateOnce();
    try {
      return await this.meetingSyncInFlight;
    } finally {
      this.meetingSyncInFlight = undefined;
    }
  }

  private async syncMeetingStateOnce(): Promise<MeetingState> {
    const previous = this.meeting.getState();
    const current = await this.meeting.syncState();
    this.meetingSyncAt = Date.now();
    const urgentBefore = previous.waitingRoom.length > 0 || previous.raisedHands.length > 0;
    const urgentNow = current.waitingRoom.length > 0 || current.raisedHands.length > 0;
    const stateChanged = previous.status !== current.status
      || previous.reconnecting !== current.reconnecting
      || previous.screenSharePolicy !== current.screenSharePolicy
      || urgentBefore !== urgentNow;
    if (previous.status !== current.status
      || previous.reconnecting !== current.reconnecting
      || previous.screenSharePolicy !== current.screenSharePolicy) {
      await this.log({
        source: "system",
        level: current.status === "error" ? "error" : current.reconnecting ? "warn" : "info",
        action: "meeting.state",
        result: current.status === "error" ? "failure" : "success",
        message: current.lastEvent ?? `Zoom state changed to ${current.status}`,
        details: {
          previousStatus: previous.status,
          status: current.status,
          reconnecting: Boolean(current.reconnecting),
          sdkStatus: current.sdkStatus,
          sdkResult: current.sdkResult,
          screenSharePolicy: current.screenSharePolicy
        }
      });
    }
    if (urgentNow || urgentBefore !== urgentNow) {
      await this.oled.showPage("home");
    } else if (stateChanged) {
      await this.renderCurrentOledPage();
    }
    return current;
  }

  private async restoreMeetingIntent(): Promise<void> {
    const meetingNumber = this.settingsStore.get().zoom.meetingNumber.trim();
    const intent = await this.meetingIntentStore.load(meetingNumber, this.meetingIntentMaxAgeMs);
    if (intent.desiredLive && this.podcast.getState().recoveredFinalization) {
      await this.meetingIntentStore.save(false, meetingNumber);
      this.meetingDesiredLive = false;
      this.meetingIntentRequestedAt = undefined;
      await this.log({
        source: "system",
        level: "warn",
        action: "meeting.intent.finalizationRecovery",
        result: "success",
        message: "Cleared stale Zoom meeting intent after recovering interrupted recording finalization"
      });
      return;
    }
    this.meetingDesiredLive = intent.desiredLive;
    this.meetingIntentRequestedAt = intent.requestedAt;
    if (intent.desiredLive) {
      this.meetingRecoveryActive = false;
      this.meetingNonLiveSince = Date.now();
      this.meetingNextRecoveryAt = 0;
      await this.log({
        source: "system",
        level: "warn",
        action: "meeting.intent.restore",
        result: "success",
        message: "Restored active Zoom meeting intent after service restart"
      });
    }
  }

  private async setMeetingDesiredLive(desiredLive: boolean): Promise<void> {
    const meetingNumber = this.settingsStore.get().zoom.meetingNumber.trim();
    if (this.meetingDesiredLive === desiredLive && (desiredLive || !this.meetingIntentRequestedAt)) return;
    if (desiredLive && !this.meetingIntentRequestedAt) {
      this.meetingIntentRequestedAt = new Date().toISOString();
    }
    if (!desiredLive) this.meetingIntentRequestedAt = undefined;
    this.meetingDesiredLive = desiredLive;
    await this.meetingIntentStore.save(desiredLive, meetingNumber, this.meetingIntentRequestedAt);
    if (!desiredLive) {
      this.meetingRecoveryAttempt = 0;
      this.meetingRecoveryActive = false;
      this.meetingWasLiveForIntent = false;
      this.meetingNonLiveSince = 0;
      this.meetingNextRecoveryAt = 0;
    }
  }

  private startMeetingSupervisor(): void {
    if (getZoomConfig().meetingMode !== "runner" || this.meetingSupervisorTimer) return;
    this.meetingSupervisorTimer = setInterval(() => {
      void this.superviseMeeting().catch((error: unknown) => {
        console.error(`Zoom meeting supervisor failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, Math.max(1_000, this.meetingSupervisorIntervalMs));
    this.meetingSupervisorTimer.unref();
    if (this.meetingDesiredLive) {
      void this.superviseMeeting().catch((error: unknown) => {
        console.error(`Initial Zoom meeting recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private async superviseMeeting(): Promise<void> {
    if (this.meetingRecoveryInFlight) return;
    const current = await this.syncMeetingState();
    if (!this.meetingDesiredLive) return;

    if (current.sdkStatus === "ended" || (current.sdkStatus === "failed" && current.sdkResult === 6)) {
      await this.setMeetingDesiredLive(false);
      await this.log({
        source: "system",
        level: "info",
        action: "meeting.intent.remoteEnd",
        result: "success",
        message: "Zoom reported that the meeting ended; automatic rejoin was cancelled",
        details: { sdkStatus: current.sdkStatus, sdkResult: current.sdkResult }
      });
      await this.syncHardwareIndicators();
      return;
    }

    if (current.status === "live") {
      this.meetingWasLiveForIntent = true;
      if (this.meetingRecoveryActive) {
        await this.log({
          source: "system",
          level: "info",
          action: "meeting.rejoin.connected",
          result: "success",
          message: "StudyBox rejoined the active Zoom meeting",
          details: { attempts: this.meetingRecoveryAttempt }
        });
        await this.syncHardwareIndicators();
      }
      this.meetingRecoveryAttempt = 0;
      this.meetingRecoveryActive = false;
      this.meetingNonLiveSince = 0;
      this.meetingNextRecoveryAt = 0;
      return;
    }

    const now = Date.now();
    if (!this.meetingNonLiveSince) this.meetingNonLiveSince = now;
    if (this.isWithinInitialZoomConnectGrace(now)) {
      return;
    }
    if (current.status === "starting" && now - this.meetingNonLiveSince < this.meetingReconnectGraceMs) {
      return;
    }
    if (now < this.meetingNextRecoveryAt) return;

    try {
      await this.runMeetingRecovery({ source: "system", actor: "zoom-supervisor" });
    } catch {
      // The failed attempt is logged and scheduled by runMeetingRecovery.
    }
  }

  private async recoverMeetingNow(context: ActionContext): Promise<StudyBoxSnapshot> {
    await this.setMeetingDesiredLive(true);
    this.meetingNextRecoveryAt = 0;
    this.meetingNonLiveSince = 0;
    await this.runMeetingRecovery(context);
    return this.snapshot();
  }

  private async runMeetingRecovery(context: ActionContext): Promise<MeetingState> {
    if (this.meetingRecoveryInFlight) return this.meetingRecoveryInFlight;
    const operation = async () => {
      this.meetingRecoveryAttempt += 1;
      this.meetingRecoveryActive = true;
      await this.log({
        source: context.source ?? "system",
        actor: context.actor,
        level: "warn",
        action: "meeting.rejoin.attempt",
        result: "success",
        message: `Attempting to rejoin the active Zoom meeting (attempt ${this.meetingRecoveryAttempt})`,
        details: { attempt: this.meetingRecoveryAttempt }
      });
      try {
        // recoverMeeting changes the state to a non-terminal reconnecting state
        // synchronously before it begins runner I/O. Reflect that graceful blue
        // state immediately instead of flashing the previous red error state.
        const recovery = this.meeting.recoverMeeting();
        await this.syncHardwareIndicators();
        const state = await recovery;
        this.meetingNonLiveSince = Date.now();
        this.meetingNextRecoveryAt = Date.now() + this.meetingReconnectGraceMs;
        await this.log({
          source: context.source ?? "system",
          actor: context.actor,
          level: "info",
          action: "meeting.rejoin.accepted",
          result: "success",
          message: state.status === "live" ? "StudyBox rejoined Zoom" : "Zoom accepted the StudyBox rejoin request",
          details: { attempt: this.meetingRecoveryAttempt, status: state.status }
        });
        await this.syncHardwareIndicators();
        return state;
      } catch (error) {
        const attempt = this.meetingRecoveryAttempt;
        const retryDelayMs = Math.min(
          this.meetingReconnectMaxDelayMs,
          5_000 * 2 ** Math.min(attempt - 1, 5)
        );
        const terminal = attempt >= this.meetingTerminalRecoveryAttempts;
        if (terminal) {
          this.meeting.markTerminalError(`Zoom could not reconnect after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}`);
          await this.setMeetingDesiredLive(false);
          await this.log({
            source: context.source ?? "system",
            actor: context.actor,
            level: "error",
            action: "meeting.rejoin.failed",
            result: "failure",
            message: `Zoom rejoin entered a terminal error after ${attempt} attempts`,
            details: { attempt, error: error instanceof Error ? error.message : String(error) }
          });
        } else {
          this.meetingNextRecoveryAt = Date.now() + retryDelayMs;
          await this.log({
            source: context.source ?? "system",
            actor: context.actor,
            level: "warn",
            action: "meeting.rejoin.retry",
            result: "failure",
            message: `Zoom rejoin attempt ${attempt} did not connect; retrying in ${Math.round(retryDelayMs / 1000)} seconds`,
            details: {
              attempt,
              retryDelaySeconds: Math.round(retryDelayMs / 1000),
              error: error instanceof Error ? error.message : String(error)
            }
          });
        }
        await this.syncHardwareIndicators();
        throw error;
      }
    };
    this.meetingRecoveryInFlight = operation().finally(() => {
      this.meetingRecoveryInFlight = undefined;
    });
    return this.meetingRecoveryInFlight;
  }

  async updateSettings(settings: StudyBoxSettings, context: ActionContext = {}): Promise<StudyBoxSettings> {
    const current = this.settingsStore.get();
    const saved = await this.settingsStore.save({
      ...settings,
      // Meeting credentials are persistent and must not be cleared by a
      // stale settings form or an unrelated OAuth/settings update.
      zoom: {
        ...current.zoom,
        ...settings.zoom,
        meetingNumber: settings.zoom.meetingNumber.trim() || current.zoom.meetingNumber,
        passcode: settings.zoom.passcode?.trim() || current.zoom.passcode,
        joinUrl: settings.zoom.joinUrl?.trim() || current.zoom.joinUrl,
        displayName: settings.zoom.displayName.trim() || current.zoom.displayName
      }
    });
    await this.scheduler.updateSchedule(saved.schedule);
    await this.log({
      source: context.source ?? "web",
      actor: context.actor,
      level: "info",
      action: "settings.save",
      result: "success",
      message: "Settings saved"
    });
    return saved;
  }

  getSettings(): StudyBoxSettings {
    return this.settingsStore.get();
  }

  async pressPage(): Promise<StudyBoxSnapshot> {
    await this.buttons.pressPage();
    return this.snapshot();
  }

  async pressAction(): Promise<StudyBoxSnapshot> {
    await this.buttons.pressAction();
    return this.snapshot();
  }

  async pressZoomButton(longPress = false): Promise<StudyBoxSnapshot> {
    const meeting = this.meeting.getState();
    if (longPress) {
      if (this.meetingDesiredLive || meeting.status !== "idle") {
        try {
          return await this.endMeeting({ source: "button", actor: "zoom-button-long-press" });
        } catch (error) {
          await this.showButtonFailureNotice("ZOOM STOP FAILED", error);
          return this.snapshot();
        }
      }
      await this.logAction("meeting.end.noop", "Zoom long press ignored because no meeting is active", { source: "button", actor: "zoom-button" });
      return this.snapshot();
    }
    if (meeting.status === "error") {
      try {
        return await this.recoverMeetingNow({ source: "button", actor: "zoom-button-rejoin" });
      } catch (error) {
        await this.showButtonFailureNotice("ZOOM REJOIN FAILED", error);
        return this.snapshot();
      }
    }
    if (meeting.status === "idle") {
      try {
        return await this.startMeeting({ source: "button", actor: "zoom-button" });
      } catch (error) {
        await this.showButtonFailureNotice("ZOOM START FAILED", error);
        return this.snapshot();
      }
    }
    await this.logAction("meeting.start.noop", "Zoom short press ignored while meeting is already active", { source: "button", actor: "zoom-button" });
    return this.snapshot();
  }

  async pressRecordingButton(longPress = false): Promise<StudyBoxSnapshot> {
    const podcast = this.podcast.getState();
    const context = { source: "button" as const, actor: "recording-button" };
    if (longPress) {
      if (podcast.activeRecording) return this.stopRecording({ ...context, actor: "recording-button-long-press" });
      await this.logAction("podcast.recording.finish.noop", "Recording long press ignored because no recording is active", context);
      return this.snapshot();
    }
    if (podcast.status === "idle") {
      try {
        return await this.startRecording(context);
      } catch (error) {
        await this.showButtonFailureNotice("REC START FAILED", error);
        return this.snapshot();
      }
    }
    if (podcast.status === "recording") return this.pauseRecording(context);
    if (podcast.status === "paused") return this.resumeRecording(context);
    await this.logAction("podcast.recording.button.noop", "Recording short press ignored while recorder is waiting for audio or has an error", context);
    return this.snapshot();
  }

  async requestParticipantJoin(displayName: string, context: ActionContext = {}): Promise<Participant> {
    const participant = await this.meeting.requestParticipantJoin(displayName);
    await this.logAction("meeting.participant.requestJoin", "Participant entered StudyBox lobby", context, {
      participantId: participant.id,
      displayName: participant.displayName
    });
    await this.syncHardwareIndicators();
    return participant;
  }

  async startMeeting(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    if (this.meeting.getState().status === "error") {
      return this.recoverMeetingNow(context);
    }
    if (this.meetingStartInFlight) return this.meetingStartInFlight;
    this.meetingStartInFlight = this.startMeetingOnce(context).finally(() => {
      this.meetingStartInFlight = undefined;
    });
    return this.meetingStartInFlight;
  }

  private async startMeetingOnce(context: ActionContext): Promise<StudyBoxSnapshot> {
    await this.wakeOled();
    if (!this.settingsStore.get().zoom.meetingNumber.trim()) {
      throw new Error("Zoom meeting number is required before StudyBox can start Zoom.");
    }
    await this.setMeetingDesiredLive(true);
    try {
      await this.meeting.startMeeting();
    } catch {
      // The runner can still be settling immediately after appliance boot.
      // Retry once in-process without presenting a transient reconnect as an
      // operator-facing failure. A second failure is a real issue.
      await delay(1_500);
      try {
        await this.meeting.recoverMeeting();
      } catch (error) {
        this.meeting.markTerminalError(`Zoom could not start after retry: ${error instanceof Error ? error.message : String(error)}`);
        await this.syncHardwareIndicators();
        throw error;
      }
    }
    await this.logAction("meeting.start", "Meeting started", context);
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async endMeeting(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    if (this.zoomEndInFlight) return this.zoomEndInFlight;
    this.zoomEndInFlight = this.endMeetingOnce(context).finally(() => {
      this.zoomEndInFlight = undefined;
    });
    return this.zoomEndInFlight;
  }

  private async endMeetingOnce(context: ActionContext): Promise<StudyBoxSnapshot> {
    await this.wakeOled();
    // Clear intent first so a concurrent health check cannot undo an
    // intentional long-press stop by rejoining the meeting.
    await this.setMeetingDesiredLive(false);
    if (this.podcast.getState().status !== "idle") {
      await this.logAction("meeting.end.finalizeRecording", "Finalizing recording before ending meeting", context);
      await this.stopRecording(context);
    }
    let ended = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !ended; attempt += 1) {
      try {
        if (this.meeting.getState().status === "idle") {
          ended = true;
          break;
        }
        await this.meeting.endMeeting();
        const state = await this.meeting.syncState();
        ended = state.status === "idle";
        if (!ended) throw new Error(`Zoom meeting is still ${state.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === 0) await delay(400);
      }
    }
    if (!ended) {
      this.meeting.markTerminalError(`Zoom did not confirm that it stopped: ${lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error")}`);
      await this.syncHardwareIndicators();
      throw lastError instanceof Error ? lastError : new Error("Zoom meeting did not confirm that it stopped");
    }
    await this.logAction("meeting.end", "Meeting ended", context);
    // The physical Zoom button must return to its ready blue blink as soon as
    // Zoom confirms idle. Backup packaging and transcript work continue as a
    // durable background wrap-up and must never delay the operator feedback.
    await this.syncHardwareIndicators();
    this.startSessionWrapup(context);
    return this.snapshot();
  }

  async admitParticipant(participantId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.admitParticipant(participantId);
    await this.logAction("meeting.participant.admit", "Participant admitted", context, { participantId });
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async dismissRaisedHand(participantId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.dismissRaisedHand(participantId);
    await this.logAction("meeting.raisedHand.dismiss", "Raised hand dismissed", context, { participantId });
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async allowParticipantToSpeak(participantId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.allowParticipantToSpeak(participantId);
    if (this.settingsStore.get().moderation.includeApprovedRemoteSpeakersInPodcast) {
      await this.meeting.setParticipantPodcastInclusion(participantId, true);
    }
    await this.logAction("meeting.participant.allowToSpeak", "Participant allowed to speak", context, { participantId });
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async muteParticipant(participantId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.muteParticipant(participantId);
    await this.logAction("meeting.participant.mute", "Participant muted", context, { participantId });
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async makeParticipantHost(participantId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    const participant = this.meeting.getState().participants.find((item) => item.id === participantId);
    await this.meeting.makeParticipantHost(participantId);
    await this.logAction("meeting.participant.makeHost", `${participant?.displayName ?? "Participant"} made host`, context, { participantId });
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async allowScreenShare(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.allowScreenShare();
    await this.logAction("meeting.allowScreenShare", "Participant screen sharing enabled", context);
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async setRemoteSpeakerPodcastInclusion(participantId: string, included: boolean, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.setParticipantPodcastInclusion(participantId, included);
    await this.logAction(
      "meeting.participant.podcastInclusion",
      included ? "Remote speaker included in podcast mix" : "Remote speaker excluded from podcast mix",
      context,
      { participantId, included }
      );
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async setTeacherAudioDevice(deviceId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.audio.setTeacherInputDevice(deviceId);
    await this.logAction("audio.teacherInput.set", "Teacher audio input selected", context, { deviceId });
    return this.snapshot();
  }

  async setAudienceAudioDevice(deviceId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.audio.setAudienceInputDevice(deviceId);
    await this.logAction("audio.audienceInput.set", "Audience audio input selected", context, { deviceId });
    return this.snapshot();
  }

  async setSpeakerAudioDevice(deviceId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.audio.setSpeakerOutputDevice(deviceId);
    await this.logAction("audio.speakerOutput.set", "Room speaker audio output selected", context, { deviceId });
    return this.snapshot();
  }

  async startRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.wakeOled();
    const podcast = await this.podcast.startRecording();
    if (this.zoomLocalRecordingEnabled && this.meeting.getState().status === "live" && podcast.activeRecording?.filePath) {
      await this.meeting.startZoomRecording(dirname(podcast.activeRecording.filePath));
    }
    const captureStarted = podcast.status === "recording";
    await this.logAction(
      captureStarted ? "podcast.recording.start" : "podcast.recording.waitingForAudio",
      captureStarted ? "Recording started" : "Recording requested; waiting for DJI audio",
      context
    );
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async pauseRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.wakeOled();
    await this.podcast.pauseRecording();
    await this.logAction("podcast.recording.pause", "Recording paused", context);
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async resumeRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.wakeOled();
    await this.podcast.resumeRecording();
    await this.logAction("podcast.recording.resume", "Recording resumed", context);
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async stopRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.wakeOled();
    const activeRecordingStartedAt = this.podcast.getState().activeRecording?.startedAt;
    const recordingIdsBeforeStop = new Set(this.podcast.getState().recordings.map((recording) => recording.id));
    const zoomRecordingDirectory = this.zoomLocalRecordingEnabled && this.meeting.getState().status === "live"
      ? await this.meeting.stopZoomRecording()
      : undefined;
    await this.podcast.stopRecording();
    const completedRecordings = this.podcast.getState().recordings.filter((recording) => !recordingIdsBeforeStop.has(recording.id));
    const completedRecording = completedRecordings[0];
    if (completedRecordings.length > 0) {
      this.finalizedRecordingIds = completedRecordings.map((recording) => recording.id);
      await this.sessionWrapupStore.save(this.finalizedRecordingIds);
    } else {
      this.finalizedRecordingIds = [];
      await this.sessionWrapupStore.clear();
    }
    if (completedRecordings.length > 0 && activeRecordingStartedAt && zoomRecordingDirectory) {
      const zoomPath = await this.findZoomRecording(zoomRecordingDirectory, activeRecordingStartedAt);
      if (zoomPath) {
        const recordingIds = completedRecordings.map((recording) => recording.id);
        await this.podcast.setZoomRecordingAsset(recordingIds, zoomPath, !this.settingsStore.get().testMode);
        await this.logAction("zoom.recording.saved", `Zoom recording saved: ${basename(zoomPath)}`, context, { recordingId: recordingIds.join(","), filePath: zoomPath });
      } else {
        await this.logAction("zoom.recording.missing", "Zoom recording did not produce a local video file", context, { recordingId: completedRecordings.map((recording) => recording.id).join(",") });
      }
    }
    await this.logAction(
      completedRecording ? "podcast.recording.finish" : "podcast.recording.cancel",
      completedRecording
        ? completedRecordings.length > 1 ? `Recording finished as ${completedRecordings.length} parts` : "Recording finished"
        : "Recording cancelled: DJI audio unavailable",
      context,
      completedRecordings.length > 1 ? { partCount: completedRecordings.length } : undefined
    );
    await this.syncHardwareIndicators();
    if (!this.settingsStore.get().testMode) {
      for (const recording of completedRecordings) {
        if (recording.filePath) await this.library.enqueue(recording, recording.filePath);
      }
    }
    this.startSessionWrapup(context);
    return this.snapshot();
  }

  private async findZoomRecording(directory: string, startedAt: string): Promise<string | undefined> {
    const startedAtMs = Date.parse(startedAt);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidates = await readdir(directory, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp4"))).catch(() => []);
      const files = await Promise.all(candidates.map(async (entry) => {
        const filePath = join(directory, entry.name);
        const info = await stat(filePath).catch(() => undefined);
        return info && info.size > 0 && info.mtimeMs >= startedAtMs ? { filePath, mtimeMs: info.mtimeMs } : undefined;
      }));
      const newest = files.filter((file): file is { filePath: string; mtimeMs: number } => Boolean(file)).sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
      if (newest) {
        return newest.filePath;
      }
      await sleep(1000);
    }
    return undefined;
  }

  async getRecordingDownload(recordingId: string, context: ActionContext = {}): Promise<RecordingDownload | undefined> {
    const download = await this.podcast.getRecordingDownload(recordingId);
    if (download) {
      await this.logAction("podcast.recording.download", `Recording download prepared: ${download.fileName}`, context, { recordingId, fileName: download.fileName });
    }
    return download;
  }

  async getRecordingAssetDownload(recordingId: string, assetKind: RecordingAssetKind, context: ActionContext = {}): Promise<RecordingDownload | undefined> {
    const download = await this.podcast.getRecordingAssetDownload(recordingId, assetKind);
    if (download) {
      await this.logAction("podcast.recording.download", `${assetKind} download prepared: ${download.fileName}`, context, { recordingId, fileName: download.fileName, assetKind });
    }
    return download;
  }

  async getRecordingAssetUrl(recordingId: string, assetKind: RecordingAssetKind, context: ActionContext = {}): Promise<string | undefined> {
    const url = await this.podcast.getRecordingAssetUrl(recordingId, assetKind);
    if (url) await this.logAction("podcast.recording.download", `${assetKind} archive URL prepared`, context, { recordingId, assetKind });
    return url;
  }

  async attachZoomCloudRecording(startedAt: string, filePath: string): Promise<string> {
    const zoomDurationSeconds = await mediaDurationSeconds(filePath);
    if (!zoomDurationSeconds) {
      throw new Error(`Could not determine the duration of Zoom recording ${filePath}`);
    }
    const recordings = await this.podcast.listRecordings();
    const result = matchZoomRecording(
      { startedAt, durationSeconds: zoomDurationSeconds },
      recordings,
      Boolean(this.podcast.getState().activeRecording)
    );
    if (result.status === "rejected") {
      throw new ZoomRecordingMatchRejectedError(result.reason);
    }
    if (result.status === "waiting") {
      throw new ZoomRecordingMatchPendingError(result.reason);
    }
    const candidate = result.status === "matched" ? result.match.recording : result.matches[0]?.recording;
    const partBaseId = candidate?.id.replace(/-part-\d+$/, "");
    const partRecordings = candidate && partBaseId !== candidate.id
      ? recordings.filter((recording) => recording.id.replace(/-part-\d+$/, "") === partBaseId)
      : [];
    if (result.status === "ambiguous" && (partRecordings.length < 2
      || result.matches.some((match) => match.recording.id.replace(/-part-\d+$/, "") !== partBaseId))) {
      throw new ZoomRecordingMatchRejectedError(`Zoom recording match is ambiguous between ${result.matches.map((match) => match.recording.id).join(" and ")}; refusing to attach automatically`);
    }
    if (!candidate) throw new ZoomRecordingMatchRejectedError("Zoom recording match did not include a recording");
    const recordingIds = partRecordings.length > 1 ? partRecordings.map((recording) => recording.id) : [candidate.id];
    await this.podcast.setZoomRecordingAsset(recordingIds, filePath);
    const archivedAsset = (await this.podcast.listRecordings())
      .find((recording) => recording.id === recordingIds[0])
      ?.assets?.find((asset) => asset.kind === "zoom");
    if (archivedAsset?.archiveProvider !== "s3" || !archivedAsset.archiveSha256 || !archivedAsset.archiveKey) {
      throw new Error(`Zoom recording ${recordingIds.join(",")} was not verified in S3`);
    }
    return recordingIds[0];
  }

  async hasPotentialZoomCloudRecording(startedAt: string, durationSeconds?: number): Promise<boolean> {
    const zoomStartedAt = Date.parse(startedAt);
    if (!Number.isFinite(zoomStartedAt)) return false;
    const recordings = await this.podcast.listRecordings();
    const activeRecording = this.podcast.getState().activeRecording;
    const candidates = activeRecording ? [activeRecording, ...recordings] : recordings;
    if (durationSeconds && Number.isFinite(durationSeconds) && durationSeconds >= 60) {
      const zoomEndedAt = zoomStartedAt + durationSeconds * 1000;
      return candidates.some((recording) => {
        const audioStartedAt = Date.parse(recording.startedAt);
        const audioEndedAt = recording.endedAt ? Date.parse(recording.endedAt) : Date.now();
        return Number.isFinite(audioStartedAt)
          && Number.isFinite(audioEndedAt)
          && Math.min(audioEndedAt, zoomEndedAt) > Math.max(audioStartedAt, zoomStartedAt);
      });
    }
    return candidates.some((recording) => Math.abs(Date.parse(recording.startedAt) - zoomStartedAt) <= 90 * 60_000);
  }

  async setLibraryTitle(recordingId: string, title: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    const normalizedTitle = title.trim().replace(/\s+/g, " ");
    if (!normalizedTitle) throw new Error("Title is required");
    if (normalizedTitle.length > 180) throw new Error("Title must be 180 characters or fewer");
    const recording = (await this.podcast.listRecordings()).find((candidate) => candidate.id === recordingId);
    const document = this.library.getDocument(recordingId);
    if (!recording || !document) throw new Error("Library recording not found");
    await this.podcast.setRecordingTitle(recordingId, normalizedTitle);
    await this.library.setTitle(recordingId, normalizedTitle);
    await this.logAction("library.title.update", `Library title updated: ${normalizedTitle}`, context, { recordingId });
    return this.snapshot();
  }

  async processLibraryRecording(recordingId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    const recording = (await this.podcast.listRecordings()).find((candidate) => candidate.id === recordingId);
    if (!recording?.filePath) throw new Error("Recording audio is not available");
    if (!this.library.getDocument(recordingId)) {
      await this.library.enqueue(recording, recording.filePath);
      await this.logAction("library.transcript.enqueue", `Transcript queued: ${recording.title}`, context, { recordingId });
    }
    return this.snapshot();
  }

  async getRecordingFile(recordingId: string, context: ActionContext = {}, assetKind: RecordingAssetKind = "audio"): Promise<{ recording: Recording; filePath: string; fileName: string; mimeType: string } | undefined> {
    const recording = (await this.podcast.listRecordings()).find((candidate) => candidate.id === recordingId);
    const asset = recording?.assets?.find((candidate) => candidate.kind === assetKind);
    const filePath = asset?.filePath ?? (assetKind === "audio" ? recording?.filePath : undefined);
    if (!recording || !filePath || (asset && asset.status !== "available")) {
      return undefined;
    }

    const originalFileName = asset?.fileName ?? recording.downloadFileName ?? recording.id;
    const extension = originalFileName.split(".").at(-1)?.toLowerCase() ?? (assetKind === "zoom" ? "mp4" : "wav");
    const slug = recording.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "bible-study";
    const fileName = `${slug}-${assetKind}.${extension}`;
    const mimeType = asset?.mimeType ?? recording.downloadMimeType ?? "audio/wav";
    await this.logAction("podcast.recording.download", `${assetKind} download prepared: ${fileName}`, context, { recordingId, fileName, assetKind });
    return {
      recording,
      filePath,
      fileName,
      mimeType
    };
  }

  async syncBackups(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.renderCurrentOledPage();
    await this.backup.syncPending();
    await this.renderCurrentOledPage();
    await this.log({
      source: "backup",
      actor: context.actor,
      level: "info",
      action: "backup.sync.manual",
      result: "success",
      message: `Backup sync triggered for ${this.backup.getState().target}`
    });
    return this.snapshot();
  }

  async retryBackups(): Promise<void> {
    if (this.meeting.getState().status !== "idle" || this.podcast.getState().status !== "idle") {
      return;
    }

    const before = this.backup.getState();
    const retryableCount = before.pendingCount + before.failedCount;
    if (retryableCount === 0) {
      return;
    }

    const after = await this.backup.syncPending();
    await this.renderCurrentOledPage();
    const failed = after.failedCount;
    await this.log({
      source: "backup",
      actor: "scheduler",
      level: failed > 0 ? "warn" : "info",
      action: "backup.sync.retry",
      result: failed > 0 ? "failure" : "success",
      message: failed > 0 ? "Automatic backup retry completed with failures" : "Automatic backup retry completed",
      details: {
        attempted: retryableCount,
        pending: after.pendingCount,
        uploaded: after.uploadedCount,
        failed: after.failedCount,
        target: after.target
      }
    });
  }

  async recordAudit(context: AuditContext & { source: LogSource; level: LogLevel; message: string; result?: LogResult }): Promise<StudyBoxSnapshot> {
    await this.log(context);
    return this.snapshot();
  }

  private async executeCurrentPageAction(): Promise<void> {
    const pageId: OledPageId = this.oled.getCurrentPage().id;
    if (pageId === "home") {
      await this.executeHomePageAction();
      return;
    }

    if (pageId === "meeting") {
      const meeting = this.meeting.getState();
      if (meeting.status === "live") {
        await this.endMeeting({ source: "button" });
      } else {
        await this.startMeeting({ source: "button" });
      }
      return;
    }

    if (pageId === "podcast") {
      const podcast = this.podcast.getState();
      if (podcast.status === "recording") {
        await this.pauseRecording({ source: "button" });
      } else if (podcast.status === "paused") {
        await this.resumeRecording({ source: "button" });
      } else if (podcast.status === "waitingForAudio") {
        await this.stopRecording({ source: "button" });
      } else if (podcast.status === "error" && podcast.activeRecording) {
        await this.stopRecording({ source: "button" });
      } else {
        await this.startRecording({ source: "button" });
      }
      return;
    }

    if (pageId === "screenShare") {
      if (this.meeting.getState().status === "live") {
        await this.allowScreenShare({ source: "button" });
      }
      return;
    }

    if (pageId === "recordingStop") {
      if (this.podcast.getState().status !== "idle") {
        await this.stopRecording({ source: "button" });
      }
      return;
    }

    await this.log({
      source: "button",
      level: "info",
      action: "button.action.noop",
      result: "success",
      message: "Action button has no action on this page",
      details: { pageId }
    });
  }

  private async executeHomePageAction(): Promise<void> {
    const meeting = this.meeting.getState();
    if (meeting.activeSpeaker) {
      await this.muteParticipant(meeting.activeSpeaker.id, { source: "button" });
      return;
    }

    if (meeting.waitingRoom[0]) {
      await this.admitParticipant(meeting.waitingRoom[0].id, { source: "button" });
      return;
    }

    if (meeting.raisedHands[0]) {
      await this.allowParticipantToSpeak(meeting.raisedHands[0].id, { source: "button" });
      return;
    }

    await this.log({
      source: "button",
      level: "info",
      action: "button.action.noop",
      result: "success",
      message: "Action button has no action on this page",
      details: { pageId: "home" }
    });
  }

  private getSystemStatus(): SystemStatus {
    const meeting = this.meeting.getState();
    const podcast = this.podcast.getState();
    if (meeting.status === "error" || podcast.status === "error") {
      return "error";
    }
    if (podcast.audioReady !== true) {
      return "attention";
    }
    if (meeting.screenSharePolicy === "error") {
      return "attention";
    }
    if (meeting.waitingRoom.length > 0 || meeting.raisedHands.length > 0) {
      return "attention";
    }
    if (meeting.status === "live") {
      return "meeting-live";
    }
    return "ready";
  }

  private getMetrics(): SystemMetrics {
    return {
      cpuPercent: getCpuPercent(),
      ssdPercent: getRootDiskPercent(),
      wifiConnected: getWifiConnected(),
      temperatureC: getTemperatureC()
    };
  }

  private getHardwareState(): HardwareState {
    const currentPage = this.oled.getCurrentPage();
    const ringColor = this.getRingColor();
    const meeting = this.meeting.getState();
    const podcast = this.podcast.getState();
    const audio = this.audio.getState({
      meetingStatus: meeting.status,
      podcastStatus: podcast.status,
      activeSpeaker: meeting.activeSpeaker
    });
    const audioReady = podcast.audioReady === true;
    return {
      oled: {
        mode: this.hardwareMode,
        health: "ready",
        connected: true,
        currentPageId: currentPage.id,
        currentPageTitle: currentPage.title,
        lastEvent: `Rendered ${currentPage.title}`
      },
      pageButton: {
        mode: this.buttonMode,
        health: "ready",
        connected: this.buttonMode === "raspberryPi" || true,
        label: "PAGE",
        lastPressedAt: this.lastPagePressedAt,
        lastEvent: this.lastPagePressedAt ? "Page button pressed" : "Ready"
      },
      actionButton: {
        mode: this.buttonMode,
        health: "ready",
        connected: this.buttonMode === "raspberryPi" || true,
        label: "ACTION",
        ringColor,
        ringMode: ringColor === "off" ? "off" : this.getSystemStatus() === "attention" ? "pulsing" : "solid",
        lastPressedAt: this.lastActionPressedAt,
        lastEvent: this.lastActionPressedAt ? "Action button pressed" : "Ready"
      },
      recordingLed: {
        mode: this.ledMode,
        health: "ready",
        connected: true,
        state: this.recordingLedState,
        lastEvent: `REC LED ${this.recordingLedState}`
      },
      zoomLed: {
        mode: this.ledMode,
        health: "ready",
        connected: true,
        state: this.zoomLedState,
        lastEvent: `Zoom LED ${this.zoomLedState}`
      },
      audio: {
        ...audio,
        health: audioReady ? audio.health : "missing",
        connected: audioReady,
        lastEvent: podcast.audioLastEvent ?? audio.lastEvent,
        inputDevices: audio.inputDevices.map((device) => device.id === "dji-receiver" ? { ...device, connected: audioReady } : device),
        devices: audio.devices.map((device) => device.id === "dji-receiver" ? { ...device, connected: audioReady } : device)
      }
    };
  }

  private getRingColor(): LedColor {
    const status = this.getSystemStatus();
    if (status === "ready") return "green";
    if (status === "meeting-live") return "blue";
    if (status === "attention") return "yellow";
    if (status === "wifi-setup") return "purple";
    if (status === "booting") return "white";
    return "red";
  }

  private updateDashboardPresence(viewerId?: string): StudyBoxSnapshot["presence"] {
    const now = Date.now();
    const activeWindowMs = 10_000;
    const normalizedViewerId = viewerId?.trim().slice(0, 80);
    if (normalizedViewerId) {
      this.dashboardViewers.set(normalizedViewerId, now);
    }

    for (const [id, lastSeenMs] of this.dashboardViewers) {
      if (now - lastSeenMs > activeWindowMs) {
        this.dashboardViewers.delete(id);
      }
    }

    return {
      activeViewerCount: this.dashboardViewers.size,
      currentViewerId: normalizedViewerId,
      lastSeenAt: normalizedViewerId ? new Date(now).toISOString() : undefined
    };
  }

  private async syncHardwareIndicators(): Promise<void> {
    if (this.meeting.getState().status !== "idle" || this.podcast.getState().status !== "idle") {
      await this.wakeOled();
    }
    await this.syncLeds();
    await this.renderCurrentOledPage();
  }

  private async showButtonFailureNotice(title: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const isZoom = title.startsWith("ZOOM");
    const now = Date.now();
    if (isZoom) this.zoomButtonFailureUntil = now + 8_000;
    else this.recordingButtonFailureUntil = now + 8_000;
    await this.syncLeds();
    await this.wakeOled();
    const lines = isZoom
      ? [title, message.includes("meeting number") ? "MEETING NUMBER" : "CHECK ZOOM", message.includes("meeting number") ? "REQUIRED" : "SEE WEB ADMIN"]
      : [title, message.includes("audio") || message.includes("DJI") ? "CHECK MICROPHONE" : "CHECK RECORDER", "SEE WEB ADMIN"];
    await this.oled.render({ id: this.oled.getCurrentPage().id, title, lines });
    if (this.buttonNoticeTimer) clearTimeout(this.buttonNoticeTimer);
    this.buttonNoticeTimer = setTimeout(() => {
      this.buttonNoticeTimer = undefined;
      void this.syncHardwareIndicators().catch((renderError: unknown) => {
        console.error(`Button failure notice recovery failed: ${renderError instanceof Error ? renderError.message : String(renderError)}`);
      });
    }, 8_000);
    this.buttonNoticeTimer.unref();
  }

  private async renderCurrentOledPage(): Promise<void> {
    if (this.oledScreensaverActive) {
      if (this.canUseOledScreensaver()) return;
      await this.wakeOled();
    }
    const renderedPage = "getRenderedPage" in this.oled && typeof this.oled.getRenderedPage === "function"
      ? this.oled.getRenderedPage()
      : undefined;
    if (!renderedPage) {
      return;
    }
    await this.oled.showPage(renderedPage.id);
  }

  private async updateOledScreensaver(): Promise<void> {
    const idleLongEnough = Date.now() - this.lastOledActivityAt >= this.oledScreensaverIdleMs;
    if (!idleLongEnough || !this.canUseOledScreensaver()) {
      if (this.oledScreensaverActive) await this.wakeOled();
      return;
    }

    this.oledScreensaverActive = true;
    const page: OledPage = {
      id: "screensaver",
      title: "",
      lines: [this.oledScreensaverPosition % 2 === 0 ? "text" : "logo"]
    };
    this.oledScreensaverPosition = (this.oledScreensaverPosition + 1) % 2;
    await this.oled.render(page);
  }

  private async requestWifiSetup(): Promise<void> {
    if (this.meeting.getState().status !== "idle" || this.podcast.getState().status !== "idle") {
      await this.logAction("wifi.setup.noop", "Wi-Fi setup request ignored while StudyBox is active", { source: "button", actor: "wifi-setup-chord" });
      return;
    }

    await this.logAction("wifi.setup.request", "Wi-Fi setup mode requested", { source: "button", actor: "wifi-setup-chord" });
    try {
      await writeFile("/tmp/studybox-force-wifi-setup", `${Date.now()}\n`);
      await execFileAsync("sudo", ["-n", "systemctl", "restart", "studybox-wifi-fallback.service"], { timeout: 15_000 });
    } catch (error) {
      console.error(`StudyBox Wi-Fi setup restart failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private canUseOledScreensaver(): boolean {
    const meetingIdle = this.meeting.getState().status === "idle";
    const recordingIdle = this.podcast.getState().status === "idle";
    const backupIdle = !this.backup.getState().bundles.some((bundle) => bundle.status === "zipping" || bundle.status === "uploading" || bundle.status === "promoting");
    return meetingIdle
      && recordingIdle
      && backupIdle
      && !isNearScheduledMeeting(new Date(), this.settingsStore.get().schedule, this.oledScheduleGuardMinutes);
  }

  private async wakeOled(): Promise<void> {
    this.lastOledActivityAt = Date.now();
    if (!this.oledScreensaverActive) return;
    this.oledScreensaverActive = false;
    await this.oled.showPage(this.oled.getCurrentPage().id);
  }

  private logDebugHeartbeat(): void {
    const podcast = this.podcast.getState();
    const hardware = this.getHardwareState();
    const currentPage = this.oled.getCurrentPage();
    const renderedPage = "getRenderedPage" in this.oled && typeof this.oled.getRenderedPage === "function"
      ? this.oled.getRenderedPage()
      : undefined;
    console.log(JSON.stringify({
      type: "studybox-debug-heartbeat",
      audio: {
        ready: podcast.audioReady,
        event: podcast.audioLastEvent,
        device: podcast.audioCaptureDevice,
        failures: podcast.audioFailureCount,
        recorderPid: podcast.audioRecorderPid,
        probe: podcast.audioProbeLastResult,
        hardwareConnected: hardware.audio.connected,
        hardwareEvent: hardware.audio.lastEvent
      },
      meeting: this.meeting.getState().status,
      podcast: podcast.status,
      oled: {
        currentPage: currentPage.id,
        currentLines: currentPage.lines,
        renderedPage: renderedPage?.id,
        renderedLines: renderedPage?.lines
      }
    }));
  }

  private scheduleBackupDoneRender(): void {
    if (this.backupDoneRenderTimer || !this.backup.getState().bundles.some((bundle) => bundle.status === "uploaded" && bundle.uploadedAt && Date.now() - Date.parse(bundle.uploadedAt) < 10 * 1000)) {
      return;
    }

    this.backupDoneRenderTimer = setTimeout(() => {
      this.backupDoneRenderTimer = undefined;
      void this.renderCurrentOledPage().catch((error: unknown) => {
        console.error("OLED backup completion render failed", error);
      });
    }, 10 * 1000);
    this.backupDoneRenderTimer.unref();
  }

  private async syncLeds(): Promise<void> {
    const status = this.getSystemStatus();
    await this.leds.setSystem(status === "ready" ? "green" : status === "meeting-live" ? "blue" : status === "attention" ? "yellow" : "red");

    const podcast = this.podcast.getState();
    const recordingStatus = podcast.status;
    this.recordingLedState = recordingStatus === "recording" ? "solid" : recordingStatus === "paused" || recordingStatus === "waitingForAudio" || recordingStatus === "error" && Boolean(podcast.activeRecording) ? "blinking" : "off";
    const recorderState: RecorderButtonState = this.recordingButtonFailureUntil > Date.now() ? "error" : podcast.status === "recording"
      ? "recording"
      : podcast.status === "paused"
        ? "paused"
        : podcast.status === "error" || podcast.status === "waitingForAudio"
          ? "error"
          : podcast.audioReady === true ? "ready" : "unavailable";
    await this.leds.setRecorderState(recorderState);

    const meetingStatus = this.meeting.getState().status;
    const meeting = this.meeting.getState();
    const reconnecting = Boolean(meeting.reconnecting);
    const initialConnectGrace = this.isWithinInitialZoomConnectGrace();
    this.zoomLedState = meetingStatus === "live"
      ? "solid"
      : meetingStatus === "error"
        ? "fastBlink"
        : initialConnectGrace || reconnecting || meetingStatus === "starting" || meetingStatus === "ending"
          ? "slowBlink"
          : "off";
    const runtime = getZoomRuntimeStatus();
    const zoomState: ZoomButtonState = initialConnectGrace ? "ready" : this.zoomButtonFailureUntil > Date.now() ? "error" : !runtime.configured || !runtime.runnerAvailable
      ? "unavailable"
      : meeting.status === "live"
        ? (meeting.waitingRoom.length > 0 || meeting.raisedHands.length > 0 ? "attention" : "live")
        : meeting.status === "error"
          ? "error"
          : "ready";
    await this.leds.setZoomState(zoomState);
  }

  private isWithinInitialZoomConnectGrace(now = Date.now()): boolean {
    if (!this.meetingDesiredLive || this.meetingWasLiveForIntent) return false;
    const requestedAtMs = Date.parse(this.meetingIntentRequestedAt ?? "");
    return Number.isFinite(requestedAtMs)
      && now >= requestedAtMs
      && now - requestedAtMs < this.meetingInitialConnectGraceMs;
  }

  private async logAction(action: string, message: string, context: ActionContext = {}, details?: Record<string, string | number | boolean | undefined>): Promise<void> {
    await this.log({
      source: context.source ?? "web",
      actor: context.actor,
      level: "info",
      action,
      result: "success",
      message,
      details
    });
  }

  private startSessionWrapup(context: ActionContext = {}): void {
    if (!this.sessionWrapupStore.get()) return;
    if (this.sessionWrapupRetryTimer) {
      clearTimeout(this.sessionWrapupRetryTimer);
      this.sessionWrapupRetryTimer = undefined;
    }
    if (this.sessionWrapupInFlight) {
      this.sessionWrapupRunAgain = true;
      return;
    }

    let completed = false;
    this.sessionWrapupInFlight = this.queueBackupIfSessionFinalized(context);
    void this.sessionWrapupInFlight
      .then((result) => { completed = result; })
      .catch((error: unknown) => {
        console.error(`Session wrap-up failed and will retry: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.sessionWrapupInFlight = undefined;
        const runAgain = this.sessionWrapupRunAgain;
        this.sessionWrapupRunAgain = false;
        if (completed || !this.sessionWrapupStore.get()) return;
        if (runAgain) {
          this.startSessionWrapup(context);
          return;
        }
        this.sessionWrapupRetryTimer = setTimeout(() => {
          this.sessionWrapupRetryTimer = undefined;
          this.startSessionWrapup({ source: "system", actor: "session-wrapup-retry" });
        }, 60_000);
        this.sessionWrapupRetryTimer.unref();
      });
  }

  private async queueBackupIfSessionFinalized(context: ActionContext = {}): Promise<boolean> {
    if (this.settingsStore.get().testMode) {
      this.finalizedRecordingIds = [];
      await this.sessionWrapupStore.clear();
      return true;
    }
    const meeting = this.meeting.getState();
    const podcast = this.podcast.getState();
    if (meeting.status !== "idle" || podcast.status !== "idle") {
      return false;
    }

    const recordingIds = this.sessionWrapupStore.get()?.recordingIds
      ?? this.finalizedRecordingIds;
    if (!recordingIds.length) return true;
    const recordings = recordingIds
      .map((recordingId) => podcast.recordings.find((recording) => recording.id === recordingId))
      .filter((recording): recording is Recording => Boolean(recording?.endedAt));
    if (recordings.length !== recordingIds.length) return false;

    const meetingEndedAt = new Date().toISOString();
    for (const recording of recordings) {
      if (this.backup.getState().bundles.some((bundle) => bundle.recordingId === recording.id)) continue;
      const audioAsset = recording.assets?.find((asset) => asset.kind === "audio" && asset.status === "available");
      const filePath = audioAsset?.filePath ?? recording.filePath;
      if (!filePath || !await stat(filePath).then((info) => info.isFile() && info.size > 0).catch(() => false)) {
        await this.log({
          source: context.source ?? "system",
          actor: context.actor,
          level: "warn",
          action: "backup.bundle.create",
          result: "failure",
          message: "Session wrap-up is waiting because recording audio is unavailable",
          details: { recordingId: recording.id }
        });
        return false;
      }

      const bundle = await this.backup.createBundle({
        recording,
        source: {
          filePath,
          fileName: audioAsset?.fileName ?? recording.downloadFileName ?? basename(filePath),
          mimeType: audioAsset?.mimeType ?? recording.downloadMimeType ?? "audio/wav"
        },
        logs: this.logsForRecording(recording),
        meetingEndedAt
      });

      await this.log({
        source: context.source ?? "system",
        actor: context.actor,
        level: "info",
        action: "backup.bundle.create",
        result: "success",
        message: `Backup bundle queued: ${bundle.fileName}`,
        details: { bundleId: bundle.id, recordingId: recording.id, target: bundle.target }
      });

      await this.log({
        source: "backup",
        level: "info",
        action: "backup.bundle.local",
        result: "success",
        message: "Backup bundle saved locally; public publication awaits approval",
        details: { bundleId: bundle.id, recordingId: recording.id }
      });
    }

    await this.oled.render(this.oled.getCurrentPage());
    this.finalizedRecordingIds = [];
    await this.sessionWrapupStore.clear();
    return true;
  }

  private logsForRecording(recording: Recording): LogEntry[] {
    const startedAtMs = Date.parse(recording.startedAt);
    const endedAtMs = Date.parse(recording.endedAt ?? new Date().toISOString());
    return this.logStore.get(500).filter((log) => {
      const timestampMs = Date.parse(log.timestamp);
      return timestampMs >= startedAtMs && timestampMs <= endedAtMs + 60_000;
    });
  }

  private async log(input: {
    source: LogSource;
    level: LogLevel;
    message: string;
    action?: string;
    actor?: string;
    result?: LogResult;
    details?: Record<string, string | number | boolean | undefined>;
  }): Promise<LogEntry> {
    return this.logStore.append(input);
  }
}

async function mediaDurationSeconds(filePath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(process.env.STUDYBOX_FFPROBE_PATH ?? "/usr/bin/ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath
    ]);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
  } catch {
    return undefined;
  }
}

function getCpuPercent(): number {
  const cores = Math.max(1, availableParallelism());
  const oneMinuteLoad = loadavg()[0] ?? 0;
  return clampPercent(Math.round((oneMinuteLoad / cores) * 100));
}

function getRootDiskPercent(): number {
  try {
    const stats = statfsSync("/");
    const totalBlocks = Number(stats.blocks);
    const availableBlocks = Number(stats.bavail);
    if (totalBlocks <= 0) {
      return 0;
    }
    return clampPercent(Math.round(((totalBlocks - availableBlocks) / totalBlocks) * 100));
  } catch {
    return 0;
  }
}

function getWifiConnected(): boolean {
  try {
    const wireless = readFileSync("/proc/net/wireless", "utf8");
    return wireless.split("\n").some((line) => line.includes(":") && !line.trim().startsWith("Inter-"));
  } catch {
    return false;
  }
}

function getTemperatureC(): number {
  try {
    const raw = readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim();
    const milliCelsius = Number(raw);
    if (Number.isFinite(milliCelsius)) {
      return Math.round(milliCelsius / 1000);
    }
  } catch {
    // Non-Pi development machines may not expose Linux thermal zones.
  }
  return 0;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function isNearScheduledMeeting(now: Date, schedule: MeetingSchedule, guardMinutes: number): boolean {
  const weekdayIndexes: Record<MeetingSchedule["dayOfWeek"], number> = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6
  };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value as MeetingSchedule["dayOfWeek"] | undefined;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const [scheduledHour, scheduledMinute] = schedule.time.split(":").map(Number);
  if (!weekday || !Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(scheduledHour) || !Number.isFinite(scheduledMinute)) {
    return false;
  }

  const minutesPerWeek = 7 * 24 * 60;
  const currentWeekMinute = weekdayIndexes[weekday] * 24 * 60 + hour * 60 + minute;
  const scheduledWeekMinute = weekdayIndexes[schedule.dayOfWeek] * 24 * 60 + scheduledHour * 60 + scheduledMinute;
  const directDistance = Math.abs(currentWeekMinute - scheduledWeekMinute);
  const weeklyDistance = Math.min(directDistance, minutesPerWeek - directDistance);
  return weeklyDistance <= Math.max(0, guardMinutes);
}

function createOledDisplay(
  mode: HardwareMode,
  getMeeting: () => MeetingState,
  getPodcast: () => ReturnType<PodcastService["getState"]>,
  getMetrics: () => SystemMetrics,
  getBackup: () => BackupSyncState,
  getZoom?: () => ReturnType<typeof getZoomRuntimeStatus>,
  getCloud?: () => ZoomCloudRecordingStatus,
  getWatchdog?: () => WatchdogStatus
): OledDisplay {
  if (mode === "raspberryPi") {
    try {
      return new RaspberryPiOledDisplay(getMeeting, getPodcast, getMetrics, getBackup, getZoom, getCloud, getWatchdog);
    } catch (error) {
      console.error(`StudyBox OLED unavailable; continuing without display: ${error instanceof Error ? error.message : String(error)}`);
      return new MockOledDisplay(getMeeting, getPodcast, getMetrics, getBackup, getZoom, getCloud, getWatchdog);
    }
  }

  return new MockOledDisplay(getMeeting, getPodcast, getMetrics, getBackup, getZoom, getCloud, getWatchdog);
}

function createButtonController(
  mode: HardwareMode,
  onPage: () => Promise<void>,
  onAction: () => Promise<void>,
  onZoom: (longPress: boolean) => Promise<void>,
  onRecording: (longPress: boolean) => Promise<void>,
  onSetup: () => Promise<void>
): ButtonController {
  if (mode === "raspberryPi") {
    return new RaspberryPiButtonController(onPage, onZoom, onRecording, onSetup);
  }

  return new MockButtonController(onPage, onZoom, onRecording);
}

function createLedController(mode: HardwareMode): LedController {
  if (mode === "raspberryPi") {
    return new RaspberryPiLedController();
  }

  return new MockLedController();
}

function createPodcastService(onAudioReadinessChange?: () => void): PodcastService {
  if (process.env.STUDYBOX_PODCAST_MODE === "alsa") {
    const captureDevice = process.env.STUDYBOX_AUDIO_CAPTURE_SHARED_DEVICE
      ?? process.env.STUDYBOX_AUDIO_CAPTURE_DEVICE
      ?? "pulse";
    return new LocalPodcastService({
      recordingsDir: process.env.STUDYBOX_RECORDINGS_DIR ?? "/var/lib/studybox/recordings",
      manifestPath: process.env.STUDYBOX_RECORDINGS_MANIFEST ?? "/var/lib/studybox/recordings/manifest.json",
      arecordPath: process.env.STUDYBOX_ARECORD_PATH,
      captureWrapperPath: process.env.STUDYBOX_AUDIO_CAPTURE_WRAPPER,
      retentionDays: process.env.STUDYBOX_RECORDING_RETENTION_DAYS ? Number(process.env.STUDYBOX_RECORDING_RETENTION_DAYS) : 0,
      s3Archive: new S3ZoomArchive(),
      device: captureDevice,
      captureDeviceResolver: () => captureDevice,
      captureSourcePattern: process.env.STUDYBOX_AUDIO_CAPTURE_SOURCE_PATTERN ?? "DJI",
      onAudioReadinessChange,
      format: process.env.STUDYBOX_AUDIO_CAPTURE_FORMAT ?? "S16_LE",
      sampleRate: process.env.STUDYBOX_AUDIO_SAMPLE_RATE ? Number(process.env.STUDYBOX_AUDIO_SAMPLE_RATE) : 48000,
      channels: process.env.STUDYBOX_AUDIO_CHANNELS ? Number(process.env.STUDYBOX_AUDIO_CHANNELS) : 2
    });
  }

  return new MockPodcastService();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
