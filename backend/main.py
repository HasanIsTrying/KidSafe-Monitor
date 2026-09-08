import logging
from flask import Flask, jsonify, request
import time
import os
import re
import sys
import json
import secrets
import threading
import subprocess
import requests

import store

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

# Accounts, sessions, alerts and open emergencies all live in SQLite now
# (store.py) rather than a JSON file plus in-memory dicts, so nothing is lost
# on restart and concurrent writes can't corrupt it.
_store_lock = store.store_lock

# Once a CHILD_ONLY alert opens, the emergency state stays open for 2 minutes
# even if no further alerts arrive (e.g. the child went out of frame). It is
# cleared only when an adult returns (a SAFE alert) or the parent acknowledges.
# If still open after ESCALATE_AFTER_SECONDS, the emergency contacts get an SMS.
ESCALATE_AFTER_SECONDS = int(os.environ.get("ESCALATE_AFTER_SECONDS", "120"))

# How often the escalation watcher checks. This is the precision of the deadline
# above: at the old 10s tick an alert promised "in 20 seconds" could take up to
# 30, because the watcher's cycle isn't aligned with when the alert opened.
# One second keeps it honest — the query is a tiny indexed lookup.
WATCHER_TICK_SECONDS = 1

# ================= DEMO ACCOUNT =================
# A public checkout of this repo has no 019 SMS credentials, so nobody can
# receive a login code — and no camera script, so no alert would ever fire.
# The demo account is the way in: a fixed, pre-made account that logs in with
# one click and can simulate the detection flow end to end.
DEMO_PHONE = "0500000000"
DEMO_NAME = "Demo Parent"
DEMO_DEVICE_KEY = "demo-device-key"
# Deliberately unroutable placeholders. Nothing is ever texted to these — see
# _is_demo_account() in the escalation path — so they can't reach a real person.
DEMO_CONTACTS = ["0500000001", "0500000002"]
# A fixed public landmark (Dizengoff Square, Tel Aviv) used for the demo's map
# link. The demo account is SHARED, so it must never hold a real person's
# position — one visitor's location would otherwise be shown to the next.
DEMO_LOCATION = {"lat": 32.0753, "lng": 34.7748}
# A demo viewer shouldn't have to stare at the screen for two minutes to watch
# the escalation fire. Real accounts keep the full 120s.
DEMO_ESCALATE_AFTER_SECONDS = int(os.environ.get("DEMO_ESCALATE_AFTER_SECONDS", "20"))


def _is_demo_account(phone):
    return phone == DEMO_PHONE


def demo_mode_enabled():
    """Whether the one-click demo login is offered.

    DEMO_MODE=1/0 forces it either way. Otherwise it turns itself on exactly
    when real auth is impossible — no 019 credentials means no OTP can be sent,
    which is the state of a fresh clone. A configured deployment (like the one
    with real accounts in auth_store.json) therefore has it off by default.
    """
    forced = os.environ.get("DEMO_MODE", "").strip().lower()
    if forced in ("1", "true", "yes", "on"):
        return True
    if forced in ("0", "false", "no", "off"):
        return False
    cfg = load_sms_config()
    return not (cfg["username"] and cfg["token"])

IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"

# This file lives in backend/; config and data files live at the project root.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Keep helper processes (the PowerShell camera query) from flashing a console
# window on Windows. No equivalent is needed — or accepted — elsewhere.
_NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WINDOWS else {}


def _default_camera_script():
    """Where to look for the detector when CAMERA_SCRIPT isn't set: the
    project's own detector/ directory first, then the Desktop (where it used to
    live). `expanduser` resolves the Desktop on Windows and macOS alike."""
    bundled = os.path.join(PROJECT_ROOT, "detector", "run_age_detection.py")
    if os.path.exists(bundled):
        return bundled
    return os.path.expanduser(os.path.join("~", "Desktop", "run_age_detection.py"))


# The age-detection camera script, launched on demand from the dashboard.
CAMERA_SCRIPT = os.environ.get("CAMERA_SCRIPT") or _default_camera_script()
camera_process = None   # subprocess.Popen of the running detector
camera_index = None     # which camera index it was started with

