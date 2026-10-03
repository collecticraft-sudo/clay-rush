#!/bin/bash
# Clay Rush launcher. Double-click this file in Finder (or run ./start.command in Terminal).
# It starts the local game server (if it is not already running) and opens Google Chrome on it.
# Before that it builds the native Bluetooth bridge (bridge/build.sh, non-fatal): the recommended way to connect the Joy-Con.
# Start the game from THIS launcher (Terminal): macOS asks for the Bluetooth permission of the app that started the server.
# It never uses sudo and never changes any system setting.

cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8141}"
URL="http://localhost:${PORT}"
HEALTH="${URL}/__health"

pause_and_exit() {
  echo
  echo "Press Enter to close this window."
  read -r _
  exit "${1:-1}"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found on this Mac."
  echo "Install it once with Homebrew:   brew install node"
  echo "(or download it from https://nodejs.org), then double-click start.command again."
  pause_and_exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "Node.js $(node --version) is too old: version 22 or newer is needed."
  echo "Update it with:   brew upgrade node"
  pause_and_exit 1
fi

# Native Bluetooth bridge (the recommended way to connect the Joy-Con: any browser will do, Web Bluetooth is not needed). The game talks to the
# controller through a small native helper (bridge/joycon-bridge.m) that server.js starts when the player asks for it. It is compiled here,
# once, with clang from Apple's Command Line Tools; the step is fast when nothing changed and it can NEVER stop the launcher: without the
# tools the game still works with the mouse and the simulator (and the Joy-Con through Chrome's Web Bluetooth). Opt out with
# JOYCON_NO_BRIDGE=1. macOS asks for the Bluetooth permission of the app that started the server, which is Terminal when you use this
# launcher (the supported way).
if [ -z "${JOYCON_NO_BRIDGE:-}" ] && [ -f "bridge/build.sh" ]; then
  if bash bridge/build.sh; then
    echo "The first time you connect a Joy-Con through the native bridge, macOS asks whether Terminal may use Bluetooth: choose Allow."
    echo "(If you chose Don't Allow: System Settings > Privacy & Security > Bluetooth > switch Terminal on, then try again.)"
  else
    echo
    echo "NOTE: the native Bluetooth bridge is not available (see the message above). The game still starts and works with the mouse and"
    echo "the simulator; the Joy-Con can still be tried through Chrome's Web Bluetooth. To get the bridge: xcode-select --install, then start"
    echo "the game again."
    echo
  fi
fi

is_up() {
  curl -fsS --max-time 1 "${HEALTH}" 2>/dev/null | grep -q '"name":"clay-shooter"'
}

SERVER_PID=""
# Stop every background job this launcher started (the server it started, the keep-awake helper, the idle sleep).
# The job TABLE is used instead of variables holding PIDs: a Ctrl+C that lands between "cmd &" and "PID=$!" would
# otherwise leave a child behind (an orphaned "sleep" also kept the stdout pipe of the caller open forever).
cleanup() {
  trap - EXIT INT TERM HUP
  # shellcheck disable=SC2046
  kill $(jobs -p) 2>/dev/null
  if [ -n "${SERVER_PID}" ]; then
    wait "${SERVER_PID}" 2>/dev/null
  fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM HUP

if is_up; then
  echo "Clay Rush is already running at ${URL}"
else
  PORT="${PORT}" node server.js &
  SERVER_PID=$!
  # wait until the server answers (10 s at most)
  for _ in $(seq 1 50); do
    if is_up; then break; fi
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
      echo "The server stopped right after starting. See the message above."
      SERVER_PID=""
      pause_and_exit 1
    fi
    sleep 0.2
  done
  if ! is_up; then
    echo "The server did not answer within 10 seconds."
    pause_and_exit 1
  fi
fi

# Keep the display awake while the game window is open. A Joy-Con talks to Chrome over Bluetooth, which does not count as
# keyboard or mouse activity, so a player who only swings the sword would otherwise see the Mac dim and sleep the display,
# which pauses the game. caffeinate only holds a power assertion for as long as this launcher lives (-w $$): it changes
# no system setting and ends by itself when this window closes. Opt out with JOYCON_NO_CAFFEINATE=1.
KEEP_AWAKE_STARTED=""
if [ -z "${JOYCON_NO_CAFFEINATE:-}" ] && command -v caffeinate >/dev/null 2>&1; then
  caffeinate -di -w "$$" >/dev/null 2>&1 &
  KEEP_AWAKE_STARTED="1"
fi

if [ -d "/Applications/Google Chrome.app" ] || [ -d "${HOME}/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "${URL}"
else
  echo "WARNING: Google Chrome was not found. Opening the default browser instead."
  echo "The native Bluetooth bridge works in any browser; only the Web Bluetooth path (the second button) needs Chrome."
  open "${URL}"
fi

echo
echo "Clay Rush is open at ${URL}"
if [ -n "${KEEP_AWAKE_STARTED}" ]; then
  echo "The Mac will not dim or sleep the display while this window stays open."
fi
echo "Press Ctrl+C in this window to quit (this stops the server)."
if [ -n "${SERVER_PID}" ]; then
  wait "${SERVER_PID}"
else
  # the server was already running (started elsewhere): just keep the window open until Ctrl+C
  # (sleep runs in the background and the shell waits for it, so the Ctrl+C trap fires at once;
  # its output is detached so that it can never hold this script's pipes open)
  while true; do
    sleep 3600 >/dev/null 2>&1 &
    wait $!
  done
fi
