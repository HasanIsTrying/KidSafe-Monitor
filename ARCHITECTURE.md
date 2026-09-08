# KidSafe — Technology, Architecture & How It Works

KidSafe is a system that watches a car's interior through a camera, detects when a
**young child is left without a responsible supervisor**, and escalates an alert to
the parent and (if unanswered) to emergency contacts by SMS.

This document explains the technology stack, the software architecture, and a
step‑by‑step walkthrough of exactly **what happens when**.

---

## 1. What the software does (in one paragraph)

A camera + AI script watches the car and classifies each detected face by age band
(child / teen / adult). Using a windowed decision it determines the situation:
`CHILD_ONLY` (a child with no qualifying supervisor) or `SAFE` (a supervisor is
present). It sends that status to a server, which records it **per parent account**
and drives a real‑time dashboard (installable as a phone app / PWA). The moment a
`CHILD_ONLY` situation opens, the server sends an immediate **push notification** to
the parent (OneSignal). The parent then has **2 minutes** to acknowledge it on the
dashboard; if they don't, the server sends an **SMS to the parent's emergency
contacts**, including a map link to the vehicle's location.

---

## 2. Technology stack

| Layer | Technology | Why it's used |
|---|---|---|
| AI detection | **Python, OpenCV, MediaPipe, PyTorch + HuggingFace Transformers** | OpenCV grabs camera frames; MediaPipe finds faces fast; the `prithivMLmods/open-age-detection` model classifies each face into an age band. |
| Detection host | **Local Python process** (`detector/run_age_detection.py`) | Runs on the in‑car/host machine, talks to the camera, and posts results over HTTP. |
| API / business logic | **Python Flask** (`backend/main.py`) | Handles auth, accounts, alert routing, escalation, and camera control. Lightweight and easy to call the SMS API from. |
| Web server / glue | **Node.js + Express + TypeScript** (`server/`) | Serves the web app and **proxies** API calls to Flask; also launches the Flask process. |
| Web app | **React + TypeScript + Vite** | The dashboard, login, settings and camera‑control UI. |
| UI styling | **Tailwind CSS + Radix UI + lucide-react + framer-motion** | Fast, consistent styling and accessible components. |
| Data fetching | **TanStack Query (react‑query)** | Polling, caching and request state for the live dashboard. |
| Routing | **wouter** | Tiny client‑side router (login / dashboard / settings / camera). |
| Installable app | **PWA** (web manifest + service worker) | Lets the dashboard be "Add to Home Screen" and load its shell offline. |
| SMS | **019 SMS gateway** (`019sms.co.il/api`) | Sends OTP login codes and emergency‑escalation SMS. |
| Push | **OneSignal Web Push** | Immediate alert to the parent's device(s) the instant a child is detected alone (replaces the old email). |
| Persistence | **SQLite** (`kidsafe.db` via `backend/store.py`) | Accounts, sessions, alerts and open emergencies survive a restart; WAL mode handles concurrent access from the request threads and the escalation watcher. |
| Public access | **ngrok** | Exposes the local server on a public HTTPS URL so the phone can reach it. |

> Schema types are also declared with **Drizzle + Zod** in `shared/`, used by the
> frontend to validate the alert shape.

---

## 3. Architecture overview

