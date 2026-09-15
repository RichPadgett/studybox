#!/usr/bin/env bash
set -euo pipefail

interface="${STUDYBOX_WIFI_INTERFACE:-wlan0}"
setup_ssid="${STUDYBOX_SETUP_SSID:-StudyBox-Setup}"
setup_password="${STUDYBOX_SETUP_PASSWORD:-StudyBoxSetup!26}"
setup_address="${STUDYBOX_SETUP_ADDRESS:-10.42.0.1/24}"
setup_dir="/run/studybox-wifi-fallback"

is_connected() {
  wpa_cli -i "$interface" status 2>/dev/null | awk -F= '$1 == "wpa_state" { found = ($2 == "COMPLETED") } END { exit found ? 0 : 1 }'
}

stop_fallback() {
  if [[ -f "$setup_dir/hostapd.pid" ]]; then kill "$(cat "$setup_dir/hostapd.pid")" 2>/dev/null || true; fi
  if [[ -f "$setup_dir/dnsmasq.pid" ]]; then kill "$(cat "$setup_dir/dnsmasq.pid")" 2>/dev/null || true; fi
  rm -rf "$setup_dir"
}

if [[ "${1:-start}" == "stop" ]]; then
  stop_fallback
  exit 0
fi

# Clear a previous AP instance before checking the normal Wi-Fi connection.
# hostapd and dnsmasq run as background daemons and can outlive a prior boot.
stop_fallback

for ((second = 0; second < ${STUDYBOX_WIFI_FALLBACK_WAIT_SECONDS:-75}; second += 5)); do
  if is_connected; then exit 0; fi
  sleep 5
done
if is_connected; then exit 0; fi

mkdir -p "$setup_dir"
systemctl stop netplan-wpa-wlan0.service 2>/dev/null || true
ip addr flush dev "$interface"
ip addr add "$setup_address" dev "$interface"
ip link set "$interface" up

cat > "$setup_dir/hostapd.conf" <<EOF
interface=$interface
driver=nl80211
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
EOF

cat > "$setup_dir/dnsmasq.conf" <<EOF
interface=$interface
bind-interfaces
dhcp-range=10.42.0.10,10.42.0.100,255.255.255.0,12h
address=/#/10.42.0.1
EOF

hostapd -B -P "$setup_dir/hostapd.pid" "$setup_dir/hostapd.conf"
dnsmasq --conf-file="$setup_dir/dnsmasq.conf" --pid-file="$setup_dir/dnsmasq.pid"
logger -t studybox-wifi-fallback "Started $setup_ssid at ${setup_address%/*}; configure Wi-Fi at http://${setup_address%/*}:5173"
