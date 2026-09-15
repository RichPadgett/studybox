#!/usr/bin/env python3
import json
import re
import subprocess

result = subprocess.run(["iw", "dev", "wlan0", "scan"], check=True, capture_output=True, text=True)
networks = {}
for block in result.stdout.split("\nBSS ")[1:]:
    ssid_match = re.search(r"\n\tSSID: (.*)", block)
    signal_match = re.search(r"\n\s+signal: ([0-9.-]+) dBm", block)
    if not ssid_match:
        continue
    ssid = ssid_match.group(1).strip()
    if not ssid:
        continue
    signal_dbm = float(signal_match.group(1)) if signal_match else -100
    signal_percent = max(0, min(100, round(2 * (signal_dbm + 100))))
    security = "WPA2/WPA3" if "RSN:" in block else ("WPA" if "WPA:" in block else "Open")
    current = networks.get(ssid)
    if not current or signal_percent > current["signalPercent"]:
        networks[ssid] = {"ssid": ssid, "signalPercent": signal_percent, "security": security, "inUse": False}
print(json.dumps(sorted(networks.values(), key=lambda network: network["signalPercent"], reverse=True)))
