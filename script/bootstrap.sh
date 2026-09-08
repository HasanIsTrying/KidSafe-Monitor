#!/bin/bash
# ===========================================================
#  Shared first-run bootstrap for the macOS launchers.
#
#  Checks Node.js and Python (offering to install them), then
#  installs the project's own dependencies if they're missing.
#
#  Exit 0 = ready to start.  Exit 1 = caller should stop.
#  The caller has already cd'd to the project root.
# ===========================================================

ask() {
  # ask "question" -> 0 if the user said yes
  local reply
  read -r -p "     $1 [y/N] " reply
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# ---------------- Node.js ----------------
if ! command -v npm >/dev/null 2>&1; then
  echo "  [X] Node.js was not found - KidSafe needs it to run."
  echo
  if command -v brew >/dev/null 2>&1; then
    echo "      Homebrew can install it for you."
    echo
    if ask "Install Node.js with Homebrew now?"; then
      echo
      if brew install node; then
        echo
        echo "  Node.js installed. Starting up..."
      fi
    fi
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo
    echo "      Install Node.js (the LTS build) from https://nodejs.org"
    echo "      then double-click the launcher again."
    open "https://nodejs.org/en/download" 2>/dev/null
    exit 1
  fi
fi

# ---------------- Python 3 ----------------
PY=""
for candidate in python3.12 python3.11 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' 2>/dev/null; then
    PY="$candidate"
    break
  fi
done

if [ -z "$PY" ]; then
  echo "  [X] Python 3 was not found - KidSafe needs it to run."
  echo
  if command -v brew >/dev/null 2>&1; then
    echo "      Homebrew can install it for you. This installs Python 3.12,"
    echo "      which the camera libraries support (the very newest Python"
    echo "      often has no MediaPipe build yet)."
    echo
    if ask "Install Python 3.12 with Homebrew now?"; then
      echo
      brew install python@3.12
      for candidate in python3.12 python3; do
        if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
      done
    fi
  fi

  if [ -z "$PY" ]; then
    echo
    echo "      Install Python from https://www.python.org/downloads/"
    echo "      then double-click the launcher again."
    open "https://www.python.org/downloads/" 2>/dev/null
    exit 1
  fi
fi

# ------------- Project dependencies -------------
#  tsx is what every npm script runs through, so checking for it catches a
#  half-finished "npm install" that would otherwise fail later with
#  "tsx: command not found".
if [ ! -f "node_modules/tsx/package.json" ] ||
   [ ! -f "node_modules/vite/package.json" ] ||
   [ ! -f ".setup-complete" ]; then
  echo "  Installing everything KidSafe needs. This downloads several"
  echo "  hundred MB and can take a few minutes. It only happens once."
  echo
  if ! "$PY" script/setup.py --venv; then
    echo
    echo "  [X] Setup did not finish. Scroll up to see what failed."
    echo
    echo "      If it failed on mediapipe or torch, your Python is too new."
    echo "      Install Python 3.12 and try again:"
    echo "          brew install python@3.12"
    exit 1
  fi
  echo done > .setup-complete
  echo
  echo "  Setup finished."
  echo
fi

exit 0
