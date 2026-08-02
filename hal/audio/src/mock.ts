import type { AudioDevice } from "@studybox/shared";

export class MockAudioDevice implements AudioDevice {
  async getInputDevices(): Promise<string[]> {
    return ["DJI Mic Receiver (Mock)", "USB Audio Interface (Mock)"];
  }

  async getLevel(): Promise<number> {
    return Math.round(35 + Math.random() * 45);
  }
}
