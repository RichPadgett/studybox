import type { ButtonController } from "@studybox/shared";

export class MockButtonController implements ButtonController {
  constructor(
    private readonly onPage: () => Promise<void>,
    private readonly onZoom: (longPress: boolean) => Promise<void>,
    private readonly onRecording: (longPress: boolean) => Promise<void>
  ) {}

  async pressPage(): Promise<void> {
    await this.onPage();
  }

  async pressAction(): Promise<void> {
    await this.onRecording(false);
  }

  async pressZoom(): Promise<void> {
    await this.onZoom(false);
  }

  async pressRecording(): Promise<void> {
    await this.onRecording(false);
  }
}
