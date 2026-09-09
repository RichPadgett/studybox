import type { BackupSyncState, MeetingState, OledDisplay, OledPage, OledPageId, PodcastState, SystemMetrics } from "@studybox/shared";

export class MockOledDisplay implements OledDisplay {
  private pageIndex = 0;
  private renderedPage?: OledPage;

  constructor(
    private readonly getMeeting: () => MeetingState,
    private readonly getPodcast: () => PodcastState,
    private readonly getMetrics: () => SystemMetrics,
    private readonly getBackup?: () => BackupSyncState
  ) {}

  getPages(): OledPage[] {
    const meeting = this.getMeeting();
    const podcast = this.getPodcast();
    const metrics = this.getMetrics();
    const backup = this.getBackup?.();
    const activeBackupPage = backup ? getActiveBackupPage(backup) : undefined;

    if (activeBackupPage) {
      return [activeBackupPage];
    }

    const pages: OledPage[] = [
      {
        id: "home",
        title: "StudyBox",
        lines: meeting.waitingRoom[0]
          ? ["WAITING ROOM", meeting.waitingRoom[0].displayName, "ACTION: Admit"]
          : meeting.lobbyRequests[0]
          ? ["LOBBY", meeting.lobbyRequests[0].displayName, "OPENING ZOOM"]
          : meeting.raisedHands[0]
          ? ["HAND RAISED", meeting.raisedHands[0].displayName, "ACTION: Allow"]
          : meeting.activeSpeaker
            ? [`${meeting.activeSpeaker.displayName} LIVE`, "Remote speaker", "ACTION: Mute"]
            : meeting.status === "live" && (podcast.status === "recording" || podcast.status === "paused" || podcast.status === "waitingForAudio")
              ? ["LIVE + RECORDING", `${meeting.participants.length} Participants`, "Use Finish Rec"]
            : meeting.status === "live"
              ? ["MEETING LIVE", `${meeting.participants.length} Participants`, "Awaiting recording"]
            : podcast.status === "recording" || podcast.status === "paused" || podcast.status === "waitingForAudio"
              ? ["RECORDING", formatDuration(podcast.elapsedSeconds), "Use Finish Rec"]
            : podcast.audioReady !== true
              ? ["AUDIO NOT READY", "Connect DJI Mic", "Meeting locked"]
            : ["READY", "Next Meeting", "Saturday 11:00"],
        actionLabel: meeting.waitingRoom[0] ? "Admit Participant" : meeting.raisedHands[0] ? "Allow to Speak" : meeting.activeSpeaker ? "Mute Speaker" : undefined
      },
      {
        id: "meeting",
        title: meeting.status === "live" ? "Meeting Live" : "Meeting",
        lines: meeting.status !== "live" && podcast.audioReady !== true
          ? ["MIC NOT READY", "Connect DJI Mic", "Then start meeting"]
          : [`${meeting.participants.length} Participants`, `Lobby: ${meeting.lobbyRequests.length}`, `Waiting: ${meeting.waitingRoom.length}`],
        actionLabel: meeting.status === "live" ? "End Meeting" : podcast.audioReady !== true ? "Mic Not Ready" : "Start Meeting"
      },
      {
        id: "podcast",
        title: "Podcast",
        lines: podcast.audioReady !== true && podcast.status === "idle"
          ? ["AUDIO NOT READY", "Press to connect", "Recording will retry"]
          : podcast.status === "waitingForAudio"
          ? ["WAITING FOR AUDIO", "Connect DJI Mic"]
          : podcast.status === "error" && podcast.activeRecording
          ? ["AUDIO ERROR", "Partial audio saved"]
          : [podcast.status.toUpperCase(), formatDuration(podcast.elapsedSeconds)],
        actionLabel: podcast.audioReady !== true && podcast.status === "idle" ? "Connect Audio" : podcast.status === "recording" ? "Pause Recording" : podcast.status === "paused" ? "Resume Recording" : podcast.status === "waitingForAudio" ? "Finish Recording" : podcast.status === "error" && podcast.activeRecording ? "Save Partial Recording" : podcast.status === "error" ? "Retry Recording" : "Start Recording"
      }
    ];

    if (podcast.status === "recording" || podcast.status === "paused" || podcast.status === "error" && podcast.activeRecording) {
      pages.push({
        id: "recordingStop",
        title: "Finish Rec",
        lines: [podcast.status === "error" ? "PARTIAL AUDIO" : podcast.status.toUpperCase(), formatDuration(podcast.elapsedSeconds), "Save recording"],
        actionLabel: podcast.status === "error" ? "Save Partial" : "Finish Recording"
      });
    }

    pages.push(
      {
        id: "system",
        title: "System",
        lines: [
          `CPU ${metrics.cpuPercent}%`,
          `Disk ${metrics.ssdPercent}%`,
          `WiFi ${metrics.wifiConnected ? "OK" : "OFF"}`,
          `Temp ${metrics.temperatureC}C`
        ]
      }
    );

    return pages;
  }

  getCurrentPage(): OledPage {
    return this.getPages()[this.pageIndex] ?? this.getPages()[0];
  }

  async showPage(pageId: OledPageId): Promise<OledPage> {
    const pageIndex = this.getPages().findIndex((page) => page.id === pageId);
    if (pageIndex >= 0) {
      this.pageIndex = pageIndex;
    }
    const page = this.getCurrentPage();
    await this.render(page);
    return page;
  }

  async nextPage(): Promise<OledPage> {
    this.pageIndex = (this.pageIndex + 1) % this.getPages().length;
    const page = this.getCurrentPage();
    await this.render(page);
    return page;
  }

  async render(page: OledPage): Promise<void> {
    this.renderedPage = page;
  }

  getRenderedPage(): OledPage | undefined {
    return this.renderedPage;
  }
}

function getActiveBackupPage(backup: BackupSyncState): OledPage | undefined {
  const activeBundle = backup.bundles.find((bundle) =>
    bundle.id === backup.activeBundleId
    && (bundle.status === "zipping" || bundle.status === "uploading" || bundle.status === "promoting")
  ) ?? backup.bundles.find((bundle) => bundle.status === "zipping" || bundle.status === "uploading" || bundle.status === "promoting");
  if (activeBundle) {
    const percent = Math.round(activeBundle.progressPercent ?? backup.activeProgressPercent ?? 0);
    const title = activeBundle.status === "zipping" ? "Zipping Mtg" : activeBundle.status === "promoting" ? "Finishing Up" : "Uploading";
    return {
      id: "system",
      title,
      lines: [
        activeBundle.recordingTitle,
        `${percent}% COMPLETE`,
        activeBundle.stage ?? "Please wait"
      ]
    };
  }

  const latestUploaded = backup.bundles.find((bundle) => bundle.status === "uploaded" && bundle.uploadedAt);
  const uploadedAt = latestUploaded?.uploadedAt;
  if (latestUploaded && uploadedAt && Date.now() - Date.parse(uploadedAt) < 10 * 1000) {
    return {
      id: "system",
      title: "Upload Done",
      lines: [
        latestUploaded.recordingTitle,
        "HETZNER BACKUP",
        "COMPLETED"
      ]
    };
  }

  return undefined;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${remainingSeconds}`;
}
