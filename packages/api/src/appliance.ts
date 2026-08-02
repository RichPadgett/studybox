import { MockAudioDevice } from "@studybox/audio";
import { MockButtonController } from "@studybox/buttons";
import { MockLedController } from "@studybox/led";
import { MissingZoomRunnerClient, MockMeetingService, ZoomMeetingService } from "@studybox/meeting";
import { MockOledDisplay } from "@studybox/oled";
import { MockPodcastService } from "@studybox/podcast";
import { MockSchedulerService } from "@studybox/scheduler";
import type { LogEntry, LogLevel, LogResult, LogSource, MeetingService, OledPageId, RecordingDownload, StudyBoxSettings, StudyBoxSnapshot, SystemMetrics, SystemStatus } from "@studybox/shared";
import { LogStore } from "./logStore.js";
import { SettingsStore } from "./settingsStore.js";
import { getZoomConfig, getZoomRuntimeStatus } from "./zoomConfig.js";
import { ZoomRunnerProcessClient } from "./zoomRunnerProcessClient.js";

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
  readonly podcast = new MockPodcastService();
  readonly scheduler = new MockSchedulerService();
  readonly audio = new MockAudioDevice();
  readonly leds = new MockLedController();
  readonly oled = new MockOledDisplay(
    () => this.meeting.getState(),
    () => this.podcast.getState(),
    () => this.getMetrics()
  );
  readonly buttons = new MockButtonController(
    async () => {
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
      await this.executeCurrentPageAction();
    }
  );

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly logStore: LogStore
  ) {
    const zoomConfig = getZoomConfig();
    this.meeting = zoomConfig.meetingMode === "runner"
      ? new ZoomMeetingService(
          zoomConfig.runnerCommand
            ? new ZoomRunnerProcessClient(zoomConfig.runnerCommand, zoomConfig.runnerArgs)
            : new MissingZoomRunnerClient()
        )
      : new MockMeetingService();
  }

  async initialize(): Promise<void> {
    await this.settingsStore.load();
    await this.logStore.load();
    await this.oled.render(this.oled.getCurrentPage());
    await this.syncLeds();
    await this.log({
      source: "system",
      level: "info",
      action: "system.initialize",
      result: "success",
      message: "StudyBox mock appliance initialized"
    });
  }

  snapshot(): StudyBoxSnapshot {
    return {
      systemStatus: this.getSystemStatus(),
      meeting: this.meeting.getState(),
      zoom: getZoomRuntimeStatus(),
      podcast: this.podcast.getState(),
      oled: {
        currentPageId: this.oled.getCurrentPage().id,
        pages: this.oled.getPages()
      },
      metrics: this.getMetrics(),
      settings: this.settingsStore.get(),
      logs: this.logStore.get(100)
    };
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

  async startMeeting(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.startMeeting();
    await this.logAction("meeting.start", "Meeting started", context);
    await this.syncLeds();
    return this.snapshot();
  }

  async endMeeting(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.endMeeting();
    await this.logAction("meeting.end", "Meeting ended", context);
    await this.syncLeds();
    return this.snapshot();
  }

  async admitParticipant(participantId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.admitParticipant(participantId);
    await this.logAction("meeting.participant.admit", "Participant admitted", context, { participantId });
    await this.syncLeds();
    return this.snapshot();
  }

  async dismissRaisedHand(participantId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.dismissRaisedHand(participantId);
    await this.logAction("meeting.raisedHand.dismiss", "Raised hand dismissed", context, { participantId });
    await this.syncLeds();
    return this.snapshot();
  }

  async allowParticipantToSpeak(participantId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.allowParticipantToSpeak(participantId);
    await this.logAction("meeting.participant.allowToSpeak", "Participant allowed to speak", context, { participantId });
    await this.syncLeds();
    return this.snapshot();
  }

  async muteParticipant(participantId: string, context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.meeting.muteParticipant(participantId);
    await this.logAction("meeting.participant.mute", "Participant muted", context, { participantId });
    await this.syncLeds();
    return this.snapshot();
  }

  async startRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.podcast.startRecording();
    await this.logAction("podcast.recording.start", "Recording started", context);
    await this.syncLeds();
    return this.snapshot();
  }

  async pauseRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.podcast.pauseRecording();
    await this.logAction("podcast.recording.pause", "Recording paused", context);
    await this.syncLeds();
    return this.snapshot();
  }

  async resumeRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.podcast.resumeRecording();
    await this.logAction("podcast.recording.resume", "Recording resumed", context);
    await this.syncLeds();
    return this.snapshot();
  }

  async stopRecording(context: ActionContext = {}): Promise<StudyBoxSnapshot> {
    await this.podcast.stopRecording();
    await this.logAction("podcast.recording.finish", "Recording finished", context);
    await this.syncLeds();
    return this.snapshot();
  }

  async getRecordingDownload(recordingId: string, context: ActionContext = {}): Promise<RecordingDownload | undefined> {
    const download = await this.podcast.getRecordingDownload(recordingId);
    if (download) {
      await this.logAction("podcast.recording.download", `Recording download prepared: ${download.fileName}`, context, { recordingId, fileName: download.fileName });
    }
    return download;
  }

  async recordAudit(context: AuditContext & { source: LogSource; level: LogLevel; message: string; result?: LogResult }): Promise<StudyBoxSnapshot> {
    await this.log(context);
    return this.snapshot();
  }

  private async executeCurrentPageAction(): Promise<void> {
    const pageId: OledPageId = this.oled.getCurrentPage().id;
    const meeting = this.meeting.getState();
    if (meeting.activeSpeaker) {
      await this.muteParticipant(meeting.activeSpeaker.id, { source: "button" });
      return;
    }

    if (meeting.raisedHands[0]) {
      await this.allowParticipantToSpeak(meeting.raisedHands[0].id, { source: "button" });
      return;
    }

    if (pageId === "meeting") {
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
      } else {
        await this.startRecording({ source: "button" });
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

  private getSystemStatus(): SystemStatus {
    const meeting = this.meeting.getState();
    if (meeting.waitingRoom.length > 0 || meeting.raisedHands.length > 0) {
      return "attention";
    }
    if (meeting.status === "live") {
      return "meeting-live";
    }
    return "ready";
  }

  private getMetrics(): SystemMetrics {
    const now = Date.now();
    return {
      cpuPercent: 18 + Math.round((Math.sin(now / 8000) + 1) * 12),
      ssdPercent: 12,
      wifiConnected: true,
      temperatureC: 46 + Math.round((Math.sin(now / 12000) + 1) * 4)
    };
  }

  private async syncLeds(): Promise<void> {
    const status = this.getSystemStatus();
    await this.leds.setSystem(status === "ready" ? "green" : status === "meeting-live" ? "blue" : status === "attention" ? "yellow" : "red");

    const recordingStatus = this.podcast.getState().status;
    await this.leds.setRecording(recordingStatus === "recording" ? "solid" : recordingStatus === "paused" ? "blinking" : "off");
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
