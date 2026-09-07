"""SQLite persistence for KidSafe.

Replaces the previous auth_store.json file and the in-memory alert/pending
dictionaries, so accounts, sessions, alerts and open emergencies all survive a
restart and can't be corrupted by two threads writing the file at once.

Every function opens its own short-lived connection. SQLite handles the locking
(WAL mode), which is what the request threads and the escalation watcher need.
"""
import json
import os
import sqlite3
import threading
import time

# The database lives at the project root, not beside this file, so it sits
# next to auth_config.json and matches the .gitignore entry.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("KIDSAFE_DB", os.path.join(PROJECT_ROOT, "kidsafe.db"))

# Serialises read-modify-write sequences that span more than one statement.
store_lock = threading.RLock()

MAX_ALERTS_PER_ACCOUNT = 100

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    phone               TEXT    PRIMARY KEY,
    name                TEXT    NOT NULL DEFAULT '',
    created_at          INTEGER NOT NULL,
    device_key          TEXT    NOT NULL DEFAULT '',
    teens_mature        INTEGER NOT NULL DEFAULT 0,
    lat                 REAL,
    lng                 REAL,
    location_updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS emergency_contacts (
    phone    TEXT    NOT NULL REFERENCES accounts(phone) ON DELETE CASCADE ON UPDATE CASCADE,
    position INTEGER NOT NULL,
    contact  TEXT    NOT NULL,
    PRIMARY KEY (phone, position)
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    phone      TEXT    NOT NULL REFERENCES accounts(phone) ON DELETE CASCADE ON UPDATE CASCADE,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    phone     TEXT    NOT NULL,
    status    TEXT    NOT NULL,
    message   TEXT    NOT NULL DEFAULT '',
    timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_phone ON alerts(phone, id DESC);

CREATE TABLE IF NOT EXISTS pending_alerts (
    phone        TEXT    PRIMARY KEY REFERENCES accounts(phone) ON DELETE CASCADE ON UPDATE CASCADE,
    alert_id     INTEGER,
    created_at   REAL    NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    escalated    INTEGER NOT NULL DEFAULT 0,
    message      TEXT    NOT NULL DEFAULT '',
    sms_json     TEXT
);
"""


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with connect() as conn:
        # WAL lets the escalation watcher read while a request thread writes.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
    return DB_PATH


# ---------------------------------------------------------------- accounts

def _account_from_row(conn, row):
    if row is None:
        return None
    contacts = [
        r["contact"]
        for r in conn.execute(
            "SELECT contact FROM emergency_contacts WHERE phone = ? ORDER BY position",
            (row["phone"],),
        )
    ]
    location = None
    if row["lat"] is not None and row["lng"] is not None:
        location = {
            "lat": row["lat"],
            "lng": row["lng"],
            "updated_at": row["location_updated_at"],
        }
    return {
        "phone": row["phone"],
        "name": row["name"],
        "created_at": row["created_at"],
        "device_key": row["device_key"],
        "teens_mature": bool(row["teens_mature"]),
        "location": location,
        "emergency_contacts": contacts,
    }


def get_account(phone):
    with connect() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE phone = ?", (phone,)).fetchone()
        return _account_from_row(conn, row)


def account_count():
    with connect() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM accounts").fetchone()["n"]


def only_account_phone():
    """The single account's phone, or None if there isn't exactly one.

    Supports the single-household convenience of routing unkeyed alerts.
    """
    with connect() as conn:
        rows = conn.execute("SELECT phone FROM accounts LIMIT 2").fetchall()
    return rows[0]["phone"] if len(rows) == 1 else None


def phone_for_device_key(device_key):
    if not device_key:
        return None
    with connect() as conn:
        row = conn.execute(
            "SELECT phone FROM accounts WHERE device_key = ?", (device_key,)
        ).fetchone()
    return row["phone"] if row else None


def create_account(phone, name="", device_key="", teens_mature=False):
    """Insert an account if it's new; returns the account either way."""
    with connect() as conn:
        conn.execute(
            """INSERT INTO accounts (phone, name, created_at, device_key, teens_mature)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(phone) DO NOTHING""",
            (phone, name, int(time.time()), device_key, 1 if teens_mature else 0),
        )
    return get_account(phone)


def set_name(phone, name):
    with connect() as conn:
        conn.execute("UPDATE accounts SET name = ? WHERE phone = ?", (name, phone))


def set_device_key(phone, device_key):
    with connect() as conn:
        conn.execute(
            "UPDATE accounts SET device_key = ? WHERE phone = ?", (device_key, phone)
        )


def set_teens_mature(phone, value):
    with connect() as conn:
        conn.execute(
            "UPDATE accounts SET teens_mature = ? WHERE phone = ?",
            (1 if value else 0, phone),
        )


def get_teens_mature(phone):
    with connect() as conn:
        row = conn.execute(
            "SELECT teens_mature FROM accounts WHERE phone = ?", (phone,)
        ).fetchone()
    return bool(row["teens_mature"]) if row else False


def set_location(phone, lat, lng):
    updated = int(time.time())
    with connect() as conn:
        conn.execute(
            "UPDATE accounts SET lat = ?, lng = ?, location_updated_at = ? WHERE phone = ?",
            (lat, lng, updated, phone),
        )
    return {"lat": lat, "lng": lng, "updated_at": updated}


def set_contacts(phone, contacts):
    with connect() as conn:
        conn.execute("DELETE FROM emergency_contacts WHERE phone = ?", (phone,))
        conn.executemany(
            "INSERT INTO emergency_contacts (phone, position, contact) VALUES (?, ?, ?)",
            [(phone, i, c) for i, c in enumerate(contacts)],
        )
    return list(contacts)


def rename_account(old_phone, new_phone):
    """Move an account to a new number, taking its sessions, alerts and any
    open emergency with it. ON UPDATE CASCADE handles the child rows."""
    with connect() as conn:
        conn.execute(
            "UPDATE accounts SET phone = ?, created_at = created_at WHERE phone = ?",
            (new_phone, old_phone),
        )
        # alerts has no FK (it outlives account deletion), so move it by hand.
        conn.execute("UPDATE alerts SET phone = ? WHERE phone = ?", (new_phone, old_phone))


def account_exists(phone):
    with connect() as conn:
        return (
            conn.execute("SELECT 1 FROM accounts WHERE phone = ?", (phone,)).fetchone()
            is not None
        )


# ---------------------------------------------------------------- sessions

def create_session(token, phone, expires_at):
    with connect() as conn:
        conn.execute(
            "INSERT INTO sessions (token, phone, expires_at) VALUES (?, ?, ?)",
            (token, phone, expires_at),
        )


def get_session(token):
    """Returns {phone, name, expires_at} or None. Expired tokens are removed."""
    if not token:
        return None
    with connect() as conn:
        row = conn.execute(
            """SELECT s.token, s.phone, s.expires_at, a.name
               FROM sessions s JOIN accounts a ON a.phone = s.phone
               WHERE s.token = ?""",
            (token,),
        ).fetchone()
        if row is None:
            return None
        if row["expires_at"] < int(time.time()):
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            return None
    return {"phone": row["phone"], "name": row["name"], "expires_at": row["expires_at"]}


def delete_session(token):
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


# ------------------------------------------------------------------ alerts

def add_alert(phone, status, message, timestamp):
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO alerts (phone, status, message, timestamp) VALUES (?, ?, ?, ?)",
            (phone, status, message or "", int(timestamp)),
        )
        alert_id = cur.lastrowid
        # Keep only the newest MAX_ALERTS_PER_ACCOUNT rows for this account.
        conn.execute(
            """DELETE FROM alerts WHERE phone = ? AND id NOT IN (
                   SELECT id FROM alerts WHERE phone = ? ORDER BY id DESC LIMIT ?
               )""",
            (phone, phone, MAX_ALERTS_PER_ACCOUNT),
        )
    return {
        "id": alert_id,
        "status": status,
        "message": message or "",
        "timestamp": int(timestamp),
    }


