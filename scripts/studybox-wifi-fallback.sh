#!/usr/bin/env bash
# StudyBox Wi-Fi supervisor.
#
#   start  (boot)  wait for a saved network; open the StudyBox-Setup hotspot if none connects
#   setup          open the StudyBox-Setup hotspot now (button chord / forced setup)
#   try            close the hotspot, try saved networks, reopen the hotspot with the reason if none connects
#   retry  (timer) while the hotspot is open and nobody is using it, quietly re-try saved networks
#   stop           close the hotspot and hand wlan0 back to the normal network stack
#
# While the hotspot is open, systemd-networkd owns the 10.42.0.1 address through a
# runtime .network file that sorts before netplan's, so networkd no longer strips the
# address or runs DHCP on wlan0 underneath hostapd. That fight is what left phones
# without an IP address ("no address range available for DHCP request").
set -euo pipefail

interface="${STUDYBOX_WIFI_INTERFACE:-wlan0}"
setup_ssid="${STUDYBOX_SETUP_SSID:-StudyBox-Setup}"
setup_password="${STUDYBOX_SETUP_PASSWORD:-StudyBoxSetup!26}"
setup_ip="${STUDYBOX_SETUP_IP:-10.42.0.1}"
connect_wait="${STUDYBOX_WIFI_CONNECT_WAIT_SECONDS:-60}"
boot_wait="${STUDYBOX_WIFI_FALLBACK_WAIT_SECONDS:-75}"
# Leave a freshly opened hotspot alone this long before the timer retries saved
# networks, so it never disappears while someone is walking over to join it.
setup_idle_seconds="${STUDYBOX_WIFI_SETUP_IDLE_SECONDS:-600}"
setup_dir="/run/studybox-wifi-fallback"
status_dir="/run/studybox-wifi"
status_file="$status_dir/status.json"
scan_cache="$status_dir/scan.json"
ap_network="/run/systemd/network/05-studybox-setup-ap.network"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { logger -t studybox-wifi-fallback "$*"; echo "$*"; }