```
                          ┌─────────────────────────────────────────────┐
                          │                 HOST MACHINE                  │
                          │                                               │
   Camera ───frames──▶ ┌──┴───────────────────┐                          │
                       │ run_age_detection.py  │   (Python AI detector)   │
                       │  OpenCV + MediaPipe +  │                          │
                       │  age model (PyTorch)   │                          │
                       └──┬───────────────┬─────┘                          │
                          │ POST           │ GET /device-config (poll)     │
                          │ /receive-alert │ (live teen-toggle setting)    │
                          ▼                ▼                               │
                       ┌────────────────────────────┐   spawns/controls   │
   Browser / PWA ◀────▶│  Express (Node)  :5050      │◀───────┐            │
   (dashboard)   HTTP  │  - serves React app         │        │            │
                       │  - proxies /api → Flask     │        │            │
                       └──────────────┬──────────────┘        │            │
                                      │ proxy                 │            │
                                      ▼                        │            │
                       ┌────────────────────────────┐         │            │
                       │  Flask (Python)  :3050      │─────────┘            │
                       │  - auth (OTP)               │                      │
                       │  - per-account alerts       │   launches          │
                       │  - escalation watcher (bg)  │──▶ run_age_detection │
                       │  - camera control           │                      │
                       └───┬───────────────┬─────────┘                      │
                           │               │                                │
                    kidsafe.db      auth_config.json                        │
                  (accounts,        (019 SMS creds,                         │
                   sessions,         OneSignal key)                         │
                   alerts)                                                  │
                           │                                                │
                           ▼                                                │
                  ┌─────────────────┐    ┌──────────────────┐              │
                  │ 019 SMS gateway │    │ OneSignal push   │              │
                  │ (OTP + SMS      │    │ (instant parent  │              │
                  │  escalation)    │    │  notification)   │              │
                  └─────────────────┘    └──────────────────┘              │
                          └────────────────────────────────────────────────┘
                                   (public access via ngrok HTTPS tunnel)
```

**Two HTTP servers run side by side:**
- **Express on port `5050`** (`PORT`) — the only public-facing port. Serves the React
  app and forwards every API path to Flask.
- **Flask on port `3050`** (`FLASK_PORT`) — all the real logic. Started automatically
  by Express.

The browser only ever talks to Express (same origin → no CORS issues). The camera
script talks to Flask (via the proxy / localhost).

---

## 4. Data model

Everything persistent lives in **SQLite** (`kidsafe.db`, git‑ignored), accessed
through `backend/store.py`. This replaced the old `auth_store.json` file plus the
in‑memory alert dictionaries, which meant alerts and open emergencies were lost
on every restart and two threads could clobber the JSON file.

| Table | Holds |
|---|---|
| `accounts` | `phone` (PK), `name`, `created_at`, `device_key`, `teens_mature`, `lat`/`lng`/`location_updated_at` |
| `emergency_contacts` | `phone` → ordered contact numbers (up to 5) |
| `sessions` | `token` (PK), `phone`, `expires_at` — the name is read from `accounts`, so it can't drift |
| `alerts` | `id`, `phone`, `status`, `message`, `timestamp` — newest 100 per account |
| `pending_alerts` | `phone` (PK), `alert_id`, `created_at`, `acknowledged`, `escalated`, `message`, `sms_json` |

Notes:
- Child rows use `ON DELETE/UPDATE CASCADE`, so changing a phone number carries
  the sessions, contacts and any open emergency with it in one statement.
- **WAL** journal mode lets the escalation watcher read while a request thread
  writes. `store.store_lock` additionally serialises multi‑statement
  read‑modify‑write sequences.
- Alerts and open emergencies now **survive a restart** — a `CHILD_ONLY` state
  is no longer silently forgotten because the server was restarted.
- Set `KIDSAFE_DB` to put the database somewhere else.

`auth_config.json` (git‑ignored) holds the secrets: the 019 SMS credentials
(`sms019_username`, `sms019_source`, `sms019_token`) and the OneSignal push
credentials (`onesignal_app_id`, `onesignal_api_key`). See
`auth_config.example.json` for the shape.

---

## 5. Step‑by‑step: how it works, and when

### 5.1 Startup
1. You run `npm run launch` (or `npm run dev` for the app alone).
2. **Express** (`server/index.ts`) starts and runs `registerRoutes` (`server/routes.ts`).
3. `registerRoutes` **spawns the Flask backend** (`backend/main.py`, under the Python 3
   that `server/python.ts` found for this platform) and sets up the API proxy.
   Flask binds to `FLASK_PORT` (3050).
4. Flask starts a **background escalation thread** (`escalation_watcher`) that wakes
   every 10 seconds.
5. In dev, Express attaches the **Vite** dev server (hot reload). In prod it serves the
   built static files. Express listens on `PORT` (5050).

