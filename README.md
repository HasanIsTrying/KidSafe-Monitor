# KidSafe-Monitor

**A camera watches a car's interior and raises the alarm when a young child is left without a supervising adult.**

An AI detector classifies every face it sees into an age band. When it decides a
child is present with no qualifying supervisor, it sounds a local alarm and
pushes a notification to the parent's phone. If the parent doesn't respond
within two minutes, it texts their emergency contacts with a map link to the
vehicle.

> **This is an assistive tool, not a certified safety device.** The age model is
> an estimate, cameras fail, phones lose signal. Never rely on it to keep a
> child safe. See [Limitations](#limitations).

---

## Try it in two minutes (no phone, no camera, no accounts)

The demo account exists precisely so you can explore this without an SMS
gateway, a push provider, or a car.

```bash
git clone https://github.com/HasanIsTrying/KidSafe-Monitor.git
cd KidSafe-Monitor

python  script/setup.py --venv      # Windows
python3 script/setup.py --venv      # macOS / Linux

npm run demo
```

Open **http://127.0.0.1:5050** and click **"Try the demo — no phone needed"**.

Runs on **Windows and macOS**. You need [Node.js](https://nodejs.org) 20+ and
Python 3.9+; the setup script installs everything else and tells you if
something's missing.

That quick install skips the heavy ML packages, which is fine — everything in
the demo works without them **except** the age labels in the camera preview.
Add `--detector` if you want those (several hundred MB, mostly PyTorch).

---

## Setup, step by step

### 1. Install the prerequisites

| | Version | Where |
|---|---|---|
| **Git** | any | [git-scm.com](https://git-scm.com/downloads) |
| **Node.js** | 20 or newer | [nodejs.org](https://nodejs.org) (the LTS build) |
| **Python** | 3.9 - 3.12 | [python.org](https://www.python.org/downloads/) |
| **ngrok** | optional | [ngrok.com/download](https://ngrok.com/download) — only needed to reach the app from a phone |

Check them:

```bash
git --version
node -v
python --version      # Windows;  python3 --version on macOS
```

> **On Python versions:** prefer **3.11 or 3.12** if you plan to run the camera
> detector. MediaPipe and PyTorch publish wheels for new Python releases months
> late, so the newest Python often can't install them. The server itself works
> on any 3.9+.
>
> On Windows, tick **"Add Python to PATH"** in the installer.

### 2. Download the project

```bash
git clone https://github.com/HasanIsTrying/KidSafe-Monitor.git
cd KidSafe-Monitor
```

### 3. Install the dependencies

One command handles both the Node and Python sides:

```bash
python  script/setup.py --venv          # Windows
python3 script/setup.py --venv          # macOS / Linux
```

It runs `npm install`, installs the Python packages, then **verifies every
import** and prints exactly what is missing if anything failed.

| Flag | Effect |
|---|---|
| `--venv` | Install Python packages into `./.venv` instead of your system Python. **Recommended** — KidSafe pins versions (MediaPipe constrains `numpy`) that can otherwise disturb your other projects. The app finds `.venv` automatically. |
| `--detector` | Also install PyTorch, MediaPipe, OpenCV, Transformers and Pillow. Needed for a real camera, and for age labels in the demo preview. Several hundred MB. |
| `--skip-npm` | Don't touch `node_modules`. |

So a full install, camera included:

```bash
python script/setup.py --venv --detector
```

If that fails on MediaPipe or PyTorch, it's almost always the Python version —
run it with an older one:

```bash
py -3.11 script/setup.py --venv --detector      # Windows
python3.11 script/setup.py --venv --detector    # macOS
```

### 4. Start it

```bash
npm run demo        # demo account, no phone or credentials needed
npm run launch      # normal start (needs credentials - see below)
npm run dev         # just the app, no ngrok tunnel
```

Then open **http://127.0.0.1:5050**.

That single command starts everything: the Express web server, the Flask backend
it spawns, and an ngrok tunnel. Press **Ctrl+C** once to stop all of them.

To use different ports:

```powershell
$env:PORT="5060"; $env:FLASK_PORT="3060"; npm run demo    # Windows
```
```bash
PORT=5060 FLASK_PORT=3060 npm run demo                    # macOS / Linux
```

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Port 5050 is already in use` | Another copy is running. Stop it, or start on another port as above. |
| A 404 saying "The requested URL was not found" | You opened **3050**. That's the internal Flask backend — the website is on **5050**. |
| `ngrok not found` | Only needed for phone access. The app still runs; install ngrok or add `-- --no-tunnel`. |
| Setup fails on mediapipe / torch | Your Python is too new. Use 3.11 or 3.12 as shown above. |
| Face boxes but no age labels | The ML packages aren't installed — re-run setup with `--detector`. |
| The first age reading hangs for ~a minute | Expected. The server is loading the model, once per start. |
| No SMS or push in the real setup | Check `auth_config.json`. Without credentials the app falls back to demo mode. |

---

## What the demo account does

A fresh clone has no SMS credentials, so nobody can receive a login code — and
no camera is wired up, so no alert would ever fire. The demo account bridges
both gaps with a fixed, shared account you enter in one click.

| | |
|---|---|
| Phone | `0500000000` (never dialled) |
| Emergency contacts | `0500000001`, `0500000002` — placeholders, **never texted** |
| Location | A fixed sample landmark |
| Escalation delay | **20 seconds** instead of 120, so it's watchable |

### Two ways to trigger an alert

**1. Simulate it.** Two buttons on the dashboard stand in for the camera:
*"Simulate: child left alone"* and *"Simulate: adult returns"*. They post
through the same code path the real detector uses.

**2. Use your own webcam.** Open the **Camera** page and press **Start camera**.
Your browser previews *your* camera and runs the real pipeline on it:

- faces detected in-browser with **MediaPipe** (the same library the detector uses),
- each face classified into an age band by **the same model** the detector runs,
- the same **10-second window / 70% threshold** decision.

Hold a photo of a child to the camera with no adult in frame and you get a
genuine alert. Beside the camera is a live mini-dashboard showing the status,
the countdown to escalation, the acknowledge button and the detection log.

> **Age labels need the ML packages** (`script/setup.py --detector`). Without
> them you still get live face boxes and the honest note that age
> classification is unavailable. The first age reading also takes about a minute
> while the server loads the model; every one after that is instant.

### What you'll see happen

1. **Alert** — the dashboard turns red, "Child Detected Alone".
2. **Countdown** — 20 seconds to respond, with a progress bar.
3. **Acknowledge** — press *"I'm nearby"* and escalation is cancelled. The
   warning stays up until an adult is actually detected: pressing a button
   doesn't make a car safe.
4. **Escalation** — ignore it and the SMS appears as a message bubble showing
   exactly what the emergency contacts would receive, map link included.
   **Nothing is ever actually sent.**

### Demo safety rules

The demo account is public and shared, so it is deliberately fenced in. These
are enforced on the server, not just hidden in the UI:

- **Never sends SMS.** Those placeholder numbers could belong to a real person.
- **Can't store a real location.** It would expose one visitor's whereabouts to
  the next. It uses a fixed landmark, and `POST /account/location` refuses it.
- **Can't start or stop the host camera.** Otherwise any visitor could spawn a
  process on the machine running the server, or stop real monitoring.

### When is the demo available?

It enables itself when real authentication is impossible — that is, when no 019
SMS credentials are configured, which is the state of every fresh clone. Add
credentials and it **switches itself off**, so a real deployment never exposes a
public way in.

```bash
npm run demo        # force it on (works even with credentials configured)
npm run launch      # normal start; demo off when credentials exist
```

The `DEMO_MODE` environment variable overrides both (`1` on, `0` off), but
`npm run demo` is easier — an environment variable only lasts for the terminal
session you set it in.

---

## Running the real thing

The demo needs nothing. A real installation needs four things.

### 1. An SMS gateway account — [019](https://019sms.co.il)

Used for both login codes and the emergency escalation text.

> **Note:** the 019 gateway and the phone-number validation are **Israel-specific**
> (numbers must be `05XXXXXXXX`). Using this anywhere else means swapping the SMS
> provider in `backend/main.py` (`call_019`, `send_sms`, `normalize_phone`).

### 2. A push provider — [OneSignal](https://onesignal.com)

Free tier is fine. Create a Web Push app and note the **App ID** and **REST API
Key**. The App ID also goes in `client/index.html` (it's public by design). Push
is what reaches the parent within seconds; without it you only get the SMS
escalation two minutes later.

### 3. Credentials file

```bash
cp auth_config.example.json auth_config.json
```

```jsonc
{
  "sms019_username":   "your-019-username",
  "sms019_source":     "0500000000",          // the sender number
  "sms019_token":      "your-019-api-token",
  "onesignal_app_id":  "your-onesignal-app-id",
  "onesignal_api_key": "your-onesignal-rest-api-key"
}
```

`auth_config.json` is git-ignored. **Never commit it.** Environment variables
(`SMS019_USERNAME`, `SMS019_SOURCE`, `SMS019_TOKEN`, `ONESIGNAL_APP_ID`,
`ONESIGNAL_API_KEY`) take priority if you'd rather use those.

### 4. A camera and the detector

```bash
python script/setup.py --venv --detector
```

This adds PyTorch, MediaPipe, OpenCV, Transformers and Pillow — several hundred
MB. If it fails, the usual cause is a Python version newer than MediaPipe
supports; use an older interpreter (`py -3.11 script/setup.py --venv --detector`).

Grant camera permission: **macOS** gives it to the app that launched the process
(your Terminal); **Windows** needs Settings → Privacy & security → Camera →
allow desktop apps.

### Then

```bash
npm run launch
```

1. Sign up with your phone number and the SMS code.
2. **Settings** → add emergency contacts (up to 5), set the vehicle location,
   and decide whether a teenager counts as a guardian.
3. **Camera** → pick a camera and press Start. The detector opens its own window
   on the host machine.
4. Install the dashboard to your phone's home screen from the ngrok URL.

`npm run launch` also starts an **ngrok** tunnel and prints a public HTTPS URL.
You need it: **web push and "add to home screen" only work over HTTPS**, so a
phone can't use `localhost`. Install [ngrok](https://ngrok.com/download) first,
or pass `--no-tunnel` to skip it.

> The public URL exposes the dashboard to anyone who has it — including the
> camera controls that run on your machine. Don't share it broadly.

---

## How the detection works

| Setting | Value | Meaning |
|---|---|---|
| `SAMPLE_INTERVAL` | 0.5 s | one verdict every half-second |
| `WINDOW_SECONDS` | 10 | rolling window of the last 10 seconds |
| `CHILD_RATIO_THRESHOLD` | 0.7 | at least 70% of samples must say "child alone" |
| `ESCALATE_AFTER_SECONDS` | 120 | unacknowledged alerts text the contacts |

A frame counts as an alert only when a **child (0-12)** is present with no
supervisor. An **adult (21+)** always supervises; a **teenager (13-20)** counts
only if you enable it in Settings — but a teen *alone* is always fine.

**How long until it triggers?** About **10 seconds** after an adult leaves —
any adult sample in the 10-second window blocks the alarm, so their samples have
to age out first. That's a deliberate bias toward silence. From a cold start
with the child already alone, about **3 seconds**.

Full flow: adult leaves, then ~10 s to the alert and push, then 120 s
unacknowledged before the SMS reaches the emergency contacts.

---

## Project layout

```
backend/     Flask API: auth, alerts, escalation, push, camera control
  main.py      routes and business logic
  store.py     SQLite data layer (the only module touching the database)
detector/    the camera + AI script that watches the car
server/      Express: serves the web app, proxies the API, spawns Flask
client/      React dashboard (PWA)
shared/      types shared between client and server
script/      setup, build and launch scripts
```

Two HTTP servers run side by side: **Express on 5050** is the only public port;
**Flask on 3050** holds the real logic and is started automatically by Express.
The browser only ever talks to Express.

> Opening `http://localhost:3050` gives a 404 — that's Flask, the internal
> backend. The website is on **5050**.

Data lives in **SQLite** (`kidsafe.db`), created automatically on first startup.
It holds accounts, sessions, alerts and open emergencies, and is git-ignored —
a fresh clone always starts empty.

### Commands

| Command | Does |
|---|---|
| `npm run demo` | app + tunnel, demo account forced on |
| `npm run launch` | app + tunnel, normal login |
| `npm run dev` | just the app, no tunnel |
| `npm run build` / `npm start` | production build and run |
| `npm run check` | TypeScript type check |
| `python script/setup.py --venv --detector` | install everything |

Add `-- --no-tunnel` to any launch command to skip ngrok.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `FLASK_PORT` | 5050 / 3050 | Express and Flask ports |
| `DEMO_MODE` | auto | `1` forces the demo on, `0` off |
| `ESCALATE_AFTER_SECONDS` | 120 | delay before contacts are texted |
| `DEMO_ESCALATE_AFTER_SECONDS` | 20 | the same, for the demo account |
| `NGROK_DOMAIN` | — | a reserved ngrok domain |
| `PYTHON` | auto | force a specific interpreter |
| `CAMERA_SCRIPT` | `detector/run_age_detection.py` | path to the detector |
| `KIDSAFE_DB` | `kidsafe.db` | database location |
| `AGE_MODEL` | `prithivMLmods/open-age-detection` | the HuggingFace age model |

---

## Limitations

Please read these before trusting it with anything that matters.

- **It is not a certified safety device.** It is an assistive tool. Never leave a
  child in a vehicle.
- **The age model estimates.** It confuses faces near band boundaries, and
  struggles with poor light, angles and partial faces. The 10-second window
  reduces false alarms from single bad frames but cannot fix a bad model.
- **A face must be visible.** A sleeping child facing away, or one in a
  rear-facing seat, may not be detected at all.
- **It depends on a chain that can break** — power, camera, network, the phone's
  battery, notification permissions. Any link failing means no alert.
- **SMS is Israel-only** as shipped, via the 019 gateway.
- **Push requires HTTPS** and the parent granting notification permission.

## Tech stack

Python · Flask · SQLite · OpenCV · MediaPipe · PyTorch + HuggingFace
Transformers · Node.js · Express · TypeScript · React · Vite · Tailwind ·
TanStack Query · OneSignal · ngrok

For the full architecture and a step-by-step walkthrough of what happens when,
see **[ARCHITECTURE.md](ARCHITECTURE.md)**.
