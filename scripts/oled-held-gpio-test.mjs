import { openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const spiDevice = process.env.STUDYBOX_OLED_SPI_DEVICE ?? "/dev/spidev0.0";
const gpioChip = process.env.STUDYBOX_GPIO_CHIP ?? "gpiochip4";
const dcGpio = String(Number(process.env.STUDYBOX_OLED_DC_GPIO ?? 25));
const rstGpio = String(Number(process.env.STUDYBOX_OLED_RST_GPIO ?? 27));
const fd = openSync(spiDevice, "w");

let dcHolder;
let rstHolder;
let closed = false;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holdGpio(gpio, value) {
  const child = spawn("gpioset", ["--mode=signal", gpioChip, `${gpio}=${value ? 1 : 0}`], {
    stdio: "ignore"
  });
  sleep(15);
  return child;
}

function release(child) {
  if (child && !child.killed && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    sleep(15);
  }
}

function releaseAll() {
  if (closed) return;
  closed = true;
  release(dcHolder);
  release(rstHolder);
  dcHolder = undefined;
  rstHolder = undefined;
}

process.once("exit", releaseAll);
process.once("SIGINT", () => {
  releaseAll();
  process.exit(130);
});
process.once("SIGTERM", () => {
  releaseAll();
  process.exit(143);
});

function setDc(value) {
  release(dcHolder);
  dcHolder = holdGpio(dcGpio, value);
}

function setRst(value) {
  release(rstHolder);
  rstHolder = holdGpio(rstGpio, value);
}

function spiWrite(bytes) {
  writeFileSync(fd, Buffer.from(bytes));
}

function command(...bytes) {
  setDc(0);
  spiWrite(bytes);
}

function data(bytes) {
  setDc(1);
  spiWrite(bytes);
}

function init() {
  setRst(1);
  sleep(20);
  setRst(0);
  sleep(80);
  setRst(1);
  sleep(80);

  command(
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
    0x81, 0xff,
    0xd9, 0xf1,
    0xdb, 0x40,
    0xa4,
    0xa6,
    0xaf
  );
}

function setCursor(x, page) {
  command(0xb0 + page, 0x00 + (x & 0x0f), 0x10 + ((x >> 4) & 0x0f));
}

try {
  init();
  for (let page = 0; page < 8; page += 1) {
    setCursor(0, page);
    data(new Array(128).fill(page % 2 === 0 ? 0xff : 0x00));
  }
  command(0xa5);
  console.log(`Sent held-GPIO OLED test on ${spiDevice}`);
  sleep(5000);
} finally {
  releaseAll();
}