### 5.2 Registration / Login (phone OTP)  → `client/src/pages/AuthPage.tsx`
1. The parent enters **name + phone** and presses Sign Up / Log In.
2. Frontend → `POST /auth/request-code` → (proxy) → Flask `request_code`.
3. Flask calls the **019 `send_otp`** API → the parent gets an SMS:
   *"Your KidSafe login code: 123456"*.
4. The parent enters the code → `POST /auth/verify` → Flask calls **019
   `validate_otp`**.
5. On success Flask creates/updates the account (assigning a **`device_key`** if new),
   issues a **session token valid for 1 year**, and saves it to `auth_store.json`.
6. The token is stored in the browser's `localStorage`. Every later request sends it as
   `Authorization: Bearer <token>` (plus an `ngrok-skip-browser-warning` header so the
   ngrok free tier doesn't block API calls).
7. Protected routes (`/`, `/settings`, `/camera`) check the session via `GET /auth/me`;
   if it's missing/expired the app redirects to `/login`.
8. Once on the dashboard, the app subscribes the device to **OneSignal** and tags it
   with the parent's phone as the OneSignal **external_id** (`OneSignal.login(phone)`),
   then asks for notification permission. This is how the server later targets pushes
   to the right parent's devices.

### 5.2b Demo account (no phone, no camera)  → Flask `demo_login`
A public checkout has no 019 credentials (so no login code can be sent) and no
camera script (so no alert would ever fire). The demo account bridges both gaps:

1. **When it's offered.** `demo_mode_enabled()` is on when `DEMO_MODE=1`, or —
   by default — whenever the 019 credentials are missing, which is exactly the
   state of a fresh clone. A configured deployment therefore has it **off**, and
   `POST /auth/demo` returns `403`. `DEMO_MODE=0` forces it off.
2. **Logging in.** The login page polls `GET /auth/demo-status`; if enabled it
   shows *"Try the demo — no phone needed"*, which calls `POST /auth/demo` and
   gets a normal session token. No OTP is involved.
3. **The account.** Fixed phone `0500000000`, device key `demo-device-key`, and
   two placeholder emergency contacts. It ships with a **fixed sample location**
   and `POST /account/location` *refuses* to change it. The demo account is
   shared by every visitor, so storing a real position there would show one
   visitor's whereabouts to the next; the automatic capture in 5.6 is for real
   accounts only.
4. **Simulating detection.** `POST /demo/alert` with `CHILD_ONLY` or `SAFE`
   feeds `_record_alert` — the *same* function the real detector's
   `/receive-alert` calls, so the demo exercises the real path rather than a
   mock. The dashboard exposes this as two buttons. Only the demo account may
   call it (`403` otherwise).
5. **Escalation.** The demo account escalates after
   `DEMO_ESCALATE_AFTER_SECONDS` (20s) instead of 120s, so the flow is watchable.
   Its contacts are **never texted** — those placeholder numbers could belong to
   a real stranger. Instead the message is recorded on the pending record and
   the dashboard renders it as a message bubble: *"the text message that would
   be sent"*.

### 5.3 Starting the camera  → `client/src/pages/CameraMonitor.tsx`
1. The dashboard shows a **Camera** page. On open it calls `GET /cameras`.
2. Flask lists the machine's cameras — `system_profiler` on macOS (e.g. *FaceTime
   HD*, *iPhone Continuity*), a `Win32_PnPEntity` query on Windows. Either way it
   returns names paired with the index `cv2.VideoCapture(index)` expects; if
   enumeration finds nothing, it offers the first three indices.
3. The parent picks a camera and presses **Start camera** → `POST /camera/start`.
4. Flask launches `detector/run_age_detection.py` as a subprocess, passing it the right context
   through environment variables:
   - `CAMERA_INDEX` — which camera to open,
   - `DEVICE_KEY` — so its alerts attach to *this* account,
   - `ALERT_URL` — where to POST alerts,
   - `TEENS_MATURE` — the initial teen‑guardian setting.
5. **Stop camera** → `POST /camera/stop` terminates the subprocess.

> On **macOS**, camera access requires the server to run under a process that has
> camera permission (your Terminal), because macOS grants the permission to the
> launching app. On **Windows**, allow desktop apps to use the camera under
> Settings → Privacy & security → Camera.

