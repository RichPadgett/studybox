import type { BackupSyncState, MeetingState, OledDisplay, OledPage, OledPageId, PodcastState, SystemMetrics, WatchdogStatus, ZoomCloudRecordingStatus, ZoomRuntimeStatus } from "@studybox/shared";

export class MockOledDisplay implements OledDisplay {
  private pageIndex = 0;
  private renderedPage?: OledPage;
  private backupOverlaySignature?: string;
  private backupOverlayDismissed = false;
  private cloudOverlaySignature?: string;
  private cloudOverlayDismissed = false;

  constructor(
    private readonly getMeeting: () => MeetingState,
    private readonly getPodcast: () => PodcastState,
    private readonly getMetrics: () => SystemMetrics,
    private readonly getBackup?: () => BackupSyncState,
    private readonly getZoom?: () => ZoomRuntimeStatus,
    private readonly getCloud?: () => ZoomCloudRecordingStatus,
    private readonly getWatchdog?: () => WatchdogStatus
  ) {}

  getPages(): OledPage[] {
    const meeting = this.getMeeting();
    const podcast = this.getPodcast();
    const metrics = this.getMetrics();
    const backup = this.getBackup?.();
    const zoom = this.getZoom?.();
    const cloud = this.getCloud?.();
    const watchdog = this.getWatchdog?.() ?? { live: true, issues: [] };
    const activeBackupPage = backup ? getActiveBackupPage(backup) : undefined;
    const overlaySignature = activeBackupPage ? JSON.stringify(activeBackupPage) : undefined;
    if (overlaySignature !== this.backupOverlaySignature) {
      this.backupOverlaySignature = overlaySignature;
      this.backupOverlayDismissed = false;
    }

    if (activeBackupPage && !this.backupOverlayDismissed) {
      return [activeBackupPage];
    }

    const cloudPage = cloud ? getCloudPage(cloud) : undefined;
    const cloudSignature = cloudPage ? JSON.stringify(cloudPage) : undefined;
    if (cloudSignature !== this.cloudOverlaySignature) {
      this.cloudOverlaySignature = cloudSignature;
      this.cloudOverlayDismissed = false;
    }
    if (cloudPage && !this.cloudOverlayDismissed) return [cloudPage];

    if (!metrics.wifiConnected) {
      return [{
        id: "wifiSetup",
        title: "WIFI SETUP",
        lines: [
          `SSID ${process.env.STUDYBOX_SETUP_SSID ?? "StudyBox-Setup"}`,
          `PASS ${process.env.STUDYBOX_SETUP_PASSWORD ?? "StudyBoxSetup!26"}`,
          `OPEN ${(process.env.STUDYBOX_SETUP_ADDRESS ?? "10.42.0.1/24").split("/")[0]}:5173`,
          "ADD WIFI NETWORK"
        ]
      }];
    }

    const meetingStatus = formatMeetingStatus(meeting);
    const recordingStatus = formatRecordingStatus(podcast);
    const zoomAuthRequired = Boolean(zoom?.configured && !zoom.oauth.authorized);
    const homeCondition = !metrics.wifiConnected
      ? "WIFI OFF"
      : zoomAuthRequired
      ? "ZOOM AUTH REQUIRED"
      : meeting.status === "error" || podcast.status === "error"
      ? "SYSTEM ATTENTION"
      : "SYSTEM READY";

    const pages: OledPage[] = [
      {
        id: "home",
        title: "Church of the Word",
        lines: ["STUDYBOX", "NEXT MEETING", "SATURDAY 11:00", "", homeCondition]
      },
      {
        id: "meeting",
        title: "Study Status",
        lines: [
          zoomAuthRequired ? "ZOOM AUTH REQUIRED" : meetingStatus,
          recordingStatus,
          podcast.activeRecording ? `TIME ${formatDuration(podcast.elapsedSeconds)}` : podcast.audioReady === true ? "MIC READY" : "MIC NOT READY",
          meeting.screenSharePolicy === "error"
            ? "SHARE SETTING ERROR"
            : meeting.screenSharePolicy === "all-participants"
              ? `SHARE ALL  ${meeting.participants.length} JOINED`
              : `${meeting.participants.length} PARTICIPANTS`
        ]
      }
    ];

    pages.push(
      {
        id: "system",
        title: "Raspberry Pi 5",
        lines: [
          "SYSTEM INFO",
          `CPU ${metrics.cpuPercent}%`,
          `Disk ${metrics.ssdPercent}%`,
          `WiFi ${metrics.wifiConnected ? "OK" : "OFF"}`,
          `Temp ${metrics.temperatureC}C`
        ]
      }
    );

    pages.push({
      id: "system",
      title: "WATCHDOG",
      lines: watchdog.live && watchdog.issues.length === 0
        ? ["SYSTEMS GOOD"]
        : ["SYSTEM ISSUE", ...(watchdog.live ? watchdog.issues.slice(0, 4) : ["WATCHDOG OFF"])]
    });

    return pages;
  }

  getCurrentPage(): OledPage {
    return this.getPages()[this.pageIndex] ?? this.getPages()[0];
  }

  async showWatchdogStatus(): Promise<void> {
    await this.render({ id: "system", title: "WATCHDOG LIVE", lines: ["WATCHDOG", "LIVE"] });
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
    const pages = this.getPages();
    if (pages.length === 1 && pages[0]?.id === "system" && this.backupOverlaySignature) {
      this.backupOverlayDismissed = true;
      this.pageIndex = 0;
    } else if (pages.length === 1 && pages[0]?.id === "system" && this.cloudOverlaySignature) {
      this.cloudOverlayDismissed = true;
      this.pageIndex = 0;
    } else {
      this.pageIndex = (this.pageIndex + 1) % pages.length;
    }
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

function getCloudPage(status: ZoomCloudRecordingStatus): OledPage | undefined {
  if (status.failed > 0 && status.lastError) {
    return { id: "system", title: "CLOUD ERROR", lines: ["ZOOM VIDEO", "ARCHIVE FAILED", status.lastError ?? "RETRY NEEDED", "PRESS PAGE"] };
  }
  if (status.pending > 0 || status.processing > 0) {
    return { id: "system", title: "CLOUD VIDEO", lines: ["ZOOM RECORDING", "PROCESSING", `${status.pending + status.processing} JOB(S)`, "PRESS PAGE"] };
  }
  return undefined;
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

function formatMeetingStatus(meeting: MeetingState): string {
  if (meeting.reconnecting) return `ZOOM REJOINING${meeting.reconnectAttempt ? ` ${meeting.reconnectAttempt}` : ""}`;
  if (meeting.status === "live") return "MEETING LIVE";
  if (meeting.status === "starting") return "MEETING STARTING";
  if (meeting.status === "ending") return "MEETING ENDING";
  if (meeting.status === "error") return "MEETING ERROR";
  return "MEETING READY";
}

function formatRecordingStatus(podcast: PodcastState): string {
  if (podcast.status === "recording") return "RECORDING LIVE";
  if (podcast.status === "paused") return "RECORDING PAUSED";
  if (podcast.status === "waitingForAudio") return "WAITING FOR AUDIO";
  if (podcast.status === "stopping") return "SAVING RECORDING";
  if (podcast.status === "error") return "RECORDING ERROR";
  return podcast.audioReady === true ? "RECORDING READY" : "AUDIO NOT READY";
}