def _resolve_account_phone(data):
    """Map an incoming alert to an account.

    The camera script identifies its account with a `device_key`. As a
    convenience for a single-household setup, if exactly one account exists we
    attach unkeyed alerts to it. Otherwise the alert can't be routed.
    """
    device_key = (data.get("device_key") or "").strip()
    if device_key:
        return store.phone_for_device_key(device_key)
    return store.only_account_phone()


def _record_alert(phone, status, message, timestamp):
    """Store an alert against one account and drive its escalation state.

    Shared by the real camera detector (/receive-alert) and the demo simulator,
    so the demo exercises exactly the same code path rather than a mock of it.
    """
    with _store_lock:
        alert = store.add_alert(phone, status, message, timestamp)
        print(f"RECEIVED ALERT for {phone}: {alert}")

        opened = False
        # Track per-account escalation state for the alarm/SMS workflow.
        if status == "CHILD_ONLY":
            current = store.get_pending(phone)
            # Open a new emergency only if none is currently open for this account.
            if current is None or current.get("acknowledged"):
                store.open_pending(phone, alert["id"], message)
                opened = True
        elif status == "SAFE":
            # An adult returned — clear this account's emergency state.
            store.clear_pending(phone)

    if opened:
        # Notify the parent immediately via push (non-blocking).
        threading.Thread(
            target=send_push,
            args=(phone, "KidSafe Alert", "A child was left alone in the car!"),
            daemon=True,
        ).start()
    return alert


@app.route('/receive-alert', methods=['POST'])
def receive_alert():
    try:
        data = request.json
        if not data:
            return jsonify({"message": "Invalid JSON"}), 400

        # Simple validation
        required_fields = ['status', 'message', 'timestamp']
        if not all(field in data for field in required_fields):
            return jsonify({"message": "Missing fields"}), 400

        phone = _resolve_account_phone(data)
        if not phone:
            print(f"Alert could not be routed to an account: {data.get('device_key')}")
            return jsonify({"message": "Unknown device", "assigned": False}), 200

        alert = _record_alert(
            phone, data.get("status"), data.get("message"), data.get("timestamp")
        )
        return jsonify(alert), 200
    except Exception as e:
        print(f"Error processing alert: {e}")
        return jsonify({"message": "Internal Server Error"}), 500


@app.route('/alerts', methods=['GET'])
def get_alerts():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    return jsonify(store.list_alerts(session["phone"])), 200


@app.route('/device-config', methods=['GET'])
def device_config():
    """Live per-account settings for the camera script, keyed by device_key
    (so it can poll without a login token)."""
    phone = _resolve_account_phone({"device_key": request.args.get("device_key", "")})
    teens = store.get_teens_mature(phone) if phone else False
    return jsonify({"teens_mature": teens}), 200


# ================= AUTH (phone OTP via 019 SMS) =================

API_019_URL = "https://019sms.co.il/api"
SESSION_TTL_SECONDS = 365 * 24 * 60 * 60  # account/session saved for one year
CONFIG_PATH = os.path.join(PROJECT_ROOT, "auth_config.json")


def load_sms_config():
    """SMS019 credentials: env vars first, then auth_config.json (gitignored)."""
    cfg = {}
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        pass
    return {
        "username": os.environ.get("SMS019_USERNAME", cfg.get("sms019_username", "")),
        "source": os.environ.get("SMS019_SOURCE", cfg.get("sms019_source", "")),
        "token": os.environ.get("SMS019_TOKEN", cfg.get("sms019_token", "")),
    }


def normalize_phone(raw):
    """Return an Israeli mobile number as 05XXXXXXXX, or None if it looks invalid."""
    digits = re.sub(r"\D", "", raw or "")
    if digits.startswith("972"):
        digits = "0" + digits[3:]
    if not digits.startswith("0"):
        digits = "0" + digits
    # Israeli mobile: 05X + 7 digits = 10 digits
    if len(digits) != 10 or not digits.startswith("05"):
        return None
    return digits


