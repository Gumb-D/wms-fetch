"""
WMS Export — control UI.

Wraps download_export.py with:
  • Status strip (next scheduled run / last log result / cookies age)
  • "Run Now" mode picker + per-export status chips + live stdout console
  • Tabs:
      Output    — live stdout from the current run
      History   — list of recent logs/run_*.log (double-click to open)
      Schedules — table of Windows Task Scheduler entries we own
                  (one task per row, add/edit/delete/enable/disable/run-now)

Each schedule maps to its own Windows scheduled task named
`WMS_Export_<HHMM>_<dayspec>` (or `..._DAILY`), so you can have any number
of schedules at different times of day.

Launch via run.bat (or `python wms_ui.py`). Requires Python 3.10+.
"""

from __future__ import annotations

import os
import queue
import re
import subprocess
import sys
import threading
from datetime import datetime, timedelta
from pathlib import Path
from tkinter import (
    BooleanVar,
    Label as TkLabel,
    StringVar,
    Tk,
    Toplevel,
    messagebox,
    ttk,
)
from tkinter.scrolledtext import ScrolledText

HERE = Path(__file__).resolve().parent
DOWNLOAD_SCRIPT = HERE / "download_export.py"
SCHEDULED_WRAPPER = HERE / "_scheduled_run.py"
LOG_DIR = HERE / "logs"
COOKIE_META = HERE / "cookies_meta.txt"

# Keep in sync with exports/__init__.py — listed manually so the UI can be
# imported without running the export package (avoids the requests import on
# startup, makes the UI snappy).
EXPORT_NAMES: list[str] = ["inventory", "transfer", "lock"]

DAY_CODES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]

# All WMS-owned scheduled tasks share this prefix so enumeration is a simple
# name-prefix filter on `schtasks /Query` output.
WMS_TASK_PREFIX = "WMS_Export_"


# ─────────────────────────────────────────────────────────────────── subprocess


