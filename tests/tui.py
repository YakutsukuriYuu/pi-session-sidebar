#!/usr/bin/env python3
# ruff: noqa
# Vendored PTY test harness from pi-resume-plus (kept byte-compatible).
"""Drive a real pi TUI in a PTY to smoke-test the resume-plus picker.

Usage:
  python3 tests/tui.py                        # /r flow: default All panel, Tab scopes
  python3 tests/tui.py <cwd> <pin-folder>     # also assert the current cwd folder is pinned first
  python3 tests/tui.py --startup-flag         # pi --rr opens the picker with no input, then resume works
  python3 tests/tui.py --startup-cancel       # closing the auto-opened picker (Esc / Ctrl+C) restores typing
"""
import os, pty, select, subprocess, sys, time, re, signal, fcntl, termios, struct
import json, shutil, tempfile, uuid
from datetime import datetime, timezone

ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b[>=][0-9]?u?")

def strip_ansi(data: bytes) -> str:
    return ANSI.sub(b"", data).decode("utf-8", "replace")


class Session:
    """A pi TUI running in a PTY, with helpers to drive and inspect it."""

    def __init__(self, args, cwd="/tmp", env=None):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        self.proc = subprocess.Popen(["pi", *args], stdin=slave, stdout=slave, stderr=slave,
                                     cwd=cwd, env=env, close_fds=True, start_new_session=True)
        os.close(slave)
        self.log = bytearray()

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.master], [], [], 0.1)
            if r:
                try: self.log.extend(os.read(self.master, 65536))
                except OSError: return

    def send(self, data, settle=0.6):
        os.write(self.master, data)
        self.pump(settle)

    def text(self, tail=None):
        data = bytes(self.log) if tail is None else bytes(self.log[-tail:])
        return strip_ansi(data)

    def mark(self):
        """Byte offset to measure output produced from now on."""
        return len(self.log)

    def since(self, mark):
        """Only the output produced after `mark` (avoids stale frames in checks)."""
        return strip_ansi(bytes(self.log[mark:]))

    def wait_for(self, probe, seconds):
        """Pump until `probe` shows up anywhere in the captured output."""
        end = time.time() + seconds
        while time.time() < end:
            self.pump(0.25)
            if probe in self.text():
                return True
        return False

    def wait_until(self, predicate, seconds):
        end = time.time() + seconds
        while time.time() < end:
            self.pump(0.25)
            if predicate(self.text()):
                return True
        return False

    def close(self):
        if getattr(self, "closed", False):
            return
        self.closed = True
        try: self.proc.terminate()
        except Exception: pass
        try: self.proc.wait(timeout=5)
        except Exception:
            try: os.killpg(self.proc.pid, signal.SIGKILL)
            except Exception: pass

    def quit(self):
        """End pi so shutdown handlers run: Ctrl+C twice, then SIGTERM, waiting for exit."""
        try:
            os.write(self.master, b"\x03"); self.pump(1.0)
            os.write(self.master, b"\x03"); self.pump(1.0)
        except OSError:
            pass
        try:
            self.proc.wait(timeout=2)
            self.closed = True
            return
        except Exception:
            pass
        try: self.proc.terminate()      # SIGTERM is a documented graceful exit path
        except Exception: pass
        try:
            self.proc.wait(timeout=8)
            self.closed = True
        except Exception:
            pass


def check(name, ok, detail=""):
    print(("PASS" if ok else "FAIL"), name, detail)
    return ok


def mode_startup_flag(cwd):
    s = Session(["--no-session", "--rr"], cwd)
    try:
        s.pump(1)
        # No input is sent: the --rr flag must open the picker by itself.
        opened = s.wait_for("Resume Session (All)", 30) and s.wait_for("📁", 30)
        ok = check("--rr opens the picker with no input", opened)
        s.send(b"\x1b[B", 1)      # folder row -> first session row
        mark = s.mark()
        s.send(b"\r", 1)
        resumed = s.wait_until(lambda _t: "Resumed session" in s.since(mark), 15)
        ok &= check("selecting in the auto-opened picker resumes that session", resumed)
        return ok
    finally:
        s.close()