def list_alerts(phone, limit=MAX_ALERTS_PER_ACCOUNT):
    with connect() as conn:
        rows = conn.execute(
            """SELECT id, status, message, timestamp FROM alerts
               WHERE phone = ? ORDER BY id DESC LIMIT ?""",
            (phone, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# ----------------------------------------------------------------- pending

def _pending_from_row(row):
    if row is None:
        return None
    return {
        "id": row["alert_id"],
        "created_at": row["created_at"],
        "acknowledged": bool(row["acknowledged"]),
        "escalated": bool(row["escalated"]),
        "message": row["message"],
        "escalation_sms": json.loads(row["sms_json"]) if row["sms_json"] else None,
    }


def get_pending(phone):
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM pending_alerts WHERE phone = ?", (phone,)
        ).fetchone()
    return _pending_from_row(row)


def open_pending(phone, alert_id, message):
    with connect() as conn:
        conn.execute(
            """INSERT INTO pending_alerts (phone, alert_id, created_at, acknowledged,
                                           escalated, message, sms_json)
               VALUES (?, ?, ?, 0, 0, ?, NULL)
               ON CONFLICT(phone) DO UPDATE SET
                   alert_id = excluded.alert_id,
                   created_at = excluded.created_at,
                   acknowledged = 0, escalated = 0,
                   message = excluded.message, sms_json = NULL""",
            (phone, alert_id, time.time(), message or ""),
        )


def clear_pending(phone):
    with connect() as conn:
        conn.execute("DELETE FROM pending_alerts WHERE phone = ?", (phone,))


def acknowledge_pending(phone):
    with connect() as conn:
        conn.execute(
            "UPDATE pending_alerts SET acknowledged = 1 WHERE phone = ?", (phone,)
        )


def mark_escalated(phone, sms):
    with connect() as conn:
        conn.execute(
            "UPDATE pending_alerts SET escalated = 1, sms_json = ? WHERE phone = ?",
            (json.dumps(sms), phone),
        )


def update_escalation_sms(phone, sms):
    with connect() as conn:
        conn.execute(
            "UPDATE pending_alerts SET sms_json = ? WHERE phone = ?",
            (json.dumps(sms), phone),
        )


def pending_phones():
    """Phones with an open emergency that still needs the watcher's attention."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT phone FROM pending_alerts WHERE acknowledged = 0 AND escalated = 0"
        ).fetchall()
    return [r["phone"] for r in rows]
