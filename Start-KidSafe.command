#!/bin/bash
# ===========================================================
#  KidSafe - REAL mode (macOS)
#
#  Just double-click this file.
#  The first run checks for Node.js and Python (offering to
#  install them) and downloads everything else. Later runs go
#  straight to starting the app.
#
#  Real mode needs auth_config.json (SMS + push credentials).
#  Without it, use Start-Demo.command instead.
#
#  If macOS refuses to open it, run this once in Terminal:
#      chmod +x "Start-KidSafe.command"
# ===========================================================

cd "$(dirname "$0")" || exit 1

echo
echo "  ==========================================="
echo "    KidSafe"
echo "  ==========================================="
echo

finish() {
  echo
  read -n 1 -s -r -p "Press any key to close this window..."
  echo
  exit "${1:-0}"
}

bash script/bootstrap.sh || finish 1

# --- Real mode needs credentials ---------------------------
if [ ! -f "auth_config.json" ]; then
  echo "  [!] auth_config.json was not found."
  echo
  echo "      Real mode needs SMS and push credentials to send login"
  echo "      codes and alerts. Copy auth_config.example.json to"
  echo "      auth_config.json and fill in your own values."
  echo "      See section 2 of README.md."
  echo
  echo "      Without it the app falls back to the demo account."
  echo
  echo "      Starting anyway in 5 seconds - close this window to cancel."
  sleep 5
fi

echo "  Starting KidSafe..."
echo
echo "  When it says \"serving on port\", open:  http://127.0.0.1:5050"
echo "  A public HTTPS link is printed too - use that one on a phone,"
echo "  because push notifications do not work over localhost."
echo
echo "  Press Ctrl+C in this window to stop."
echo
npm run launch

finish 0
