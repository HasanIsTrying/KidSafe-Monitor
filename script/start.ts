/**
 * One-command launcher: starts everything KidSafe needs, in one terminal.
 *
 *   1. the app  — Express (dashboard + API proxy) and the Flask backend it
 *      spawns, which is also what starts/stops the camera detector.
 *   2. the tunnel — ngrok, publishing the app on a public HTTPS URL. Push
 *      notifications and "add to home screen" only work over HTTPS, so the
 *      phone needs this URL rather than localhost.
 *
 * Usage:
 *   npm run launch                 # app + tunnel
 *   npm run launch -- --no-tunnel  # app only (localhost, no push)
 *   npm run demo                   # same, with the no-login demo account on
 *
 * Env: PORT, FLASK_PORT, NGROK_DOMAIN (a reserved ngrok domain, optional).
 */
import { spawn, type ChildProcess } from "child_process";

const PORT = process.env.PORT || "5050";
const FLASK_PORT = process.env.FLASK_PORT || "3050";
const NGROK_DOMAIN = process.env.NGROK_DOMAIN || "";
const WITH_TUNNEL = !process.argv.includes("--no-tunnel");
// --demo forces the no-login demo account on even when SMS credentials exist.
// An env var would work too, but it only lasts for one shell session, which is
// easy to lose when you open a new terminal.
const FORCE_DEMO = process.argv.includes("--demo");

const IS_WINDOWS = process.platform === "win32";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

const children: ChildProcess[] = [];
let shuttingDown = false;

/** Stream a child's output, tagging each line so the two are tellable apart. */
function forward(child: ChildProcess, label: string, color: string) {
  const tag = `${color}[${label}]${RESET} `;
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buffered = "";
    stream.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) console.log(tag + line);
    });
    stream.on("end", () => {
      if (buffered) console.log(tag + buffered);
    });
  }
}

function launch(
  label: string,
  color: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  shell = false,
): ChildProcess {
  // Under a shell the args go into the command string: Node deprecates passing
  // them separately (they'd be concatenated unescaped anyway). Safe here — the
  // args are fixed literals, never user input.
  const child = spawn(shell ? [command, ...args].join(" ") : command, shell ? [] : args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    // A process group on macOS/Linux, so shutdown reaches grandchildren
    // (tsx -> python -> the detector). Windows uses taskkill /T instead.
    detached: !IS_WINDOWS,
    shell,
  });
  forward(child, label, color);
  children.push(child);
  return child;
}

/** Kill a child and everything it spawned — the OSes disagree on how. */
function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  if (IS_WINDOWS) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${DIM}Shutting down...${RESET}`);
  for (const child of children) killTree(child);
  // Give taskkill/SIGTERM a moment to land before the process leaves.
  setTimeout(() => process.exit(code), 500);
}

// ---------------------------------------------------------------- the app
// Console output stays ASCII: legacy Windows terminals aren't always UTF-8.
console.log(`${DIM}KidSafe - starting app on port ${PORT} (Flask on ${FLASK_PORT})${RESET}`);

// npm is a .cmd shim on Windows, which Node refuses to spawn directly since
// v20.12 — it has to go through a shell there. ngrok below is a real
// executable, so it stays shell-free and can still report ENOENT if missing.
const app = launch(
  "app",
  CYAN,
  "npm",
  ["run", "dev"],
  { PORT, FLASK_PORT, ...(FORCE_DEMO ? { DEMO_MODE: "1" } : {}) },
  IS_WINDOWS,
);

if (FORCE_DEMO) {
  console.log(`${DIM}Demo login forced on (--demo).${RESET}`);
}

// Flask prints its own "Running on http://127.0.0.1:<FLASK_PORT>" banner, which
// looks like the address to open but is the internal backend and 404s on "/".
// Call out the real one the moment Express is listening.
app.stdout?.on("data", (chunk: Buffer) => {
  if (/\[express\] serving on port/.test(chunk.toString())) {
    console.log(`\n${GREEN}  Open the app: http://127.0.0.1:${PORT}${RESET}`);
    console.log(
      `${DIM}  (Ignore the "Running on ...:${FLASK_PORT}" lines above - that's the` +
        ` internal Python backend, not the website.)${RESET}\n`,
    );
  }
});

app.on("error", (err) => {
  console.error(`${YELLOW}Could not start the app: ${err.message}${RESET}`);
  shutdown(1);
});
app.on("exit", (code) => {
  if (!shuttingDown) {
    console.log(`${YELLOW}The app exited (code ${code}).${RESET}`);
    shutdown(code ?? 0);
  }
});

// ------------------------------------------------------------- the tunnel
if (WITH_TUNNEL) {
  const ngrokArgs = ["http", PORT];
  if (NGROK_DOMAIN) {
    const domain = /^https?:\/\//.test(NGROK_DOMAIN) ? NGROK_DOMAIN : `https://${NGROK_DOMAIN}`;
    ngrokArgs.push(`--url=${domain}`);
  }
  // Log to stdout so we can read the public URL back out; ngrok's interactive
  // dashboard needs a TTY it doesn't have here.
  ngrokArgs.push("--log=stdout", "--log-format=logfmt");

  const tunnel = launch("ngrok", MAGENTA, IS_WINDOWS ? "ngrok.exe" : "ngrok", ngrokArgs);

  tunnel.stdout?.on("data", (chunk: Buffer) => {
    const match = /url=(https:\/\/\S+)/.exec(chunk.toString());
    if (match) {
      console.log(`\n${GREEN}  Public URL: ${match[1]}${RESET}`);
      console.log(`${DIM}  Open this on the phone - push notifications need HTTPS.${RESET}\n`);
    }
  });

  tunnel.on("error", (err) => {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    console.log(
      missing
        ? `${YELLOW}ngrok not found - the app is still running on http://127.0.0.1:${PORT}, ` +
          `but push notifications need HTTPS.\n` +
          `  Install it (https://ngrok.com/download), or run with --no-tunnel to hide this.${RESET}`
        : `${YELLOW}ngrok failed: ${err.message}${RESET}`,
    );
  });

  tunnel.on("exit", (code) => {
    if (!shuttingDown && code !== 0) {
      console.log(`${YELLOW}ngrok exited (code ${code}). The app is still running.${RESET}`);
    }
  });
} else {
  console.log(`${DIM}Tunnel skipped (--no-tunnel). Push notifications need HTTPS.${RESET}`);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