class RunnerThread(threading.Thread):
    """Run download_export.py in a child process and stream stdout to a queue.

    Why a queue + after(): tkinter is single-threaded; touching widgets from a
    worker thread is a recipe for crashes. The UI polls the queue on its own
    event loop and writes lines from there.
    """

    def __init__(self, args: list[str], out_queue: queue.Queue[str]) -> None:
        super().__init__(daemon=True)
        self.args = args
        self.q = out_queue
        self.returncode: int | None = None
        self._proc: subprocess.Popen[str] | None = None

    def run(self) -> None:
        cmd = [sys.executable, "-u", str(DOWNLOAD_SCRIPT), *self.args]
        self.q.put(f"$ {' '.join(cmd)}\n")
        try:
            self._proc = subprocess.Popen(
                cmd,
                cwd=str(HERE),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            self.q.put(f"[launch failed] {exc}\n")
            self.returncode = -1
            self.q.put("__DONE__")
            return

        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            self.q.put(line)
        self._proc.wait()
        self.returncode = self._proc.returncode
        self.q.put(f"\n[exit code: {self.returncode}]\n")
        self.q.put("__DONE__")

    def cancel(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()


# ─────────────────────────────────────────────────────────────────── task names

# Compact single-character day codes used inside task names. Cron-ish: T is
# Tuesday, H is Thursday, A is Saturday, U is Sunday. Keeping names short
# avoids butting against Windows' MAX_PATH on the per-task .bat path.
_DAY_COMPACT = {
    "MON": "M", "TUE": "T", "WED": "W", "THU": "H",
    "FRI": "F", "SAT": "A", "SUN": "U",
}
_DAY_FROM_COMPACT = {v: k for k, v in _DAY_COMPACT.items()}
_TASK_NAME_RE = re.compile(r"^WMS_Export_(\d{4})_(DAILY|[MTWHFAU]+)$")


def compact_days(days: list[str]) -> str:
    """['MON','WED','FRI'] -> 'MWF'. All 7 -> 'DAILY'."""
    s = set(days)
    if len(s) == 7:
        return "DAILY"
    return "".join(_DAY_COMPACT[d] for d in DAY_CODES if d in s)


def expand_compact(spec: str) -> list[str]:
    if spec == "DAILY":
        return list(DAY_CODES)
    return [_DAY_FROM_COMPACT[c] for c in spec if c in _DAY_FROM_COMPACT]


def task_name_for(hh_mm: str, days: list[str]) -> str:
    hh, mm = hh_mm.split(":")
    return f"{WMS_TASK_PREFIX}{hh}{mm}_{compact_days(days)}"


def parse_task_name(name: str) -> tuple[str, list[str]] | None:
    """Reverse of task_name_for: 'WMS_Export_0830_MTWHF' -> ('08:30', [...])."""
    m = _TASK_NAME_RE.match(name)
    if not m:
        return None
    hhmm, dayspec = m.group(1), m.group(2)
    return f"{hhmm[:2]}:{hhmm[2:]}", expand_compact(dayspec)


def format_days(days: list[str] | None) -> str:
    if not days:
        return "?"
    s = set(days)
    if len(s) == 7:
        return "Every day"
    if s == {"MON", "TUE", "WED", "THU", "FRI"}:
        return "Weekdays"
    if s == {"SAT", "SUN"}:
        return "Weekends"
    return ", ".join(d for d in DAY_CODES if d in s)


# schtasks "Last Result" exit codes worth naming. Anything else is shown as a
# hex code so a failing run is recognizable (e.g. 0x80070002 = file not found).
_LAST_RESULT_LABELS = {
    "0": "OK",
    "267008": "Ready",
    "267009": "Running",
    "267010": "Queued",
    "267011": "Never run",
}


def format_last_result(code: str) -> str:
    code = (code or "").strip()
    if not code:
        return "--"
    if code in _LAST_RESULT_LABELS:
        return _LAST_RESULT_LABELS[code]
    try:
        return f"err 0x{int(code) & 0xFFFFFFFF:08X}"
    except ValueError:
        return code


def format_mode_summary(args: list[str]) -> str:
    """Human-readable summary of the per-task CLI args, for the Mode column."""
    exports = [a for a in args if a in EXPORT_NAMES]
    skip = "--skip-auth" in args
    base = "Full pipeline" if not exports else ", ".join(exports)
    return base + ("  (skip auth)" if skip else "")


# ─────────────────────────────────────────────────────────────────── scheduling


def _python_exe_for_task() -> str:
    """Use pythonw.exe for the scheduled task so it runs without a console.

    Falls back to the current python.exe if pythonw isn't alongside it (very
    rare on Windows installs, but possible for embedded Python).
    """
    here = Path(sys.executable).parent
    pyw = here / "pythonw.exe"
    return str(pyw if pyw.exists() else Path(sys.executable))


_SAFE_TASK_RE = re.compile(r"[^A-Za-z0-9._-]")


def _launcher_bat_path(task_name: str) -> Path:
    """Where the per-task launcher lives. Sanitized so the filename is always safe."""
    safe = _SAFE_TASK_RE.sub("_", task_name) or "task"
    return HERE / f"_scheduled_{safe}.bat"


def _write_task_launcher(task_name: str, export_args: list[str]) -> Path:
    """Write a per-task .bat the scheduler calls — one absolute path, no nested
    quoting through schtasks. Side benefit: the user can open the .bat to see
    exactly what their schedule will run.
    """
    pyexe = _python_exe_for_task()
    bat = _launcher_bat_path(task_name)
    args_joined = " ".join(export_args)
    body = (
        "@echo off\r\n"
        f"REM AUTOGENERATED by wms_ui.py for scheduled task: {task_name}\r\n"
        "REM Edit the schedule through the WMS UI, not this file.\r\n"
        f'cd /d "{HERE}"\r\n'
        f'"{pyexe}" "{SCHEDULED_WRAPPER}" {args_joined}\r\n'
    )
    bat.write_text(body, encoding="ascii")
    return bat


_BAT_ARGS_RE = re.compile(r'_scheduled_run\.py"\s*(.*?)\s*$')


def read_task_args(task_name: str) -> list[str]:
    """Recover the CLI args a scheduled task will pass to download_export.py.

    Source of truth is the per-task .bat we wrote — its last line invokes the
    wrapper with the args at the end. Returns [] if the .bat is missing or
    unparseable (treated as 'full pipeline').
    """
    bat = _launcher_bat_path(task_name)
    if not bat.exists():
        return []
    try:
        text = bat.read_text(encoding="ascii", errors="replace")
    except OSError:
        return []
    for line in text.splitlines():
        m = _BAT_ARGS_RE.search(line)
        if m:
            return m.group(1).split()
    return []


def schtasks_create(
    task_name: str,
    hh_mm: str,
    days: list[str],
    export_args: list[str],
) -> tuple[bool, str]:
    """Create (or replace, via /F) a Windows scheduled task.

    Points the task at a generated per-task .bat instead of inlining the full
    command — keeps schtasks' /TR parsing out of the picture entirely.
    """
    bat = _write_task_launcher(task_name, export_args)

    # /TR must be a *quoted* path: our project dir contains a space
    # ("WMS CLARA export"), and Task Scheduler stores /TR verbatim. Without the
    # embedded quotes it splits the action at the first space and runs
    # "...\Python\WMS", failing every run with 0x80070002 (file not found).
    cmd = [
        "schtasks", "/Create",
        "/TN", task_name,
        "/TR", f'"{bat}"',
        "/ST", hh_mm,
        "/F",
    ]
    if days and len(days) < 7:
        cmd += ["/SC", "WEEKLY", "/D", ",".join(days)]
    else:
        cmd += ["/SC", "DAILY"]

    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as exc:
        return False, f"could not invoke schtasks: {exc}"
    out = (r.stdout or "") + (r.stderr or "")
    return r.returncode == 0, out.strip()


def schtasks_delete(task_name: str) -> tuple[bool, str]:
    r = subprocess.run(
        ["schtasks", "/Delete", "/TN", task_name, "/F"],
        capture_output=True, text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    # Best-effort cleanup of the generated launcher — schtasks success isn't
    # required (e.g., manual deletes via the GUI still want the .bat gone).
    try:
        _launcher_bat_path(task_name).unlink(missing_ok=True)
    except OSError:
        pass
    return r.returncode == 0, (r.stdout or r.stderr).strip()


def schtasks_change_enabled(task_name: str, enabled: bool) -> tuple[bool, str]:
    flag = "/ENABLE" if enabled else "/DISABLE"
    try:
        r = subprocess.run(
            ["schtasks", "/Change", "/TN", task_name, flag],
            capture_output=True, text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as exc:
        return False, f"could not invoke schtasks: {exc}"
    out = (r.stdout or "") + (r.stderr or "")
    return r.returncode == 0, out.strip()


# ─────────────────────────────────────────────────────────────────── enumeration

# Keys in schtasks /Query /V /FO LIST output (English Windows). On a localized
# install the table just shows "(unknown)" / blank — everything still works.
_FIELDS_OF_INTEREST = {
    "TaskName", "Next Run Time", "Last Run Time", "Last Result",
    "Status", "Scheduled Task State",
}


def list_wms_tasks() -> list[dict]:
    """Enumerate every scheduled task whose name starts with WMS_TASK_PREFIX.

    schtasks /Query /FO LIST /V emits blank-line-separated key:value blocks,
    one per task. We pull the fields we care about and parse the time/days
    from our canonical task name (the bat file gives us back the CLI args).
    """
    try:
        r = subprocess.run(
            ["schtasks", "/Query", "/FO", "LIST", "/V"],
            capture_output=True, text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError:
        return []
    if r.returncode != 0:
        return []

    blocks: list[dict[str, str]] = []
    cur: dict[str, str] = {}
    for line in (r.stdout or "").splitlines():
        if not line.strip():
            if cur:
                blocks.append(cur)
                cur = {}
            continue
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if k in _FIELDS_OF_INTEREST and k not in cur:
            cur[k] = v
    if cur:
        blocks.append(cur)

    out: list[dict] = []
    for b in blocks:
        # TaskName is the full path: "\WMS_Export_0830_MTWHF". Strip the slash.
        name = b.get("TaskName", "").lstrip("\\")
        if not name.startswith(WMS_TASK_PREFIX):
            continue
        parsed = parse_task_name(name)
        state = b.get("Scheduled Task State", "").lower()
        # Older Windows versions surface enabled/disabled in "Status" instead.
        enabled = "disabled" not in state
        if state == "" and b.get("Status", "").lower() == "disabled":
            enabled = False
        out.append({
            "name": name,
            "time": parsed[0] if parsed else None,
            "days": parsed[1] if parsed else None,
            "args": read_task_args(name),
            "enabled": enabled,
            "next_run": b.get("Next Run Time", ""),
            "last_run": b.get("Last Run Time", ""),
            "last_result": b.get("Last Result", ""),
            "status": b.get("Status", ""),
        })
    # Sort by time so the table reads top-to-bottom chronologically.
    out.sort(key=lambda d: (d["time"] or "99:99", d["name"]))
    return out


# ─────────────────────────────────────────────────────────────────── log status

_LOG_SUMMARY_RE = re.compile(r"^\s*(\d+)\s+ok,\s+(\d+)\s+failed\b", re.MULTILINE)
_LOG_NAME_RE = re.compile(r"^run_(\d{8})_(\d{6})\.log$")


def log_timestamp(path: Path) -> datetime | None:
    m = _LOG_NAME_RE.match(path.name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
    except ValueError:
        return None


def parse_log_status(path: Path) -> str:
    """OK / FAIL ×N / crashed / running? / unknown — from the log tail."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > 16384:
                fh.seek(-16384, 2)
            tail = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return "unknown"
    if "[wrapper] unhandled exception" in tail:
        return "crashed"
    m = _LOG_SUMMARY_RE.search(tail)
    if m:
        fail = int(m.group(2))
        return "OK" if fail == 0 else f"FAIL x{fail}"
    return "running?"


def list_run_logs(limit: int = 100) -> list[tuple[Path, datetime, int, str]]:
    """(path, run_time, size_bytes, status) for recent logs, newest first."""
    if not LOG_DIR.exists():
        return []
    items: list[tuple[Path, datetime, int, str]] = []
    for p in LOG_DIR.glob("run_*.log"):
        ts = log_timestamp(p)
        if ts is None:
            continue
        try:
            sz = p.stat().st_size
        except OSError:
            sz = 0
        items.append((p, ts, sz, parse_log_status(p)))
    items.sort(key=lambda t: t[1], reverse=True)
    return items[:limit]


def cookies_age() -> timedelta | None:
    if not COOKIE_META.exists():
        return None
    try:
        for line in COOKIE_META.read_text(encoding="utf-8").splitlines():
            if line.startswith("extracted_at="):
                dt = datetime.fromisoformat(line.split("=", 1)[1].strip())
                now = datetime.now(dt.tzinfo) if dt.tzinfo else datetime.now()
                return now - dt
    except (OSError, ValueError):
        return None
    return None


def fmt_age(td: timedelta) -> str:
    s = max(0, int(td.total_seconds()))
    if s < 60: return f"{s}s"
    if s < 3600: return f"{s // 60}m"
    if s < 86400: return f"{s // 3600}h"
    return f"{s // 86400}d"


def fmt_size(n: int) -> str:
    if n < 1024: return f"{n} B"
    if n < 1024 * 1024: return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


# ─────────────────────────────────────────────────────────────────── UI


_CHIP_STATES = {
    # state -> (bg, fg, label-suffix)
    "idle": ("#e5e7eb", "#374151", ""),
    "run":  ("#dbeafe", "#1e40af", " ..."),
    "ok":   ("#dcfce7", "#166534", " ok"),
    "fail": ("#fee2e2", "#991b1b", " fail"),
}


class LogViewer(Toplevel):
    """Read-only viewer for one run log, shown in-app (no external editor).

    Scheduled runs write logs/run_*.log via _scheduled_run.py; this surfaces
    them without depending on whatever .log is associated with in the shell.
    Refresh re-reads from disk so an in-progress run can be tailed live.
    """

    def __init__(self, parent: Tk, path: Path) -> None:
        super().__init__(parent)
        self.path = path
        self.title(f"Log — {path.name}")
        self.geometry("900x600")
        self.transient(parent)

        bar = ttk.Frame(self, padding=(8, 6))
        bar.pack(fill="x")
        ttk.Label(bar, text=str(path), foreground="#555").pack(side="left")
        ttk.Button(bar, text="Refresh", command=self._load).pack(side="right")
        ttk.Button(bar, text="Open externally", command=self._open_external).pack(
            side="right", padx=(0, 6)
        )

        self.text = ScrolledText(self, wrap="none", font=("Consolas", 10))
        self.text.pack(fill="both", expand=True, padx=6, pady=(0, 6))
        self.text.configure(state="disabled")

        self.bind("<Escape>", lambda _e: self.destroy())
        self._load()

    def _load(self) -> None:
        try:
            content = self.path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            content = f"[could not read log]\n{exc}"
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")
        self.text.insert("1.0", content)
        self.text.see("end")
        self.text.configure(state="disabled")

    def _open_external(self) -> None:
        try:
            os.startfile(str(self.path))
        except OSError as exc:
            messagebox.showerror("Open failed", f"{self.path}\n\n{exc}", parent=self)


class ScheduleDialog(Toplevel):
    """Modal add/edit dialog for one scheduled run.

    On OK, `self.result` is a dict {time, days, args}. On cancel/close it's None.
    """

    def __init__(
        self,
        parent: Tk,
        initial: dict | None = None,
        title: str = "Add schedule",
    ) -> None:
        super().__init__(parent)
        self.title(title)
        self.transient(parent)
        self.resizable(False, False)

        self.result: dict | None = None
        ini = initial or {}
        ini_args = ini.get("args") or []
        ini_exports = [a for a in ini_args if a in EXPORT_NAMES]

        self._time_var = StringVar(value=ini.get("time") or "08:30")
        self._day_vars = {
            d: BooleanVar(value=(d in (ini.get("days") or
                                       ["MON", "TUE", "WED", "THU", "FRI"])))
            for d in DAY_CODES
        }
        self._mode_var = StringVar(value="custom" if ini_exports else "full")
        # In full mode, pre-tick all so flipping to custom doesn't start empty.
        self._export_vars = {
            n: BooleanVar(value=(n in ini_exports) if ini_exports else True)
            for n in EXPORT_NAMES
        }
        self._skip_var = BooleanVar(value=("--skip-auth" in ini_args))

        self._build()
        self._refresh_custom_state()

        self.bind("<Return>", lambda _e: self._on_ok())
        self.bind("<Escape>", lambda _e: self._on_cancel())
        self.protocol("WM_DELETE_WINDOW", self._on_cancel)

        # Center over parent before grabbing focus.
        self.update_idletasks()
        px, py = parent.winfo_rootx(), parent.winfo_rooty()
        pw, ph = parent.winfo_width(), parent.winfo_height()
        w, h = self.winfo_width(), self.winfo_height()
        self.geometry(f"+{px + (pw - w) // 2}+{py + (ph - h) // 2}")
        self.grab_set()
        self.wait_window()

    def _build(self) -> None:
        f = ttk.Frame(self, padding=12)
        f.pack(fill="both", expand=True)

        rt = ttk.Frame(f)
        rt.pack(fill="x", pady=(0, 8))
        ttk.Label(rt, text="Time (HH:MM, 24h):").pack(side="left")
        ttk.Entry(rt, textvariable=self._time_var, width=10).pack(side="left", padx=(8, 0))

        rd_box = ttk.LabelFrame(f, text="Days")
        rd_box.pack(fill="x", pady=(0, 8))
        rd = ttk.Frame(rd_box)
        rd.pack(padx=8, pady=6)
        for d in DAY_CODES:
            ttk.Checkbutton(rd, text=d, variable=self._day_vars[d]).pack(
                side="left", padx=2
            )

        mode_box = ttk.LabelFrame(f, text="Mode")
        mode_box.pack(fill="x", pady=(0, 8))
        ttk.Radiobutton(
            mode_box, text="Full pipeline (all exports)",
            value="full", variable=self._mode_var,
            command=self._refresh_custom_state,
        ).pack(anchor="w", padx=10, pady=(8, 2))
        ttk.Radiobutton(
            mode_box, text="Custom subset",
            value="custom", variable=self._mode_var,
            command=self._refresh_custom_state,
        ).pack(anchor="w", padx=10, pady=(2, 4))
        self._custom_frame = ttk.Frame(mode_box)
        self._custom_frame.pack(anchor="w", padx=32, pady=(0, 6))
        for n in EXPORT_NAMES:
            ttk.Checkbutton(
                self._custom_frame, text=n, variable=self._export_vars[n],
            ).pack(side="left", padx=6)
        ttk.Checkbutton(
            mode_box, text="Skip auth refresh (trust cookies.txt as-is)",
            variable=self._skip_var,
        ).pack(anchor="w", padx=10, pady=(0, 8))

        rb = ttk.Frame(f)
        rb.pack(fill="x", pady=(8, 0))
        ttk.Button(rb, text="OK", command=self._on_ok).pack(side="right")
        ttk.Button(rb, text="Cancel", command=self._on_cancel).pack(
            side="right", padx=(0, 6)
        )

    def _refresh_custom_state(self) -> None:
        state = "normal" if self._mode_var.get() == "custom" else "disabled"
        for c in self._custom_frame.winfo_children():
            c.configure(state=state)

    def _on_ok(self) -> None:
        try:
            t = datetime.strptime(self._time_var.get().strip(), "%H:%M")
        except ValueError:
            messagebox.showerror(
                "Bad time", "Use 24-hour HH:MM, e.g. 08:30.", parent=self,
            )
            return
        hh_mm = t.strftime("%H:%M")  # zero-pad — schtasks rejects "9:00".
        days = [d for d in DAY_CODES if self._day_vars[d].get()]
        if not days:
            messagebox.showerror(
                "No days", "Pick at least one day of the week.", parent=self,
            )
            return
        args: list[str] = []
        if self._mode_var.get() == "custom":
            chosen = [n for n in EXPORT_NAMES if self._export_vars[n].get()]
            if not chosen:
                messagebox.showerror(
                    "Nothing selected",
                    "Custom mode is on but no exports are checked.",
                    parent=self,
                )
                return
            args.extend(chosen)
        if self._skip_var.get():
            args.append("--skip-auth")
        self.result = {"time": hh_mm, "days": days, "args": args}
        self.destroy()

    def _on_cancel(self) -> None:
        self.result = None
        self.destroy()


class App:
    POLL_MS = 80              # subprocess output queue drain
    STATUS_REFRESH_MS = 5000  # status strip + tables auto-refresh

    def __init__(self, root: Tk) -> None:
        self.root = root
        root.title("WMS Export — Control Panel")
        root.geometry("960x900")
        root.minsize(820, 700)

        self.runner: RunnerThread | None = None
        self.out_queue: queue.Queue[str] = queue.Queue()

        # Run Now state (the schedule tab carries its own per-row state)
        self.mode_var = StringVar(value="full")
        self.skip_auth_var = BooleanVar(value=False)
        self.export_vars: dict[str, BooleanVar] = {
            n: BooleanVar(value=True) for n in EXPORT_NAMES
        }

        # Status strip vars
        self.schedule_status_var = StringVar(value="Schedule:  (loading...)")
        self.last_run_var = StringVar(value="Last run:  (loading...)")
        self.cookies_status_var = StringVar(value="Cookies:  (loading...)")

        # Per-export chips
        self.chip_widgets: dict[str, TkLabel] = {}

        # Schedule-tab cache (most recent enumeration) so selection -> row
        # lookup doesn't need a re-query.
        self._current_schedules: list[dict] = []

        self._build_ui()
        self._refresh_custom_state()
        root.after(self.POLL_MS, self._drain_queue)
        root.after(100, self._refresh_status)

    # ------------------------------------------------------------------ build

    def _build_ui(self) -> None:
        pad = {"padx": 8, "pady": 6}
        outer = ttk.Frame(self.root, padding=10)
        outer.pack(fill="both", expand=True)

        # --- Status strip ----------------------------------------------
        strip = ttk.Frame(outer, relief="groove", padding=(8, 4))
        strip.pack(fill="x", **pad)
        ttk.Label(strip, textvariable=self.schedule_status_var).pack(
            side="left", padx=(0, 18)
        )
        ttk.Label(strip, textvariable=self.last_run_var).pack(
            side="left", padx=(0, 18)
        )
        ttk.Label(strip, textvariable=self.cookies_status_var).pack(side="left")
        ttk.Button(strip, text="Refresh", command=self._refresh_status, width=9).pack(
            side="right"
        )

        # --- Run Now mode ----------------------------------------------
        mode_box = ttk.LabelFrame(outer, text="Run Now mode")
        mode_box.pack(fill="x", **pad)
        ttk.Radiobutton(
            mode_box,
            text="Full pipeline  (run all exports in registry order)",
            value="full", variable=self.mode_var,
            command=self._refresh_custom_state,
        ).pack(anchor="w", padx=10, pady=(8, 2))
        ttk.Radiobutton(
            mode_box, text="Custom subset",
            value="custom", variable=self.mode_var,
            command=self._refresh_custom_state,
        ).pack(anchor="w", padx=10, pady=(2, 4))
        self.custom_frame = ttk.Frame(mode_box)
        self.custom_frame.pack(anchor="w", padx=32, pady=(0, 8))
        for name in EXPORT_NAMES:
            ttk.Checkbutton(
                self.custom_frame, text=name, variable=self.export_vars[name],
            ).pack(side="left", padx=6)
        ttk.Checkbutton(
            mode_box, text="Skip auth refresh (trust cookies.txt as-is)",
            variable=self.skip_auth_var,
        ).pack(anchor="w", padx=10, pady=(0, 8))

        # --- Run controls + chips --------------------------------------
        run_box = ttk.Frame(outer)
        run_box.pack(fill="x", **pad)
        self.run_btn = ttk.Button(run_box, text="Run Now", command=self.on_run)
        self.run_btn.pack(side="left")
        self.stop_btn = ttk.Button(
            run_box, text="Stop", command=self.on_stop, state="disabled"
        )
        self.stop_btn.pack(side="left", padx=(8, 0))
        ttk.Button(run_box, text="Clear Output", command=self._clear_output).pack(
            side="left", padx=(8, 0)
        )
        chip_box = ttk.Frame(run_box)
        chip_box.pack(side="left", padx=(16, 0))
        for name in EXPORT_NAMES:
            chip = TkLabel(
                chip_box,
                text=name,
                padx=8, pady=2,
                borderwidth=1, relief="solid",
                font=("Segoe UI", 9),
            )
            chip.pack(side="left", padx=3)
            self.chip_widgets[name] = chip
        self._reset_chips()
        self.status_var = StringVar(value="Idle.")
        ttk.Label(run_box, textvariable=self.status_var, foreground="#444").pack(
            side="right"
        )

        # --- Notebook (Output / History / Schedules) -------------------
        nb = ttk.Notebook(outer)
        nb.pack(fill="both", expand=True, **pad)
        self.notebook = nb

        # Output tab
        out_tab = ttk.Frame(nb)
        nb.add(out_tab, text="Output")
        self.output = ScrolledText(
            out_tab, height=14, wrap="word", font=("Consolas", 10)
        )
        self.output.pack(fill="both", expand=True, padx=4, pady=4)
        self.output.configure(state="disabled")

        # History tab
        hist_tab = ttk.Frame(nb)
        nb.add(hist_tab, text="History")
        hist_tab.grid_rowconfigure(0, weight=1)
        hist_tab.grid_columnconfigure(0, weight=1)
        cols = ("time", "status", "size")
        self.history_tree = ttk.Treeview(
            hist_tab, columns=cols, show="headings", selectmode="browse"
        )
        self.history_tree.heading("time", text="Run Time")
        self.history_tree.heading("status", text="Status")
        self.history_tree.heading("size", text="Size")
        self.history_tree.column("time", width=180, anchor="w")
        self.history_tree.column("status", width=120, anchor="w")
        self.history_tree.column("size", width=90, anchor="e")
        sb = ttk.Scrollbar(hist_tab, orient="vertical", command=self.history_tree.yview)
        self.history_tree.configure(yscrollcommand=sb.set)
        self.history_tree.grid(row=0, column=0, sticky="nsew", padx=(4, 0), pady=4)
        sb.grid(row=0, column=1, sticky="ns", pady=4)
        self.history_tree.bind("<Double-1>", self._on_history_open)

        hist_btns = ttk.Frame(hist_tab)
        hist_btns.grid(row=1, column=0, columnspan=2, sticky="ew", padx=4, pady=(0, 6))
        ttk.Button(hist_btns, text="View log", command=self._on_history_open).pack(
            side="left"
        )
        ttk.Label(
            hist_btns, text="(scheduled runs log here; double-click a row to view)",
            foreground="#777",
        ).pack(side="left", padx=(10, 0))

        # Schedules tab
        sch_tab = ttk.Frame(nb)
        nb.add(sch_tab, text="Schedules")
        sch_tab.grid_rowconfigure(0, weight=1)
        sch_tab.grid_columnconfigure(0, weight=1)

        tree_frame = ttk.Frame(sch_tab)
        tree_frame.grid(row=0, column=0, sticky="nsew", padx=4, pady=4)
        tree_frame.grid_rowconfigure(0, weight=1)
        tree_frame.grid_columnconfigure(0, weight=1)

        scols = ("enabled", "time", "days", "mode", "next", "last")
        self.schedule_tree = ttk.Treeview(
            tree_frame, columns=scols, show="headings", selectmode="browse"
        )
        self.schedule_tree.heading("enabled", text="On")
        self.schedule_tree.heading("time", text="Time")
        self.schedule_tree.heading("days", text="Days")
        self.schedule_tree.heading("mode", text="Mode")
        self.schedule_tree.heading("next", text="Next run")
        self.schedule_tree.heading("last", text="Last result")
        self.schedule_tree.column("enabled", width=40, anchor="center", stretch=False)
        self.schedule_tree.column("time", width=70, anchor="w", stretch=False)
        self.schedule_tree.column("days", width=140, anchor="w", stretch=False)
        self.schedule_tree.column("mode", width=230, anchor="w", stretch=True)
        self.schedule_tree.column("next", width=170, anchor="w", stretch=False)
        self.schedule_tree.column("last", width=90, anchor="w", stretch=False)
        sb2 = ttk.Scrollbar(tree_frame, orient="vertical", command=self.schedule_tree.yview)
        self.schedule_tree.configure(yscrollcommand=sb2.set)
        self.schedule_tree.grid(row=0, column=0, sticky="nsew")
        sb2.grid(row=0, column=1, sticky="ns")
        self.schedule_tree.bind("<Double-1>", lambda _e: self._on_schedule_edit())
        # Color disabled rows so the eye can skip them at a glance.
        self.schedule_tree.tag_configure("disabled", foreground="#9ca3af")

        btns = ttk.Frame(sch_tab)
        btns.grid(row=1, column=0, sticky="ew", padx=4, pady=(0, 6))
        ttk.Button(btns, text="+ Add", command=self._on_schedule_add).pack(side="left")
        ttk.Button(btns, text="Edit", command=self._on_schedule_edit).pack(
            side="left", padx=(6, 0)
        )
        ttk.Button(btns, text="Delete", command=self._on_schedule_delete).pack(
            side="left", padx=(6, 0)
        )
        ttk.Button(btns, text="Enable / Disable", command=self._on_schedule_toggle).pack(
            side="left", padx=(6, 0)
        )
        ttk.Button(btns, text="Run selected now", command=self._on_run_selected_now).pack(
            side="left", padx=(16, 0)
        )

    # ------------------------------------------------------------------ helpers

    def _refresh_custom_state(self) -> None:
        state = "normal" if self.mode_var.get() == "custom" else "disabled"
        for child in self.custom_frame.winfo_children():
            child.configure(state=state)

    def _selected_exports(self) -> list[str]:
        if self.mode_var.get() == "full":
            return []
        return [n for n in EXPORT_NAMES if self.export_vars[n].get()]

    def _build_cli_args(self) -> list[str] | None:
        args: list[str] = []
        if self.mode_var.get() == "custom":
            chosen = self._selected_exports()
            if not chosen:
                messagebox.showwarning(
                    "Nothing selected",
                    "Custom mode is on but no exports are checked.",
                )
                return None
            args.extend(chosen)
        if self.skip_auth_var.get():
            args.append("--skip-auth")
        return args

    def _append(self, text: str) -> None:
        self.output.configure(state="normal")
        self.output.insert("end", text)
        self.output.see("end")
        self.output.configure(state="disabled")

    def _clear_output(self) -> None:
        self.output.configure(state="normal")
        self.output.delete("1.0", "end")
        self.output.configure(state="disabled")

    # --- chip helpers ---------------------------------------------------

    def _set_chip(self, name: str, state: str) -> None:
        chip = self.chip_widgets.get(name)
        if chip is None:
            return
        bg, fg, suffix = _CHIP_STATES[state]
        chip.configure(text=f"{name}{suffix}", bg=bg, fg=fg)

    def _reset_chips(self) -> None:
        for name in EXPORT_NAMES:
            self._set_chip(name, "idle")

    _EXPORT_START_RE = re.compile(r"^\s*EXPORT:\s+(\w+)\s*$")
    _EXPORT_OK_RE    = re.compile(r"^\s*\[OK\]\s+(\w+)\b")
    _EXPORT_FAIL_RE  = re.compile(r"^\s*\[FAIL\]\s+(\w+)\b")

    def _chip_from_line(self, line: str) -> None:
        if (m := self._EXPORT_START_RE.match(line)):
            self._set_chip(m.group(1), "run")
        elif (m := self._EXPORT_OK_RE.match(line)):
            self._set_chip(m.group(1), "ok")
        elif (m := self._EXPORT_FAIL_RE.match(line)):
            self._set_chip(m.group(1), "fail")

    def _drain_queue(self) -> None:
        try:
            while True:
                line = self.out_queue.get_nowait()
                if line == "__DONE__":
                    self._on_run_finished()
                else:
                    self._append(line)
                    self._chip_from_line(line)
        except queue.Empty:
            pass
        self.root.after(self.POLL_MS, self._drain_queue)

    # ------------------------------------------------------------------ runs

    def _start_run(self, args: list[str], label: str) -> bool:
        if self.runner and self.runner.is_alive():
            messagebox.showinfo("Already running", "A run is in progress.")
            return False
        if not DOWNLOAD_SCRIPT.exists():
            messagebox.showerror("Missing script", f"Not found: {DOWNLOAD_SCRIPT}")
            return False

        self._clear_output()
        self._reset_chips()
        running_set = {a for a in args if a in EXPORT_NAMES} or set(EXPORT_NAMES)
        for n in EXPORT_NAMES:
            if n not in running_set:
                self.chip_widgets[n].configure(fg="#9ca3af")  # dimmed
        self._append(
            f"[{datetime.now():%Y-%m-%d %H:%M:%S}] starting ({label})\n"
        )
        self.status_var.set("Running...")
        self.run_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        try:
            self.notebook.select(0)  # surface Output tab
        except Exception:
            pass

        self.runner = RunnerThread(args, self.out_queue)
        self.runner.start()
        return True

    def on_run(self) -> None:
        args = self._build_cli_args()
        if args is None:
            return
        if self.mode_var.get() == "full":
            label = "full pipeline"
        else:
            label = f"custom: {', '.join(self._selected_exports())}"
        if self.skip_auth_var.get():
            label += " (skip auth)"
        self._start_run(args, label)

    def on_stop(self) -> None:
        if self.runner and self.runner.is_alive():
            self.runner.cancel()
            self._append("\n[stop requested]\n")

    def _on_run_finished(self) -> None:
        rc = self.runner.returncode if self.runner else None
        self.status_var.set(f"Finished (exit {rc})." if rc is not None else "Idle.")
        self.run_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        # Any chip still "run" means the export never printed [OK]/[FAIL] —
        # flip it to fail so the row honestly reflects the exit code.
        if rc not in (None, 0):
            for name, chip in self.chip_widgets.items():
                if str(chip.cget("bg")) == _CHIP_STATES["run"][0]:
                    self._set_chip(name, "fail")
        self.root.after(200, self._refresh_status)

    # ------------------------------------------------------------------ schedule actions

    def _selected_schedule(self) -> dict | None:
        sel = self.schedule_tree.selection()
        if not sel:
            return None
        tags = self.schedule_tree.item(sel[0], "tags")
        # tag[0] is the task name; tag[1] (if present) is the row-style tag.
        if not tags:
            return None
        name = tags[0]
        for s in self._current_schedules:
            if s["name"] == name:
                return s
        return None

    def _on_schedule_add(self) -> None:
        dlg = ScheduleDialog(self.root, title="Add schedule")
        if dlg.result is None:
            return
        self._create_or_replace(None, dlg.result)

    def _on_schedule_edit(self) -> None:
        item = self._selected_schedule()
        if item is None:
            messagebox.showinfo("No selection", "Pick a schedule in the table first.")
            return
        if item["time"] is None:
            messagebox.showwarning(
                "Legacy task",
                f"'{item['name']}' wasn't created by this UI. "
                "Delete it and add a fresh schedule instead.",
            )
            return
        initial = {"time": item["time"], "days": item["days"], "args": item["args"]}
        dlg = ScheduleDialog(self.root, initial=initial, title="Edit schedule")
        if dlg.result is None:
            return
        self._create_or_replace(item["name"], dlg.result)

    def _create_or_replace(self, old_name: str | None, new: dict) -> None:
        new_name = task_name_for(new["time"], new["days"])
        # If the rename would orphan the old task, delete it first.
        if old_name and old_name != new_name:
            schtasks_delete(old_name)
        ok, msg = schtasks_create(new_name, new["time"], new["days"], new["args"])
        if ok:
            self._append(
                f"\n[scheduled] {new_name}: {new['time']} on "
                f"{','.join(new['days'])} -- args: {new['args'] or '(all)'}\n"
            )
            self.root.after(200, self._refresh_status)
        else:
            self._append(f"\n[schtasks failed]\n{msg}\n")
            messagebox.showerror("schtasks failed", msg or "Unknown error.")

    def _on_schedule_delete(self) -> None:
        item = self._selected_schedule()
        if item is None:
            messagebox.showinfo("No selection", "Pick a schedule in the table first.")
            return
        if not messagebox.askyesno(
            "Delete schedule", f"Delete schedule '{item['name']}'?",
        ):
            return
        ok, msg = schtasks_delete(item["name"])
        self._append(f"\n[delete '{item['name']}']\n{msg}\n")
        if ok:
            self.root.after(200, self._refresh_status)
        else:
            messagebox.showerror("Delete failed", msg or "Unknown error.")

    def _on_schedule_toggle(self) -> None:
        item = self._selected_schedule()
        if item is None:
            messagebox.showinfo("No selection", "Pick a schedule in the table first.")
            return
        new_state = not item["enabled"]
        ok, msg = schtasks_change_enabled(item["name"], new_state)
        label = "enabled" if new_state else "disabled"
        self._append(f"\n[toggle '{item['name']}'] -> {label}\n{msg}\n")
        if ok:
            self.root.after(200, self._refresh_status)
        else:
            messagebox.showerror("Toggle failed", msg or "Unknown error.")

    def _on_run_selected_now(self) -> None:
        item = self._selected_schedule()
        if item is None:
            messagebox.showinfo("No selection", "Pick a schedule in the table first.")
            return
        self._start_run(list(item["args"]), f"schedule {item['name']}")

    # ------------------------------------------------------------------ status

    def _refresh_status(self) -> None:
        """Pull schedule list + cookies + logs on a worker, apply on the UI thread."""

        def worker() -> None:
            schedules = list_wms_tasks()
            age = cookies_age()
            logs = list_run_logs(limit=200)
            self.root.after(0, lambda: self._apply_status(schedules, age, logs))

        threading.Thread(target=worker, daemon=True).start()
        self.root.after(self.STATUS_REFRESH_MS, self._refresh_status)

    def _apply_status(
        self,
        schedules: list[dict],
        age: timedelta | None,
        logs: list[tuple[Path, datetime, int, str]],
    ) -> None:
        # --- Status strip: schedule summary ------------------------------
        enabled = [s for s in schedules if s["enabled"]]
        if not schedules:
            self.schedule_status_var.set("Schedule:  none")
        elif not enabled:
            self.schedule_status_var.set(
                f"Schedule:  {len(schedules)} (all disabled)"
            )
        else:
            # Lacking a parsed datetime we sort by HH:MM string and report
            # the first enabled row. Close enough for an at-a-glance label.
            with_time = [s for s in enabled if s["time"]]
            soonest = sorted(with_time, key=lambda s: s["time"])[0] if with_time else enabled[0]
            when = soonest["time"] or soonest["next_run"] or "?"
            more = f"  (+{len(enabled) - 1} more)" if len(enabled) > 1 else ""
            self.schedule_status_var.set(f"Schedule:  next {when}{more}")

        # --- Last run ----------------------------------------------------
        if not logs:
            self.last_run_var.set("Last run:  (none yet)")
        else:
            _, ts, _, st = logs[0]
            self.last_run_var.set(f"Last run:  {ts:%Y-%m-%d %H:%M}  {st}")

        # --- Cookies -----------------------------------------------------
        if age is None:
            self.cookies_status_var.set("Cookies:  (missing meta)")
        else:
            tag = "valid" if age < timedelta(hours=24) else "stale"
            self.cookies_status_var.set(f"Cookies:  {tag} ({fmt_age(age)} old)")

        self._refresh_schedule_table(schedules)
        self._refresh_history_tree(logs)

    def _refresh_schedule_table(self, schedules: list[dict]) -> None:
        # Preserve selection by task name across rebuilds.
        sel_name = ""
        if (sel := self.schedule_tree.selection()):
            tags = self.schedule_tree.item(sel[0], "tags")
            if tags:
                sel_name = tags[0]
        self.schedule_tree.delete(*self.schedule_tree.get_children())
        self._current_schedules = schedules
        for s in schedules:
            on_mark = "Yes" if s["enabled"] else "No"
            time = s["time"] or "(legacy)"
            days = format_days(s["days"])
            mode = format_mode_summary(s["args"])
            nxt = s["next_run"] or "--"
            last = format_last_result(s["last_result"])
            row_tag = "enabled" if s["enabled"] else "disabled"
            iid = self.schedule_tree.insert(
                "", "end",
                values=(on_mark, time, days, mode, nxt, last),
                tags=(s["name"], row_tag),
            )
            if s["name"] == sel_name:
                self.schedule_tree.selection_set(iid)
                self.schedule_tree.see(iid)

    def _refresh_history_tree(
        self, logs: list[tuple[Path, datetime, int, str]],
    ) -> None:
        sel_path = ""
        if (sel := self.history_tree.selection()):
            tags = self.history_tree.item(sel[0], "tags")
            if tags:
                sel_path = tags[0]
        self.history_tree.delete(*self.history_tree.get_children())
        for path, ts, sz, st in logs:
            iid = self.history_tree.insert(
                "", "end",
                values=(f"{ts:%Y-%m-%d %H:%M:%S}", st, fmt_size(sz)),
                tags=(str(path),),
            )
            if str(path) == sel_path:
                self.history_tree.selection_set(iid)
                self.history_tree.see(iid)

    def _on_history_open(self, _event: object = None) -> None:
        sel = self.history_tree.selection()
        if not sel:
            messagebox.showinfo("No selection", "Pick a log row first.")
            return
        tags = self.history_tree.item(sel[0], "tags")
        if not tags:
            return
        LogViewer(self.root, Path(tags[0]))


def main() -> None:
    if sys.platform == "win32":
        try:
            from ctypes import windll  # type: ignore[attr-defined]
            windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    root = Tk()
    try:
        style = ttk.Style(root)
        if "vista" in style.theme_names():
            style.theme_use("vista")
    except Exception:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
