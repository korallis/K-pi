#!/usr/bin/env python3
"""
UAT PTY driver — stdlib only (pty, os, select, struct, fcntl, re, json).

Sets exact winsize, sends keystrokes gated on output regexes (no fixed sleeps),
captures frame.raw (ANSI intact) and frame.txt (SGR-stripped).

Usage:
  python3 uat/pty_drive.py --cols 120 --rows 40 --out-dir /tmp/pty \\
    --script '[{"expect":"kpi","send":"/settings\\n"},{"expect":"Theme","send":"q"}]' \\
    -- node packages/coding-agent/dist/bundle/cli.js --offline

  python3 uat/pty_drive.py --self-test
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import tty
from pathlib import Path


SGR_RE = re.compile(
    rb"(?:\x1b\[[0-9;?]*[ -/]*[@-~])"  # CSI
    rb"|(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))"  # OSC
    rb"|(?:\x1b[()][0-9A-Za-z])"  # charset
    rb"|(?:\x1b.)"  # other singles
)


def strip_ansi(data: bytes) -> str:
    cleaned = SGR_RE.sub(b"", data)
    # drop other C0 controls except \n \t \r
    out = bytearray()
    for b in cleaned:
        if b in (9, 10, 13) or 32 <= b <= 126 or b >= 128:
            out.append(b)
    return out.decode("utf-8", errors="replace")


def set_winsize(fd: int, rows: int, cols: int) -> None:
    # struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel }
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
    # notify child if already running — caller may raise SIGWINCH


def parse_script(raw: str | None, path: str | None) -> list[dict]:
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    if raw:
        return json.loads(raw)
    return []


def run_pty(
    argv: list[str],
    *,
    cols: int,
    rows: int,
    script: list[dict],
    out_dir: Path,
    env: dict[str, str] | None,
    overall_timeout: float,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    master, slave = pty.openpty()
    set_winsize(slave, rows, cols)
    set_winsize(master, rows, cols)

    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    child_env.setdefault("TERM", "xterm-256color")
    child_env.setdefault("COLORTERM", "truecolor")
    child_env.setdefault("FORCE_COLOR", "3")
    child_env["COLUMNS"] = str(cols)
    child_env["LINES"] = str(rows)
    # PTY rows must never force NO_COLOR
    child_env.pop("NO_COLOR", None)

    pid = os.fork()
    if pid == 0:
        try:
            os.close(master)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            os.execvpe(argv[0], argv, child_env)
        except Exception as exc:  # pragma: no cover
            sys.stderr.write(f"pty child exec failed: {exc}\n")
            os._exit(127)

    os.close(slave)
    # ensure winsize on master side too after fork
    set_winsize(master, rows, cols)
    try:
        os.kill(pid, signal.SIGWINCH)
    except OSError:
        pass

    buf = bytearray()
    step_i = 0
    deadline = time.monotonic() + overall_timeout
    step_deadline = deadline
    if script:
        first = script[0]
        step_deadline = time.monotonic() + float(first.get("timeout", 15))

    status = None
    try:
        while True:
            now = time.monotonic()
            if now > deadline:
                raise TimeoutError(f"overall timeout after {overall_timeout}s")
            if step_i < len(script) and now > step_deadline:
                exp = script[step_i].get("expect", "")
                raise TimeoutError(f"step {step_i} timed out waiting for /{exp}/")

            wait = max(0.0, min(deadline, step_deadline) - now)
            r, _, _ = select.select([master], [], [], min(0.2, wait))
            if master in r:
                try:
                    chunk = os.read(master, 65536)
                except OSError as e:
                    if e.errno == errno.EIO:
                        chunk = b""
                    else:
                        raise
                if not chunk:
                    break
                buf.extend(chunk)

            # drain completed child without blocking forever
            if status is None:
                wpid, wstatus = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    status = wstatus

            text = strip_ansi(bytes(buf))
            while step_i < len(script):
                step = script[step_i]
                pattern = step.get("expect", "")
                if pattern and not re.search(pattern, text, re.MULTILINE | re.DOTALL):
                    break
                send = step.get("send")
                if send is not None:
                    data = send.encode("utf-8") if isinstance(send, str) else bytes(send)
                    # interpret common escapes
                    if isinstance(send, str):
                        data = (
                            send.replace("\\n", "\n")
                            .replace("\\r", "\r")
                            .replace("\\t", "\t")
                            .replace("\\x1b", "\x1b")
                            .encode("utf-8")
                        )
                    os.write(master, data)
                step_i += 1
                if step_i < len(script):
                    step_deadline = time.monotonic() + float(script[step_i].get("timeout", 15))
                else:
                    step_deadline = deadline

            if status is not None and step_i >= len(script):
                # brief drain after last send
                r, _, _ = select.select([master], [], [], 0.15)
                if master in r:
                    try:
                        more = os.read(master, 65536)
                        if more:
                            buf.extend(more)
                            continue
                    except OSError:
                        pass
                break
            if status is not None and not script:
                break
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        if status is None:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                _, status = os.waitpid(pid, 0)
            except OSError:
                status = 0

    raw = bytes(buf)
    txt = strip_ansi(raw)
    (out_dir / "frame.raw").write_bytes(raw)
    (out_dir / "frame.txt").write_text(txt, encoding="utf-8")
    exit_code = os.waitstatus_to_exitcode(status) if status is not None else -1
    result = {
        "ok": step_i >= len(script),
        "exit": exit_code,
        "steps_done": step_i,
        "steps_total": len(script),
        "cols": cols,
        "rows": rows,
        "bytes": len(raw),
        "out_dir": str(out_dir),
    }
    (out_dir / "pty-result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def self_test() -> None:
    import tempfile

    # child prints a truecolor SGR sequence then waits for a marker
    child = (
        "import sys,time\n"
        "sys.stdout.write('\\x1b[38;2;255;106;26mAMBER\\x1b[0m ready-for-input\\n')\n"
        "sys.stdout.flush()\n"
        "line=sys.stdin.readline()\n"
        "sys.stdout.write('got:'+line)\n"
        "sys.stdout.flush()\n"
    )
    with tempfile.TemporaryDirectory(prefix="uat-pty-") as td:
        out = Path(td) / "out"
        script = [
            {"expect": r"ready-for-input", "send": "hello\\n", "timeout": 5},
            {"expect": r"got:hello", "timeout": 5},
        ]
        result = run_pty(
            [sys.executable, "-u", "-c", child],
            cols=80,
            rows=24,
            script=script,
            out_dir=out,
            env={"TERM": "xterm-256color", "COLORTERM": "truecolor", "FORCE_COLOR": "3"},
            overall_timeout=10,
        )
        raw = (out / "frame.raw").read_bytes()
        txt = (out / "frame.txt").read_text(encoding="utf-8")
        if b"38;2;255;106;26" not in raw:
            raise SystemExit(f"truecolor SGR missing in frame.raw: {raw!r}")
        if "AMBER" not in txt:
            raise SystemExit(f"stripped text missing AMBER: {txt!r}")
        if "\x1b" in txt:
            raise SystemExit("frame.txt still contains ESC")
        if not result["ok"]:
            raise SystemExit(f"script incomplete: {result}")
        # winsize check via stty in child would be ideal; verify COLUMNS env path at least
        print("pty_drive self-test: ok", json.dumps(result))


def main() -> None:
    ap = argparse.ArgumentParser(description="UAT PTY driver")
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--out-dir", type=str, default=".")
    ap.add_argument("--script", type=str, default=None, help="JSON array of {expect,send,timeout}")
    ap.add_argument("--script-file", type=str, default=None)
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("cmd", nargs=argparse.REMAINDER, help="command after --")
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return

    cmd = args.cmd
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        ap.error("command required after --")

    script = parse_script(args.script, args.script_file)
    result = run_pty(
        cmd,
        cols=args.cols,
        rows=args.rows,
        script=script,
        out_dir=Path(args.out_dir),
        env=None,
        overall_timeout=args.timeout,
    )
    print(json.dumps(result))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
