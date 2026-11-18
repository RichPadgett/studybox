#!/usr/bin/env python3
"""List nearby Wi-Fi networks as JSON.

While the StudyBox-Setup hotspot owns wlan0 the radio cannot scan, so this
returns the list cached just before the hotspot opened. --live forces a real
scan (used by the Wi-Fi supervisor to refresh the cache).
"""
import json
import os
import re
import subprocess
import sys
import time

CACHE = "/run/studybox-wifi/scan.json"
AP_PID = "/run/studybox-wifi-fallback/hostapd.pid"
# Before the setup hotspot opens (--live) take several passes; the admin page waits at most 12 s.
ROUNDS = 3 if "--live" in sys.argv else 1


def ap_active() -> bool:
    try:
        with open(AP_PID, encoding="utf-8") as stream:
            os.kill(int(stream.read().strip()), 0)
        return True
    except (OSError, ValueError):
        return False


def connected_ssid() -> str:
    result = subprocess.run(["wpa_cli", "-i", "wlan0", "status"], capture_output=True, text=True, timeout=5)
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    return fields.get("ssid", "") if fields.get("wpa_state") == "COMPLETED" else ""


def iw_scan(networks: dict, current: str) -> bool:
    # `iw scan` can hang indefinitely on the Pi's brcmfmac radio when wpa_supplicant
    # is (re)connecting at the same moment; never let it block the Wi-Fi supervisor.
    try:
        result = subprocess.run(["iw", "dev", "wlan0", "scan"], check=True, capture_output=True, text=True, timeout=20)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return False
    for block in result.stdout.split("\nBSS ")[1:]:
        ssid_match = re.search(r"\n\tSSID: (.*)", block)
        signal_match = re.search(r"\n\s+signal: ([0-9.-]+) dBm", block)
        if not ssid_match:
            continue
        security = "WPA2/WPA3" if "RSN:" in block else ("WPA" if "WPA:" in block else "Open")
        add(networks, ssid_match.group(1).strip(), float(signal_match.group(1)) if signal_match else -100, security, current)
    return True


def wpa_scan_results(networks: dict, current: str) -> None:
    """wpa_supplicant keeps its own table of recently seen networks (from its scans
    for saved networks), which often holds ones a single `iw scan` missed."""
    try:
        result = subprocess.run(["wpa_cli", "-i", "wlan0", "scan_results"], capture_output=True, text=True, timeout=5)
    except (subprocess.TimeoutExpired, OSError):
        return
    for line in result.stdout.splitlines()[1:]:
        fields = line.split("\t")
        if len(fields) < 5:
            continue
        try:
            signal_dbm = float(fields[2])
        except ValueError:
            continue
        flags = fields[3]
        security = "WPA2/WPA3" if ("RSN" in flags or "WPA2" in flags or "SAE" in flags) else ("WPA" if "WPA" in flags else "Open")
        add(networks, fields[4].strip(), signal_dbm, security, current)


def add(networks: dict, ssid: str, signal_dbm: float, security: str, current: str) -> None:
    # Hidden networks have no name; "\x00" padding is how some routers hide one.
    if not ssid or ssid == "StudyBox-Setup" or ssid.startswith("\\x00"):
        return
    signal_percent = max(0, min(100, round(2 * (signal_dbm + 100))))
    previous = networks.get(ssid)
    if not previous or signal_percent > previous["signalPercent"]:
        networks[ssid] = {"ssid": ssid, "signalPercent": signal_percent, "security": security, "inUse": ssid == current}


def live_scan():
    """One scan by the Pi's radio often misses networks, especially weaker ones or
    while wpa_supplicant is busy trying saved networks (right before the setup
    hotspot opens). Combine several passes plus wpa_supplicant's own results."""
    try:
        current = connected_ssid()
    except (subprocess.TimeoutExpired, OSError):
        current = ""
    networks: dict = {}
    succeeded = False
    for attempt in range(ROUNDS):
        if attempt:
            time.sleep(2)
        succeeded = iw_scan(networks, current) or succeeded
        wpa_scan_results(networks, current)
    if not succeeded and not networks:
        raise OSError("Wi-Fi scan failed")
    return sorted(networks.values(), key=lambda network: network["signalPercent"], reverse=True)


def cached():
    try:
        with open(CACHE, encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError):
        return []


if "--live" not in sys.argv and ap_active():
    print(json.dumps(cached()))
    sys.exit(0)

try:
    networks = live_scan()
except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
    networks = cached()
print(json.dumps(networks))
