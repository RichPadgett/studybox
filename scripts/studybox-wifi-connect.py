#!/usr/bin/env python3
"""Save a Wi-Fi network and switch to it.

  studybox-wifi-connect.py SSID [PASSWORD]
      While the setup hotspot is open, the network is only *pending*: netplan gets
      it so the box can try it, but /etc/studybox/wifi-networks.json keeps the
      previous (working) password until the supervisor confirms it connects. A
      typo therefore never replaces a password that was working.
      Prints {"ssid": ..., "mode": "switching"}.
      When already online (admin page), it is saved and applied in place:
      {"ssid": ..., "mode": "applied"}.

  studybox-wifi-connect.py --commit    pending network connected: keep it
  studybox-wifi-connect.py --discard   pending network failed: forget it and
                                       restore the saved passwords in netplan

Never touches /etc/netplan/50-cloud-init.yaml, where the hosts' networks live.
"""
import json
import os
import subprocess
import sys
import time

STATE_PATH = "/etc/studybox/wifi-networks.json"
PENDING_PATH = "/etc/studybox/wifi-pending.json"
NETPLAN_PATH = "/etc/netplan/99-studybox-wifi.yaml"
SCAN_CACHE = "/run/studybox-wifi/scan.json"
REQUEST_PATH = "/run/studybox-wifi/try-request"
AP_PID = "/run/studybox-wifi-fallback/hostapd.pid"
SUPERVISOR = "/opt/studybox/scripts/studybox-wifi-fallback.sh"


def ap_active() -> bool:
    try:
        with open(AP_PID, encoding="utf-8") as stream:
            os.kill(int(stream.read().strip()), 0)
        return True
    except (OSError, ValueError):
        return False


def load(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as stream:
            value = json.load(stream)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_private(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f"{path}.tmp"
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as stream:
        stream.write(content)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def write_netplan(networks: dict) -> None:
    lines = ["network:", "  version: 2", "  wifis:", "    wlan0:", "      access-points:"]
    for network, secret in sorted(networks.items()):
        lines.append(f"        {json.dumps(network, ensure_ascii=True)}:")
        if secret:
            lines.extend(["          auth:", "            key-management: psk", f"            password: {json.dumps(secret, ensure_ascii=True)}"])
        else:
            lines.append("          {}")
    write_private(NETPLAN_PATH, "\n".join(lines) + "\n")


def remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


if len(sys.argv) > 1 and sys.argv[1] in ("--commit", "--discard"):
    saved = load(STATE_PATH)
    pending = load(PENDING_PATH)
    if sys.argv[1] == "--commit" and pending:
        saved.update(pending)
        write_private(STATE_PATH, json.dumps(saved, indent=2))
    remove(PENDING_PATH)
    write_netplan(saved)
    print(json.dumps({"mode": sys.argv[1][2:], "ssids": sorted(pending)}))
    sys.exit(0)

ssid = sys.argv[1].strip() if len(sys.argv) > 1 else ""
password = sys.argv[2] if len(sys.argv) > 2 else ""
if not ssid or (password and len(password) < 8):
    raise SystemExit("A network name and valid password are required")

# Network names are case-sensitive. If a typed name matches a nearby network
# except for case, use the exact name the router broadcasts.
try:
    with open(SCAN_CACHE, encoding="utf-8") as stream:
        nearby = [network["ssid"] for network in json.load(stream)]
    if ssid not in nearby:
        matches = [name for name in nearby if name.casefold() == ssid.casefold()]
        if len(matches) == 1:
            ssid = matches[0]
except (OSError, ValueError, KeyError, TypeError):
    pass

saved = load(STATE_PATH)

if ap_active():
    # Try it first; the supervisor commits it only once it connects.
    write_private(PENDING_PATH, json.dumps({ssid: password}, indent=2))
    write_netplan({**saved, ssid: password})
    # Only the newest request runs: an older queued try sees a different id and stops.
    request_id = f"{time.time_ns()}"
    os.makedirs(os.path.dirname(REQUEST_PATH), exist_ok=True)
    with open(REQUEST_PATH, "w", encoding="utf-8") as stream:
        stream.write(request_id)
    # Answer the phone before the hotspot goes away, then switch in the background.
    subprocess.run([
        "systemd-run", "--no-block", "--collect", "--on-active=4",
        "--timer-property=AccuracySec=100ms",
        f"--unit=studybox-wifi-try-{os.getpid()}",
        SUPERVISOR, "try", ssid, request_id
    ], check=True)
    print(json.dumps({"ssid": ssid, "mode": "switching"}))
else:
    saved[ssid] = password
    write_private(STATE_PATH, json.dumps(saved, indent=2))
    remove(PENDING_PATH)
    write_netplan(saved)
    subprocess.run(["netplan", "apply"], check=True)
    print(json.dumps({"ssid": ssid, "mode": "applied"}))
