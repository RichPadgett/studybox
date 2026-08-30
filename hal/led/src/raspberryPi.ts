import { spawn, type ChildProcess } from "node:child_process";
import type { LedColor, LedController, RecLedState, ZoomLedState } from "@studybox/shared";

export class RaspberryPiLedController implements LedController {
  systemColor: LedColor = "white";
  recordingState: RecLedState = "off";
  zoomConnectionState: ZoomLedState = "off";
  private readonly gpioChip = process.env.STUDYBOX_GPIO_CHIP ?? "gpiochip4";
  private readonly recordingLed = new GpioLedOutput(
    this.gpioChip,
    Number(process.env.STUDYBOX_REC_LED_GPIO ?? 23),
    process.env.STUDYBOX_REC_LED_ACTIVE_LOW === "true"
  );
  private readonly zoomLed = new GpioLedOutput(
    this.gpioChip,
    Number(process.env.STUDYBOX_ZOOM_LED_GPIO ?? 24),
    process.env.STUDYBOX_ZOOM_LED_ACTIVE_LOW === "true"
  );

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

    if (state === "solid") {
      this.recordingLed.setSolid(true);
      return;
    }

    if (state === "blinking") {
      this.recordingLed.setBlinking(500);
      return;
    }

    this.recordingLed.setSolid(false);
  }

  async setZoomConnection(state: ZoomLedState): Promise<void> {
    this.zoomConnectionState = state;

    if (state === "solid") {
      this.zoomLed.setSolid(true);
      return;
    }

    if (state === "slowBlink") {
      this.zoomLed.setBlinking(1000);
      return;
    }

    if (state === "fastBlink") {
      this.zoomLed.setBlinking(250);
      return;
    }

    this.zoomLed.setSolid(false);
  }

  close(): void {
    this.recordingLed.close();
    this.zoomLed.close();
  }
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
    this.stopBlinking();
    this.setLed(on);
  }

  setBlinking(intervalMs: number): void {
    this.stopBlinking();
    this.blinkOn = false;
    this.blinkTimer = setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.setLed(this.blinkOn);
    }, intervalMs);
    this.blinkTimer.unref();
    this.setLed(true);
  }

  close(): void {
    this.stopBlinking();
    this.setLed(false);
    this.release();
  }

  private stopBlinking(): void {
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
  }

  private release(): void {
    if (this.holder && !this.holder.killed && this.holder.exitCode === null && this.holder.signalCode === null) {
      this.holder.kill("SIGTERM");
    }
    this.holder = undefined;
  }
}
