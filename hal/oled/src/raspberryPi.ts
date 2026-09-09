import { closeSync, openSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { BackupSyncState, MeetingState, OledDisplay, OledPage, OledPageId, PodcastState, SystemMetrics } from "@studybox/shared";
import { MockOledDisplay } from "./mock.js";

export class RaspberryPiOledDisplay implements OledDisplay {
  private readonly pages: MockOledDisplay;
  private readonly spiDevice = process.env.STUDYBOX_OLED_SPI_DEVICE ?? "/dev/spidev0.0";
  private readonly gpioChip = process.env.STUDYBOX_GPIO_CHIP ?? "gpiochip4";
  private readonly dcGpio = String(Number(process.env.STUDYBOX_OLED_DC_GPIO ?? 25));
  private readonly rstGpio = String(Number(process.env.STUDYBOX_OLED_RST_GPIO ?? 27));
  private readonly fd = openSync(this.spiDevice, "w");
  private initialized = false;
  private dcHolder?: ChildProcess;
  private rstHolder?: ChildProcess;
  private lastRenderedPage?: OledPage;
  private lastRenderedFrameSignature?: string;
  private closed = false;

  constructor(
    getMeeting: () => MeetingState,
    getPodcast: () => PodcastState,
    getMetrics: () => SystemMetrics,
    getBackup?: () => BackupSyncState
  ) {
    this.pages = new MockOledDisplay(getMeeting, getPodcast, getMetrics, getBackup);
    process.once("beforeExit", () => this.close());
    process.once("exit", () => this.close());
    process.once("uncaughtException", (error) => {
      this.close();
      throw error;
    });
    process.once("SIGINT", () => {
      this.close();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      this.close();
      process.exit(143);
    });
  }

  getPages(): OledPage[] {
    return this.pages.getPages();
  }

  getCurrentPage(): OledPage {
    return this.pages.getCurrentPage();
  }

  async showPage(pageId: OledPageId): Promise<OledPage> {
    const page = await this.pages.showPage(pageId);
    await this.render(page);
    return page;
  }

  async nextPage(): Promise<OledPage> {
    const page = await this.pages.nextPage();
    await this.render(page);
    return page;
  }

  async render(page: OledPage): Promise<void> {
    const frame = this.createFrame(page);
    const signature = frameSignature(frame);
    if (signature !== this.lastRenderedFrameSignature) {
      this.renderFrame(frame);
      this.lastRenderedFrameSignature = signature;
    }
    this.lastRenderedPage = page;
  }

  getRenderedPage(): OledPage | undefined {
    return this.lastRenderedPage;
  }

  private init(): void {
    if (this.initialized) return;

    this.reset();

    this.command(
      0xae,
      0xd5, 0x80,
      0xa8, 0x3f,
      0xd3, 0x00,
      0x40,
      0x8d, 0x14,
      0x20, 0x02,
      0xa1,
      0xc8,
      0xda, 0x12,
      0x81, 0xcf,
      0xd9, 0xf1,
      0xdb, 0x40,
      0xa4,
      0xa6,
      0xaf
    );
    this.initialized = true;
  }

  private reset(): void {
    this.setRst(1);
    sleep(50);
    this.setRst(0);
    sleep(150);
    this.setRst(1);
    sleep(150);
  }

  private createFrame(page: OledPage): number[][] {
    const frame = Array.from({ length: 8 }, () => new Array(128).fill(0));
    this.drawTextToFrame(frame, 0, 0, page.title);
    page.lines.slice(0, 5).forEach((line, index) => {
      this.drawTextToFrame(frame, 0, index + 2, line);
    });
    if (page.actionLabel) {
      this.drawTextToFrame(frame, 0, 7, `PUSH ${page.actionLabel}`);
    }
    return frame;
  }

  private drawTextToFrame(frame: number[][], x: number, page: number, text: string): void {
    let cursor = x;
    for (const char of text.toUpperCase().slice(0, 21)) {
      const glyph = font[char] ?? font[" "];
      for (const column of [...glyph, 0x00]) {
        if (cursor >= 128) {
          return;
        }
        frame[page][cursor] = column;
        cursor += 1;
      }
    }
  }

  private renderFrame(frame: number[][]): void {
    const result = spawnSync("python3", ["-c", pythonSsd1309Renderer], {
      input: JSON.stringify({
        spiDevice: this.spiDevice,
        gpioChip: this.gpioChip,
        dcGpio: this.dcGpio,
        rstGpio: this.rstGpio,
        frame
      }),
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `OLED renderer exited with status ${result.status ?? "unknown"}`);
    }
  }

  private clear(): void {
    for (let page = 0; page < 8; page += 1) {
      this.setCursor(0, page);
      this.data(new Array(128).fill(0));
    }
  }

  private setCursor(x: number, page: number): void {
    this.command(0xb0 + page, 0x00 + (x & 0x0f), 0x10 + ((x >> 4) & 0x0f));
  }

  private drawText(x: number, page: number, text: string): void {
    this.setCursor(x, page);
    const output: number[] = [];
    for (const char of text.toUpperCase().slice(0, 21)) {
      const glyph = font[char] ?? font[" "];
      output.push(...glyph, 0x00);
    }
    this.data(output);
  }

  private command(...bytes: number[]): void {
    this.setDc(0);
    this.spiWrite(bytes);
  }

  private data(bytes: number[]): void {
    this.setDc(1);
    this.spiWrite(bytes);
  }

  private spiWrite(bytes: number[]): void {
    writeFileSync(this.fd, Buffer.from(bytes));
  }

  private setDc(value: number): void {
    this.release(this.dcHolder);
    this.dcHolder = this.holdGpio(this.dcGpio, value);
  }

  private setRst(value: number): void {
    this.release(this.rstHolder);
    this.rstHolder = this.holdGpio(this.rstGpio, value);
  }

  private holdGpio(gpio: string, value: number): ChildProcess {
    const child = spawn("gpioset", ["--mode=signal", this.gpioChip, `${gpio}=${value ? 1 : 0}`], {
      stdio: "ignore"
    });
    child.once("error", (error) => {
      console.error(`StudyBox OLED GPIO ${gpio} failed: ${error.message}`);
    });
    sleep(30);
    return child;
  }

  private release(child: ChildProcess | undefined): void {
    if (child && !child.killed && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      sleep(15);
    }
  }

  private releaseAll(): void {
    this.release(this.dcHolder);
    this.release(this.rstHolder);
    this.dcHolder = undefined;
    this.rstHolder = undefined;
  }

  private close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.releaseAll();
    closeSync(this.fd);
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function frameSignature(frame: number[][]): string {
  return frame.map((row) => Buffer.from(row).toString("base64")).join(".");
}

const pythonSsd1309Renderer = String.raw`
import fcntl
import json
import os
import struct
import subprocess
import sys
import time

SPI_IOC_WR_MODE = 0x40016B01
SPI_IOC_WR_BITS_PER_WORD = 0x40016B03
SPI_IOC_WR_MAX_SPEED_HZ = 0x40046B04

payload = json.loads(sys.stdin.read())
spi_device = payload["spiDevice"]
gpio_chip = payload["gpioChip"]
dc_gpio = str(payload["dcGpio"])
rst_gpio = str(payload["rstGpio"])
frame = payload["frame"]
holders = []

def hold(gpio, value):
    process = subprocess.Popen(
        ["gpioset", "--mode=signal", gpio_chip, f"{gpio}={1 if value else 0}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    time.sleep(0.03)
    if process.poll() is not None:
        stderr = process.stderr.read() if process.stderr else ""
        raise RuntimeError(stderr.strip() or f"gpioset failed for GPIO {gpio}")
    holders.append(process)
    return process

def release(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            process.kill()
    time.sleep(0.01)

def cleanup():
    for process in holders:
        release(process)

dc_holder = None
rst_holder = None
fd = os.open(spi_device, os.O_WRONLY)

try:
    fcntl.ioctl(fd, SPI_IOC_WR_MODE, struct.pack("B", 0))
    fcntl.ioctl(fd, SPI_IOC_WR_BITS_PER_WORD, struct.pack("B", 8))
    fcntl.ioctl(fd, SPI_IOC_WR_MAX_SPEED_HZ, struct.pack("I", 1000000))

    def set_dc(value):
        global dc_holder
        release(dc_holder)
        dc_holder = hold(dc_gpio, value)

    def set_rst(value):
        global rst_holder
        release(rst_holder)
        rst_holder = hold(rst_gpio, value)

    def command(*values):
        set_dc(0)
        os.write(fd, bytes(values))
        time.sleep(0.005)

    def data(values):
        set_dc(1)
        os.write(fd, bytes(values))
        time.sleep(0.005)

    set_rst(1)
    time.sleep(0.05)
    set_rst(0)
    time.sleep(0.15)
    set_rst(1)
    time.sleep(0.15)

    command(
        0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40,
        0x8D, 0x14, 0x20, 0x02, 0xA1, 0xC8, 0xDA, 0x12,
        0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF
    )

    for page_index, row in enumerate(frame[:8]):
        command(0xB0 + page_index, 0x00, 0x10)
        data([int(value) & 0xFF for value in row[:128]])
finally:
    cleanup()
    os.close(fd)
`;

const font: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0],
  "-": [0x08, 0x08, 0x08, 0x08, 0x08],
  ":": [0, 0x36, 0x36, 0, 0],
  "0": [0x3e, 0x51, 0x49, 0x45, 0x3e],
  "1": [0x00, 0x42, 0x7f, 0x40, 0x00],
  "2": [0x42, 0x61, 0x51, 0x49, 0x46],
  "3": [0x21, 0x41, 0x45, 0x4b, 0x31],
  "4": [0x18, 0x14, 0x12, 0x7f, 0x10],
  "5": [0x27, 0x45, 0x45, 0x45, 0x39],
  "6": [0x3c, 0x4a, 0x49, 0x49, 0x30],
  "7": [0x01, 0x71, 0x09, 0x05, 0x03],
  "8": [0x36, 0x49, 0x49, 0x49, 0x36],
  "9": [0x06, 0x49, 0x49, 0x29, 0x1e],
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e],
  B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22],
  D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41],
  F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a],
  H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00],
  J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41],
  L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f],
  N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
  P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e],
  R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31],
  T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f],
  V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f],
  X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07],
  Z: [0x61, 0x51, 0x49, 0x45, 0x43]
};
