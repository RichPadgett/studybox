import type { MeetingState, OledDisplay, OledPage, PodcastState, SystemMetrics } from "@studybox/shared";

export class MockOledDisplay implements OledDisplay {
  private pageIndex = 0;
  private renderedPage?: OledPage;

  constructor(
    private readonly getMeeting: () => MeetingState,
    private readonly getPodcast: () => PodcastState,
    private readonly getMetrics: () => SystemMetrics
  ) {}

  getPages(): OledPage[] {
    const meeting = this.getMeeting();
    const podcast = this.getPodcast();
    const metrics = this.getMetrics();

    return [
      {
        id: "home",
        title: "StudyBox",
        lines: ["READY", "Next Meeting", "Saturday 11:00"]
      },
      {
        id: "meeting",
        title: meeting.status === "live" ? "Meeting Live" : "Meeting",
        lines: [`${meeting.participants.length} Participants`, `Waiting: ${meeting.waitingRoom.length}`],
        actionLabel: meeting.status === "live" ? "End Meeting" : "Start Meeting"
      },
      {
        id: "podcast",
        title: "Podcast",
        lines: [podcast.status.toUpperCase(), formatDuration(podcast.elapsedSeconds)],
        actionLabel: podcast.status === "recording" ? "Pause Recording" : podcast.status === "paused" ? "Resume Recording" : "Start Recording"
      },
      {
        id: "system",
        title: "System",
        lines: [
          `CPU ${metrics.cpuPercent}%`,
          `SSD ${metrics.ssdPercent}%`,
          `WiFi ${metrics.wifiConnected ? "OK" : "OFF"}`,
          `Temp ${metrics.temperatureC}C`
        ]
      }
    ];
  }

  getCurrentPage(): OledPage {
    return this.getPages()[this.pageIndex] ?? this.getPages()[0];
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

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${remainingSeconds}`;
}