### 5.4 Detection loop  → `detector/run_age_detection.py`
Running continuously while the camera is on:
1. Read a frame from the camera; **mirror it** (`cv2.flip`) for a natural selfie view.
2. Every ~5 s, poll `GET /device-config?device_key=…` to refresh the **`TEENS_MATURE`**
   setting live (so toggling it in Settings takes effect without a restart).
3. Run **MediaPipe** face detection on the frame.
4. For each face, crop it and run the **age model** → a label like `Child 0-12`,
   `Teenager 13-20`, `Adult 21-44`, `Middle Age 45-64`, `Aged 65+`.
5. Every 0.5 s, classify the whole frame into one bucket and push it into a rolling
   **10‑second window** (`classify_frame`):
   - **child present** = any `Child 0-12`,
   - **supervisor present** = any adult (21+), **or** a teen *if* `TEENS_MATURE`,
   - if a child is present **without** a supervisor → frame = `"Child"`,
   - else if anyone can supervise, or only a teen is present → frame = `"Adult"` (safe;
     a teen alone is always fine),
   - else → `"None"`.
6. **Decision** over the window: if ≥70% of samples are `"Child"` and there's no
   `"Adult"` → status `CHILD_ONLY`; if any `"Adult"` → status `SAFE`.
7. **Actions when `CHILD_ONLY`:** play a Mac alarm sound (every 3 s) and
   `POST /receive-alert` to the server (every 10 s). (The parent notification itself is
   sent by the server as a push — see 5.5 — not by the script.) On transition to
   `SAFE`, it posts a single SAFE alert.

### 5.5 Receiving an alert (per‑account routing)  → Flask `receive_alert`
1. `POST /receive-alert` arrives with `{ status, message, timestamp, device_key }`.
2. Flask resolves the alert to an account by matching `device_key`
   (`_resolve_account_phone`). Unknown key + multiple accounts → ignored (kept isolated).
3. The alert is stored in **that account's** list only.
4. Escalation state per account:
   - `CHILD_ONLY` → opens a `pending` record (timestamped) **if one isn't already open**
     (so repeated alerts don't reset the 2‑minute timer). On this *first* open, Flask
     immediately fires a **OneSignal push** to the parent's devices (`send_push`,
     targeted by `external_id = phone`, on a background thread so it never blocks).
   - `SAFE` → clears the account's pending state (an adult returned).

