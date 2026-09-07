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

function works(command: string[]): boolean {
  const [cmd, ...args] = command;
  const probe = spawnSync(
    cmd,
    [...args, "-c", "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)"],
    { stdio: "ignore", timeout: 10_000 },
  );
  return !probe.error && probe.status === 0;
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
  // A project virtualenv wins over whatever Python is on PATH: it's the one
  // the setup script installed the dependencies into.
  const candidates = override
    ? [[override]]
    : [...(venvPython() ? [venvPython()!] : []), ...CANDIDATES];

  for (const candidate of candidates) {
    if (works(candidate)) {
      cached = candidate;
      return cached;
    }
  }

  throw new Error(
    override
      ? `PYTHON is set to "${override}" but it isn't a working Python 3 interpreter.`
      : `Python 3 not found. Tried: ${CANDIDATES.map((c) => c.join(" ")).join(", ")}. ` +
        `Install Python 3 or set the PYTHON environment variable to its path.`,
  );
}
