#!/usr/bin/env python3
import json
import os
import subprocess
import sys

ssid = sys.argv[1].strip() if len(sys.argv) > 1 else ""
password = sys.argv[2] if len(sys.argv) > 2 else ""
if not ssid or (password and len(password) < 8):
    raise SystemExit("A network name and valid password are required")

state_path = "/etc/studybox/wifi-networks.json"
netplan_path = "/etc/netplan/99-studybox-wifi.yaml"
os.makedirs(os.path.dirname(state_path), exist_ok=True)
try:
    with open(state_path, "r", encoding="utf-8") as stream:
        networks = json.load(stream)
except FileNotFoundError:
    networks = {}
networks[ssid] = password
with open(state_path, "w", encoding="utf-8") as stream:
    json.dump(networks, stream, indent=2)

def yaml_string(value):
    return json.dumps(value, ensure_ascii=True)

lines = ["network:", "  version: 2", "  wifis:", "    wlan0:", "      access-points:"]
for network, secret in sorted(networks.items()):
    lines.extend([f"        {yaml_string(network)}:", "          auth:", "            key-management: psk", f"            password: {yaml_string(secret)}"])
with open(netplan_path, "w", encoding="utf-8") as stream:
    stream.write("\n".join(lines) + "\n")
subprocess.run(["netplan", "apply"], check=True)
