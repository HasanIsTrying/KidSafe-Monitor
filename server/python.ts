import { spawnSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

// How to invoke Python 3 differs per platform:
//  - macOS/Linux ship `python3`; `python` is often Python 2 or missing.
//  - Windows installs `python` plus the `py` launcher, and also has a
//    WindowsApps `python3.exe` stub that opens the Microsoft Store instead of
//    running anything — so `python3` must be tried last there, and verified.
const CANDIDATES: string[][] =
  process.platform === "win32"
    ? [["python"], ["py", "-3"], ["python3"]]
    : [["python3"], ["python"]];

// What the backend needs to start, and what it additionally needs to classify
// ages. torchvision is in the second list because transformers' image
// processor refuses to load without it, even though nothing imports it.
const BACKEND_IMPORTS = "import flask, requests";
const DETECTOR_IMPORTS = "import torch, torchvision, transformers, cv2";

let cached: string[] | null = null;
let repairAttempted = false;

function probe(command: string[], code: string): boolean {
  const [cmd, ...args] = command;
  const result = spawnSync(cmd, [...args, "-c", code], {
    stdio: "ignore",
    timeout: 60_000,
  });
  return !result.error && result.status === 0;
}

const isPython3 = (c: string[]) =>
  probe(c, "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)");
const canRunBackend = (c: string[]) => probe(c, BACKEND_IMPORTS);
const hasDetectorStack = (c: string[]) => probe(c, DETECTOR_IMPORTS);
const isComplete = (c: string[]) => canRunBackend(c) && hasDetectorStack(c);

/** ./.venv's interpreter, if `script/setup.py --venv` created one. */
function venvPython(): string[] | null {
  const venv = path.resolve(process.cwd(), ".venv");
  const candidate =
    process.platform === "win32"
      ? path.join(venv, "Scripts", "python.exe")
      : path.join(venv, "bin", "python");
  return existsSync(candidate) ? [candidate] : null;
}

/**
 * Install the missing packages into `command`'s environment.
 *
 * setup.py installs into whichever interpreter runs it, so invoking it with
 * this one fills exactly the environment we're about to use — repairing a
 * half-built .venv in place rather than silently falling back to another
 * Python and leaving the broken one to confuse the next person.
 *
 * Runs at most once per process, and can be turned off with
 * KIDSAFE_NO_AUTO_INSTALL=1 for anyone who'd rather manage it themselves.
 */
function repair(command: string[], what: string): boolean {
  if (repairAttempted) return false;
  if (process.env.KIDSAFE_NO_AUTO_INSTALL) {
    console.warn(
      `Python packages are missing (${what}) and KIDSAFE_NO_AUTO_INSTALL is set.\n` +
        `Install them with: python script/setup.py --venv`,
    );
    return false;
  }
  repairAttempted = true;

  // ASCII only: a Windows console on a legacy codepage mangles anything else.
  console.log(
    `\nPython packages are missing (${what}).\n` +
      `Installing them into ${command.join(" ")} - this can take a few\n` +
      `minutes the first time, and only happens once.\n`,
  );

  const [cmd, ...args] = command;
  const result = spawnSync(
    cmd,
    [...args, path.join("script", "setup.py"), "--skip-npm"],
    { stdio: "inherit", cwd: process.cwd() },
  );

  if (result.error || result.status !== 0) {
    console.warn(
      `\nAutomatic install did not finish. Run it yourself to see why:\n` +
        `    python script/setup.py --venv\n`,
    );
    return false;
  }
  return true;
}

/**
 * The command that runs Python 3 for the backend, as [command, ...args].
 *
 * Prefers ./.venv, repairs whichever interpreter it settles on if packages are
 * missing, and never lets an unusable interpreter shadow a working one.
 * Set PYTHON to force a specific interpreter.
 */
export function resolvePython(): string[] {
  if (cached) return cached;

  const override = process.env.PYTHON;
  if (override) {
    if (!isPython3([override])) {
      throw new Error(
        `PYTHON is set to "${override}" but it isn't a working Python 3 interpreter.`,
      );
    }
    const forced = [override];
    if (!isComplete(forced)) repair(forced, "for the interpreter PYTHON points at");
    cached = forced;
    return cached;
  }

  const venv = venvPython();
  const candidates = [...(venv ? [venv] : []), ...CANDIDATES];
  const usable = candidates.filter(isPython3);

  if (usable.length === 0) {
    throw new Error(
      `Python 3 not found. Tried: ${CANDIDATES.map((c) => c.join(" ")).join(", ")}. ` +
        `Install Python 3 or set the PYTHON environment variable to its path.`,
    );
  }

  // A ./.venv is the project's declared environment, so it wins even when it's
  // incomplete — we fill it rather than quietly using a different Python and
  // leaving a broken venv behind to confuse the next run. Without one, any
  // interpreter that already has everything is good enough.
  const venvUsable = venv ? usable.find((c) => c[0] === venv[0]) : undefined;
  const target = venvUsable ?? usable.find(isComplete) ?? usable.find(canRunBackend) ?? usable[0];

  if (isComplete(target)) {
    cached = target;
    return cached;
  }

  const missing = canRunBackend(target)
    ? "the age-detection packages"
    : "the server's packages";

  if (repair(target, missing) && isComplete(target)) {
    cached = target;
    return cached;
  }

  // Repair failed or was declined. Use the most capable interpreter available
  // so the app still starts, and say plainly what won't work.
  const fallback = usable.find(isComplete) ?? usable.find(canRunBackend) ?? usable[0];
  if (!canRunBackend(fallback)) {
    console.warn(
      "No Python has the server's packages installed. Run: python script/setup.py --venv",
    );
  } else if (!hasDetectorStack(fallback)) {
    console.warn(
      `Using ${fallback.join(" ")} - it lacks the age-detection packages, so the ` +
        `camera's age labels will not work. Fix with: python script/setup.py --venv`,
    );
  }
  cached = fallback;
  return cached;
}