def call_019(payload):
    cfg = load_sms_config()
    if not cfg["token"] or not cfg["username"]:
        raise RuntimeError("SMS019 credentials are not configured")
    resp = requests.post(
        API_019_URL,
        json=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cfg["token"],
        },
        timeout=15,
    )
    try:
        data = resp.json()
    except ValueError:
        data = {"status": -999, "message": resp.text}
    return data


def load_push_config():
    """OneSignal credentials: env vars first, then auth_config.json (git-ignored)."""
    cfg = {}
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        pass
    return {
        "app_id": os.environ.get("ONESIGNAL_APP_ID", cfg.get("onesignal_app_id", "")),
        "api_key": os.environ.get("ONESIGNAL_API_KEY", cfg.get("onesignal_api_key", "")),
    }


def send_push(phone, title, message):
    """Send a OneSignal web push to a parent's devices, targeted by external_id (phone)."""
    cfg = load_push_config()
    if not cfg["app_id"] or not cfg["api_key"]:
        print("Push skipped: OneSignal not configured")
        return
    try:
        resp = requests.post(
            "https://api.onesignal.com/notifications",
            headers={
                "Authorization": f"Key {cfg['api_key']}",
                "Content-Type": "application/json",
            },
            json={
                "app_id": cfg["app_id"],
                "target_channel": "push",
                "include_aliases": {"external_id": [phone]},
                "headings": {"en": title},
                "contents": {"en": message},
            },
            timeout=10,
        )
        print(f"Push to {phone}: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"Push failed for {phone}: {e}")


@app.route('/auth/request-code', methods=['POST'])
def request_code():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    phone = normalize_phone(data.get("phone"))
    if not name:
        return jsonify({"message": "Parent name is required"}), 400
    if not phone:
        return jsonify({"message": "Invalid phone number"}), 400

    cfg = load_sms_config()
    result = call_019({
        "send_otp": {
            "user": {"username": cfg["username"]},
            "phone": phone,
            "app_id": 1,
            "source": cfg["source"],
            "max_tries": 5,
            "valid_time": 10,
            "text": "Your KidSafe login code: [code]",
        }
    })
    if result.get("status") == 0:
        print(f"OTP sent to {phone} for {name}")
        return jsonify({"ok": True, "phone": phone}), 200
    print(f"OTP send failed: {result}")
    return jsonify({"message": "Failed to send the code", "detail": result.get("message")}), 502


@app.route('/auth/verify', methods=['POST'])
def verify_code():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    phone = normalize_phone(data.get("phone"))
    code = re.sub(r"\D", "", str(data.get("code") or ""))
    if not phone or not code:
        return jsonify({"message": "Missing details"}), 400

    cfg = load_sms_config()
    result = call_019({
        "validate_otp": {
            "user": {"username": cfg["username"]},
            "phone": phone,
            # Sent as a string: int() would strip a leading zero, so a code like
            # "012345" went out as 12345 and could never match. 019 takes either.
            "code": code,
            "app_id": 1,
            "service_type": "sms",
        }
    })
    if result.get("status") != 0:
        print(f"OTP validation failed for {phone}: {result}")
        return jsonify({
            "message": "Invalid or expired code",
            "detail": result.get("message"),
        }), 401

    now = int(time.time())
    with _store_lock:
        account = store.create_account(phone, name=name)
        if name and account["name"] != name:
            store.set_name(phone, name)
            account["name"] = name
        # Stable per-account key the camera script uses to route its alerts.
        if not account["device_key"]:
            device_key = secrets.token_hex(8)
            store.set_device_key(phone, device_key)
            account["device_key"] = device_key

        token = secrets.token_urlsafe(32)
        expires_at = now + SESSION_TTL_SECONDS
        store.create_session(token, phone, expires_at)

    return jsonify({
        "token": token,
        "name": account["name"],
        "phone": phone,
        "expires_at": expires_at,
    }), 200


def _ensure_demo_account():
    """Create the demo account on first use, and keep its fixed fields correct."""
    account = store.create_account(DEMO_PHONE, name=DEMO_NAME, device_key=DEMO_DEVICE_KEY)
    if account["name"] != DEMO_NAME:
        store.set_name(DEMO_PHONE, DEMO_NAME)
    if account["device_key"] != DEMO_DEVICE_KEY:
        store.set_device_key(DEMO_PHONE, DEMO_DEVICE_KEY)
    # Placeholder contacts so the escalation preview has something to show.
    if not account["emergency_contacts"]:
        store.set_contacts(DEMO_PHONE, DEMO_CONTACTS)
    # A fixed, public landmark — NOT the visitor's real position. The demo
    # account is shared, so capturing a real location here would show one
    # visitor's whereabouts to the next. Real accounts still auto-capture.
    if not account["location"]:
        store.set_location(DEMO_PHONE, DEMO_LOCATION["lat"], DEMO_LOCATION["lng"])
    return store.get_account(DEMO_PHONE)


@app.route('/auth/demo-status', methods=['GET'])
def demo_status():
    """Public: lets the login page decide whether to offer the demo button."""
    return jsonify({"enabled": demo_mode_enabled(), "phone": DEMO_PHONE}), 200


@app.route('/auth/demo', methods=['POST'])
def demo_login():
    """Log into the shared demo account without an SMS code."""
    if not demo_mode_enabled():
        return jsonify({"message": "Demo mode is disabled on this server"}), 403

    now = int(time.time())
    with _store_lock:
        account = _ensure_demo_account()
        token = secrets.token_urlsafe(32)
        expires_at = now + SESSION_TTL_SECONDS
        store.create_session(token, DEMO_PHONE, expires_at)

    print("Demo account login issued")
    return jsonify({
        "token": token,
        "name": account["name"],
        "phone": DEMO_PHONE,
        "expires_at": expires_at,
        "demo": True,
    }), 200


def _session_from_request():
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    if not token:
        return None, None
    session = store.get_session(token)  # drops the token if it has expired
    if not session:
        return None, None
    return token, session


@app.route('/auth/me', methods=['GET'])
def me():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    return jsonify({
        "name": session["name"],
        "phone": session["phone"],
        "expires_at": session["expires_at"],
        "demo": _is_demo_account(session["phone"]),
    }), 200


@app.route('/auth/logout', methods=['POST'])
def logout():
    token, _session = _session_from_request()
    if token:
        store.delete_session(token)
    return jsonify({"ok": True}), 200


# ================= ACCOUNT SETTINGS =================

MAX_EMERGENCY_CONTACTS = 5


def send_sms(phones, message):
    """Send a plain SMS to one or more phone numbers via the 019 gateway."""
    phones = [p for p in phones if p]
    if not phones:
        return {"status": -1, "message": "no recipients"}
    cfg = load_sms_config()
    result = call_019({
        "sms": {
            "user": {"username": cfg["username"]},
            "source": cfg["source"],
            "destinations": {"phone": phones},
            "message": message,
        }
    })
    return result


def account_public(account):
    return {
        "name": account.get("name", ""),
        "phone": account.get("phone", ""),
        "emergency_contacts": account.get("emergency_contacts", []),
        "location": account.get("location"),
        "device_key": account.get("device_key", ""),
        "teens_mature": bool(account.get("teens_mature", False)),
        "demo": _is_demo_account(account.get("phone", "")),
    }


@app.route('/account', methods=['GET'])
def get_account():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    account = store.get_account(session["phone"])
    if not account:
        return jsonify({"message": "Account not found"}), 404
    data = account_public(account)
    data["expires_at"] = session["expires_at"]
    return jsonify(data), 200


@app.route('/account/name', methods=['POST'])
def update_name():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    name = (request.json or {}).get("name", "").strip()
    if not name:
        return jsonify({"message": "Name is required"}), 400
    with _store_lock:
        if not store.account_exists(session["phone"]):
            return jsonify({"message": "Account not found"}), 404
        # Sessions read the name from the account, so there's nothing to sync.
        store.set_name(session["phone"], name)
    return jsonify({"ok": True, "name": name}), 200


@app.route('/account/contacts', methods=['POST'])
def update_contacts():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    raw = (request.json or {}).get("contacts", [])
    if not isinstance(raw, list):
        return jsonify({"message": "Invalid format"}), 400
    contacts = []
    for item in raw:
        phone = normalize_phone(item if isinstance(item, str) else item.get("phone"))
        if phone and phone not in contacts:
            contacts.append(phone)
    if len(contacts) > MAX_EMERGENCY_CONTACTS:
        return jsonify({"message": f"You can add up to {MAX_EMERGENCY_CONTACTS} contacts"}), 400
    with _store_lock:
        if not store.account_exists(session["phone"]):
            return jsonify({"message": "Account not found"}), 404
        store.set_contacts(session["phone"], contacts)
    return jsonify({"ok": True, "emergency_contacts": contacts}), 200


@app.route('/account/teens-mature', methods=['POST'])
def update_teens_mature():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    value = bool((request.json or {}).get("value"))
    with _store_lock:
        if not store.account_exists(session["phone"]):
            return jsonify({"message": "Account not found"}), 404
        store.set_teens_mature(session["phone"], value)
    return jsonify({"ok": True, "teens_mature": value}), 200


@app.route('/account/location', methods=['POST'])
def update_location():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    data = request.json or {}
    try:
        lat = float(data.get("lat"))
        lng = float(data.get("lng"))
    except (TypeError, ValueError):
        return jsonify({"message": "Invalid location"}), 400

    # The demo account is shared by every visitor, so storing a real position
    # there would expose one person's whereabouts to the next. Refuse, and keep
    # the fixed landmark. Enforced here so the browser can't bypass it.
    if _is_demo_account(session["phone"]):
        return jsonify({
            "ok": False,
            "message": "The demo account uses a fixed location and can't store a real one",
            "location": store.get_account(DEMO_PHONE)["location"],
        }), 200

    with _store_lock:
        if not store.account_exists(session["phone"]):
            return jsonify({"message": "Account not found"}), 404
        location = store.set_location(session["phone"], lat, lng)
    return jsonify({"ok": True, "location": location}), 200


@app.route('/account/phone/request', methods=['POST'])
def change_phone_request():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    phone = normalize_phone((request.json or {}).get("phone"))
    if not phone:
        return jsonify({"message": "Invalid phone number"}), 400
    cfg = load_sms_config()
    result = call_019({
        "send_otp": {
            "user": {"username": cfg["username"]},
            "phone": phone,
            "app_id": 1,
            "source": cfg["source"],
            "max_tries": 5,
            "valid_time": 10,
            "text": "Your KidSafe number-change code: [code]",
        }
    })
    if result.get("status") == 0:
        return jsonify({"ok": True, "phone": phone}), 200
    return jsonify({"message": "Failed to send the code", "detail": result.get("message")}), 502


@app.route('/account/phone/verify', methods=['POST'])
def change_phone_verify():
    _token, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    data = request.json or {}
    new_phone = normalize_phone(data.get("phone"))
    code = re.sub(r"\D", "", str(data.get("code") or ""))
    if not new_phone or not code:
        return jsonify({"message": "Missing details"}), 400

    cfg = load_sms_config()
    result = call_019({
        "validate_otp": {
            "user": {"username": cfg["username"]},
            "phone": new_phone,
            "code": code,  # string, to preserve a leading zero — see verify_code
            "app_id": 1,
            "service_type": "sms",
        }
    })
    if result.get("status") != 0:
        print(f"Phone-change validation failed for {new_phone}: {result}")
        return jsonify({
            "message": "Invalid or expired code",
            "detail": result.get("message"),
        }), 401

    with _store_lock:
        old_phone = session["phone"]
        if new_phone != old_phone and store.account_exists(new_phone):
            return jsonify({"message": "That number is already registered"}), 409
        if new_phone != old_phone:
            # Sessions, contacts and any open emergency follow the account via
            # ON UPDATE CASCADE; alerts are moved explicitly.
            store.rename_account(old_phone, new_phone)
    return jsonify({"ok": True, "phone": new_phone}), 200


# ================= ALERT ACK + ESCALATION =================

@app.route('/alerts/pending', methods=['GET'])
def get_pending():
    """Tells the dashboard whether this account has a CHILD_ONLY alert awaiting a response."""
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    phone = session["phone"]
    p = store.get_pending(phone)
    if not p:
        return jsonify({"pending": False}), 200
    # Reported even once acknowledged: the emergency is still open (the camera
    # hasn't seen an adult yet), it just no longer needs the parent's response.
    # The dashboard needs this to confirm the acknowledgement registered.
    return jsonify({
        "pending": True,
        "acknowledged": bool(p.get("acknowledged")),
        "id": p["id"],
        "message": p["message"],
        "age": int(time.time() - p["created_at"]),
        "escalated": p.get("escalated", False),
        "escalates_after": (
            DEMO_ESCALATE_AFTER_SECONDS
            if _is_demo_account(phone)
            else ESCALATE_AFTER_SECONDS
        ),
        "escalation_sms": p.get("escalation_sms"),
    }), 200


@app.route('/alerts/ack', methods=['POST'])
def ack_alert():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    store.acknowledge_pending(session["phone"])
    print(f"Alert acknowledged by {session['phone']}")
    return jsonify({"ok": True}), 200


# ---- Age classification for the demo preview -------------------------------
# Reuses the exact model the camera detector runs, so the age bands the browser
# preview shows are the real thing rather than a mock-up. Loaded lazily on the
# first request: a checkout without the ML packages simply reports it's
# unavailable and the preview falls back to unlabelled boxes.
AGE_MODEL_NAME = os.environ.get("AGE_MODEL", "prithivMLmods/open-age-detection")
MAX_FACE_IMAGE_BYTES = 400_000

_age_model = None
_age_processor = None
_age_model_failed = False
_age_model_lock = threading.Lock()


def _load_age_model():
    """True once the model is ready; False if the packages aren't installed."""
    global _age_model, _age_processor, _age_model_failed
    if _age_model is not None:
        return True
    if _age_model_failed:
        return False
    with _age_model_lock:
        if _age_model is not None:
            return True
        if _age_model_failed:
            return False
        try:
            from transformers import AutoImageProcessor, AutoModelForImageClassification
            print(f"Loading age model {AGE_MODEL_NAME} (first demo request, may take a moment)...")
            _age_processor = AutoImageProcessor.from_pretrained(AGE_MODEL_NAME)
            _age_model = AutoModelForImageClassification.from_pretrained(AGE_MODEL_NAME)
            print("Age model loaded")
            return True
        except Exception as e:
            print(f"Age model unavailable ({type(e).__name__}: {e})")
            print("  Fix: reinstall the detector packages with")
            print("       python script/setup.py --venv")
            print("  (the demo still works; only the age labels are missing)")
            _age_model_failed = True
            return False


@app.route('/demo/age', methods=['POST'])
def demo_age():
    """Classify one cropped face into an age band, for the demo preview."""
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    if not _is_demo_account(session["phone"]):
        return jsonify({"message": "Demo account only"}), 403

    raw = (request.json or {}).get("image", "")
    if not isinstance(raw, str) or not raw:
        return jsonify({"message": "No image"}), 400
    if "," in raw[:64]:          # strip a "data:image/jpeg;base64," prefix
        raw = raw.split(",", 1)[1]
    if len(raw) > MAX_FACE_IMAGE_BYTES:
        return jsonify({"message": "Image too large"}), 413

    if not _load_age_model():
        return jsonify({"available": False}), 200

    try:
        import base64
        from io import BytesIO
        import torch
        from PIL import Image

        image = Image.open(BytesIO(base64.b64decode(raw))).convert("RGB")
        inputs = _age_processor(images=image, return_tensors="pt")
        with torch.no_grad():
            outputs = _age_model(**inputs)
        label = _age_model.config.id2label[outputs.logits.argmax(-1).item()]
        return jsonify({"available": True, "label": label}), 200
    except Exception as e:
        print(f"Age classification failed: {e}")
        return jsonify({"available": False}), 200


@app.route('/demo/alert', methods=['POST'])
def demo_alert():
    """Simulate the camera detecting a child alone (or an adult returning).

    A public checkout has no camera script, so without this the demo dashboard
    would sit empty forever and the escalation could never be seen.
    """
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    if not _is_demo_account(session["phone"]):
        return jsonify({"message": "Only the demo account can simulate alerts"}), 403

    status = (request.json or {}).get("status", "CHILD_ONLY")
    if status not in ("CHILD_ONLY", "SAFE"):
        return jsonify({"message": "Invalid status"}), 400

    message = (
        "Demo: a child was detected alone in the vehicle"
        if status == "CHILD_ONLY"
        else "Demo: a supervising adult is present"
    )
    alert = _record_alert(session["phone"], status, message, int(time.time()))
    return jsonify(alert), 200


def _build_emergency_message(account):
    """Short alert text (kept to ~70 chars) plus a vehicle-location link if known."""
    contacts = list(account.get("emergency_contacts", []))
    location = account.get("location")
    message = "KidSafe alert: a child was left alone in the car! Please make contact immediately."
    if location:
        message += f" Location: https://maps.google.com/?q={location['lat']},{location['lng']}"
    return contacts, message


def escalation_watcher():
    """Background loop: for each account, if a CHILD_ONLY alert is unacknowledged
    for ESCALATE_AFTER_SECONDS, notify that account's emergency contacts by SMS
    (once). The demo account previews the message instead of sending it."""
    while True:
        time.sleep(WATCHER_TICK_SECONDS)
        now = time.time()
        for phone in store.pending_phones():
            deadline = (
                DEMO_ESCALATE_AFTER_SECONDS
                if _is_demo_account(phone)
                else ESCALATE_AFTER_SECONDS
            )
            with _store_lock:
                # Re-read under the lock: the parent may have acknowledged, or
                # an adult returned, since pending_phones() listed this account.
                p = store.get_pending(phone)
                if not p or p["acknowledged"] or p["escalated"]:
                    continue
                if now - p["created_at"] < deadline:
                    continue
                account = store.get_account(phone) or {}
                contacts, message = _build_emergency_message(account)
                # What the dashboard shows: the exact text, and whether it went out.
                sms = {
                    "to": contacts,
                    "message": message,
                    "sent": False,
                    "demo": _is_demo_account(phone),
                }
                store.mark_escalated(phone, sms)

            if not contacts:
                print(f"Escalation due for {phone} but no emergency contacts configured")
                continue
            # The demo account's contacts are placeholder numbers that could
            # belong to a real stranger — never actually text them.
            if _is_demo_account(phone):
                print(f"[demo] Escalation SMS previewed (not sent) to {contacts}: {message}")
                continue
            try:
                result = send_sms(contacts, message)
                sms["sent"] = result.get("status") == 0
                store.update_escalation_sms(phone, sms)
                print(f"Escalation SMS for {phone} to {contacts}: {result}")
            except Exception as e:
                print(f"Escalation SMS failed for {phone}: {e}")


# ================= CAMERA CONTROL =================

# Lists camera device names on Windows. Win32_PnPEntity is the same list Device
# Manager shows; 'Camera' covers modern webcams, 'Image' the older ones.
_PS_LIST_CAMERAS = (
    "Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | "
    "Where-Object { $_.PNPClass -eq 'Camera' -or $_.PNPClass -eq 'Image' } | "
    "Select-Object -ExpandProperty Name | ConvertTo-Json"
)


def _camera_names_macos():
    out = subprocess.check_output(
        ["system_profiler", "SPCameraDataType", "-json"], timeout=15
    )
    items = json.loads(out).get("SPCameraDataType", [])
    return [item.get("_name", "") for item in items]


def _camera_names_windows():
    out = subprocess.check_output(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", _PS_LIST_CAMERAS],
        timeout=25,
        stderr=subprocess.DEVNULL,
        **_NO_WINDOW,
    )
    text = out.decode("utf-8", "replace").strip()
    if not text:
        return []
    names = json.loads(text)
    # ConvertTo-Json emits a bare string when there's exactly one match.
    if isinstance(names, str):
        names = [names]
    return [n for n in names if isinstance(n, str)]


def list_cameras():
    """Available cameras (name + index). The index is the enumeration order,
    which is what OpenCV's VideoCapture(index) expects; the names are a
    best-effort label so the picker isn't a list of bare numbers."""
    names = []
    try:
        if IS_MACOS:
            names = _camera_names_macos()
        elif IS_WINDOWS:
            names = _camera_names_windows()
    except Exception as e:
        print("camera list error:", e)

    cams = [
        {"index": i, "name": name or f"Camera {i}"}
        for i, name in enumerate(names)
    ]
    if cams:
        return cams
    # Unknown platform, or nothing enumerated — offer the first few indices.
    return [{"index": i, "name": f"Camera {i}"} for i in range(3)]


def _camera_running():
    return camera_process is not None and camera_process.poll() is None


def _stop_camera_process():
    global camera_process, camera_index
    if _camera_running():
        camera_process.terminate()
        try:
            camera_process.wait(timeout=5)
        except Exception:
            camera_process.kill()
    camera_process = None
    camera_index = None


@app.route('/cameras', methods=['GET'])
def get_cameras():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    return jsonify({"cameras": list_cameras(), "running": _camera_running(), "index": camera_index}), 200


@app.route('/camera/start', methods=['POST'])
def camera_start():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    # The demo account is public. Starting the detector spawns a process on the
    # HOST machine and takes over its camera, so a visitor must never be able to
    # do it. The demo shows a browser-side preview instead.
    if _is_demo_account(session["phone"]):
        return jsonify({"message": "The demo account can't control the host camera"}), 403
    if not os.path.exists(CAMERA_SCRIPT):
        return jsonify({"message": f"Script file not found: {CAMERA_SCRIPT}"}), 404

    try:
        index = int((request.json or {}).get("index", 0))
    except (TypeError, ValueError):
        index = 0

    account = store.get_account(session["phone"]) or {}
    device_key = account.get("device_key", "")

    global camera_process, camera_index
    _stop_camera_process()

    flask_port = os.environ.get("FLASK_PORT", "3000")
    env = {
        **os.environ,
        "CAMERA_INDEX": str(index),
        "DEVICE_KEY": device_key,
        # 127.0.0.1 rather than "localhost": the detector posts with `requests`,
        # which has no IPv6->IPv4 fast failover, so on Windows "localhost" would
        # cost ~2s on every alert and every config poll.
        "ALERT_URL": f"http://127.0.0.1:{flask_port}/receive-alert",
        "TEENS_MATURE": "1" if account.get("teens_mature") else "0",
    }
    try:
        # sys.executable is the interpreter running this server, so the detector
        # gets the same Python (and virtualenv) without guessing at a command
        # name that differs between Windows and macOS.
        camera_process = subprocess.Popen([sys.executable, CAMERA_SCRIPT], env=env)
        camera_index = index
    except Exception as e:
        return jsonify({"message": f"Couldn't start the camera: {e}"}), 500
    print(f"Camera detector started (index {index}) for {session['phone']}")
    return jsonify({"ok": True, "index": index}), 200


@app.route('/camera/stop', methods=['POST'])
def camera_stop():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    # Likewise: a demo visitor must not be able to stop real monitoring.
    if _is_demo_account(session["phone"]):
        return jsonify({"message": "The demo account can't control the host camera"}), 403
    _stop_camera_process()
    return jsonify({"ok": True}), 200


@app.route('/camera/status', methods=['GET'])
def camera_status():
    _, session = _session_from_request()
    if not session:
        return jsonify({"message": "Not logged in"}), 401
    return jsonify({"running": _camera_running(), "index": camera_index}), 200


print(f"Using database: {store.init_db()}")

_watcher_thread = threading.Thread(target=escalation_watcher, daemon=True)
_watcher_thread.start()


if __name__ == '__main__':
    # Run on the port given by FLASK_PORT (default 3000)
    import os
    flask_port = int(os.environ.get('FLASK_PORT', '3000'))
    print(f"Starting Flask server on port {flask_port}...")
    app.run(host='0.0.0.0', port=flask_port)
