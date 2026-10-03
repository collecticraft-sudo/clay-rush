#!/bin/bash
# Build the native Bluetooth helper (bridge/joycon-bridge.m) with clang. `npm run build:bridge` runs this script.
#
#   bridge/build.sh            build if the binary is missing or older than its sources, otherwise do nothing
#   bridge/build.sh --force    always rebuild
#   bridge/build.sh --check    only say whether this Mac can build the helper (exit 0 = yes, 1 = no); builds nothing
#
# Exit codes: 0 built or already up to date, 1 cannot build (not macOS, no compiler, sources missing), 2 the compiler failed,
# 3 the new binary failed its own --selftest (it is removed, so a broken helper is never used).
#
# Swift is not used on purpose: on this Mac the Swift toolchain is broken by a stale module map in the Command Line Tools,
# while plain clang compiles Objective-C fine. Environment overrides (tests): JOYCON_BRIDGE_CLANG (compiler path),
# JOYCON_BRIDGE_BUILD_DIR (output folder, default bridge/build). The script never uses sudo and changes no system setting.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${HERE}/joycon-bridge.m"
PLIST="${HERE}/Info.plist"
OUT_DIR="${JOYCON_BRIDGE_BUILD_DIR:-${HERE}/build}"
OUT="${OUT_DIR}/joycon-bridge"
SELF="${HERE}/build.sh"

MODE="build"
case "${1:-}" in
  --force) MODE="force" ;;
  --check) MODE="check" ;;
  "") ;;
  *) echo "usage: bridge/build.sh [--force | --check]" >&2; exit 1 ;;
esac

say() { [ "${MODE}" = "check" ] || echo "bridge: $*"; }
fail() {
  # $1 exit code, rest: message
  local code="$1"; shift
  if [ "${MODE}" = "check" ]; then echo "cannot-build: $*"; else echo "bridge: $*" >&2; fi
  exit "${code}"
}

[ "$(uname -s)" = "Darwin" ] || fail 1 "the native Bluetooth bridge only works on macOS (CoreBluetooth)."
[ -f "${SRC}" ] && [ -f "${PLIST}" ] || fail 1 "the sources are missing (expected ${SRC} and ${PLIST})."

# Find clang. On a Mac without the Command Line Tools, /usr/bin/clang is only a stub that opens an install dialog, so it is never
# run blindly: `xcode-select -p` answers silently whether a developer directory exists.
find_clang() {
  if [ -n "${JOYCON_BRIDGE_CLANG:-}" ]; then
    [ -x "${JOYCON_BRIDGE_CLANG}" ] && echo "${JOYCON_BRIDGE_CLANG}"
    return
  fi
  local dev
  dev="$(xcode-select -p 2>/dev/null)" || return 1
  local c
  for c in "${dev}/usr/bin/clang" "${dev}/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"; do
    if [ -x "${c}" ]; then echo "${c}"; return 0; fi
  done
  return 1
}

CLANG="$(find_clang)"
if [ -z "${CLANG}" ]; then
  fail 1 "clang was not found. The bridge needs Apple's Command Line Tools: install them once with   xcode-select --install   (a macOS dialog opens), wait for it to finish, then start the game again. Without the bridge the game still works with the mouse and the simulator."
fi

if [ "${MODE}" = "check" ]; then
  echo "can-build"
  exit 0
fi

needs_build() {
  [ "${MODE}" = "force" ] && return 0
  [ -x "${OUT}" ] || return 0
  [ "${SRC}" -nt "${OUT}" ] && return 0
  [ "${PLIST}" -nt "${OUT}" ] && return 0
  [ "${SELF}" -nt "${OUT}" ] && return 0
  return 1
}

if ! needs_build; then
  say "up to date (${OUT})"
  exit 0
fi

mkdir -p "${OUT_DIR}" || fail 1 "cannot create ${OUT_DIR}."

# The SDK path: a clang taken straight from the Command Line Tools does not find the system headers without it.
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)"
SDK_ARGS=()
[ -n "${SDK}" ] && SDK_ARGS=(-isysroot "${SDK}")

# Compile to a private temporary file and move it into place in one step, so a second build running at the same time (or a
# failed one) can never leave a half-written helper behind.
TMP="${OUT_DIR}/.joycon-bridge.$$.tmp"
cleanup() { rm -f "${TMP}" "${TMP}.log"; }
trap cleanup EXIT

say "compiling ${SRC##*/} with ${CLANG} ..."
if ! "${CLANG}" ${SDK_ARGS[@]+"${SDK_ARGS[@]}"} -fobjc-arc -O2 -Wall -Wextra -mmacosx-version-min=11.0 \
      -framework Foundation -framework CoreBluetooth \
      -sectcreate __TEXT __info_plist "${PLIST}" \
      "${SRC}" -o "${TMP}" >"${TMP}.log" 2>&1; then
  echo "bridge: the compiler failed. Its output:" >&2
  sed 's/^/bridge:   /' "${TMP}.log" >&2
  echo "bridge: the game still works with the mouse and the simulator. If the Command Line Tools look broken, reinstall them with   xcode-select --install" >&2
  exit 2
fi
# warnings are shown (they are not errors: a newer SDK must never stop the build)
[ -s "${TMP}.log" ] && sed 's/^/bridge:   /' "${TMP}.log"

chmod 755 "${TMP}"
# The helper must pass its own checks before it is put in place. --selftest never touches Bluetooth.
if ! "${TMP}" --selftest >"${TMP}.log" 2>&1; then
  echo "bridge: the freshly built helper failed its --selftest:" >&2
  sed 's/^/bridge:   /' "${TMP}.log" >&2
  exit 3
fi

mv -f "${TMP}" "${OUT}" || fail 1 "cannot move the helper into ${OUT}."
say "built ${OUT}"
exit 0
