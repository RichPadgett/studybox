#!/usr/bin/env bash
set -u

# This watchdog is deliberately conservative. systemd owns ordinary process
# restarts; this script handles services that are alive but no longer serving.
STATE_DIR="${STUDYBOX_WATCHDOG_STATE_DIR:-/var/lib/studybox}"
STATE_FILE="$STATE_DIR/watchdog-state"
PUBLIC_URL="${STUDYBOX_PUBLIC_URL:-https://studybox.enochscalendar.com/}"
COOLDOWN_SECONDS="${STUDYBOX_WATCHDOG_COOLDOWN_SECONDS:-120}"
FAILURE_THRESHOLD="${STUDYBOX_WATCHDOG_FAILURE_THRESHOLD:-2}"

mkdir -p "$STATE_DIR"
touch "$STATE_FILE"

get_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { value = substr($0, index($0, "=") + 1) } END { print value }' "$STATE_FILE"
}

set_value() {
  local key="$1" value="$2" temporary
  temporary="$STATE_FILE.tmp.$$.${RANDOM}"
  awk -F= -v key="$key" -v value="$value" '
    $1 == key { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$STATE_FILE" > "$temporary"
  mv "$temporary" "$STATE_FILE"
}

check_service() {
  local name="$1" url="$2" count last now
  now="$(date +%s)"
  if systemctl is-active --quiet "$name" && curl -fsS --max-time 6 "$url" >/dev/null; then
    set_value "${name}_failures" 0
    return 0
  fi

  count="$(get_value "${name}_failures")"
  count="${count:-0}"
  count=$((count + 1))
  set_value "${name}_failures" "$count"
  logger -t studybox-watchdog "$name health check failed ($count/$FAILURE_THRESHOLD)"

  last="$(get_value "${name}_last_restart")"
  last="${last:-0}"
  if (( count >= FAILURE_THRESHOLD && now - last >= COOLDOWN_SECONDS )); then
    logger -t studybox-watchdog "restarting unhealthy $name"
    if systemctl restart "$name"; then
      set_value "${name}_last_restart" "$now"
      set_value "${name}_failures" 0
      set_value "last_action" "restarted:$name"
      set_value "last_action_at" "$now"
    fi
  fi
  return 1
}

check_service "studybox-api.service" "http://127.0.0.1:4000/api/snapshot" || true
check_service "studybox-web.service" "http://127.0.0.1:5173/" || true
check_service "cloudflared.service" "$PUBLIC_URL" || true

set_value "last_check_at" "$(date +%s)"
