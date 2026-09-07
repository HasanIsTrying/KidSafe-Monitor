"""One-command setup for KidSafe: installs everything the app needs.

    python  script/setup.py            (Windows)
    python3 script/setup.py            (macOS / Linux)

By default it installs only what the *server* needs, which is small and quick.
The camera detector additionally needs PyTorch, MediaPipe and OpenCV - several
hundred MB - so those are opt-in:

    python script/setup.py --detector      # server + camera detector
    python script/setup.py --venv          # install into ./.venv instead of
                                           # the interpreter running this
    python script/setup.py --skip-npm      # don't touch node_modules

Run it with the interpreter you want KidSafe to use. If you have several
Pythons installed, that choice matters - this script tells you which one it is
and checks it's a version the dependencies actually support.
"""
import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# The server itself - small, pure Python, installs in seconds.
SERVER_PACKAGES = ["flask>=3.1.2", "requests>=2.32.0"]

# The camera detector (detector/run_age_detection.py). Large downloads;
# MediaPipe in particular lags new Python releases by months, which is the usual
# reason setup fails.
DETECTOR_PACKAGES = [
    "opencv-python>=4.10",
    "mediapipe>=0.10",
    "transformers>=4.44",
    "torch>=2.4",
    "pillow>=10.4",
]

# import name -> what to blame if it's missing
SERVER_IMPORTS = {"flask": "flask", "requests": "requests"}
DETECTOR_IMPORTS = {
    "cv2": "opencv-python",
    "mediapipe": "mediapipe",
    "transformers": "transformers",
    "torch": "torch",
    "PIL": "pillow",
}

MIN_PYTHON = (3, 9)


def say(message=""):
    print(message, flush=True)


def heading(title):
    say()
    say(title)
    say("-" * len(title))


def run(command, **kwargs):
    """Run a command, streaming its output. Returns True on success."""
    say(f"$ {' '.join(command)}")
    try:
        return subprocess.call(command, cwd=ROOT, **kwargs) == 0
    except FileNotFoundError:
        say(f"  ! '{command[0]}' not found")
        return False


def check_python():
    version = sys.version_info
    say(f"Python {version.major}.{version.minor}.{version.micro}")
    say(f"  at {sys.executable}")
    if version < MIN_PYTHON:
        say(f"  ! KidSafe needs Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer.")
        return False
    if version >= (3, 14):
        # Not fatal - wheels appear over time, and pip will tell us for sure.
        say("  note: this Python is very new. If a detector package has no wheel")
        say("        for it yet, install with an older one, e.g.  py -3.11 script/setup.py")
    return True


def make_venv():
    """Create ./.venv and return its interpreter path."""
    venv_dir = os.path.join(ROOT, ".venv")
    python = (
        os.path.join(venv_dir, "Scripts", "python.exe")
        if sys.platform == "win32"
        else os.path.join(venv_dir, "bin", "python")
    )
    if os.path.exists(python):
        say(f"Reusing existing virtualenv: {venv_dir}")
        return python
    say(f"Creating virtualenv: {venv_dir}")
    if not run([sys.executable, "-m", "venv", venv_dir]):
        say("  ! Could not create the virtualenv.")
        return None
    return python


def pip_install(python, packages, label):
    heading(f"Installing {label}")
    say("(this can take a while - large downloads)" if label.startswith("camera") else "")
    ok = run([python, "-m", "pip", "install", "--upgrade", "pip"], stdout=subprocess.DEVNULL)
    if not ok:
        say("  note: could not upgrade pip; continuing anyway")
    return run([python, "-m", "pip", "install", *packages])


def verify(python, imports):
    """Import each module in the target interpreter and report what's missing."""
    missing = []
    for module, package in imports.items():
        probe = subprocess.run(
            [python, "-c", f"import {module}"],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        ok = probe.returncode == 0
        say(f"  {'OK     ' if ok else 'MISSING'} {module:<14} ({package})")
        if not ok:
            missing.append(package)
    return missing


def main():
    parser = argparse.ArgumentParser(
        description="Install KidSafe's dependencies.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--detector", action="store_true",
                        help="also install the camera detector's ML packages (large)")
    parser.add_argument("--venv", action="store_true",
                        help="install into ./.venv instead of this interpreter")
    parser.add_argument("--skip-npm", action="store_true",
                        help="skip 'npm install'")
    args = parser.parse_args()

    heading("Checking Python")
    if not check_python():
        return 1

    python = sys.executable
    if args.venv:
        heading("Virtual environment")
        python = make_venv()
        if not python:
            return 1

    if not pip_install(python, SERVER_PACKAGES, "server packages"):
        say("  ! Server packages failed to install.")
        return 1

    if args.detector:
        if not pip_install(python, DETECTOR_PACKAGES, "camera detector packages"):
            say()
            say("  ! Detector packages failed to install.")
            say("    The most common cause is a Python version too new for MediaPipe")
            say("    or PyTorch. Try an older interpreter:")
            say("        py -3.11 script/setup.py --detector --venv    (Windows)")
            say("        python3.11 script/setup.py --detector --venv  (macOS)")
            say("    The server itself still works without these - you just")
            say("    can't run the camera, and the demo account doesn't need it.")

    if not args.skip_npm:
        heading("Installing Node packages")
        if not run(["npm.cmd" if sys.platform == "win32" else "npm", "install"],
                   shell=sys.platform == "win32"):
            say("  ! 'npm install' failed. Install Node.js 20+ and re-run.")

    heading("Verifying")
    missing = verify(python, SERVER_IMPORTS)
    if args.detector:
        missing += verify(python, DETECTOR_IMPORTS)

    heading("Result")
    if missing:
        say(f"Missing: {', '.join(missing)}")
        say("Re-run this script, or install those manually.")
        return 1

    say("All dependencies are installed.")
    if args.venv:
        say()
        say("You used --venv, so point KidSafe at it when you start the app:")
        say(f'    $env:PYTHON="{python}"' if sys.platform == "win32"
            else f'    export PYTHON="{python}"')
        say("(the server also finds ./.venv automatically)")
    say()
    say("Next:")
    say("    npm run demo      - try it with the no-login demo account")
    say("    npm run launch    - normal start (real phone login)")
    if not args.detector:
        say()
        say("The camera detector's packages were not installed.")
        say("Add them with:  --detector")
    return 0


if __name__ == "__main__":
    sys.exit(main())
