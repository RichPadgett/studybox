import { spawn, type ChildProcess } from "node:child_process";
import type { ButtonController } from "@studybox/shared";

export class RaspberryPiButtonController implements ButtonController {
  private readonly gpioChip = process.env.STUDYBOX_GPIO_CHIP ?? "gpiochip4";
  private readonly pageGpio = String(Number(process.env.STUDYBOX_PAGE_BUTTON_GPIO ?? 5));
  private readonly actionGpio = String(Number(process.env.STUDYBOX_ACTION_BUTTON_GPIO ?? 6));
  private readonly debounceMs = process.env.STUDYBOX_BUTTON_DEBOUNCE_MS ? Number(process.env.STUDYBOX_BUTTON_DEBOUNCE_MS) : 250;
  private readonly edge = process.env.STUDYBOX_BUTTON_EDGE === "rising" ? "rising" : "falling";
  private readonly bias = process.env.STUDYBOX_BUTTON_BIAS ?? "pull-up";
  private monitor?: ChildProcess;
  private lastPressedAt = new Map<string, number>();
  private actionRunning = false;
  private pageRunning = false;

  constructor(
    private readonly onPage: () => Promise<void>,
    private readonly onAction: () => Promise<void>
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
    await this.invokeAction();
  }

  close(): void {
    if (this.monitor && !this.monitor.killed && this.monitor.exitCode === null && this.monitor.signalCode === null) {
      this.monitor.kill("SIGTERM");
    }
    this.monitor = undefined;
  }

  private startMonitoring(): void {
    const edgeFlag = this.edge === "rising" ? "--rising-edge" : "--falling-edge";
    const monitor = spawn(
      "gpiomon",
      ["--line-buffered", edgeFlag, `--bias=${this.bias}`, "--format=%o %e", this.gpioChip, this.pageGpio, this.actionGpio],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.monitor = monitor;

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

    const [gpio] = line.split(/\s+/);
    if (!this.shouldAcceptPress(gpio)) {
      return;
    }

    if (gpio === this.pageGpio) {
      void this.invokePage();
    } else if (gpio === this.actionGpio) {
      void this.invokeAction();
    }
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

  private async invokeAction(): Promise<void> {
    if (this.actionRunning) {
      return;
    }

    this.actionRunning = true;
    try {
      await this.onAction();
    } finally {
      this.actionRunning = false;
    }
  }
}