### 5.6 The live dashboard  → `client/src/pages/Dashboard.tsx`
1. The dashboard polls `GET /alerts` every 2 s (only this account's alerts) and
   `GET /alerts/pending` every 3 s.
2. It shows the current status banner (Warning / Safe) and the detection log.
3. If there's an unacknowledged `CHILD_ONLY`, an **amber banner** appears with an
   *"I'm nearby / Acknowledge"* button → `POST /alerts/ack` marks it acknowledged and
   stops escalation.
4. **Automatic location.** If no location is saved, the dashboard asks the
   browser for one and posts it to `/account/location` — **on load**, and again
   **the moment an alert opens** (once per alert), which is the point where a
   missing location actually costs something: the escalation SMS is only as
   useful as the map link in it.
   - It never overwrites a location already saved. One the parent set at the
     vehicle is deliberate and more accurate than wherever their phone is now.
   - Best-effort and silent: a refused permission just leaves the manual control
     in Settings. Geolocation needs HTTPS, so on a phone this works from the
     ngrok URL, not `localhost`.
   - **Skipped for the demo account** — see 5.2b.
5. **Escalation message.** Once an alert escalates, the dashboard shows the SMS
   that went to the emergency contacts — or, on the demo account, the one that
   *would* have gone, rendered as a message bubble.

### 5.7 Escalation (the 2‑minute rule)  → Flask `escalation_watcher` (background thread)
The background thread wakes every 10 s and, for each account with an open pending alert:
1. If it's acknowledged or already escalated → skip.
2. If it has been open for **≥ 120 seconds (2 minutes)** and is still unacknowledged →
   build the emergency message and send it via **019 SMS** to the account's emergency
   contacts (once), e.g.:
   *"KidSafe alert: a child was left alone in the car! Please make contact immediately.
   Location: https://maps.google.com/?q=LAT,LNG"*
3. The pending stays open (now flagged `escalated`) until an adult returns (`SAFE`) or
   the parent acknowledges.

### 5.8 Settings  → `client/src/pages/Settings.tsx`
All scoped to the logged‑in account:
- **Parent name** → `POST /account/name`.
- **Phone number** → `POST /account/phone/request` (OTP) then `/verify` (migrates the
  account + sessions to the new number).
- **Teen as guardian toggle** → `POST /account/teens-mature`. Read live by the detector
  via `/device-config`, so it applies within seconds.
- **Vehicle location** → browser geolocation → `POST /account/location`.
- **Emergency contacts** (up to 5) → `POST /account/contacts`.
- **Device key** → shown read‑only so it can be pasted into the camera script.

### 5.9 PWA, push & remote access
- A single **service worker** (`client/public/OneSignalSDKWorker.js`) does double duty:
  it imports the OneSignal push SDK **and** caches the app shell (so the dashboard is
  installable and opens instantly). They're merged into one file so they don't fight
  over the `/` scope.
- **Push requires HTTPS** — it works from the public ngrok URL, not from `localhost` on
  a phone.
- **ngrok** publishes Express (`:5050`) on a public HTTPS URL so the phone can reach the
  dashboard from anywhere. (Some networks block ngrok as an "Anonymizer" — use cellular
  data or deploy to a real host in that case.)

---

## 6. File map

The three processes live in three directories: `backend/` (Flask), `detector/`
(the camera script) and `server/` + `client/` (Node and React).

| Path | Role |
|---|---|
| `detector/run_age_detection.py` | Camera + AI detector; classifies ages, posts alerts, plays the alarm sound, polls live config. |
| `backend/main.py` | Flask backend: auth (OTP), per‑account alerts, escalation thread, **push (`send_push`)**, account settings, camera control, `/device-config`, demo account. |
| `backend/store.py` | SQLite data layer — accounts, sessions, alerts, pending emergencies. The only module that touches the database. |
| `script/setup.py` | Installs every dependency and verifies the result. |
| `script/start.ts` | One-command launcher: runs the app **and** the ngrok tunnel together, tags their output, shuts the whole tree down on Ctrl+C. |
| `server/index.ts` | Express entry: middleware, error handling, Vite/static, listen on `PORT`. |
| `server/routes.ts` | Spawns Flask; proxies all API paths (`/auth/*`, `/account/*`, `/alerts*`, `/cameras`, `/camera/*`, `/receive-alert`, `/device-config`). |
| `server/python.ts` | Finds a working Python 3 (`python3` vs `python`/`py -3`), honouring the `PYTHON` override. |
| `server/vite.ts` / `server/static.ts` | Dev (Vite middleware) vs prod (static files) serving. |
| `client/src/App.tsx` | Routes + auth gate (`Protected`). |
| `client/src/pages/AuthPage.tsx` | Login / sign‑up (phone OTP, 2 steps). |
| `client/src/pages/Dashboard.tsx` | Live status, detection log, acknowledge banner. |
| `client/src/pages/Settings.tsx` | All account settings. |
| `client/src/pages/CameraMonitor.tsx` | Camera picker + start/stop. |
| `client/src/lib/auth.ts` | Token storage + all API calls (`authFetch`). |
| `client/src/hooks/use-auth.ts`, `use-alerts.ts` | React Query hooks. |
| `client/public/manifest.webmanifest`, `OneSignalSDKWorker.js`, `icons/` | PWA assets + unified push/caching service worker. |
| `shared/schema.ts`, `shared/routes.ts` | Shared Drizzle/Zod types for alerts. |
| `auth_store.json`, `auth_config.json` | Runtime data / secrets (git‑ignored). |

---

## 7. Configuration & how to run

KidSafe runs on **macOS and Windows**. Node ≥ 20 and Python 3 are the only
prerequisites; `npm install` must be run on the machine you're running from (the
installed `node_modules` is platform-specific).

