import { spawn, type ChildProcess } from "node:child_process";
import type { LedColor, LedController, RecLedState } from "@studybox/shared";

export class RaspberryPiLedController implements LedController {
  systemColor: LedColor = "white";
  recordingState: RecLedState = "off";
  private readonly gpioChip = process.env.STUDYBOX_GPIO_CHIP ?? "gpiochip4";
  private readonly recordingGpio = String(Number(process.env.STUDYBOX_REC_LED_GPIO ?? 23));
  private readonly activeHigh = process.env.STUDYBOX_REC_LED_ACTIVE_LOW !== "true";
  private holder?: ChildProcess;
  private blinkTimer?: NodeJS.Timeout;
  private blinkOn = false;

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
    this.stopBlinking();

    if (state === "solid") {
      this.setLed(true);
      return;
    }

    if (state === "blinking") {
      this.blinkOn = false;
      this.blinkTimer = setInterval(() => {
        this.blinkOn = !this.blinkOn;
        this.setLed(this.blinkOn);
      }, 500);
      this.blinkTimer.unref();
      this.setLed(true);
      return;
    }

    this.setLed(false);
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
    const value = on === this.activeHigh ? 1 : 0;
    this.release();
    this.holder = spawn("gpioset", ["--mode=signal", this.gpioChip, `${this.recordingGpio}=${value}`], {
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
