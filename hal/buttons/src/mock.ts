import type { ButtonController } from "@studybox/shared";

export class MockButtonController implements ButtonController {
  constructor(
    private readonly onPage: () => Promise<void>,
    private readonly onAction: () => Promise<void>
  ) {}

  async pressPage(): Promise<void> {
    await this.onPage();
  }

  async pressAction(): Promise<void> {
    await this.onAction();
  }
}
