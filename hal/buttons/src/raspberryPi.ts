import { spawn, type ChildProcess } from "node:child_process";
import type { ButtonController } from "@studybox/shared";

export class RaspberryPiButtonController implements ButtonController {
  private readonly gpioChip = process.env.STUDYBOX_GPIO_CHIP ?? "gpiochip4";
  private readonly pageGpio = String(Number(process.env.STUDYBOX_PAGE_BUTTON_GPIO ?? 17));
  private readonly zoomGpio = String(Number(process.env.STUDYBOX_ZOOM_BUTTON_GPIO ?? 6));
  private readonly recordingGpio = String(Number(process.env.STUDYBOX_RECORDING_BUTTON_GPIO ?? 5));
  private readonly debounceMs = process.env.STUDYBOX_BUTTON_DEBOUNCE_MS ? Number(process.env.STUDYBOX_BUTTON_DEBOUNCE_MS) : 250;
  private readonly longPressMs = process.env.STUDYBOX_BUTTON_LONG_PRESS_MS ? Number(process.env.STUDYBOX_BUTTON_LONG_PRESS_MS) : 2200;
  private readonly setupChordMs = process.env.STUDYBOX_WIFI_SETUP_CHORD_MS ? Number(process.env.STUDYBOX_WIFI_SETUP_CHORD_MS) : 5000;
  private readonly bias = process.env.STUDYBOX_BUTTON_BIAS ?? "pull-up";
  private monitor?: ChildProcess;
  private lastPressedAt = new Map<string, number>();
  private pressedAt = new Map<string, number>();
  private longPressTimers = new Map<string, NodeJS.Timeout>();
  private longPressTriggered = new Set<string>();
  private pageRunning = false;
  private zoomRunning = false;
  private recordingRunning = false;
  private setupChordTimer?: NodeJS.Timeout;
  private setupTriggered = false;

  constructor(
    private readonly onPage: () => Promise<void>,
    private readonly onZoom: (longPress: boolean) => Promise<void>,
    private readonly onRecording: (longPress: boolean) => Promise<void>,
    private readonly onSetup: () => Promise<void>
  ) {
    this.startMonitoring();
    process.once("exit", () => this.close());
    process.once("SIGINT", () => {
      this.close();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      this.close();
      process.exit(143);
    });
  }

  async pressPage(): Promise<void> {
    await this.invokePage();
  }

  async pressAction(): Promise<void> {
    await this.invokeRecording(false);
  }

  async pressZoom(): Promise<void> {
    await this.invokeZoom(false);
  }

  async pressRecording(): Promise<void> {
    await this.invokeRecording(false);
  }

  close(): void {
    if (this.monitor && !this.monitor.killed && this.monitor.exitCode === null && this.monitor.signalCode === null) {
      this.monitor.kill("SIGTERM");
    }
    this.monitor = undefined;
    if (this.setupChordTimer) clearTimeout(this.setupChordTimer);
    for (const timer of this.longPressTimers.values()) clearTimeout(timer);
    this.longPressTimers.clear();
  }

