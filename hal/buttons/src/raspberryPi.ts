import type { ButtonController } from "@studybox/shared";

export class RaspberryPiButtonController implements ButtonController {
  async pressPage(): Promise<void> {
    throw new Error("Raspberry Pi button implementation is not available yet.");
  }

  async pressAction(): Promise<void> {
    throw new Error("Raspberry Pi button implementation is not available yet.");
  }
}
