import type { OledDisplay, OledPage } from "@studybox/shared";

export class RaspberryPiOledDisplay implements OledDisplay {
  getPages(): OledPage[] {
    throw new Error("Raspberry Pi OLED implementation is not available yet.");
  }

  getCurrentPage(): OledPage {
    throw new Error("Raspberry Pi OLED implementation is not available yet.");
  }

  async nextPage(): Promise<OledPage> {
    throw new Error("Raspberry Pi OLED implementation is not available yet.");
  }

  async render(_page: OledPage): Promise<void> {
    throw new Error("Raspberry Pi OLED implementation is not available yet.");
  }
}