def mode_startup_cancel(cwd):
    """Closing the startup picker must hand the keyboard back to the editor."""
    ok = True
    for key, label in ((b"\x1b", "Esc"), (b"\x03", "Ctrl+C")):
        s = Session(["--no-session", "--rr"], cwd)
        try:
            s.pump(1)
            if not s.wait_for("Resume Session (All)", 30):
                ok &= check(f"{label}: picker opened", False)
                continue
            s.send(key, 2)
            mark = s.mark()
            closed = s.wait_until(lambda _t: "Resume Session" not in s.since(mark), 8)
            ok &= check(f"{label} closes the startup picker", closed)
            mark = s.mark()
            s.send(b"hello", 1)
            typed = s.wait_until(lambda _t: "hello" in s.since(mark), 6)
            ok &= check(f"{label}: typing works right after closing", typed)
            s.send(b"\x03", 1)
            s.send(b"\x03", 1)
        finally:
            s.close()
    return ok


def mode_expand_collapse(cwd):
    """Shift+Left collapses every folder, Shift+Right expands them all."""
    s = Session(["--no-session"], cwd)
    try:
        s.pump(6)
        s.send(b"/r")
        s.send(b"\r", 3)
        if not s.wait_for("📁", 30):
            return check("picker with folders opened", False)
        mark = s.mark()
        s.send(b"\x1b[1;2D", 2)     # shift+left
        ok = check("Shift+Left collapses every folder",
                   s.wait_until(lambda _t: "▸ 📁" in s.since(mark) and "▾ 📁" not in s.since(mark), 8))
        mark = s.mark()
        s.send(b"\x1b[1;2C", 2)     # shift+right
        ok &= check("Shift+Right expands them all again",
                    s.wait_until(lambda _t: "▾ 📁" in s.since(mark), 8))
        s.send(b"\x1b", 1.5)
        return ok
    finally:
        s.close()


def mode_new_in_folder():
    """Folder-row Shift+Enter creates a new session for that folder (isolated agent dir).

    Reproduces the reported scenario: while inside project A, act on project B's
    folder row, then reopen /r and check the All scope still lists every project.
    """
    base = tempfile.mkdtemp(prefix="rp-newfolder-")
    agent = os.path.join(base, "agent")
    proj = os.path.realpath(os.path.join(base, "proj"))
    other = os.path.realpath(os.path.join(base, "otherproj"))
    plugin = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ext = os.path.join(agent, "extensions", "resume-plus")
    os.makedirs(ext); os.makedirs(proj); os.makedirs(other)
    # The merged plugin lives in index.ts + src/; copy the whole tree.
    shutil.copy(os.path.join(plugin, "index.ts"), os.path.join(ext, "index.ts"))
    shutil.copytree(os.path.join(plugin, "src"), os.path.join(ext, "src"))

    def encoded(path):
        return "--" + path.lstrip("/").replace("/", "-") + "--"

    def seed_session(path):
        sid = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        ts = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
        directory = os.path.join(agent, "sessions", encoded(path))
        os.makedirs(directory, exist_ok=True)
        seed = os.path.join(directory, f"seed_{sid}.jsonl")
        with open(seed, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "session", "version": 3, "id": sid, "timestamp": ts, "cwd": path}) + "\n")
            fh.write(json.dumps({"type": "message", "id": "aaaa1111", "parentId": None, "timestamp": ts,
                                 "message": {"role": "user", "content": "seed prompt"}}) + "\n")
        return seed

    seeds = {seed_session(proj), seed_session(other)}
    other_dir = os.path.join(agent, "sessions", encoded(other))
    proj_dir = os.path.join(agent, "sessions", encoded(proj))
    # Safety: keep the terminal path off so a stray Shift+Enter on a session row
    # can never spawn a real terminal window during tests.
    with open(os.path.join(ext, "config.json"), "w", encoding="utf-8") as fh:
        json.dump({"shiftEnter": {"enabled": False},
                   "folderNewSession": {"enabled": True, "cleanupUnused": True},
                   # Keep the left sidebar off so it cannot perturb the PTY assertions.
                   "sidebar": {"enabled": False}}, fh)
    env = {**os.environ, "PI_CODING_AGENT_DIR": agent}
    s = Session([], cwd=proj, env=env)

    def session_files(directory):
        return [] if not os.path.isdir(directory) else [f for f in os.listdir(directory) if f.endswith(".jsonl")]

    try:
        s.pump(8)
        s.send(b"/r")
        s.send(b"\r", 3)
        if not (s.wait_for("proj", 30) and s.wait_for("otherproj", 30)):
            return check("both project folders visible", False)
        s.send(b"\x1b[B", 0.6)       # current-folder row -> its session
        s.send(b"\x1b[B", 0.6)       # -> the OTHER project's folder row
        before = len(session_files(other_dir))
        mark = s.mark()
        s.send(b"\x1b[13;2u", 2)     # shift+enter on that folder row
        ok = check("Shift+Enter on another project's folder closes the picker",
                   s.wait_until(lambda _t: "Resume Session" not in s.since(mark), 12))
        mark = s.mark()
        s.send(b"hello", 1)
        ok &= check("typing works after the switch", s.wait_until(lambda _t: "hello" in s.since(mark), 8))
        created = [f for f in session_files(other_dir) if f not in {os.path.basename(p) for p in seeds}]
        ok &= check("the new session was created in the other project's dir",
                    len(session_files(other_dir)) == before + 1 and len(created) == 1,
                    f"(before={before}, now={session_files(other_dir)})")
        ok &= check("nothing was written into the current project's dir",
                    len(session_files(proj_dir)) == 1)
        ok &= check("its header targets that folder",
                    any(other in open(os.path.join(other_dir, f), encoding="utf-8").readline() for f in created))
        ok &= check("pi keeps appending to it (header was valid)",
                    any("level_change" in open(os.path.join(other_dir, f), encoding="utf-8").read() for f in created))
        # The reported symptom: after such a switch the All scope showed a single directory.
        s.send(b"\x15", 0.5)         # clear the editor before typing a command
        mark = s.mark()
        s.send(b"/r")
        s.send(b"\r", 4)
        ok &= check("/r All still lists every project after the switch",
                    s.wait_until(lambda _t: "Resume Session (All)" in s.since(mark)
                                 and "otherproj" in s.since(mark), 20))
        # Leaving the unused new session (by creating one in the other project)
        # must remove it, and quitting while unused must remove that one too.
        s.send(b"\x1b[1;2B", 0.8)    # shift+down -> the other project's folder row
        s.send(b"\x1b[13;2u", 2)     # shift+enter -> new session there
        s.pump(1.5)
        ok &= check("leaving an unused new session cleans it up",
                    len(session_files(other_dir)) == 1 and len(session_files(proj_dir)) == 2,
                    f"(other={len(session_files(other_dir))}, proj={len(session_files(proj_dir))})")
        s.quit()
        ok &= check("quitting while sitting in an unused new session cleans it up",
                    len(session_files(proj_dir)) == 1, f"(proj={session_files(proj_dir)})")
        ok &= check("no error notification", "无法在" not in s.text())
        return ok
    finally:
        s.close()
        shutil.rmtree(base, ignore_errors=True)


