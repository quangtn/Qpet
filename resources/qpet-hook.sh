#!/bin/sh

# QPet lifecycle hooks must never block or alter an agent session. Every failure
# path is intentionally silent and successful from the caller's perspective.
set +e
export LC_ALL=C

provider=${1-}
case "$provider" in
  codex|claude|cursor|hermes|claudeclaw) ;;
  *) exit 0 ;;
esac

support_dir=${QPET_SUPPORT_DIR:-"${HOME}/Library/Application Support/QPet"}
endpoint_file="${support_dir}/event-endpoint.json"
token_file="${support_dir}/event-token"

[ -r "$endpoint_file" ] || exit 0
[ -r "$token_file" ] || exit 0

base_url=$(/usr/bin/plutil -extract baseUrl raw -o - "$endpoint_file" 2>/dev/null)
case "$base_url" in
  http://127.0.0.1:*) ;;
  *) exit 0 ;;
esac

port=${base_url#http://127.0.0.1:}
case "$port" in
  ''|*[!0-9]*) exit 0 ;;
esac
[ "$port" -ge 1 ] 2>/dev/null || exit 0
[ "$port" -le 65535 ] 2>/dev/null || exit 0

token_size=$(/usr/bin/wc -c < "$token_file" 2>/dev/null | /usr/bin/tr -d ' ')
case "$token_size" in
  ''|*[!0-9]*) exit 0 ;;
esac
[ "$token_size" -ge 16 ] 2>/dev/null || exit 0
[ "$token_size" -le 512 ] 2>/dev/null || exit 0

IFS= read -r token < "$token_file"
case "$token" in
  ''|*[!A-Za-z0-9._~-]*) exit 0 ;;
esac

# Command substitution removes only trailing newlines, which is safe for the
# JSON hook payload while keeping sensitive event data out of persistent files.
payload=$(/usr/bin/head -c 262145)
payload_size=$(printf '%s' "$payload" | /usr/bin/wc -c | /usr/bin/tr -d ' ')
[ "$payload_size" -le 262144 ] 2>/dev/null || exit 0

printf '%s' "$payload" | /usr/bin/curl \
  --silent \
  --output /dev/null \
  --connect-timeout 1 \
  --max-time 1 \
  --request POST \
  --header "Authorization: Bearer ${token}" \
  --header 'Content-Type: application/json' \
  --header "X-QPet-Provider: ${provider}" \
  --data-binary @- \
  "${base_url}/events" >/dev/null 2>&1

exit 0
