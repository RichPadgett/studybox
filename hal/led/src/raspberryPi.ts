import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    if (state === "ready") this.recordingButton.set("dimGreen", "solid");
    else if (state === "recording") this.recordingButton.set("red", "solid");
    else if (state === "paused") this.recordingButton.set("yellow", "solid");
    else if (state === "error") this.recordingButton.set("red", "fastBlink");
    else this.recordingButton.set("off", "solid");
  }

  async setZoomState(state: ZoomButtonState): Promise<void> {
    // Not live (ready to start) is a dim white glow: distinct from the dim green
    // Record button beside it and from the bright blue of a live meeting.
    if (state === "ready") this.zoomButton.set("dimWhite", "solid");
    else if (state === "live") this.zoomButton.set("blue", "solid");
    else if (state === "attention") this.zoomButton.set("yellow", "pulse");
    else if (state === "error") this.zoomButton.set("red", "fastBlink");
    else this.zoomButton.set("off", "solid");
  }

  /** Both buttons pink while Wi-Fi setup runs: slow blink waiting for a phone, fast blink while connecting. */
  async setWifiSetup(mode: "searching" | "waiting" | "connecting" | "off"): Promise<void> {
    if (mode === "off") return;
    if (mode === "searching") {
      // Startup: both buttons fade in and out in purple while saved networks are tried.
      this.zoomButton.set("purple", "fade");
      this.recordingButton.set("purple", "fade");
      return;
    }
    const pattern = mode === "connecting" ? "fastBlink" : "slowBlink";
    this.zoomButton.set("pink", pattern);
    this.recordingButton.set("pink", pattern);
  }

  /** Wi-Fi joined after setup: three purple blinks on both buttons. */
  async flashWifiConnected(): Promise<void> {
    this.zoomButton.set("purple", "flash3");
    this.recordingButton.set("purple", "flash3");
  }

  close(): void {
    this.recordingButton.close();
    this.zoomButton.close();
  }
}

type RgbColor = "red" | "green" | "blue" | "yellow" | "orange" | "purple" | "pink" | "cyan" | "white" | "dimWhite" | "dimGreen" | "off";

/**
 * Brightness (0-100) of red, green and blue for each color. These buttons are
 * 6V common-anode RGB LEDs run from 3.3V, where red is far brighter than green
 * and blue, so mixes dim red to balance. Tuned by eye on the StudyBox 2026-11-15.
 */
const COLOR_LEVELS: Record<RgbColor, [number, number, number]> = {
  off: [0, 0, 0],
  red: [100, 0, 0],
  green: [0, 100, 0],
  blue: [0, 0, 100],
  white: [25, 70, 100],
  // Idle "ready" glows: quiet next to the bright live/recording colors.
  dimWhite: [6, 17, 25],
  dimGreen: [0, 12, 0],
  purple: [12, 0, 100],
  pink: [25, 0, 100],
  yellow: [35, 60, 0],
  orange: [70, 15, 0],
  cyan: [0, 60, 100]
};

/**
 * One long-running scripts/studybox-led-pwm.py process dims all six color pins
 * (software PWM via lgpio). If it cannot start (python3-lgpio missing), the
 * buttons fall back to plain on/off pins, where only red, green and blue look right.
 */
class PwmLedHelper {
  private process?: ChildProcess;
  private failed = false;

  constructor() {
    const script = process.env.STUDYBOX_LED_PWM_SCRIPT ?? fileURLToPath(new URL("../../../scripts/studybox-led-pwm.py", import.meta.url));
    if (process.env.STUDYBOX_LED_PWM === "false" || !existsSync(script)) {
      this.failed = true;
      return;
    }
    const child = spawn("python3", [script], { stdio: ["pipe", "ignore", "pipe"] });
    this.process = child;
    child.stderr?.on("data", (chunk: Buffer) => console.error(`StudyBox LED dimmer: ${chunk.toString("utf8").trim()}`));
    child.once("error", (error) => { console.error(`StudyBox LED dimmer failed to start: ${error.message}`); this.failed = true; });
    child.once("exit", (code) => { if (code !== 0) console.error(`StudyBox LED dimmer exited (${code ?? "signal"}); using plain on/off colors`); this.failed = true; this.process = undefined; });
  }

  get available(): boolean {
    return !this.failed && Boolean(this.process?.stdin?.writable);
  }

  send(button: "rec" | "zoom", color: RgbColor, pattern: RgbPattern, alternate?: RgbColor): boolean {
    if (!this.available) return false;
    this.process!.stdin!.write(JSON.stringify({ button, color: COLOR_LEVELS[color], pattern, alt: COLOR_LEVELS[alternate ?? "off"] }) + "\n");
    return true;
  }

  close(): void {
    this.process?.stdin?.end();
    this.process = undefined;
  }
}

let sharedPwmHelper: PwmLedHelper | undefined;
type RgbPattern = "solid" | "breathe" | "pulse" | "slowBlink" | "fastBlink" | "flash3" | "fade";

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
    sharedPwmHelper ??= new PwmLedHelper();
    if (sharedPwmHelper.send(this.name === "REC" ? "rec" : "zoom", color, pattern, alternate)) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const interval = pattern === "fastBlink" ? 250 : pattern === "slowBlink" ? 1000 : pattern === "pulse" ? 650 : pattern === "flash3" ? 300 : pattern === "fade" ? 1500 : 1400;
    const show = (shown: RgbColor) => {
      const [red, green, blue] = COLOR_LEVELS[shown];
      this.red.setSolid(red > 0);
      this.green.setSolid(green > 0);
      this.blue.setSolid(blue > 0);
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
    sharedPwmHelper?.close();
    sharedPwmHelper = undefined;
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