def mode_normal(cwd, pin):
    s = Session(["--no-session"], cwd)
    try:
        s.pump(6)                  # startup + extension load
        s.send("/r".encode())
        s.send(b"\r", 3)           # open selector (defaults to All panel)
        snap1 = bytes(s.log)
        s.send(b"\t", 2)           # switch to Current Folder scope
        snap2 = bytes(s.log)
        s.send(b"\t", 2)           # back to All (cached)
        snap3 = bytes(s.log)
        s.send(b"\x1b[1;2B", 1)    # Shift+Down jump between projects
        s.send(b"\x1b", 1.5)       # cancel selector
        mark = s.mark()
        typable = s.wait_until(lambda _t: "Resume Session" not in s.since(mark), 5)
        mark = s.mark()
        s.send(b"hello", 1)
        typable &= s.wait_until(lambda _t: "hello" in s.since(mark), 6)
    finally:
        s.close()
    ok = check("startup loads resume-plus", "resume-plus" in strip_ansi(bytes(s.log)))
    ok &= check("/r opens selector defaulting to All with folder roots", all(
        p in strip_ansi(snap1) for p in ["Resume Session (All)", "📁", "Sort:", "Threaded", "regex", "rename", "delete", "shift+enter"]))
    ok &= check("Tab switches to Current Folder scope", "Resume Session (Current Folder)" in strip_ansi(snap2))
    ok &= check("Tab back to All keeps folder grouping",
                all(p in strip_ansi(snap3) for p in ["Resume Session (All)", "📁"]))
    ok &= check("/r cancel also restores typing", typable)
    if pin:
        first_folder = next((l for l in strip_ansi(snap1).splitlines() if "📁" in l), "")
        ok &= check("current cwd folder pinned first", pin in first_folder, f"(first folder line: {first_folder.strip()[:60]})")
    return ok


def main():
    args = sys.argv[1:]
    if "--startup-flag" in args:
        return mode_startup_flag("/tmp")
    if "--startup-cancel" in args:
        return mode_startup_cancel("/tmp")
    if "--expand-collapse" in args:
        return mode_expand_collapse("/tmp")
    if "--new-in-folder" in args:
        return mode_new_in_folder()
    cwd = args[0] if args and not args[0].startswith("--") else "/tmp"
    pin = next((a for a in args[1:] if not a.startswith("--")), None)
    return mode_normal(cwd, pin)


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