write_status() {
  # mode: connected | setup | trying ; ssid/error are optional
  mkdir -p "$status_dir"
  chmod 755 "$status_dir"
  python3 - "$status_file" "$1" "${2:-}" "${3:-}" <<'PY'
import json, sys, datetime, os
path, mode, ssid, error = sys.argv[1:5]
data = {"mode": mode, "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
if ssid: data["ssid"] = ssid
if error: data["error"] = error
tmp = path + ".tmp"
with open(tmp, "w") as f: json.dump(data, f)
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

connected_ssid() {
  wpa_cli -i "$interface" status 2>/dev/null | awk -F= '$1 == "wpa_state" { state = $2 } $1 == "ssid" { ssid = $2 } END { if (state == "COMPLETED") print ssid }'
}

has_ipv4() {
  ip -4 addr show dev "$interface" 2>/dev/null | grep -q "inet " && ! ip -4 addr show dev "$interface" | grep -q "inet $setup_ip/"
}

is_connected() { [[ -n "$(connected_ssid)" ]] && has_ipv4; }

# Start a hotspot daemon in its own systemd scope. This script often runs inside a
# short-lived unit (the retry timer, or the systemd-run job that tries a newly saved
# network); without a scope, systemd kills hostapd and dnsmasq the moment that unit's
# script exits, leaving the box with neither Wi-Fi nor a hotspot.
run_detached() {
  if command -v systemd-run >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    # 9>&-: daemons must not inherit the supervisor lock (see the bottom of this file).
    systemd-run --scope --quiet --collect -- "$@" 9>&-
  else
    "$@" 9>&-
  fi
}

ap_active() { [[ -f "$setup_dir/hostapd.pid" ]] && kill -0 "$(cat "$setup_dir/hostapd.pid")" 2>/dev/null; }

refresh_scan_cache() {
  mkdir -p "$status_dir"
  local output
  if output="$(timeout 40 python3 "$script_dir/studybox-wifi-scan.py" --live 2>/dev/null)" && [[ "$output" == \[* ]]; then
    printf '%s\n' "$output" > "$scan_cache.tmp" && chmod 644 "$scan_cache.tmp" && mv "$scan_cache.tmp" "$scan_cache"
  fi
}

stop_ap() {
  local had_ap=0
  for name in captive dnsmasq hostapd; do
    if [[ -f "$setup_dir/$name.pid" ]]; then
      had_ap=1
      kill "$(cat "$setup_dir/$name.pid")" 2>/dev/null || true
    fi
  done
  rm -rf "$setup_dir"
  # Forget which phones joined/opened setup, so the screen restarts at step 1.
  rm -f "$status_dir/captive-released.json"
  ip neigh flush dev "$interface" 2>/dev/null || true
  if [[ -f "$ap_network" ]]; then
    rm -f "$ap_network"
    networkctl reload || true
  fi
  if (( had_ap )); then
    ip addr flush dev "$interface" || true
  fi
}

start_normal_wifi() {
  # "restart" picks up networks saved since wpa_supplicant started; "start" leaves a
  # boot-time connection attempt alone.
  local action="${1:-restart}"
  netplan generate || true
  systemctl "$action" "netplan-wpa-$interface.service" 2>/dev/null || true
  networkctl reconfigure "$interface" 2>/dev/null || true
}

wait_for_connection() {
  local seconds="$1"
  for ((second = 0; second < seconds; second += 3)); do
    if is_connected; then return 0; fi
    sleep 3
  done
  is_connected
}

# Best-effort reason a just-saved network failed, read from wpa_supplicant's log.
failure_reason() {
  local ssid="$1" since="$2" log_text
  log_text="$(journalctl -u "netplan-wpa-$interface.service" --since "@$since" --no-pager 2>/dev/null || true)"
  # Only count a rejection of *this* network; other saved networks nearby may have
  # stale passwords and must not be blamed on the one the person just entered.
  if [[ -n "$ssid" ]] && grep -F "ssid=\"$ssid\"" <<<"$log_text" | grep -q "WRONG_KEY"; then
    echo "StudyBox found \"$ssid\" but the password was rejected. Passwords are case-sensitive."
  elif [[ -n "$ssid" && -f "$scan_cache" ]] && ! python3 -c 'import json,sys; sys.exit(0 if any(n["ssid"]==sys.argv[2] for n in json.load(open(sys.argv[1]))) else 1)' "$scan_cache" "$ssid" 2>/dev/null; then
    echo "StudyBox could not see \"$ssid\" nearby. Check the network name (it is case-sensitive) or move StudyBox closer to the router."
  else
    echo "StudyBox could not join${ssid:+ \"$ssid\"}. Check the password and that the router is on."
  fi
}

start_ap() {
  local error="${1:-}"
  if ap_active; then
    write_status setup "" "$error"
    return 0
  fi
  # Scan while the radio is still a client; hostapd cannot scan once it owns wlan0.
  refresh_scan_cache
  stop_ap
  mkdir -p "$setup_dir"

  systemctl stop "netplan-wpa-$interface.service" 2>/dev/null || true
  cat > "$ap_network" <<EOF
[Match]
Name=$interface

[Network]
Address=$setup_ip/24
DHCP=no
LinkLocalAddressing=no
IPv6AcceptRA=no
ConfigureWithoutCarrier=yes
EOF
  networkctl reload || true
  ip addr flush dev "$interface" || true
  ip link set "$interface" up
  networkctl reconfigure "$interface" 2>/dev/null || true

  cat > "$setup_dir/hostapd.conf" <<EOF
interface=$interface
driver=nl80211
country_code=US
ssid=$setup_ssid
hw_mode=g
channel=6
wmm_enabled=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=$setup_password
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
# Log phones joining and leaving (and failed handshakes) to the journal.
logger_syslog=-1
logger_syslog_level=2
EOF

  cat > "$setup_dir/dnsmasq.conf" <<EOF
interface=$interface
bind-dynamic
dhcp-authoritative
dhcp-range=10.42.0.10,10.42.0.100,255.255.255.0,1h
dhcp-option=option:router,$setup_ip
dhcp-option=114,"http://$setup_ip/"
address=/#/$setup_ip
EOF

  run_detached hostapd -B -P "$setup_dir/hostapd.pid" "$setup_dir/hostapd.conf"

  # networkd applies the address asynchronously; make sure it is there before DHCP starts.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    ip -4 addr show dev "$interface" | grep -q "inet $setup_ip/" && break
    sleep 1
  done
  ip -4 addr show dev "$interface" | grep -q "inet $setup_ip/" || ip addr add "$setup_ip/24" dev "$interface"

  run_detached dnsmasq --conf-file="$setup_dir/dnsmasq.conf" --pid-file="$setup_dir/dnsmasq.pid"
  # 9>&- on the background job itself: the subshell that waits on it would otherwise
  # hold the supervisor lock for as long as the hotspot runs.
  run_detached python3 "$script_dir/studybox-captive-redirect.py" "$setup_ip" "$setup_dir/captive.pid" 9>&- &
  disown || true

  write_status setup "" "$error"
  log "Started $setup_ssid at $setup_ip; configure Wi-Fi at http://$setup_ip:5173/setup${error:+ (last error: $error)}"
}

commit_pending() { python3 "$script_dir/studybox-wifi-connect.py" --commit >/dev/null 2>&1 || true; }
discard_pending() { python3 "$script_dir/studybox-wifi-connect.py" --discard >/dev/null 2>&1 || true; }

try_saved_networks() {
  local target_ssid="${1:-}" quiet="${2:-}"
  local since
  since="$(date +%s)"
  write_status trying "$target_ssid"
  stop_ap
  start_normal_wifi
  if wait_for_connection "$connect_wait"; then
    local ssid
    ssid="$(connected_ssid)"
    write_status connected "$ssid"
    log "Connected to $ssid"
    # A network entered on the phone is only kept once it has worked.
    if [[ -n "$target_ssid" && "$ssid" == "$target_ssid" ]]; then commit_pending; else discard_pending; fi
    refresh_scan_cache
    return 0
  fi
  local reason=""
  [[ -z "$quiet" ]] && reason="$(failure_reason "$target_ssid" "$since")"
  log "No saved network connected${target_ssid:+ (wanted $target_ssid)}; reopening $setup_ssid"
  # Forget the failed entry so the previous (working) password is used from now on.
  discard_pending
  start_ap "$reason"
  return 1
}

# One Wi-Fi change at a time. The timer's retry skips its turn if anything else
# (boot, setup, trying a newly saved network) is in progress.
exec 9>/run/studybox-wifi-supervisor.lock
if [[ "${1:-start}" == "retry" ]]; then
  flock -n 9 || exit 0
else
  flock -w 240 9 || log "Wi-Fi supervisor lock wait timed out; continuing"
fi

case "${1:-start}" in
  stop)
    stop_ap
    start_normal_wifi
    ;;
  setup)
    start_ap
    ;;
  try)
    # Only the newest phone request runs; older ones queued behind the lock stop here.
    if [[ -n "${3:-}" && "$(cat "$status_dir/try-request" 2>/dev/null)" != "$3" ]]; then
      log "Skipping an older Wi-Fi request for ${2:-}; a newer one replaced it"
      exit 0
    fi
    try_saved_networks "${2:-}" || true
    ;;
  leave)
    # Page held during setup: leave the hotspot and go back to the saved networks.
    discard_pending
    log "Leaving setup on request; trying saved networks"
    try_saved_networks "" quiet || true
    ;;
  retry)
    if ap_active; then
      stations="$(iw dev "$interface" station dump 2>/dev/null | grep -c '^Station' || true)"
      ap_age=$(( $(date +%s) - $(stat -c %Y "$setup_dir/hostapd.pid" 2>/dev/null || date +%s) ))
      if [[ "${stations:-0}" == "0" && "$ap_age" -ge "$setup_idle_seconds" ]]; then
        # Keep the previous error visible if this quiet retry also fails.
        previous_error="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("error",""))' "$status_file" 2>/dev/null || true)"
        try_saved_networks "" quiet || write_status setup "" "$previous_error"
      fi
    elif is_connected; then
      write_status connected "$(connected_ssid)"
    else
      # Neither the hotspot nor Wi-Fi is up (e.g. hostapd failed to start).
      # Never leave the box stranded: try saved networks, which reopens the
      # hotspot if none connect.
      log "No hotspot and no Wi-Fi; retrying saved networks"
      try_saved_networks "" quiet || true
    fi
    ;;
  start|*)
    stop_ap
    if [[ -f /tmp/studybox-force-wifi-setup ]]; then
      rm -f /tmp/studybox-force-wifi-setup
      start_ap
      exit 0
    fi
    systemctl start "netplan-wpa-$interface.service" 2>/dev/null || true
    if wait_for_connection "$boot_wait"; then
      write_status connected "$(connected_ssid)"
      refresh_scan_cache
      exit 0
    fi
    start_ap
    ;;
esac
