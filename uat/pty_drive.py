#!/usr/bin/env python3
"""
UAT PTY driver — stdlib only (pty, os, select, struct, fcntl, re, json).

Sets exact winsize, sends keystrokes gated on output regexes (no fixed sleeps),
captures frame.raw (bytes, ANSI intact) and frame.txt (SGR-stripped).

Usage:
  python3 uat/pty_drive.py --cols 120 --rows 40 --out-dir /tmp/pty \\
    --script '[{"expect":"kpi v0","send":"/\\\\n"}]' \\
    -- node packages/coding-agent/dist/bundle/cli.js --offline

  python3 uat/pty_drive.py --self-test
  python3 uat/pty_drive.py --self-test-tui --cli path/to/cli.js ...
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
from pathlib import Path


SGR_RE = re.compile(
    rb"(?:\x1b\[[0-9;?]*[ -/]*[@-~])"
    rb"|(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))"
    rb"|(?:\x1b[()][0-9A-Za-z])"
    rb"|(?:\x1b.)"
)


def strip_ansi(data: bytes) -> str:
    cleaned = SGR_RE.sub(b"", data)
    out = bytearray()
    for b in cleaned:
        if b in (9, 10, 13) or 32 <= b <= 126 or b >= 128:
            out.append(b)
    return out.decode("utf-8", errors="replace")


def set_winsize(fd: int, rows: int, cols: int) -> None:
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def parse_script(raw: str | None, path: str | None) -> list[dict]:
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    if raw:
        return json.loads(raw)
    return []


def encode_send(send) -> bytes:
    if send is None:
        return b""
    if isinstance(send, bytes):
        return send
    return (
        str(send)
        .replace("\\n", "\n")
        .replace("\\r", "\r")
        .replace("\\t", "\t")
        .replace("\\x1b", "\x1b")
        .replace("\\x03", "\x03")
        .encode("utf-8")
    )


def write_frames(out_dir: Path, buf: bytes, meta: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "frame.raw").write_bytes(buf)
    (out_dir / "frame.txt").write_text(strip_ansi(buf), encoding="utf-8")
    (out_dir / "pty-result.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def run_pty(
    argv: list[str],
    *,
    cols: int,
    rows: int,
    script: list[dict],
    out_dir: Path,
    env: dict[str, str] | None,
    overall_timeout: float,
    cwd: str | None = None,
) -> dict:
    if not argv:
        raise ValueError("argv required")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    child_env = os.environ.copy()
    if env:
        child_env.update({k: str(v) for k, v in env.items() if v is not None})
    child_env.setdefault("TERM", "xterm-256color")
    child_env.setdefault("COLORTERM", "truecolor")
    child_env.setdefault("FORCE_COLOR", "3")
    child_env["COLUMNS"] = str(cols)
    child_env["LINES"] = str(rows)
    child_env.pop("NO_COLOR", None)

    master, slave = pty.openpty()
    set_winsize(slave, rows, cols)
    set_winsize(master, rows, cols)

    pid = os.fork()
    if pid == 0:
        try:
            os.close(master)
            os.setsid()
            try:
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            except OSError:
                pass
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            if cwd:
                os.chdir(cwd)
            os.execvpe(argv[0], argv, child_env)
        except Exception as exc:  # pragma: no cover
            sys.stderr.write(f"pty child exec failed: {exc}\n")
            os._exit(127)

    os.close(slave)
    set_winsize(master, rows, cols)
    try:
        os.kill(pid, signal.SIGWINCH)
    except OSError:
        pass

    buf = bytearray()
    step_i = 0
    t0 = time.monotonic()
    deadline = t0 + overall_timeout
    step_deadline = deadline
    if script:
        step_deadline = t0 + float(script[0].get("timeout", 20))

    status = None
    error = None
    try:
        while True:
            now = time.monotonic()
            if now > deadline:
                error = f"overall timeout after {overall_timeout}s (bytes={len(buf)} steps={step_i}/{len(script)})"
                break
            if step_i < len(script) and now > step_deadline:
                exp = script[step_i].get("expect", "")
                error = (
                    f"step {step_i} timed out waiting for /{exp}/ "
                    f"(bytes={len(buf)} elapsed={now - t0:.1f}s)"
                )
                break

            wait = max(0.05, min(0.25, min(deadline, step_deadline) - now))
            r, _, _ = select.select([master], [], [], wait)
            if master in r:
                try:
                    chunk = os.read(master, 65536)
                except OSError as e:
                    if e.errno == errno.EIO:
                        chunk = b""
                    else:
                        raise
                if chunk:
                    buf.extend(chunk)
                else:
                    # EOF from slave
                    if status is None:
                        try:
                            wpid, wstatus = os.waitpid(pid, os.WNOHANG)
                            if wpid == pid:
                                status = wstatus
                        except OSError:
                            pass
                    if status is not None and step_i >= len(script):
                        break

            if status is None:
                wpid, wstatus = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    status = wstatus

            text = strip_ansi(bytes(buf))
            progressed = True
            while progressed and step_i < len(script):
                progressed = False
                step = script[step_i]
                pattern = step.get("expect") or ""
                if pattern and not re.search(pattern, text, re.MULTILINE | re.DOTALL):
                    break
                send = step.get("send")
                if send is not None:
                    os.write(master, encode_send(send))
                step_i += 1
                progressed = True
                if step_i < len(script):
                    step_deadline = time.monotonic() + float(script[step_i].get("timeout", 15))
                else:
                    # final step matched: optional short drain of subsequent paint
                    drain = float(step.get("drain", 0.4))
                    drain_end = time.monotonic() + drain
                    while time.monotonic() < drain_end:
                        r2, _, _ = select.select([master], [], [], 0.1)
                        if master not in r2:
                            continue
                        try:
                            more = os.read(master, 65536)
                        except OSError:
                            break
                        if not more:
                            break
                        buf.extend(more)
                        text = strip_ansi(bytes(buf))

            if step_i >= len(script):
                if not script:
                    break
                # interactive TUI stays up — brief after-drain then exit loop
                after = float(script[-1].get("after", 0.8))
                after_end = time.monotonic() + after
                while time.monotonic() < after_end:
                    r2, _, _ = select.select([master], [], [], 0.1)
                    if master not in r2:
                        continue
                    try:
                        more = os.read(master, 65536)
                    except OSError:
                        break
                    if not more:
                        break
                    buf.extend(more)
                break
    finally:
        # always capture what we have
        try:
            # final non-blocking drain
            while True:
                r, _, _ = select.select([master], [], [], 0)
                if master not in r:
                    break
                try:
                    more = os.read(master, 65536)
                except OSError:
                    break
                if not more:
                    break
                buf.extend(more)
        except Exception:
            pass
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
            # second chance hard kill
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except OSError:
                pass

    try:
        exit_code = os.waitstatus_to_exitcode(status) if status is not None else -1
    except AttributeError:
        # py3.9
        if status is None:
            exit_code = -1
        elif os.WIFEXITED(status):
            exit_code = os.WEXITSTATUS(status)
        else:
            exit_code = -1

    result = {
        "ok": error is None and step_i >= len(script),
        "exit": exit_code,
        "steps_done": step_i,
        "steps_total": len(script),
        "cols": cols,
        "rows": rows,
        "bytes": len(buf),
        "out_dir": str(out_dir),
        "error": error,
        "has_sgr": b"\x1b[" in bytes(buf),
        "has_truecolor": b"38;2" in bytes(buf) or b"48;2" in bytes(buf),
    }
    write_frames(out_dir, bytes(buf), result)
    if error and not result["ok"]:
        # still return result so callers can inspect frames; raise only if zero bytes
        if len(buf) == 0:
            raise TimeoutError(error + " — child produced no PTY output")
    return result


def self_test() -> None:
    import tempfile

    child = (
        "import sys\n"
        "sys.stdout.write('\\x1b[38;2;255;106;26mAMBER\\x1b[0m ready-for-input\\n')\n"
        "sys.stdout.flush()\n"
        "line=sys.stdin.readline()\n"
        "sys.stdout.write('got:'+line)\n"
        "sys.stdout.flush()\n"
    )
    with tempfile.TemporaryDirectory(prefix="uat-pty-") as td:
        out = Path(td) / "out"
        result = run_pty(
            [sys.executable, "-u", "-c", child],
            cols=80,
            rows=24,
            script=[
                {"expect": r"ready-for-input", "send": "hello\\n", "timeout": 5},
                {"expect": r"got:hello", "timeout": 5},
            ],
            out_dir=out,
            env={"TERM": "xterm-256color", "COLORTERM": "truecolor", "FORCE_COLOR": "3"},
            overall_timeout=10,
        )
        raw = (out / "frame.raw").read_bytes()
        txt = (out / "frame.txt").read_text(encoding="utf-8")
        if b"38;2;255;106;26" not in raw:
            raise SystemExit(f"truecolor SGR missing in frame.raw: {raw!r}")
        if "AMBER" not in txt or "\x1b" in txt:
            raise SystemExit(f"frame.txt strip failed: {txt!r}")
        if not result["ok"]:
            raise SystemExit(f"script incomplete: {result}")
        print("pty_drive self-test: ok", json.dumps(result))


def self_test_tui(cli: str, extra_env: dict[str, str] | None = None) -> dict:
    """Launch the built interactive binary under PTY and assert brand + SGR."""
    import shutil
    import tempfile

    node = shutil.which("node")
    if not node:
        raise SystemExit("node not on PATH")
    cli_path = str(Path(cli).resolve())
    if not Path(cli_path).is_file():
        raise SystemExit(f"cli missing: {cli_path}")

    with tempfile.TemporaryDirectory(prefix="uat-pty-tui-") as td:
        td_path = Path(td)
        home = td_path / "home"
        agent = td_path / "agent"
        subject = td_path / "subject"
        out = td_path / "pty"
        home.mkdir()
        agent.mkdir()
        subject.mkdir()
        # stub model so discovery/model pin does not hang
        stub_log = td_path / "model-requests.jsonl"
        stub_log.write_text("")
        # start stub via node in background using os.system-less spawn
        import subprocess

        stub = Path(__file__).resolve().parent / "stub-model.mjs"
        stub_proc = subprocess.Popen(
            [node, str(stub), "--port", "0", "--log", str(stub_log)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert stub_proc.stdout is not None
        info_line = stub_proc.stdout.readline()
        info = json.loads(info_line)
        base = info["baseUrl"]
        (agent / "settings.json").write_text(
            json.dumps(
                {
                    "defaultProvider": "local-openai",
                    "defaultModel": "uat-stub",
                    "theme": "loop-amber",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        (agent / "accounts.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "pools": {
                        "local-openai": {
                            "strategy": "round-robin",
                            "slots": [{"id": "a", "kind": "local", "label": "a", "baseUrl": base}],
                        }
                    },
                    "fallback": ["local-openai"],
                    "stickiness": "session-until-exhausted",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        (agent / "local-openai-models.json").write_text(
            json.dumps([{"id": "uat-stub", "name": "uat-stub", "baseUrl": base}]) + "\n",
            encoding="utf-8",
        )
        env = {
            "HOME": str(home),
            "KPI_CODING_AGENT_DIR": str(agent),
            "CI": "1",
            "PI_SKIP_VERSION_CHECK": "1",
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "FORCE_COLOR": "3",
        }
        if extra_env:
            env.update(extra_env)
        try:
            result = run_pty(
                [
                    node,
                    cli_path,
                    "--offline",
                    "--model",
                    "local-openai/uat-stub",
                    "--use-theme",
                    "loop-amber",
                ],
                cols=120,
                rows=40,
                script=[
                    {
                        "expect": r"kpi v0|K-\u03c0|K-π|escape interrupt|/ commands",
                        "send": "/\n",
                        "timeout": 25,
                        "drain": 0.6,
                    },
                    {
                        "expect": r"settings|accounts|statusbar|specify|loop",
                        "send": "\x03",
                        "timeout": 12,
                        "after": 0.5,
                    },
                ],
                out_dir=out,
                env=env,
                overall_timeout=40,
                cwd=str(subject),
            )
        finally:
            stub_proc.terminate()
            try:
                stub_proc.wait(timeout=2)
            except Exception:
                stub_proc.kill()

        raw = (out / "frame.raw").read_bytes()
        txt = (out / "frame.txt").read_text(encoding="utf-8")
        checks = {
            "bytes": len(raw),
            "has_sgr": b"\x1b[" in raw,
            "has_truecolor": b"38;2" in raw or b"48;2" in raw,
            "has_kpi_banner": bool(re.search(r"kpi v0\.?\d", txt, re.I)),
            "has_brand": ("K-π" in txt) or ("K-\u03c0" in txt) or ("K-π" in txt),
            "has_slash_menu": bool(re.search(r"settings|accounts|statusbar|specify", txt, re.I)),
            "txt_has_esc": "\x1b" in txt,
            "result_ok": result.get("ok", False),
            "error": result.get("error"),
        }
        # Footer brand may appear as K-π in status line; banner alone is not enough for brand cell.
        # Accept either explicit brand cell or powerline footer containing K- and π.
        if not checks["has_brand"]:
            checks["has_brand"] = bool(re.search(r"K-\s*π|K-π|K-\u03c0", txt))
        failures = []
        if checks["bytes"] < 100:
            failures.append(f"frame too small ({checks['bytes']} bytes) — TUI did not render")
        if not checks["has_sgr"]:
            failures.append("frame.raw missing CSI/SGR sequences")
        if not checks["has_truecolor"]:
            failures.append("frame.raw missing truecolor 38;2/48;2 (theme not applied?)")
        if not checks["has_kpi_banner"] and not checks["has_brand"]:
            failures.append("neither kpi banner nor K-π brand found in frame.txt")
        if checks["txt_has_esc"]:
            failures.append("frame.txt still contains ESC (strip failed)")
        report = {"ok": not failures, "failures": failures, "checks": checks, "pty": result, "out_dir": str(out)}
        # copy frames next to caller if UAT_PTY_OUT set
        dump = os.environ.get("UAT_PTY_OUT")
        if dump:
            dump_p = Path(dump)
            dump_p.mkdir(parents=True, exist_ok=True)
            (dump_p / "frame.raw").write_bytes(raw)
            (dump_p / "frame.txt").write_text(txt, encoding="utf-8")
            (dump_p / "tui-selftest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        if failures:
            raise SystemExit("pty_drive TUI self-test FAILED: " + "; ".join(failures))
        print("pty_drive TUI self-test: ok", json.dumps(checks))
        return report


def main() -> None:
    ap = argparse.ArgumentParser(description="UAT PTY driver")
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--out-dir", type=str, default=".")
    ap.add_argument("--script", type=str, default=None)
    ap.add_argument("--script-file", type=str, default=None)
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--cwd", type=str, default=None)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--self-test-tui", action="store_true")
    ap.add_argument("--cli", type=str, default=None, help="built cli.js for --self-test-tui")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return
    if args.self_test_tui:
        cli = args.cli
        if not cli:
            # default to repo relative
            here = Path(__file__).resolve().parent.parent
            cli = str(here / "packages/coding-agent/dist/bundle/cli.js")
        self_test_tui(cli)
        return

    cmd = list(args.cmd)
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
        cwd=args.cwd,
    )
    print(json.dumps(result))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
