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

let cached: string[] | null = null;

function probe(command: string[], code: string): boolean {
  const [cmd, ...args] = command;
  const result = spawnSync(cmd, [...args, "-c", code], {
    stdio: "ignore",
    timeout: 20_000,
  });
  return !result.error && result.status === 0;
}

/** Is this a Python 3 at all? */
function isPython3(command: string[]): boolean {
  return probe(command, "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)");
}

/**
 * Can this interpreter actually run the backend? A half-finished virtualenv is
 * a real Python 3 but has none of the packages, so checking only the version
 * would pick it and then fail at import time — or worse, load the server but
 * silently lose the age model. flask is the minimum main.py needs; torch marks
 * an interpreter that can also do age classification.
 */
function canRunBackend(command: string[]): boolean {
  return probe(command, "import flask, requests");
}

function hasDetectorStack(command: string[]): boolean {
  return probe(command, "import torch, torchvision, transformers");
}

/**
 * The command that runs Python 3 on this machine, as [command, ...args].
 * Set the PYTHON env var to force a specific interpreter (e.g. a virtualenv).
 * Throws if no working Python 3 is found.
 */
/** ./.venv's interpreter, if `script/setup.py --venv` created one. */
function venvPython(): string[] | null {
  const venv = path.resolve(process.cwd(), ".venv");
  const candidate =
    process.platform === "win32"
      ? path.join(venv, "Scripts", "python.exe")
      : path.join(venv, "bin", "python");
  return existsSync(candidate) ? [candidate] : null;
}

export function resolvePython(): string[] {
  if (cached) return cached;

  const override = process.env.PYTHON;
  if (override) {
    if (!isPython3([override])) {
      throw new Error(
        `PYTHON is set to "${override}" but it isn't a working Python 3 interpreter.`,
      );
    }
    cached = [override];
    return cached;
  }

  // A project virtualenv is tried first - it's where the setup script installs
  // - but only if it actually has the packages. An abandoned or half-built
  // .venv must not shadow a working system Python.
  const candidates = [...(venvPython() ? [venvPython()!] : []), ...CANDIDATES];
  const usable = candidates.filter(isPython3);

  if (usable.length === 0) {
    throw new Error(
      `Python 3 not found. Tried: ${CANDIDATES.map((c) => c.join(" ")).join(", ")}. ` +
        `Install Python 3 or set the PYTHON environment variable to its path.`,
    );
  }

  // Best: runs the backend AND can classify ages. Next best: runs the backend.
  const complete = usable.find((c) => canRunBackend(c) && hasDetectorStack(c));
  const runnable = complete ?? usable.find(canRunBackend);

  if (!runnable) {
    // Nothing has flask. Fall through to the first real Python so main.py
    // reports the missing package itself, which is the clearest error.
    console.warn(
      "No Python has the server's packages installed. Run: python script/setup.py --venv",
    );
    cached = usable[0];
    return cached;
  }

  if (!complete) {
    console.warn(
      `Using ${runnable.join(" ")} - it lacks the age-detection packages, so the ` +
        `camera's age labels will not work. Fix with: python script/setup.py --venv`,
    );
  }

  cached = runnable;
  return cached;
}
