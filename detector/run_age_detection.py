import cv2
import mediapipe as mp
from transformers import AutoImageProcessor, AutoModelForImageClassification
from PIL import Image
import torch
import time
from collections import deque
import os
import sys
import subprocess
import requests

# Parent notification is handled by the server, which sends a OneSignal web push
# the moment it receives a CHILD_ONLY alert. (This script used to send email via
# hardcoded Gmail credentials; that path was disabled and has been removed.)

# ================= DASHBOARD =================
# Local KidSafe dashboard server (override with the ALERT_URL env var; the
# server sets it automatically when it launches this script).
# 127.0.0.1 rather than "localhost": on Windows the name resolves to IPv6 ::1
# first and the server binds IPv4 only, costing ~2s per request before failover.
ALERT_URL = os.environ.get(
    "ALERT_URL",
    "http://127.0.0.1:5050/receive-alert"
)

# Per-account key from the dashboard's Settings page ("מפתח מכשיר").
# Paste it here (or set the DEVICE_KEY env var) so alerts reach YOUR account.
DEVICE_KEY = os.environ.get("DEVICE_KEY", "")

# Whether teenagers (13-20) count as a responsible supervisor. Controlled by the
# per-parent toggle in the dashboard and passed in via the TEENS_MATURE env var.
TEENS_MATURE = os.environ.get("TEENS_MATURE", "0") == "1"

# Live settings: poll the dashboard so toggling the teen setting takes effect
# immediately, without restarting the camera.
CONFIG_URL = ALERT_URL.replace("/receive-alert", "/device-config")
CONFIG_INTERVAL = 5  # seconds


def refresh_config():
    global TEENS_MATURE
    try:
        r = requests.get(CONFIG_URL, params={"device_key": DEVICE_KEY}, timeout=3)
        if r.ok:
            TEENS_MATURE = bool(r.json().get("teens_mature", TEENS_MATURE))
    except Exception:
        pass


