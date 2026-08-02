import type { AudioDevice } from "@studybox/shared";

export class RaspberryPiAudioDevice implements AudioDevice {
  async getInputDevices(): Promise<string[]> {
    throw new Error("Raspberry Pi audio implementation is not available yet.");
  }

  async getLevel(): Promise<number> {
    throw new Error("Raspberry Pi audio implementation is not available yet.");
  }
}
