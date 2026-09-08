# KidSafe-Monitor

**A camera watches a car's interior and raises the alarm when a young child is left without a supervising adult.**

An AI detector classifies every face it sees into an age band. When it decides a
child is present with no qualifying supervisor, it sounds a local alarm and
pushes a notification to the parent's phone. If the parent doesn't respond
within two minutes, it texts their emergency contacts with a map link to the
vehicle.

Runs on **Windows and macOS**.

> **This is an assistive tool, not a certified safety device.** The age model is
> an estimate, cameras fail, phones lose signal. Never rely on it to keep a
> child safe. See [Limitations](#8-limitations).

---

## Contents

1. [Installation](#1-installation)
2. [Running the real thing](#2-running-the-real-thing)
3. [The demo account](#3-the-demo-account)
4. [How it works](#4-how-it-works)
5. [Project layout](#5-project-layout)
6. [Commands and configuration](#6-commands-and-configuration)
7. [Troubleshooting](#7-troubleshooting)
8. [Limitations](#8-limitations)

> **In a hurry?** Install (section 1), then run `npm run demo` and open
> http://127.0.0.1:5050. That gives you a working dashboard with no phone, no
> camera and no accounts — see [The demo account](#3-the-demo-account).

---

## 1. Installation

### 1.0 The easy way: just double-click

After downloading the project, double-click the launcher for your system:

| File | What it starts |
|---|---|
| **`Start-Demo.bat`** (Windows) / **`Start-Demo.command`** (macOS) | The demo account — no phone, no credentials |
| **`Start-KidSafe.bat`** (Windows) / **`Start-KidSafe.command`** (macOS) | The real app |

The **first run** checks for Node.js and Python, offers to install them if
they're missing (winget on Windows, Homebrew on macOS), then downloads
everything else. **Every run after that** goes straight to starting the app,
and prints the address to open.

If a tool has to be installed, the launcher asks you to double-click it once
more afterwards — a newly installed program isn't on the PATH of an already-open
window.

> **macOS:** the first double-click may be refused because the file came from
> the internet. Either right-click → **Open** → **Open**, or run this once in
> Terminal: `chmod +x *.command`

That's the whole setup. The rest of this section is the manual equivalent, for
anyone who prefers a terminal or is scripting it.

### 1.1 Prerequisites

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

### 1.2 Download the project

```bash
git clone https://github.com/HasanIsTrying/KidSafe-Monitor.git
cd KidSafe-Monitor
```

### 1.3 Install the dependencies

One command installs **everything** — the Node packages, the server's Python
packages, and the camera detector's ML stack:

```bash
python  script/setup.py --venv          # Windows
python3 script/setup.py --venv          # macOS / Linux
```

It runs `npm install`, installs all the Python packages, then **verifies every
import** and prints exactly what is missing if anything failed.

Expect it to take a few minutes and download several hundred MB — most of that
is PyTorch. It's worth it: the ML stack powers the real camera *and* the age
labels in the demo, so nearly every feature needs it.

| Flag | Effect |
|---|---|
| `--venv` | Install Python packages into `./.venv` instead of your system Python. **Recommended** — KidSafe pins versions (MediaPipe constrains `numpy`) that can otherwise disturb your other projects. The app finds `.venv` automatically. |
| `--server-only` | Skip the ML stack. The dashboard and the demo's simulated alerts still work, but a real camera and the demo's age labels won't. |
| `--skip-npm` | Don't touch `node_modules`. |

If it fails on MediaPipe or PyTorch, it's almost always the Python version —
run it with an older one:

```bash
py -3.11 script/setup.py --venv      # Windows
python3.11 script/setup.py --venv    # macOS
```

### 1.4 Start it

```bash
npm run demo        # demo account, no phone or credentials needed
npm run launch      # normal start (needs credentials - see section 2)
npm run dev         # just the app, no ngrok tunnel
```

Then open **http://127.0.0.1:5050**.

One command starts everything: the Express web server, the Flask backend it
spawns, and an ngrok tunnel. Press **Ctrl+C** once to stop all of them.

To use different ports:

```powershell
$env:PORT="5060"; $env:FLASK_PORT="3060"; npm run demo    # Windows
```
```bash
PORT=5060 FLASK_PORT=3060 npm run demo                    # macOS / Linux
```

---

## 2. Running the real thing

The demo needs nothing. A real installation needs four things.

### 2.1 An SMS gateway account — [019](https://019sms.co.il)

Used for both login codes and the emergency escalation text.

> **Note:** the 019 gateway and the phone-number validation are **Israel-specific**
> (numbers must be `05XXXXXXXX`). Using this anywhere else means swapping the SMS
> provider in `backend/main.py` (`call_019`, `send_sms`, `normalize_phone`).

### 2.2 A push provider — [OneSignal](https://onesignal.com)

Free tier is fine. Create a Web Push app and note the **App ID** and **REST API
Key**. The App ID also goes in `client/index.html` (it's public by design). Push
is what reaches the parent within seconds; without it you only get the SMS
escalation two minutes later.

### 2.3 Credentials file

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

### 2.4 A camera and the detector

The detector's packages were already installed in [1.3](#13-install-the-dependencies)
— nothing more to install unless you used `--server-only`.

Grant camera permission: **macOS** gives it to the app that launched the process
(your Terminal); **Windows** needs Settings → Privacy & security → Camera →
allow desktop apps.

### 2.5 First run

```bash
npm run launch
```

1. Sign up with your phone number and the SMS code.
2. **Settings** → add emergency contacts (up to 5) and decide whether a teenager
   counts as a guardian. Setting the vehicle location here is optional but
   recommended — if you skip it the dashboard captures one automatically (see
   [4.3](#43-where-the-location-comes-from)).
3. **Camera** → pick a camera and press Start. The detector opens its own window
   on the host machine.
4. Install the dashboard to your phone's home screen from the ngrok URL.

`npm run launch` also starts an **ngrok** tunnel and prints a public HTTPS URL.
You need it: **web push and "add to home screen" only work over HTTPS**, so a
phone can't use `localhost`. Install [ngrok](https://ngrok.com/download) first,
or pass `-- --no-tunnel` to skip it.

> The public URL exposes the dashboard to anyone who has it — including the
> camera controls that run on your machine. Don't share it broadly.

---

## 3. The demo account

A fresh clone has no SMS credentials, so nobody can receive a login code — and
no camera is wired up, so no alert would ever fire. The demo account bridges
both gaps with a fixed, shared account you enter in one click.

```bash
npm run demo
```

Open **http://127.0.0.1:5050** and click **"Try the demo — no phone needed"**.

| | |
|---|---|
| Phone | `0500000000` (never dialled) |
| Emergency contacts | `0500000001`, `0500000002` — placeholders, **never texted** |
| Location | A fixed sample landmark |
| Escalation delay | **20 seconds** instead of 120, so it's watchable |

### 3.1 Two ways to trigger an alert

**Simulate it.** Two buttons on the dashboard stand in for the camera:
*"Simulate: child left alone"* and *"Simulate: adult returns"*. They post
through the same code path the real detector uses.

**Use your own webcam.** Open the **Camera** page and press **Start camera**.
Your browser previews *your* camera and runs the real pipeline on it:

- faces detected in-browser with **MediaPipe** (the same library the detector uses),
- each face classified into an age band by **the same model** the detector runs,
- the same **10-second window / 70% threshold** decision.

Hold a photo of a child to the camera with no adult in frame and you get a
genuine alert. Beside the camera is a live mini-dashboard showing the status,
the countdown to escalation, the acknowledge button and the detection log.

> The first age reading takes about a minute while the server loads the model;
> every one after that is instant. Face boxes appear immediately either way.
> (If you installed with `--server-only` there are no age labels at all — you
> get boxes plus a note saying classification is unavailable.)

### 3.2 What you'll see happen

1. **Alert** — the dashboard turns red, "Child Detected Alone".
2. **Countdown** — 20 seconds to respond, with a progress bar.
3. **Acknowledge** — press *"I'm nearby"* and escalation is cancelled. The
   warning stays up until an adult is actually detected: pressing a button
   doesn't make a car safe.
4. **Escalation** — ignore it and the SMS appears as a message bubble showing
   exactly what the emergency contacts would receive, map link included.
   **Nothing is ever actually sent.**

### 3.3 Demo safety rules

The demo account is public and shared, so it is deliberately fenced in. These
are enforced on the server, not just hidden in the UI:

- **Never sends SMS.** Those placeholder numbers could belong to a real person.
- **Can't store a real location.** It would expose one visitor's whereabouts to
  the next. It uses a fixed landmark, and `POST /account/location` refuses it.
- **Can't start or stop the host camera.** Otherwise any visitor could spawn a
  process on the machine running the server, or stop real monitoring.

### 3.4 When is the demo available?

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

## 4. How it works

### 4.1 The detection decision

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

### 4.2 What the emergency SMS says

```
KidSafe alert: a child was left alone in the car! Please make contact
immediately. Location: https://maps.google.com/?q=32.0853,34.7818
```

That map link is the point of the whole message — a contact who can't reach you
needs to know *where* to go. It's included whenever a location is known.

### 4.3 Where the location comes from

There are two sources, and the app prefers the deliberate one:

1. **Set manually in Settings** — "Vehicle / device location", captured while
   you're at the car. This is the accurate one and is always preferred.
2. **Captured automatically** — if no location has ever been saved, the
   dashboard asks the browser for one and stores it. It tries **twice**: when
   the dashboard loads, and again **the moment an alert opens** — which is the
   point where a missing map link actually costs something.

**Automatic capture never overwrites a location you set yourself.** A position
you saved at the vehicle is more accurate than wherever your phone happens to be
when the alarm goes off, and sending emergency contacts to the parent's current
location instead of the car's would actively send help to the wrong place.

If no location is known at all, the SMS is still sent — just without the map
link.

Two caveats worth knowing:

- Browser geolocation needs **HTTPS** and the user's permission, so it works
  from the ngrok URL but not from `localhost` on a phone. If permission is
  refused, nothing breaks; the manual control in Settings still works.
- The **demo account never stores a real location**, for the reason in
  [3.3](#33-demo-safety-rules).

---

## 5. Project layout

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

For the full architecture and a step-by-step walkthrough of what happens when,
see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## 6. Commands and configuration

| Command | Does |
|---|---|
| `npm run demo` | app + tunnel, demo account forced on |
| `npm run launch` | app + tunnel, normal login |
| `npm run dev` | just the app, no tunnel |
| `npm run build` / `npm start` | production build and run |
| `npm run check` | TypeScript type check |
| `python script/setup.py --venv` | install everything |

Add `-- --no-tunnel` to any launch command to skip ngrok.

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

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Port 5050 is already in use` | Another copy is running. Stop it, or start on another port (see [1.4](#14-start-it)). |
| A 404 saying "The requested URL was not found" | You opened **3050**. That's the internal Flask backend — the website is on **5050**. |
| `ngrok not found` | Only needed for phone access. The app still runs; install ngrok or add `-- --no-tunnel`. |
| Setup fails on mediapipe / torch | Your Python is too new. Use 3.11 or 3.12 (see [1.3](#13-install-the-dependencies)), or skip them with --server-only. |
| Face boxes but no age labels | The ML packages aren't installed (did you use `--server-only`?). Re-run `python script/setup.py --venv`. |
| The first age reading hangs for ~a minute | Expected. The server is loading the model, once per start. |
| No SMS or push in the real setup | Check `auth_config.json`. Without credentials the app falls back to demo mode. |
| "Invalid or expired code" on a correct code | Codes expire after 10 minutes. The terminal prints the gateway's exact reason. |
| Camera won't open | Another app may be using it, or the OS is blocking it — see [2.4](#24-a-camera-and-the-detector). |

---

## 8. Limitations

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

---

## Tech stack

Python · Flask · SQLite · OpenCV · MediaPipe · PyTorch + HuggingFace
Transformers · Node.js · Express · TypeScript · React · Vite · Tailwind ·
TanStack Query · OneSignal · ngrok