def play_alarm():
    """Sound the local alarm. Each OS exposes a different mechanism, and all of
    these are non-blocking so the capture loop keeps running while it plays."""
    try:
        if sys.platform == "darwin":
            subprocess.Popen(
                ["afplay", "/System/Library/Sounds/Ping.aiff"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return
        if sys.platform == "win32":
            import winsound
            winsound.PlaySound(
                "SystemExclamation", winsound.SND_ALIAS | winsound.SND_ASYNC
            )
            return
        # Linux: try the usual players, fall through to the terminal bell.
        for player in (["paplay", "/usr/share/sounds/freedesktop/stereo/bell.oga"],
                       ["aplay", "-q", "/usr/share/sounds/alsa/Front_Center.wav"]):
            try:
                subprocess.Popen(
                    player, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                return
            except FileNotFoundError:
                continue
    except Exception as e:
        print("Alarm sound unavailable:", e)
    # Always make *some* noise — this is the in-car warning.
    print("\a", end="", flush=True)


def classify_frame(detected):
    """Decide a frame's status from the detected age labels.

    - Child (0-12) always needs supervision.
    - Teenager (13-20) may always stay ALONE safely; and only if TEENS_MATURE
      they may also supervise a younger child.
    - Adults (21+) always supervise.

    Returns "Child" (alert-worthy), "Adult" (safe), or "None" (nobody)."""
    child_present = any(l.startswith("Child") for l in detected)
    teen_present = any(l.startswith("Teenager") for l in detected)
    adult_present = any(l.startswith(("Adult", "Middle Age", "Aged")) for l in detected)
    supervisor_present = adult_present or (teen_present and TEENS_MATURE)

    # Alert only when a young child is present without a qualifying supervisor.
    if child_present and not supervisor_present:
        return "Child"
    # A teen alone (or any supervisor) is safe.
    if supervisor_present or teen_present:
        return "Adult"
    return "None"

def send_dashboard_alert(status, message):
    try:
        requests.post(
            ALERT_URL,
            json={
                "status": status,
                "message": message,
                "timestamp": int(time.time()),
                "device_key": DEVICE_KEY
            },
            timeout=5
        )

        print("Alert sent to dashboard")

    except Exception as e:
        print("Dashboard error:", e)

# ================= AGE MODEL =================
model_name = "prithivMLmods/open-age-detection"

print("Loading AI model...")

processor = AutoImageProcessor.from_pretrained(model_name)
model = AutoModelForImageClassification.from_pretrained(model_name)

# Console output stays ASCII: when stdout is a pipe (which it is when the
# server launches this script) Windows uses a legacy codepage, and printing an
# emoji there raises UnicodeEncodeError.
print("Model loaded")

# ================= MEDIAPIPE =================
mp_face = mp.solutions.face_detection.FaceDetection(
    model_selection=0,
    min_detection_confidence=0.6
)

# ================= CAMERA =================
# Try a few camera indices (0 = built-in camera, 1 = external/Continuity).
# Override with the CAMERA_INDEX env var to force a specific one.
#
# On Windows, ask for DirectShow explicitly: OpenCV's default (MSMF) backend can
# take many seconds to open a webcam and often fails on indices that do work.
CAPTURE_API = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY

cap = None
forced = os.environ.get("CAMERA_INDEX")
# Try the requested camera first, then fall back to the others if it can't open
# (e.g. a Continuity/iPhone camera that isn't currently available to OpenCV).
if forced is not None:
    forced = int(forced)
    indices = [forced] + [i for i in [0, 1, 2] if i != forced]
else:
    indices = [0, 1, 2]

for idx in indices:
    candidate = cv2.VideoCapture(idx, CAPTURE_API)
    if candidate.isOpened():
        cap = candidate
        print(f"Camera started (index {idx})")
        break
    candidate.release()

if cap is None:
    print("Camera not available. Check that no other app is using it, and that "
          "camera access is allowed for desktop apps.")
    sys.exit(1)

# ================= DECISION PARAMS =================
WINDOW_SECONDS = 10
SAMPLE_INTERVAL = 0.5
CHILD_RATIO_THRESHOLD = 0.7
ALARM_INTERVAL = 3
ALERT_INTERVAL = 10

history = deque()

last_sample = 0
last_alarm = 0
last_alert = 0
last_config = 0

last_status = None

# ================= MAIN LOOP =================
while True:

    ret, frame = cap.read()

    if not ret:
        break

    # Mirror the feed so it behaves like a selfie view.
    frame = cv2.flip(frame, 1)

    now = time.time()

    # Refresh live settings (e.g. the teen toggle) without a restart.
    if now - last_config >= CONFIG_INTERVAL:
        last_config = now
        refresh_config()

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    results = mp_face.process(rgb)

    detected = []

    # ================= FACE DETECTION =================
    if results.detections:

        for det in results.detections:

            bbox = det.location_data.relative_bounding_box

            h, w, _ = frame.shape

            x = int(bbox.xmin * w)
            y = int(bbox.ymin * h)

            bw = int(bbox.width * w)
            bh = int(bbox.height * h)

            x = max(0, x)
            y = max(0, y)

            bw = min(bw, w - x)
            bh = min(bh, h - y)

            face = frame[y:y+bh, x:x+bw]

            if face.size == 0:
                continue

            # ================= AGE DETECTION =================
            face_pil = Image.fromarray(
                cv2.cvtColor(face, cv2.COLOR_BGR2RGB)
            )

            inputs = processor(
                images=face_pil,
                return_tensors="pt"
            )

            with torch.no_grad():
                outputs = model(**inputs)

            label = model.config.id2label[
                outputs.logits.argmax(-1).item()
            ]

            detected.append(label)

            # ================= DRAW =================
            cv2.rectangle(
                frame,
                (x, y),
                (x+bw, y+bh),
                (0, 255, 0),
                2
            )

            cv2.putText(
                frame,
                label,
                (x, y-10),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 255, 0),
                2
            )

    # ================= SAMPLING =================
    if now - last_sample >= SAMPLE_INTERVAL:

        last_sample = now

        history.append((classify_frame(detected), now))

    while history and now - history[0][1] > WINDOW_SECONDS:
        history.popleft()

    # ================= DECISION =================
    status = "UNKNOWN"

    if len(history) > 5:

        labels = [h[0] for h in history]

        ratio = labels.count("Child") / len(labels)

        adult = "Adult" in labels

        if ratio >= CHILD_RATIO_THRESHOLD and not adult:
            status = "CHILD_ONLY"

        elif adult:
            status = "SAFE"

    # ================= ACTIONS =================
    if status == "CHILD_ONLY":

        cv2.putText(
            frame,
            "WARNING: CHILD ONLY",
            (40, 70),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.2,
            (0, 0, 255),
            3
        )

        # ===== ALARM SOUND =====
        if now - last_alarm >= ALARM_INTERVAL:

            play_alarm()

            last_alarm = now

        # ===== DASHBOARD =====
        if now - last_alert >= ALERT_INTERVAL:

            send_dashboard_alert(
                "CHILD_ONLY",
                "Child alone detected"
            )

            last_alert = now

            last_status = "CHILD_ONLY"

    elif status == "SAFE" and last_status != "SAFE":

        send_dashboard_alert(
            "SAFE",
            "Adult detected, system safe"
        )

        last_status = "SAFE"

    # ================= SHOW =================
    cv2.imshow("KidSafe - Camera", frame)

    # ESC to exit
    if cv2.waitKey(1) & 0xFF == 27:
        break

# ================= CLEANUP =================
cap.release()
cv2.destroyAllWindows()