  private startMonitoring(): void {
    const monitor = spawn(
      "gpiomon",
      ["--line-buffered", "--falling-edge", "--rising-edge", `--bias=${this.bias}`, "--format=%o %e", this.gpioChip, this.pageGpio, this.zoomGpio, this.recordingGpio],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.monitor = monitor;

    monitor.once("error", (error) => {
      console.error(`StudyBox button monitor failed: ${error.message}`);
      if (this.monitor === monitor) {
        this.monitor = undefined;
      }
    });

    monitor.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        this.handleEvent(line.trim());
      }
    });

    monitor.on("exit", () => {
      if (this.monitor === monitor) {
        this.monitor = undefined;
      }
    });
  }

  private handleEvent(line: string): void {
    if (!line) {
      return;
    }

    const [gpio, event] = line.split(/\s+/);
    // libgpiod can emit numeric event codes with %e: 0 is falling, 1 is rising.
    const normalizedEvent = event?.toLowerCase() ?? "";
    const isPress = normalizedEvent === "0" || normalizedEvent.includes("falling");
    if (gpio === this.pageGpio) {
      if (isPress && this.shouldAcceptPress(gpio)) void this.invokePage().catch((error: unknown) => console.error("StudyBox page button action failed", error));
      return;
    }
    if (isPress) {
      if (this.shouldAcceptPress(gpio)) {
        this.pressedAt.set(gpio, Date.now());
        this.scheduleLongPress(gpio);
      }
      this.updateSetupChord();
      return;
    }
    const startedAt = this.pressedAt.get(gpio);
    const setupWasTriggered = this.setupTriggered;
    const longPressTimer = this.longPressTimers.get(gpio);
    if (longPressTimer) clearTimeout(longPressTimer);
    this.longPressTimers.delete(gpio);
    this.pressedAt.delete(gpio);
    if (this.pressedAt.size === 0) {
      this.setupTriggered = false;
      this.updateSetupChord();
    }
    if (setupWasTriggered) return;
    if (!startedAt || !this.shouldAcceptPress(`${gpio}:release`)) return;
    if (this.longPressTriggered.delete(gpio)) return;
    const longPress = Date.now() - startedAt >= this.longPressMs;
    if (gpio === this.zoomGpio) void this.invokeZoom(longPress).catch((error: unknown) => console.error("StudyBox Zoom button action failed", error));
    if (gpio === this.recordingGpio) void this.invokeRecording(longPress).catch((error: unknown) => console.error("StudyBox recording button action failed", error));
  }

  private scheduleLongPress(gpio: string): void {
    if (gpio !== this.zoomGpio && gpio !== this.recordingGpio) return;
    const timer = setTimeout(() => {
      this.longPressTimers.delete(gpio);
      // Holding all three buttons is reserved for Wi-Fi setup mode.
      if (!this.pressedAt.has(gpio) || this.pressedAt.has(this.pageGpio) || this.setupTriggered) return;
      this.longPressTriggered.add(gpio);
      if (gpio === this.zoomGpio) void this.invokeZoom(true).catch((error: unknown) => console.error("StudyBox Zoom long-press action failed", error));
      if (gpio === this.recordingGpio) void this.invokeRecording(true).catch((error: unknown) => console.error("StudyBox recording long-press action failed", error));
    }, this.longPressMs);
    timer.unref();
    this.longPressTimers.set(gpio, timer);
  }

  private updateSetupChord(): void {
    const chordHeld = [this.pageGpio, this.zoomGpio, this.recordingGpio].every((gpio) => this.pressedAt.has(gpio));
    if (!chordHeld) {
      if (this.setupChordTimer) clearTimeout(this.setupChordTimer);
      this.setupChordTimer = undefined;
      this.setupTriggered = false;
      return;
    }
    if (this.setupChordTimer || this.setupTriggered) return;
    this.setupChordTimer = setTimeout(() => {
      this.setupChordTimer = undefined;
      if (!this.setupTriggered && [this.pageGpio, this.zoomGpio, this.recordingGpio].every((gpio) => this.pressedAt.has(gpio))) {
        this.setupTriggered = true;
        void this.onSetup().catch((error: unknown) => console.error(`StudyBox Wi-Fi setup chord failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    }, this.setupChordMs);
  }

  private shouldAcceptPress(gpio: string): boolean {
    const now = Date.now();
    const last = this.lastPressedAt.get(gpio) ?? 0;
    if (now - last < this.debounceMs) {
      return false;
    }

    this.lastPressedAt.set(gpio, now);
    return true;
  }

  private async invokePage(): Promise<void> {
    if (this.pageRunning) {
      return;
    }

    this.pageRunning = true;
    try {
      await this.onPage();
    } finally {
      this.pageRunning = false;
    }
  }

  private async invokeZoom(longPress: boolean): Promise<void> {
    if (this.zoomRunning) {
      return;
    }

    this.zoomRunning = true;
    try {
      await this.onZoom(longPress);
    } finally {
      this.zoomRunning = false;
    }
  }

  private async invokeRecording(longPress: boolean): Promise<void> {
    if (this.recordingRunning) {
      return;
    }

    this.recordingRunning = true;
    try {
      await this.onRecording(longPress);
    } finally {
      this.recordingRunning = false;
    }
  }
}
