import type { LedColor, LedController, RecLedState } from "@studybox/shared";

export class RaspberryPiLedController implements LedController {
  async setSystem(_color: LedColor): Promise<void> {
    throw new Error("Raspberry Pi LED implementation is not available yet.");
  }

  async setRecording(_state: RecLedState): Promise<void> {
    throw new Error("Raspberry Pi LED implementation is not available yet.");
  }
}
