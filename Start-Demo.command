#!/bin/bash
# ===========================================================
#  KidSafe - DEMO mode (macOS)
#
#  Just double-click this file.
#  The first run checks for Node.js and Python (offering to
#  install them) and downloads everything else. Later runs go
#  straight to starting the app.
#
#  If macOS refuses to open it, run this once in Terminal:
#      chmod +x "Start-Demo.command"
# ===========================================================

cd "$(dirname "$0")" || exit 1

echo
echo "  ==========================================="
echo "    KidSafe - Demo mode"
echo "  ==========================================="
echo

finish() {
  echo
  read -n 1 -s -r -p "Press any key to close this window..."
  echo
  exit "${1:-0}"
}

bash script/bootstrap.sh || finish 1

echo "  Starting KidSafe in demo mode..."
echo
echo "  When it says \"serving on port\", open:  http://127.0.0.1:5050"
echo "  Then click \"Try the demo - no phone needed\"."
echo
echo "  Press Ctrl+C in this window to stop."
echo
npm run demo

finish 0
