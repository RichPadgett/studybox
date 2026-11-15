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
    // These buttons only show pure red, green or blue reliably: any mix that
    // includes red (yellow, purple, white) shows as red, and cyan looks green
    // (tested 2026-11-15). So paused is a slow red blink, not yellow.
    if (state === "ready") this.recordingButton.set("green", "solid");
    else if (state === "recording") this.recordingButton.set("red", "solid");
    else if (state === "paused") this.recordingButton.set("red", "slowBlink");
    else if (state === "error") this.recordingButton.set("red", "fastBlink");
    else this.recordingButton.set("off", "solid");
  }

  async setZoomState(state: ZoomButtonState): Promise<void> {
    // Pure red/green/blue only (see setRecorderState). Ready is a slow blue
    // blink so it differs from the green Record button and from solid blue (live).
    if (state === "ready") this.zoomButton.set("blue", "slowBlink");
    else if (state === "live") this.zoomButton.set("blue", "solid");
    else if (state === "attention") this.zoomButton.set("green", "pulse");
    else if (state === "error") this.zoomButton.set("red", "fastBlink");
    else this.zoomButton.set("off", "solid");
  }

  /**
   * Wi-Fi setup indicator on both buttons: alternating blue/green, a pattern no
   * other state uses (purple would show as red on this hardware). Slow while
   * waiting for a phone, fast while connecting.
   */
  async setWifiSetup(mode: "waiting" | "connecting" | "off"): Promise<void> {
    if (mode === "off") return;
    const pattern = mode === "connecting" ? "fastBlink" : "slowBlink";
    this.zoomButton.set("blue", pattern, "green");
    this.recordingButton.set("green", pattern, "blue");
  }

  close(): void {
    this.recordingButton.close();
    this.zoomButton.close();
  }
}

type RgbColor = "red" | "green" | "blue" | "yellow" | "orange" | "purple" | "cyan" | "white" | "off";
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

  /** With `alternate`, blinking switches between the two colors instead of on/off. */
  set(color: RgbColor, pattern: RgbPattern, alternate?: RgbColor): void {
    // Re-applying the same look would restart its blink mid-cycle; skip it.
    if (this.current === `${color}:${pattern}:${alternate ?? ""}`) return;
    this.current = `${color}:${pattern}:${alternate ?? ""}`;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const interval = pattern === "fastBlink" ? 250 : pattern === "slowBlink" ? 1000 : pattern === "pulse" ? 650 : 1400;
    const show = (shown: RgbColor) => {
      this.red.setSolid(shown === "red" || shown === "yellow" || shown === "orange" || shown === "purple" || shown === "white");
      this.green.setSolid(shown === "green" || shown === "yellow" || shown === "orange" || shown === "cyan" || shown === "white");
      this.blue.setSolid(shown === "blue" || shown === "purple" || shown === "cyan" || shown === "white");
    };
    const apply = (on: boolean) => show(on ? color : alternate ?? "off");
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
  private current?: string;
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