Environment variables (all optional):
- `PORT` — Express/public port (default `5050` via the launcher).
- `FLASK_PORT` — Flask port (default `3050` via the launcher).
- `NGROK_DOMAIN` — a reserved ngrok domain, if you have one.
- `DEMO_MODE` — `1` forces the no-login demo account on, `0` forces it off.
  Unset (the default) enables it only when 019 credentials are missing — see 5.2b.
- `ESCALATE_AFTER_SECONDS` (default `120`) / `DEMO_ESCALATE_AFTER_SECONDS`
  (default `20`) — how long an unacknowledged alert waits before escalating.
- `PYTHON` — force a specific interpreter (e.g. a virtualenv). Otherwise it's
  auto-detected: `python3` on macOS, `python` / `py -3` on Windows.
- `CAMERA_SCRIPT` — path to the detector. Defaults to `detector/run_age_detection.py`,
  falling back to the one on your Desktop.
- `ONESIGNAL_APP_ID` / `ONESIGNAL_API_KEY` — push credentials (or set them in
  `auth_config.json`). Without the REST API key, pushes are skipped and logged.

### Install

```bash
python  script/setup.py --venv    # Windows
python3 script/setup.py --venv    # macOS
```

That installs everything: the Node packages, the server's Python packages and
the camera detector's ML stack, then verifies every import and reports anything
missing. Pass `--server-only` to skip the large ML downloads — the dashboard and
the demo's simulated alerts still work without them, but a real camera and the
demo's age labels don't.

**Use `--venv`.** It installs into `./.venv` instead of your system Python,
which stops KidSafe's pinned versions (MediaPipe constrains `numpy`, for one)
from disturbing your other projects. The server prefers `./.venv` automatically
when it exists; `PYTHON=/path/to/python` overrides everything.

If a detector package has no wheel for your Python, use an older interpreter:
`py -3.11 script/setup.py --venv`. MediaPipe in particular lags new
Python releases by months.

### Run it — one command

```bash
npm run launch    # app + tunnel
npm run demo      # same, with the no-login demo account forced on
```

`npm run launch` starts **both** processes the system needs, in one terminal, and
prints the public URL to open on the phone:

1. **the app** — Express + the Flask backend it spawns (which is also what
   starts and stops the camera detector),
2. **the tunnel** — ngrok, publishing the app over HTTPS. Push notifications and
   "add to home screen" only work over HTTPS, so the phone needs this URL rather
   than `localhost`.

Ctrl+C stops everything, including the Python processes. Variations:

```bash
npm run launch -- --no-tunnel   # app only, localhost, no push
npm run dev                     # just the app (what launch runs internally)
```

If ngrok isn't installed the app still starts, with a note that push won't work.
To run the two parts in separate terminals instead, use `npm run dev` in one and
`ngrok http 5050` in the other.

The camera is started from the dashboard's **Camera** page (it launches the
detector for you), or manually — the detector runs under whatever Python 3 you
invoke it with:

```bash
# macOS
DEVICE_KEY=<from Settings> CAMERA_INDEX=0 python3 detector/run_age_detection.py
```
```powershell
# Windows (PowerShell)
$env:DEVICE_KEY="<from Settings>"; $env:CAMERA_INDEX="0"; python detector/run_age_detection.py
```

---

## 8. Security notes
- `auth_config.json` (019 token + OneSignal API key) and `auth_store.json` (accounts,
  real phone numbers, vehicle location, session tokens) are **git‑ignored** — never
  commit them. `auth_config.example.json` is the committed template: copy it to
  `auth_config.json` and fill in your own values.
- The **OneSignal app ID** in `client/index.html` is deliberately public — the web
  push SDK needs it in the page, and it grants nothing on its own. The REST API key
  is the secret half, and it lives only in `auth_config.json`.
- The public ngrok URL exposes the app to anyone who has it, **including the camera
  start/stop controls that run on the host machine** — don't share the link broadly.
- Sessions are bearer tokens valid for one year, stored in `localStorage`.
- The age model is an estimate; the windowed decision (10 s window, 70% threshold)
  reduces false alarms from single bad frames, but this is an assistive tool, not a
  certified safety device.
```
