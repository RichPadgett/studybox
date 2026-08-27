import { openSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const spiDevice = process.env.STUDYBOX_OLED_SPI_DEVICE ?? "/dev/spidev0.0";
const dcGpio = Number(process.env.STUDYBOX_OLED_DC_GPIO ?? 25);
const rstGpio = Number(process.env.STUDYBOX_OLED_RST_GPIO ?? 27);
const fd = openSync(spiDevice, "w");

function gpioSet(gpio, value) {
  execFileSync("gpioset", ["gpiochip4", `${gpio}=${value ? 1 : 0}`]);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function command(...bytes) {
  gpioSet(dcGpio, 0);
  writeFileSync(fd, Buffer.from(bytes));
}

gpioSet(rstGpio, 1);
sleep(10);
gpioSet(rstGpio, 0);
sleep(50);
gpioSet(rstGpio, 1);
sleep(50);

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
  0xa6,
  0xaf,
  0xa5
);

console.log(`Sent OLED all-pixels-on test on ${spiDevice}`);
