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

CACHE = "/run/studybox-wifi/scan.json"
AP_PID = "/run/studybox-wifi-fallback/hostapd.pid"


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


def live_scan():
    # `iw scan` can hang indefinitely on the Pi's brcmfmac radio when wpa_supplicant
    # is (re)connecting at the same moment; never let it block the Wi-Fi supervisor.
    result = subprocess.run(["iw", "dev", "wlan0", "scan"], check=True, capture_output=True, text=True, timeout=20)
    current = connected_ssid()
    networks = {}
    for block in result.stdout.split("\nBSS ")[1:]:
        ssid_match = re.search(r"\n\tSSID: (.*)", block)
        signal_match = re.search(r"\n\s+signal: ([0-9.-]+) dBm", block)
        if not ssid_match:
            continue
        ssid = ssid_match.group(1).strip()
        if not ssid or ssid == "StudyBox-Setup":
            continue
        signal_dbm = float(signal_match.group(1)) if signal_match else -100
        signal_percent = max(0, min(100, round(2 * (signal_dbm + 100))))
        security = "WPA2/WPA3" if "RSN:" in block else ("WPA" if "WPA:" in block else "Open")
        previous = networks.get(ssid)
        if not previous or signal_percent > previous["signalPercent"]:
            networks[ssid] = {"ssid": ssid, "signalPercent": signal_percent, "security": security, "inUse": ssid == current}
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
