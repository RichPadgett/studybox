#!/usr/bin/env python3
"""Dimmable driver for the two RGB pushbuttons (Zoom and Record).

The buttons are 6V common-anode RGB LEDs with built-in resistors, run here from
3.3V. At that voltage red is far brighter than green and blue, so any mix with
red (white, yellow, purple, pink) looks red unless red is dimmed. This helper
keeps software PWM (lgpio) running on all six color pins so the API can ask for
balanced colors, and it runs the blink patterns too.

Reads one JSON command per line on stdin:
  {"button": "zoom" | "rec", "color": [r, g, b], "pattern": "solid", "alt": [r, g, b]}
Levels are 0-100 (% brightness). Patterns: solid, slowBlink, fastBlink, pulse,
breathe, flash3 (three quick blinks, then `alt`). During the "off" half of a blink the button shows `alt` (default off).
Exits and turns the lights off when stdin closes.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time

# lgpio creates its notify pipe in the working directory (or $LG_WD); /opt/studybox
# is not writable by the service user, so use a private temp directory.
os.environ.setdefault("LG_WD", "/tmp")
os.chdir(os.environ["LG_WD"])

import lgpio  # noqa: E402  (must follow LG_WD)

PWM_HZ = 400
HALF_PERIOD_SECONDS = {"slowBlink": 1.0, "fastBlink": 0.25, "pulse": 0.65, "breathe": 1.4}


def env_pin(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


chip = int(os.environ.get("STUDYBOX_GPIO_CHIP", "gpiochip4").removeprefix("gpiochip"))
active_low = os.environ.get("STUDYBOX_RGB_ACTIVE_LOW", "true") != "false"
buttons = {
    "rec": (env_pin("STUDYBOX_REC_RGB_R_GPIO", 12), env_pin("STUDYBOX_REC_RGB_G_GPIO", 13), env_pin("STUDYBOX_REC_RGB_B_GPIO", 16)),
    "zoom": (env_pin("STUDYBOX_ZOOM_RGB_R_GPIO", 19), env_pin("STUDYBOX_ZOOM_RGB_G_GPIO", 20), env_pin("STUDYBOX_ZOOM_RGB_B_GPIO", 21)),
}

handle = lgpio.gpiochip_open(chip)
off_level = 1 if active_low else 0
for pins in buttons.values():
    for pin in pins:
        lgpio.gpio_claim_output(handle, pin, off_level)

lock = threading.Lock()
state = {name: {"color": (0, 0, 0), "pattern": "solid", "alt": (0, 0, 0), "since": time.monotonic()} for name in buttons}
applied: dict[int, int] = {}


def write_pin(pin: int, brightness: int) -> None:
    brightness = max(0, min(100, int(brightness)))
    if applied.get(pin) == brightness:
        return
    applied[pin] = brightness
    # Active-low: the LED is lit while the pin is low, so the high time is 100 - brightness.
    duty_high = 100 - brightness if active_low else brightness
    lgpio.tx_pwm(handle, pin, PWM_HZ, duty_high)


def render() -> None:
    now = time.monotonic()
    with lock:
        for name, pins in buttons.items():
            current = state[name]
            shown = current["color"]
            elapsed = now - current["since"]
            if current["pattern"] == "flash3":
                # Three quick blinks, then hold `alt` until the next command.
                phase = int(elapsed / 0.3)
                if phase >= 6 or phase % 2 == 1:
                    shown = current["alt"]
            else:
                half = HALF_PERIOD_SECONDS.get(current["pattern"])
                if half and int(elapsed / half) % 2 == 1:
                    shown = current["alt"]
            for pin, level in zip(pins, shown):
                write_pin(pin, level)


def triple(value, fallback=(0, 0, 0)) -> tuple[int, int, int]:
    try:
        r, g, b = (int(v) for v in value)
        return r, g, b
    except (TypeError, ValueError):
        return fallback


def read_commands() -> None:
    for line in sys.stdin:
        try:
            command = json.loads(line)
        except ValueError:
            continue
        name = command.get("button")
        if name not in buttons:
            continue
        with lock:
            state[name] = {
                "color": triple(command.get("color")),
                "pattern": command.get("pattern") or "solid",
                "alt": triple(command.get("alt")),
                "since": time.monotonic(),
            }
    stopping.set()


stopping = threading.Event()
threading.Thread(target=read_commands, daemon=True).start()
try:
    while not stopping.is_set():
        render()
        time.sleep(0.02)
finally:
    for pins in buttons.values():
        for pin in pins:
            lgpio.tx_pwm(handle, pin, PWM_HZ, 100 if active_low else 0)
    time.sleep(0.05)
    for pins in buttons.values():
        for pin in pins:
            lgpio.gpio_free(handle, pin)
    lgpio.gpiochip_close(handle)
