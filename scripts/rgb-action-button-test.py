#!/usr/bin/env python3
import argparse
import subprocess
import sys
import time


def run(args):
    return subprocess.run(args, check=False, capture_output=True, text=True)


def test_button(chip, gpio, seconds):
    print(f"Testing ACTION switch on {chip} GPIO{gpio}. Press and release the button now.")
    print("Expected: released=1, pressed=0 with internal pull-up.")
    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        result = run(["gpioget", f"--bias=pull-up", chip, str(gpio)])
        value = result.stdout.strip()
        if result.returncode != 0:
            print(result.stderr.strip() or "gpioget failed", file=sys.stderr)
            return False
        if value != last:
            print(f"GPIO{gpio}={value}")
            last = value
        time.sleep(0.1)
    return True


def color(strip, index, red, green, blue):
    strip.setPixelColor(index, (green << 16) | (red << 8) | blue)
    strip.show()


def test_rgb(gpio, count):
    try:
        from rpi_ws281x import PixelStrip
    except ImportError:
        print("RGB test skipped: Python package rpi_ws281x is not installed.", file=sys.stderr)
        print("Install on the Pi with: sudo python3 -m pip install rpi_ws281x", file=sys.stderr)
        return False

    strip = PixelStrip(count, gpio, 800000, 10, False, 80, 0)
    strip.begin()
    try:
        for name, values in [("red", (255, 0, 0)), ("green", (0, 255, 0)), ("blue", (0, 0, 255)), ("white", (255, 255, 255))]:
            print(f"RGB {name}")
            for index in range(count):
                color(strip, index, *values)
            time.sleep(1)
    finally:
        for index in range(count):
            color(strip, index, 0, 0, 0)
    return True


def main():
    parser = argparse.ArgumentParser(description="Test StudyBox RGB ACTION button wiring.")
    parser.add_argument("--chip", default="gpiochip4")
    parser.add_argument("--rgb-gpio", type=int, default=5)
    parser.add_argument("--button-gpio", type=int, default=6)
    parser.add_argument("--pixels", type=int, default=1)
    parser.add_argument("--button-seconds", type=float, default=10)
    parser.add_argument("--skip-rgb", action="store_true")
    parser.add_argument("--skip-button", action="store_true")
    args = parser.parse_args()

    ok = True
    if not args.skip_button:
        ok = test_button(args.chip, args.button_gpio, args.button_seconds) and ok
    if not args.skip_rgb:
        ok = test_rgb(args.rgb_gpio, args.pixels) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
