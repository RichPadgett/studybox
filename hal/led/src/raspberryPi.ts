import { spawn, type ChildProcess } from "node:child_process";
import type { LedColor, LedController, RecLedState, RecorderButtonState, ZoomButtonState, ZoomLedState } from "@studybox/shared";

export class RaspberryPiLedController implements LedController {
  systemColor: LedColor = "white";
  recordingState: RecLedState = "off";
  zoomConnectionState: ZoomLedState = "off";
  private readonly gpioChip = process.env.STUDYBOX_GPIO_CHIP ?? "gpiochip4";
  private readonly recordingButton = new RgbButtonOutput(this.gpioChip, "REC");
  private readonly zoomButton = new RgbButtonOutput(this.gpioChip, "ZOOM");

  constructor() {
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

  async setSystem(color: LedColor): Promise<void> {
    this.systemColor = color;
  }

  async setRecording(state: RecLedState): Promise<void> {
    this.recordingState = state;
    await this.setRecorderState(state === "solid" ? "recording" : state === "blinking" ? "paused" : "unavailable");
  }

  async setZoomConnection(state: ZoomLedState): Promise<void> {
    this.zoomConnectionState = state;
    await this.setZoomState(state === "solid" ? "live" : state === "slowBlink" ? "ready" : state === "fastBlink" ? "error" : "unavailable");
  }

  async setRecorderState(state: RecorderButtonState): Promise<void> {
    if (state === "ready") this.recordingButton.set("green", "breathe");
    else if (state === "recording") this.recordingButton.set("red", "solid");
    else if (state === "paused") this.recordingButton.set("red", "slowBlink");
    else if (state === "error") this.recordingButton.set("red", "fastBlink");
    else this.recordingButton.set("off", "solid");
  }

  async setZoomState(state: ZoomButtonState): Promise<void> {
    // Ready means the meeting is idle but Zoom can be started. Keep this
    // visibly distinct from a live meeting while matching the appliance
    // behavior: blinking blue after a meeting ends.
    if (state === "ready") this.zoomButton.set("blue", "slowBlink");
    else if (state === "live") this.zoomButton.set("blue", "solid");
    else if (state === "attention") this.zoomButton.set("yellow", "pulse");
    else if (state === "error") this.zoomButton.set("orange", "fastBlink");
    else this.zoomButton.set("off", "solid");
  }

  close(): void {
    this.recordingButton.close();
    this.zoomButton.close();
  }
}

type RgbColor = "red" | "green" | "blue" | "yellow" | "orange" | "off";
type RgbPattern = "solid" | "breathe" | "pulse" | "slowBlink" | "fastBlink";

class RgbButtonOutput {
  private readonly red: GpioLedOutput;
  private readonly green: GpioLedOutput;
  private readonly blue: GpioLedOutput;

  constructor(private readonly gpioChip: string, private readonly name: string) {
    const prefix = name === "REC" ? "STUDYBOX_REC_RGB" : "STUDYBOX_ZOOM_RGB";
    const activeLow = process.env.STUDYBOX_RGB_ACTIVE_LOW !== "false";
    this.red = new GpioLedOutput(gpioChip, Number(process.env[`${prefix}_R_GPIO`] ?? (name === "REC" ? 12 : 19)), activeLow);
    this.green = new GpioLedOutput(gpioChip, Number(process.env[`${prefix}_G_GPIO`] ?? (name === "REC" ? 13 : 20)), activeLow);
    this.blue = new GpioLedOutput(gpioChip, Number(process.env[`${prefix}_B_GPIO`] ?? (name === "REC" ? 16 : 21)), activeLow);
  }

  set(color: RgbColor, pattern: RgbPattern): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const interval = pattern === "fastBlink" ? 250 : pattern === "slowBlink" ? 1000 : pattern === "pulse" ? 650 : 1400;
    const apply = (on: boolean) => {
      this.red.setSolid(on && (color === "red" || color === "yellow" || color === "orange"));
      this.green.setSolid(on && (color === "green" || color === "yellow" || color === "orange"));
      this.blue.setSolid(on && (color === "blue"));
    };
    if (pattern === "solid") {
      apply(true);
      return;
    }
    let on = true;
    const timer = setInterval(() => { on = !on; apply(on); }, interval);
    timer.unref();
    apply(true);
    this.timer = timer;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.red.close(); this.green.close(); this.blue.close();
  }

  private timer?: NodeJS.Timeout;
}

class GpioLedOutput {
  private holder?: ChildProcess;
  private blinkTimer?: NodeJS.Timeout;
  private blinkOn = false;

  constructor(
    private readonly gpioChip: string,
    private readonly gpio: number,
    private readonly activeLow: boolean
  ) {}

  setSolid(on: boolean): void {
    this.clearBlinking();
    this.setLed(on);
  }

  setBlinking(intervalMs: number): void {
    this.clearBlinking();
    this.blinkOn = false;
    this.blinkTimer = setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.setLed(this.blinkOn);
    }, intervalMs);
    this.blinkTimer.unref();
    this.setLed(true);
  }

  stopBlinking(): void {
    this.clearBlinking();
  }

  close(): void {
    this.clearBlinking();
    this.setLed(false);
    this.release();
  }

  private clearBlinking(): void {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = undefined;
    }
  }

  private setLed(on: boolean): void {
    const value = on === !this.activeLow ? 1 : 0;
    this.release();
    this.holder = spawn("gpioset", ["--mode=signal", this.gpioChip, `${this.gpio}=${value}`], {
      stdio: "ignore"
    });
    this.holder.once("error", (error) => {
      console.error(`StudyBox LED GPIO ${this.gpio} failed: ${error.message}`);
      this.holder = undefined;
    });
  }

  private release(): void {
    if (this.holder && !this.holder.killed && this.holder.exitCode === null && this.holder.signalCode === null) {
      this.holder.kill("SIGTERM");
    }
    this.holder = undefined;
  }
}
