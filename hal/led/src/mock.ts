import type { LedColor, LedController, RecLedState, RecorderButtonState, ZoomButtonState, ZoomLedState } from "@studybox/shared";

export class MockLedController implements LedController {
  systemColor: LedColor = "white";
  recordingState: RecLedState = "off";
  zoomConnectionState: ZoomLedState = "off";

  async setSystem(color: LedColor): Promise<void> {
    this.systemColor = color;
  }

  async setRecording(state: RecLedState): Promise<void> {
    this.recordingState = state;
  }

  async setZoomConnection(state: ZoomLedState): Promise<void> {
    this.zoomConnectionState = state;
  }

  async setRecorderState(state: RecorderButtonState): Promise<void> {
    this.recordingState = state === "recording" ? "solid" : state === "paused" || state === "error" ? "blinking" : "off";
  }

  async setZoomState(state: ZoomButtonState): Promise<void> {
    this.zoomConnectionState = state === "live" ? "solid" : state === "ready" || state === "attention" ? "slowBlink" : state === "error" ? "fastBlink" : "off";
  }
}
