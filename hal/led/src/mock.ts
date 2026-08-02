import type { LedColor, LedController, RecLedState } from "@studybox/shared";

export class MockLedController implements LedController {
  systemColor: LedColor = "white";
  recordingState: RecLedState = "off";

  async setSystem(color: LedColor): Promise<void> {
    this.systemColor = color;
  }

  async setRecording(state: RecLedState): Promise<void> {
    this.recordingState = state;
  }
}
