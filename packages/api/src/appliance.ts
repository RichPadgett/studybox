import { MockAudioDevice } from "@studybox/audio";
import { MockButtonController } from "@studybox/buttons";
import { MockLedController } from "@studybox/led";
import { MissingZoomRunnerClient, MockMeetingService, ZoomMeetingService } from "@studybox/meeting";
import { MockOledDisplay } from "@studybox/oled";
import { MockPodcastService } from "@studybox/podcast";
import { MockSchedulerService } from "@studybox/scheduler";
import type { LogEntry, MeetingService, OledPageId, StudyBoxSettings, StudyBoxSnapshot, SystemMetrics, SystemStatus } from "@studybox/shared";
import { SettingsStore } from "./settingsStore.js";
import { getZoomConfig, getZoomRuntimeStatus } from "./zoomConfig.js";
import { ZoomRunnerProcessClient } from "./zoomRunnerProcessClient.js";

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
      this.log("hal", "info", `Page button selected ${page.title}`);
    },
    async () => {
      await this.executeCurrentPageAction();
    }
  );

  private logs: LogEntry[] = [];

  constructor(private readonly settingsStore: SettingsStore) {
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
    await this.oled.render(this.oled.getCurrentPage());
    await this.syncLeds();
    this.log("system", "info", "StudyBox mock appliance initialized");
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
      logs: this.logs.slice(0, 100)
    };
  }

  async updateSettings(settings: StudyBoxSettings): Promise<StudyBoxSettings> {
    const saved = await this.settingsStore.save(settings);
    await this.scheduler.updateSchedule(saved.schedule);
    this.log("system", "info", "Settings saved");
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

  async startMeeting(): Promise<StudyBoxSnapshot> {
    await this.meeting.startMeeting();
    this.log("meeting", "info", "Meeting started");
    await this.syncLeds();
    return this.snapshot();
  }

  async endMeeting(): Promise<StudyBoxSnapshot> {
    await this.meeting.endMeeting();
    this.log("meeting", "info", "Meeting ended");
    await this.syncLeds();
    return this.snapshot();
  }

  async admitParticipant(participantId: string): Promise<StudyBoxSnapshot> {
    await this.meeting.admitParticipant(participantId);
    this.log("meeting", "info", "Participant admitted");
    await this.syncLeds();
    return this.snapshot();
  }

  async dismissRaisedHand(participantId: string): Promise<StudyBoxSnapshot> {
    await this.meeting.dismissRaisedHand(participantId);
    this.log("meeting", "info", "Raised hand dismissed");
    await this.syncLeds();
    return this.snapshot();
  }

  async startRecording(): Promise<StudyBoxSnapshot> {
    await this.podcast.startRecording();
    this.log("podcast", "info", "Recording started");
    await this.syncLeds();
    return this.snapshot();
  }

  async pauseRecording(): Promise<StudyBoxSnapshot> {
    await this.podcast.pauseRecording();
    this.log("podcast", "info", "Recording paused");
    await this.syncLeds();
    return this.snapshot();
  }

  async resumeRecording(): Promise<StudyBoxSnapshot> {
    await this.podcast.resumeRecording();
    this.log("podcast", "info", "Recording resumed");
    await this.syncLeds();
    return this.snapshot();
  }

  async stopRecording(): Promise<StudyBoxSnapshot> {
    await this.podcast.stopRecording();
    this.log("podcast", "info", "Recording stopped");
    await this.syncLeds();
    return this.snapshot();
  }

  private async executeCurrentPageAction(): Promise<void> {
    const pageId: OledPageId = this.oled.getCurrentPage().id;
    if (pageId === "meeting") {
      if (this.meeting.getState().status === "live") {
        await this.endMeeting();
      } else {
        await this.startMeeting();
      }
      return;
    }

    if (pageId === "podcast") {
      const podcast = this.podcast.getState();
      if (podcast.status === "recording") {
        await this.pauseRecording();
      } else if (podcast.status === "paused") {
        await this.resumeRecording();
      } else {
        await this.startRecording();
      }
      return;
    }

    this.log("hal", "info", "Action button has no action on this page");
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

  private log(source: LogEntry["source"], level: LogEntry["level"], message: string): void {
    this.logs.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(),
      source,
      level,
      message
    });
  }
}
