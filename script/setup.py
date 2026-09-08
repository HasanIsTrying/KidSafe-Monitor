"""One-command setup for KidSafe: installs everything the app needs.

    python  script/setup.py --venv     (Windows)
    python3 script/setup.py --venv     (macOS / Linux)

Installs EVERYTHING by default - the Node packages, the server's Python
packages, and the camera detector's ML stack (PyTorch, MediaPipe, OpenCV,
Transformers, Pillow). That last group is several hundred MB, but nearly every
feature needs it: the real camera, and the age labels in the demo preview.

    python script/setup.py --venv          # install into ./.venv instead of
                                           # the interpreter running this
    python script/setup.py --server-only   # skip the ML stack (dashboard and
                                           # simulated alerts only)
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
    # transformers' AutoImageProcessor refuses to load without torchvision,
    # even though nothing here imports it directly. Leaving it out fails only
    # at the first classification, with "requires the Torchvision library".
    "torchvision>=0.19",
    "pillow>=10.4",
]

# import name -> what to blame if it's missing
SERVER_IMPORTS = {"flask": "flask", "requests": "requests"}
DETECTOR_IMPORTS = {
    "cv2": "opencv-python",
    "mediapipe": "mediapipe",
    "transformers": "transformers",
    "torch": "torch",
    "torchvision": "torchvision",
    "PIL": "pillow",
}

MIN_PYTHON = (3, 9)

# Every npm script in this project runs through tsx, and the client build needs
# vite. If these aren't on disk, `npm install` did not actually complete - which
# is what produces the confusing "'tsx' is not recognized" at startup.
NODE_MARKERS = {
    "tsx": os.path.join("node_modules", "tsx", "package.json"),
    "vite": os.path.join("node_modules", "vite", "package.json"),
}


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


def verify_node():
    """Check the Node packages actually landed. Returns a list of what's missing."""
    missing = []
    for name, marker in NODE_MARKERS.items():
        ok = os.path.exists(os.path.join(ROOT, marker))
        say(f"  {'OK     ' if ok else 'MISSING'} {name:<14} (node_modules)")
        if not ok:
            missing.append(name)
    return missing


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
    parser.add_argument("--server-only", action="store_true",
                        help="skip the camera detector's ML packages (large). "
                             "The dashboard and simulated alerts still work; "
                             "a real camera and demo age labels won't.")
    parser.add_argument("--venv", action="store_true",
                        help="install into ./.venv instead of this interpreter")
    parser.add_argument("--skip-npm", action="store_true",
                        help="skip 'npm install'")
    args = parser.parse_args()
    with_detector = not args.server_only

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

    if with_detector:
        if not pip_install(python, DETECTOR_PACKAGES, "camera detector packages"):
            say()
            say("  ! Detector packages failed to install.")
            say("    The most common cause is a Python version too new for MediaPipe")
            say("    or PyTorch. Try an older interpreter:")
            say("        py -3.11 script/setup.py --venv      (Windows)")
            say("        python3.11 script/setup.py --venv    (macOS)")
            say("    Or skip them with --server-only: the dashboard and the demo's")
            say("    simulated alerts still work, but a real camera won't.")

    if not args.skip_npm:
        heading("Installing Node packages")
        if not run(["npm.cmd" if sys.platform == "win32" else "npm", "install"],
                   shell=sys.platform == "win32"):
            say("  ! 'npm install' failed. Install Node.js 20+ and re-run.")

    heading("Verifying")
    missing = verify(python, SERVER_IMPORTS)
    if with_detector:
        missing += verify(python, DETECTOR_IMPORTS)
    node_missing = verify_node()

    heading("Result")
    if node_missing:
        say(f"Node packages missing: {', '.join(node_missing)}")
        say()
        say("The app cannot start without them - you would see")
        say("  \"'tsx' is not recognized\"  or  \"tsx: command not found\".")
        say()
        say("Fix it by running, in this folder:")
        say("    npm install")
        say("If that fails, check Node.js 20+ is installed:  node -v")
        return 1
    if missing:
        say(f"Python packages missing: {', '.join(missing)}")
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
    if not with_detector:
        say()
        say("You used --server-only, so the camera detector's packages are")
        say("missing. A real camera and the demo's age labels need them:")
        say("    python script/setup.py --venv")
    return 0


if __name__ == "__main__":
    sys.exit(main())
