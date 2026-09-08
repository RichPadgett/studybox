import { readFileSync, statfsSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { MockAudioService } from "@studybox/audio";
import { MockButtonController, RaspberryPiButtonController } from "@studybox/buttons";
import { MockLedController, RaspberryPiLedController } from "@studybox/led";
import { MissingZoomRunnerClient, MockMeetingService, ZoomMeetingService } from "@studybox/meeting";
import { MockOledDisplay, RaspberryPiOledDisplay } from "@studybox/oled";
import { LocalPodcastService, MockPodcastService } from "@studybox/podcast";
import { MockSchedulerService } from "@studybox/scheduler";
import { MockBackupSyncService } from "@studybox/sync";
import type { BackupSyncService, BackupSyncState, ButtonController, HardwareMode, HardwareState, LedColor, LedController, LogEntry, LogLevel, LogResult, LogSource, MeetingService, MeetingState, OledDisplay, OledPageId, Participant, PodcastService, RecLedState, Recording, RecordingAssetKind, RecordingDownload, StudyBoxSettings, StudyBoxSnapshot, SystemMetrics, SystemStatus, ZoomLedState } from "@studybox/shared";
import { LogStore } from "./logStore.js";
import { projectPath } from "./paths.js";
import { SettingsStore } from "./settingsStore.js";
import { getZoomConfig, getZoomRuntimeStatus } from "./zoomConfig.js";
import { ZoomRunnerProcessClient } from "./zoomRunnerProcessClient.js";
import { createZoomSdkJwt } from "./zoomSdkJwt.js";
import { ZoomZakService } from "./zoomZakService.js";

export interface ActionContext {
  actor?: string;
  source?: LogSource;
}

export interface AuditContext extends ActionContext {
  action?: string;
  details?: Record<string, string | number | boolean | undefined>;
}

export class StudyBoxAppliance {
  readonly meeting: MeetingService;
  readonly podcast: PodcastService;
  readonly scheduler = new MockSchedulerService();
  readonly backup: BackupSyncService;
  readonly audio = new MockAudioService();
  private readonly hardwareMode: HardwareMode = process.env.STUDYBOX_HARDWARE_MODE === "raspberryPi" ? "raspberryPi" : "mock";
  private readonly buttonMode: HardwareMode = this.hardwareMode === "raspberryPi" && process.env.STUDYBOX_BUTTON_MODE === "raspberryPi" ? "raspberryPi" : "mock";
  private readonly ledMode: HardwareMode = this.hardwareMode === "raspberryPi" && process.env.STUDYBOX_LED_MODE === "raspberryPi" ? "raspberryPi" : "mock";
  readonly leds: LedController = createLedController(this.ledMode);
  readonly oled: OledDisplay = createOledDisplay(
    this.hardwareMode,
    () => this.meeting.getState(),
    () => this.podcast.getState(),
    () => this.getMetrics(),
    () => this.backup.getState()
  );
  readonly buttons: ButtonController = createButtonController(
    this.buttonMode,
    async () => {
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
    }
  );
  private finalizedRecordingId?: string;
  private lastPagePressedAt?: string;
  private lastActionPressedAt?: string;
  private recordingLedState: RecLedState = "off";
  private zoomLedState: ZoomLedState = "off";
  private backupDoneRenderTimer?: NodeJS.Timeout;
  private readonly dashboardViewers = new Map<string, number>();

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
        void this.oled.render(this.oled.getCurrentPage()).catch((error: unknown) => {
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
    this.podcast = createPodcastService();
  }

  async initialize(): Promise<void> {
    await this.settingsStore.load();
    await this.logStore.load();
    if ("load" in this.podcast && typeof this.podcast.load === "function") {
      await this.podcast.load();
    }
    await this.backup.load();
    await this.oled.render(this.oled.getCurrentPage());
    await this.syncLeds();
    await this.log({
      source: "system",
      level: "info",
      action: "system.initialize",
      result: "success",
      message: "StudyBox appliance initialized with mock service adapters"
    });
  }

  snapshot(viewerId?: string): StudyBoxSnapshot {
    const presence = this.updateDashboardPresence(viewerId);
    return {
      systemStatus: this.getSystemStatus(),
      meeting: this.meeting.getState(),
      zoom: getZoomRuntimeStatus(),
      podcast: this.podcast.getState(),
      backup: this.backup.getState(),
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
    return this.meeting.syncState();
  }

  async updateSettings(settings: StudyBoxSettings, context: ActionContext = {}): Promise<StudyBoxSettings> {
    const saved = await this.settingsStore.save(settings);
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

  async pressPage(): Promise<StudyBoxSnapshot> {
    await this.buttons.pressPage();
    return this.snapshot();
  }

  async pressAction(): Promise<StudyBoxSnapshot> {
    await this.buttons.pressAction();
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
    if (this.podcast.getState().audioReady !== true) {
      throw new Error("Connect the DJI microphone receiver before starting the meeting.");
    }
    await this.meeting.startMeeting();
    await this.logAction("meeting.start", "Meeting started", context);
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async endMeeting(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.endMeeting();
    await this.logAction("meeting.end", "Meeting ended", context);
    await this.queueBackupIfSessionFinalized(context);
    await this.syncHardwareIndicators();
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
    await this.podcast.startRecording();
    await this.logAction("podcast.recording.start", "Recording started", context);
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async pauseRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.podcast.pauseRecording();
    await this.logAction("podcast.recording.pause", "Recording paused", context);
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async resumeRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.podcast.resumeRecording();
    await this.logAction("podcast.recording.resume", "Recording resumed", context);
    await this.syncHardwareIndicators();
    return this.snapshot();
  }

  async stopRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    const activeRecordingId = this.podcast.getState().activeRecording?.id;
    await this.podcast.stopRecording();
    if (activeRecordingId) {
      this.finalizedRecordingId = activeRecordingId;
    }
    await this.logAction("podcast.recording.finish", "Recording finished", context);
    await this.syncHardwareIndicators();
    await this.queueBackupIfSessionFinalized(context);
    return this.snapshot();
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

  async getRecordingFile(recordingId: string, context: ActionContext = {}, assetKind: RecordingAssetKind = "audio"): Promise<{ recording: Recording; filePath: string; fileName: string; mimeType: string } | undefined> {
    const recording = (await this.podcast.listRecordings()).find((candidate) => candidate.id === recordingId);
    const asset = recording?.assets?.find((candidate) => candidate.kind === assetKind);
    const filePath = asset?.filePath ?? (assetKind === "audio" ? recording?.filePath : undefined);
    if (!recording || !filePath || (asset && asset.status !== "available")) {
      return undefined;
    }

    const fileName = asset?.fileName ?? recording.downloadFileName ?? recording.id;
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
    await this.oled.render(this.oled.getCurrentPage());
    await this.backup.syncPending();
    await this.oled.render(this.oled.getCurrentPage());
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
    await this.oled.render(this.oled.getCurrentPage());
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
    if (podcast.audioReady === false) {
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
      audio: this.audio.getState({
        meetingStatus: meeting.status,
        podcastStatus: podcast.status,
        activeSpeaker: meeting.activeSpeaker
      })
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
    await this.syncLeds();
    await this.oled.render(this.oled.getCurrentPage());
  }

  private scheduleBackupDoneRender(): void {
    if (this.backupDoneRenderTimer || !this.backup.getState().bundles.some((bundle) => bundle.status === "uploaded" && bundle.uploadedAt && Date.now() - Date.parse(bundle.uploadedAt) < 10 * 1000)) {
      return;
    }

    this.backupDoneRenderTimer = setTimeout(() => {
      this.backupDoneRenderTimer = undefined;
      void this.oled.render(this.oled.getCurrentPage()).catch((error: unknown) => {
        console.error("OLED backup completion render failed", error);
      });
    }, 10 * 1000);
    this.backupDoneRenderTimer.unref();
  }

  private async syncLeds(): Promise<void> {
    const status = this.getSystemStatus();
    await this.leds.setSystem(status === "ready" ? "green" : status === "meeting-live" ? "blue" : status === "attention" ? "yellow" : "red");

    const recordingStatus = this.podcast.getState().status;
    this.recordingLedState = recordingStatus === "recording" ? "solid" : recordingStatus === "paused" || recordingStatus === "waitingForAudio" || recordingStatus === "error" && Boolean(this.podcast.getState().activeRecording) ? "blinking" : "off";
    await this.leds.setRecording(this.recordingLedState);

    const meetingStatus = this.meeting.getState().status;
    this.zoomLedState = meetingStatus === "live" ? "solid" : meetingStatus === "starting" || meetingStatus === "ending" ? "slowBlink" : meetingStatus === "error" ? "fastBlink" : "off";
    await this.leds.setZoomConnection(this.zoomLedState);
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

  private async queueBackupIfSessionFinalized(context: ActionContext = {}): Promise<void> {
    const meeting = this.meeting.getState();
    const podcast = this.podcast.getState();
    const latestRecording = podcast.recordings[0];
    if (meeting.status !== "idle" || podcast.status !== "idle" || !latestRecording?.endedAt || latestRecording.id !== this.finalizedRecordingId) {
      return;
    }

    if (this.backup.getState().bundles.some((bundle) => bundle.recordingId === latestRecording.id)) {
      return;
    }

    const download = await this.podcast.getRecordingDownload(latestRecording.id);
    if (!download) {
      await this.log({
        source: context.source ?? "system",
        actor: context.actor,
        level: "warn",
        action: "backup.bundle.create",
        result: "failure",
        message: "Backup bundle could not be created because recording audio was unavailable",
        details: { recordingId: latestRecording.id }
      });
      return;
    }

    const bundle = await this.backup.createBundle({
      recording: latestRecording,
      download,
      logs: this.logsForRecording(latestRecording),
      meetingEndedAt: new Date().toISOString()
    });
    await this.oled.render(this.oled.getCurrentPage());

    await this.log({
      source: context.source ?? "system",
      actor: context.actor,
      level: "info",
      action: "backup.bundle.create",
      result: "success",
      message: `Backup bundle queued: ${bundle.fileName}`,
      details: { bundleId: bundle.id, recordingId: latestRecording.id, target: bundle.target }
    });

    await this.backup.syncPending();
    await this.oled.render(this.oled.getCurrentPage());
    this.finalizedRecordingId = undefined;
    await this.log({
      source: "backup",
      level: "info",
      action: "backup.bundle.sync",
      result: "success",
      message: `Backup bundle synced to ${bundle.target}`,
      details: { bundleId: bundle.id, recordingId: latestRecording.id }
    });
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

function createOledDisplay(
  mode: HardwareMode,
  getMeeting: () => MeetingState,
  getPodcast: () => ReturnType<PodcastService["getState"]>,
  getMetrics: () => SystemMetrics,
  getBackup: () => BackupSyncState
): OledDisplay {
  if (mode === "raspberryPi") {
    return new RaspberryPiOledDisplay(getMeeting, getPodcast, getMetrics, getBackup);
  }

  return new MockOledDisplay(getMeeting, getPodcast, getMetrics, getBackup);
}

function createButtonController(
  mode: HardwareMode,
  onPage: () => Promise<void>,
  onAction: () => Promise<void>
): ButtonController {
  if (mode === "raspberryPi") {
    return new RaspberryPiButtonController(onPage, onAction);
  }

  return new MockButtonController(onPage, onAction);
}

function createLedController(mode: HardwareMode): LedController {
  if (mode === "raspberryPi") {
    return new RaspberryPiLedController();
  }

  return new MockLedController();
}

function createPodcastService(): PodcastService {
  if (process.env.STUDYBOX_PODCAST_MODE === "alsa") {
    const captureDevice = process.env.STUDYBOX_AUDIO_CAPTURE_SHARED_DEVICE
      ?? process.env.STUDYBOX_AUDIO_CAPTURE_DEVICE
      ?? "pulse";
    return new LocalPodcastService({
      recordingsDir: process.env.STUDYBOX_RECORDINGS_DIR ?? "/var/lib/studybox/recordings",
      manifestPath: process.env.STUDYBOX_RECORDINGS_MANIFEST ?? "/var/lib/studybox/recordings/manifest.json",
      arecordPath: process.env.STUDYBOX_ARECORD_PATH,
      captureWrapperPath: process.env.STUDYBOX_AUDIO_CAPTURE_WRAPPER,
      retentionDays: process.env.STUDYBOX_RECORDING_RETENTION_DAYS ? Number(process.env.STUDYBOX_RECORDING_RETENTION_DAYS) : 35,
      device: captureDevice,
      captureDeviceResolver: () => captureDevice,
      captureSourcePattern: process.env.STUDYBOX_AUDIO_CAPTURE_SOURCE_PATTERN ?? "DJI",
      format: process.env.STUDYBOX_AUDIO_CAPTURE_FORMAT ?? "S16_LE",
      sampleRate: process.env.STUDYBOX_AUDIO_SAMPLE_RATE ? Number(process.env.STUDYBOX_AUDIO_SAMPLE_RATE) : 48000,
      channels: process.env.STUDYBOX_AUDIO_CHANNELS ? Number(process.env.STUDYBOX_AUDIO_CHANNELS) : 2
    });
  }

  return new MockPodcastService();
}
