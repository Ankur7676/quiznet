"""QuizNet Tkinter client.

The client draws the quiz and sends the student's choice over TCP.
It does not contain the answer key and it does not compute the score.
Every question, judgement, timer deadline, and leaderboard row comes
from the server as newline-delimited JSON.

Run (after the server is listening):
    python client.py
"""

from __future__ import annotations

import queue
import socket
import sys
import threading
import time
from typing import Any, Callable

import protocol

try:
    import tkinter as tk
    from tkinter import messagebox, ttk
except ImportError as exc:  # pragma: no cover - depends on the OS image
    sys.stderr.write(
        "Tkinter is required for the QuizNet client.\n"
        "Windows: use a python.org install, which includes Tk.\n"
        "Debian/Ubuntu: sudo apt install python3-tk\n"
        f"Import error: {exc}\n"
    )
    raise SystemExit(1) from exc


BG = "#0B1F3A"
SURFACE = "#102C4C"
CARD = "#14365C"
INK = "#E7F1FC"
MUTED = "#9BB3CE"
ACCENT = "#4EA1FF"
ACCENT_INK = "#041018"
OK = "#3DDC97"
BAD = "#FF8B7B"
WARN = "#F0C674"
LINE = "#24507A"

FONT = "Segoe UI"
MONO = "Consolas"


def format_clock(seconds: float) -> str:
    seconds = max(0, int(seconds + 0.999)) if seconds > 0 else 0
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def format_duration(seconds: float) -> str:
    total = max(0.0, float(seconds))
    mins = int(total // 60)
    rest = total - mins * 60
    if mins:
        return f"{mins}m {rest:04.1f}s"
    return f"{rest:.1f}s"


class QuizNetApp:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("QuizNet")
        self.root.geometry("880x700")
        self.root.minsize(760, 620)
        self.root.configure(bg=BG)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self.sock: socket.socket | None = None
        self.stream: protocol.SocketStream | None = None
        self.receiver: threading.Thread | None = None
        self.alive = False
        self.send_lock = threading.Lock()
        self.events: queue.Queue[Callable[[], None]] = queue.Queue()

        self.session_id: str | None = None
        self.username = ""
        self.phase = "home"
        self.return_phase = "lobby"
        self.waiting = False
        self.question: dict[str, Any] | None = None
        self.synced_remaining = 120.0
        self.synced_at = time.monotonic()
        self.choice = tk.StringVar(value="")
        self.banner = tk.StringVar(value="")
        self.conn_text = tk.StringVar(value="Disconnected")
        self.timer_text = tk.StringVar(value="02:00")
        self.progress_text = tk.StringVar(value="Question 0 of 10")
        self.host_var = tk.StringVar(value="127.0.0.1")
        self.port_var = tk.StringVar(value="5000")
        self.user_var = tk.StringVar(value="")

        self._style()
        self._build()
        self._show("home")
        self.root.after(100, self._drain)
        self.root.after(200, self._tick)

    def _style(self) -> None:
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(
            "Quiz.Horizontal.TProgressbar",
            troughcolor=SURFACE,
            background=ACCENT,
            bordercolor=SURFACE,
            lightcolor=ACCENT,
            darkcolor=ACCENT,
            thickness=14,
        )
        style.configure(
            "Quiz.Treeview",
            background=CARD,
            fieldbackground=CARD,
            foreground=INK,
            rowheight=30,
            borderwidth=0,
            font=(FONT, 11),
        )
        style.configure(
            "Quiz.Treeview.Heading",
            background=SURFACE,
            foreground=INK,
            relief="flat",
            font=(FONT, 11, "bold"),
        )
        style.map("Quiz.Treeview", background=[("selected", "#1E6FE0")], foreground=[("selected", INK)])

    def _build(self) -> None:
        header = tk.Frame(self.root, bg=BG)
        header.pack(fill="x", padx=24, pady=(18, 8))
        tk.Label(
            header, text="QuizNet", bg=BG, fg=INK, font=(FONT, 26, "bold")
        ).pack(side="left")
        tk.Label(
            header,
            text="  multiplayer client–server quiz",
            bg=BG,
            fg=MUTED,
            font=(FONT, 12),
        ).pack(side="left", pady=(10, 0))
        self.conn_label = tk.Label(
            header,
            textvariable=self.conn_text,
            bg=SURFACE,
            fg=BAD,
            font=(FONT, 10, "bold"),
            padx=12,
            pady=6,
        )
        self.conn_label.pack(side="right")

        self.body = tk.Frame(self.root, bg=BG)
        self.body.pack(fill="both", expand=True, padx=24, pady=8)
        self.screens: dict[str, tk.Frame] = {}
        self._build_home()
        self._build_lobby()
        self._build_quiz()
        self._build_result()
        self._build_board()
        for screen in self.screens.values():
            screen.place(relx=0, rely=0, relwidth=1, relheight=1)

        footer = tk.Frame(self.root, bg=BG)
        footer.pack(fill="x", padx=24, pady=(0, 14))
        tk.Label(
            footer,
            text="TCP  ·  newline-delimited JSON  ·  the server owns the answer key and the clock",
            bg=BG,
            fg=MUTED,
            font=(FONT, 9),
        ).pack(side="left")

    def _card(self, parent: tk.Frame) -> tk.Frame:
        outer = tk.Frame(parent, bg=BG)
        outer.pack(fill="both", expand=True)
        card = tk.Frame(outer, bg=CARD, highlightbackground=LINE, highlightthickness=1)
        card.pack(fill="both", expand=True)
        inner = tk.Frame(card, bg=CARD)
        inner.pack(fill="both", expand=True, padx=28, pady=24)
        return inner

    def _button(
        self,
        parent: tk.Misc,
        text: str,
        command: Callable[[], None],
        primary: bool = True,
    ) -> tk.Button:
        bg = ACCENT if primary else SURFACE
        fg = ACCENT_INK if primary else INK
        active = "#8CC4FF" if primary else CARD
        btn = tk.Button(
            parent,
            text=text,
            command=command,
            bg=bg,
            fg=fg,
            activebackground=active,
            activeforeground=ACCENT_INK if primary else INK,
            relief="flat",
            bd=0,
            padx=18,
            pady=10,
            font=(FONT, 11, "bold"),
            cursor="hand2",
        )
        return btn

    def _entry(self, parent: tk.Misc, variable: tk.StringVar, width: int = 28) -> tk.Entry:
        return tk.Entry(
            parent,
            textvariable=variable,
            width=width,
            bg=SURFACE,
            fg=INK,
            insertbackground=INK,
            relief="flat",
            font=(FONT, 12),
            highlightthickness=1,
            highlightbackground=LINE,
            highlightcolor=ACCENT,
        )

    def _build_home(self) -> None:
        frame = tk.Frame(self.body, bg=BG)
        self.screens["home"] = frame
        inner = self._card(frame)
        tk.Label(
            inner,
            text="Connect to the quiz server",
            bg=CARD,
            fg=INK,
            font=(FONT, 18, "bold"),
        ).pack(anchor="w")
        tk.Label(
            inner,
            text="Use 127.0.0.1 when the server is on this computer.\n"
            "On a lab LAN, use the server machine's IPv4 address. Usernames must be unique.",
            bg=CARD,
            fg=MUTED,
            font=(FONT, 11),
            justify="left",
        ).pack(anchor="w", pady=(6, 18))

        form = tk.Frame(inner, bg=CARD)
        form.pack(anchor="w", fill="x")
        for label, var in (
            ("Server IP", self.host_var),
            ("Port", self.port_var),
            ("Username", self.user_var),
        ):
            row = tk.Frame(form, bg=CARD)
            row.pack(fill="x", pady=6)
            tk.Label(row, text=label, bg=CARD, fg=MUTED, font=(FONT, 11), width=14, anchor="w").pack(
                side="left"
            )
            self._entry(row, var).pack(side="left", ipady=6, padx=(8, 0))
        self.connect_btn = self._button(inner, "Connect", self._connect_clicked)
        self.connect_btn.pack(anchor="w", pady=(18, 8))
        self.home_error = tk.Label(inner, text="", bg=CARD, fg=BAD, font=(FONT, 11), justify="left")
        self.home_error.pack(anchor="w")

    def _build_lobby(self) -> None:
        frame = tk.Frame(self.body, bg=BG)
        self.screens["lobby"] = frame
        inner = self._card(frame)
        self.hello = tk.Label(inner, text="", bg=CARD, fg=INK, font=(FONT, 18, "bold"))
        self.hello.pack(anchor="w")
        rules = (
            "1. The paper is 10 multiple-choice questions, same order for every student.\n"
            "2. Each correct answer is worth 10 points. Wrong and blank answers score 0.\n"
            "3. You have 120 seconds total, measured on the server, not on this window.\n"
            "4. The server checks the choice. This program does not know the answer key.\n"
            "5. You may open the shared leaderboard after you log in.\n"
            "6. Closing this window does not disconnect anyone else."
        )
        tk.Label(
            inner, text=rules, bg=CARD, fg=INK, font=(FONT, 12), justify="left"
        ).pack(anchor="w", pady=(14, 18))
        row = tk.Frame(inner, bg=CARD)
        row.pack(anchor="w")
        self._button(row, "Start Quiz", self._start_quiz).pack(side="left")
        self._button(row, "Leaderboard", lambda: self._request_board("lobby"), primary=False).pack(
            side="left", padx=8
        )
        self._button(row, "Disconnect", self.disconnect, primary=False).pack(side="left")

    def _build_quiz(self) -> None:
        frame = tk.Frame(self.body, bg=BG)
        self.screens["quiz"] = frame
        inner = self._card(frame)
        top = tk.Frame(inner, bg=CARD)
        top.pack(fill="x")
        self.q_heading = tk.Label(top, text="Question", bg=CARD, fg=INK, font=(FONT, 16, "bold"))
        self.q_heading.pack(side="left")
        self.timer_label = tk.Label(
            top, textvariable=self.timer_text, bg=CARD, fg=WARN, font=(MONO, 18, "bold")
        )
        self.timer_label.pack(side="right")
        self.topic_label = tk.Label(inner, text="", bg=CARD, fg=ACCENT, font=(FONT, 11, "bold"))
        self.topic_label.pack(anchor="w", pady=(8, 4))
        self.q_text = tk.Label(
            inner, text="", bg=CARD, fg=INK, font=(FONT, 14), justify="left", wraplength=720, anchor="w"
        )
        self.q_text.pack(anchor="w", fill="x", pady=(4, 12))
        self.option_buttons: list[tk.Radiobutton] = []
        options = tk.Frame(inner, bg=CARD)
        options.pack(fill="x", anchor="w")
        for key in ("A", "B", "C", "D"):
            btn = tk.Radiobutton(
                options,
                text=f"{key}.",
                variable=self.choice,
                value=key,
                bg=CARD,
                fg=INK,
                selectcolor=SURFACE,
                activebackground=CARD,
                activeforeground=INK,
                font=(FONT, 12),
                anchor="w",
                justify="left",
                wraplength=700,
                padx=6,
                pady=4,
            )
            btn.pack(fill="x", anchor="w")
            self.option_buttons.append(btn)
        tk.Label(inner, textvariable=self.progress_text, bg=CARD, fg=MUTED, font=(FONT, 10)).pack(
            anchor="w", pady=(12, 4)
        )
        self.progress = ttk.Progressbar(
            inner, style="Quiz.Horizontal.TProgressbar", mode="determinate", maximum=100
        )
        self.progress.pack(fill="x", pady=(0, 12))
        row = tk.Frame(inner, bg=CARD)
        row.pack(fill="x")
        self.submit_btn = self._button(row, "Submit answer", self._submit)
        self.submit_btn.pack(side="left")
        self._button(row, "Leaderboard", lambda: self._request_board("quiz"), primary=False).pack(
            side="left", padx=8
        )
        self.banner_label = tk.Label(
            inner, textvariable=self.banner, bg=CARD, fg=MUTED, font=(FONT, 12), justify="left", wraplength=720
        )
        self.banner_label.pack(anchor="w", pady=(12, 0))

    def _build_result(self) -> None:
        frame = tk.Frame(self.body, bg=BG)
        self.screens["result"] = frame
        inner = self._card(frame)
        tk.Label(inner, text="Result", bg=CARD, fg=MUTED, font=(FONT, 12, "bold")).pack(anchor="w")
        self.result_title = tk.Label(inner, text="", bg=CARD, fg=INK, font=(FONT, 20, "bold"))
        self.result_title.pack(anchor="w", pady=(4, 8))
        self.score_big = tk.Label(inner, text="", bg=CARD, fg=ACCENT, font=(FONT, 40, "bold"))
        self.score_big.pack(anchor="w")
        self.result_detail = tk.Label(
            inner, text="", bg=CARD, fg=INK, font=(FONT, 13), justify="left"
        )
        self.result_detail.pack(anchor="w", pady=(8, 16))
        row = tk.Frame(inner, bg=CARD)
        row.pack(anchor="w")
        self._button(row, "New quiz", self._start_quiz).pack(side="left")
        self._button(row, "Leaderboard", lambda: self._request_board("result"), primary=False).pack(
            side="left", padx=8
        )
        self._button(row, "Disconnect", self.disconnect, primary=False).pack(side="left")

    def _build_board(self) -> None:
        frame = tk.Frame(self.body, bg=BG)
        self.screens["board"] = frame
        inner = self._card(frame)
        tk.Label(inner, text="Leaderboard", bg=CARD, fg=INK, font=(FONT, 18, "bold")).pack(anchor="w")
        tk.Label(
            inner,
            text="Highest score wins. If two scores match, the shorter time ranks higher.",
            bg=CARD,
            fg=MUTED,
            font=(FONT, 11),
        ).pack(anchor="w", pady=(4, 10))
        cols = ("rank", "username", "score", "duration", "status")
        self.tree = ttk.Treeview(inner, columns=cols, show="headings", style="Quiz.Treeview", height=12)
        headings = {
            "rank": "Rank",
            "username": "Username",
            "score": "Score",
            "duration": "Duration",
            "status": "Status",
        }
        widths = {"rank": 70, "username": 180, "score": 90, "duration": 140, "status": 140}
        for col in cols:
            self.tree.heading(col, text=headings[col])
            self.tree.column(col, width=widths[col], anchor="center")
        self.tree.pack(fill="both", expand=True)
        row = tk.Frame(inner, bg=CARD)
        row.pack(anchor="w", pady=(12, 0))
        self._button(row, "Refresh", self._refresh_board).pack(side="left")
        self._button(row, "Back", self._back_from_board, primary=False).pack(side="left", padx=8)

    def _show(self, name: str) -> None:
        self.phase = name
        self.screens[name].tkraise()

    def _set_connected(self, connected: bool, label: str) -> None:
        self.conn_text.set(label)
        self.conn_label.configure(fg=OK if connected else BAD, bg=SURFACE)

    def _connect_clicked(self) -> None:
        self.home_error.configure(text="")
        host = self.host_var.get().strip()
        port_text = self.port_var.get().strip()
        username = self.user_var.get().strip()
        if not host:
            self.home_error.configure(text="Enter the server IP address.")
            return
        try:
            port = int(port_text)
        except ValueError:
            self.home_error.configure(text="Port must be a number.")
            return
        if not (1 <= port <= 65535):
            self.home_error.configure(text="Port must be between 1 and 65535.")
            return
        if not username:
            self.home_error.configure(text="Enter a username.")
            return
        self.connect_btn.configure(state="disabled", text="Connecting...")
        threading.Thread(
            target=self._connect_worker, args=(host, port, username), daemon=True
        ).start()

    def _connect_worker(self, host: str, port: int, username: str) -> None:
        try:
            sock = socket.create_connection((host, port), timeout=5)
        except OSError as exc:
            self.events.put(lambda: self._connect_failed(self._friendly_net(exc)))
            return
        sock.settimeout(0.4)
        self.events.put(lambda: self._connect_ready(sock, username))

    def _friendly_net(self, exc: OSError) -> str:
        text = str(exc)
        if getattr(exc, "errno", None) in {111, 10061} or "refused" in text.lower():
            return (
                "The server is not accepting connections. Start server.py and check the IP and port."
            )
        if "timed out" in text.lower():
            return "The connection timed out. Check the IP, port, and firewall."
        return f"Could not connect: {text}"

    def _connect_failed(self, text: str) -> None:
        self.connect_btn.configure(state="normal", text="Connect")
        self.home_error.configure(text=text)
        self._set_connected(False, "Disconnected")

    def _connect_ready(self, sock: socket.socket, username: str) -> None:
        self._close_quiet()
        self.sock = sock
        self.stream = protocol.SocketStream(sock)
        self.alive = True
        self.username = username
        self.session_id = None
        self.receiver = threading.Thread(target=self._recv_loop, name="QuizRecv", daemon=True)
        self.receiver.start()
        self._send({"type": protocol.JOIN, "username": username})
        self._set_connected(True, "Connecting...")

    def _recv_loop(self) -> None:
        stream = self.stream
        while self.alive and stream is not None:
            try:
                message = stream.recv_message()
            except socket.timeout:
                continue
            except protocol.ProtocolError as exc:
                self.events.put(lambda e=str(exc): self._fail(f"The server sent a bad message: {e}"))
                return
            except OSError:
                if self.alive:
                    self.events.put(lambda: self._fail("The connection to the server dropped."))
                return
            if message is None:
                if self.alive:
                    self.events.put(lambda: self._fail("The server closed the connection."))
                return
            self.events.put(lambda m=message: self.on_message(m))

    def _drain(self) -> None:
        while True:
            try:
                fn = self.events.get_nowait()
            except queue.Empty:
                break
            try:
                fn()
            except Exception as exc:  # pragma: no cover - UI callback guard
                self.home_error.configure(text=str(exc))
        self.root.after(50, self._drain)

    def _tick(self) -> None:
        if self.phase == "quiz":
            remaining = self.synced_remaining - (time.monotonic() - self.synced_at)
            self.timer_text.set(format_clock(remaining))
            self.timer_label.configure(fg=BAD if remaining <= 15 else WARN)
            if remaining <= 0:
                self.banner.set("Time is up. Waiting for the server to close the attempt.")
        self.root.after(200, self._tick)

    def _sync_clock(self, message: dict[str, Any]) -> None:
        remaining = message.get("remaining_seconds")
        if isinstance(remaining, (int, float)) and not isinstance(remaining, bool):
            self.synced_remaining = float(remaining)
            self.synced_at = time.monotonic()

    def _send(self, payload: dict[str, Any]) -> None:
        stream = self.stream
        if stream is None:
            self._fail("Not connected.")
            return
        try:
            with self.send_lock:
                stream.send(payload)
        except (OSError, protocol.ProtocolError) as exc:
            self._fail(f"Could not send: {exc}")

    def on_message(self, message: dict[str, Any]) -> None:
        sid = message.get("session_id")
        if isinstance(sid, str) and sid:
            self.session_id = sid
        self._sync_clock(message)
        kind = message.get("type")
        if kind == protocol.JOIN_ACK:
            self.username = str(message.get("username") or self.username)
            self.hello.configure(text=f"Hello, {self.username}")
            self._set_connected(True, f"Connected as {self.username}")
            self.connect_btn.configure(state="normal", text="Connect")
            self.home_error.configure(text="")
            self._show("lobby")
            return
        if kind == protocol.QUESTION:
            self._show_question(message)
            return
        if kind == protocol.ANSWER_FEEDBACK:
            self._show_feedback(message)
            return
        if kind == protocol.QUIZ_RESULT:
            self._show_result(message)
            return
        if kind == protocol.LEADERBOARD:
            self._fill_board(message.get("entries") or [])
            self._show("board")
            return
        if kind == protocol.ERROR:
            self._show_error(str(message.get("code") or "ERROR"), str(message.get("message") or "Error"))
            return
        if kind == protocol.DISCONNECT:
            self._fail("Disconnected.")

    def _show_question(self, message: dict[str, Any]) -> None:
        self.question = message
        self.waiting = False
        self.choice.set("")
        number = int(message.get("number") or 1)
        total = int(message.get("total") or 10)
        self.q_heading.configure(text=f"Question {number} of {total}")
        self.topic_label.configure(text=str(message.get("topic") or ""))
        self.q_text.configure(text=str(message.get("text") or ""))
        options = message.get("options") if isinstance(message.get("options"), dict) else {}
        for btn, key in zip(self.option_buttons, ("A", "B", "C", "D")):
            btn.configure(text=f"{key}.  {options.get(key, '')}", state="normal")
        done = (number - 1) / total * 100 if total else 0
        self.progress["value"] = done
        self.progress_text.set(f"Question {number} of {total}")
        self.submit_btn.configure(state="normal", text="Submit answer")
        self._show("quiz")

    def _show_feedback(self, message: dict[str, Any]) -> None:
        self.waiting = False
        correct = bool(message.get("correct"))
        score = message.get("score")
        option = message.get("correct_option")
        if correct:
            text = f"Correct. The server awarded the point. Score: {score}."
            self.banner_label.configure(fg=OK)
        else:
            text = f"Incorrect. The server says the right choice was {option}. Score: {score}."
            self.banner_label.configure(fg=BAD)
        self.banner.set(text)
        for btn in self.option_buttons:
            btn.configure(state="disabled")
        self.submit_btn.configure(state="disabled")
        total = int((self.question or {}).get("total") or 10)
        number = int((self.question or {}).get("number") or 1)
        self.progress["value"] = number / total * 100 if total else 0

    def _show_result(self, message: dict[str, Any]) -> None:
        self.waiting = False
        status = str(message.get("status") or "")
        title = {
            "completed": "Quiz complete",
            "timeout": "Time expired",
            "disconnected": "Attempt closed",
        }.get(status, "Result")
        self.result_title.configure(text=title)
        score = message.get("score", 0)
        total = message.get("total", 10)
        self.score_big.configure(text=f"{score} / {total * 10 if isinstance(total, int) else 100}")
        detail = (
            f"Correct: {message.get('correct', 0)}\n"
            f"Wrong: {message.get('wrong', 0)}\n"
            f"Unanswered: {message.get('unanswered', 0)}\n"
            f"Percentage: {message.get('percentage', 0)}%\n"
            f"Time taken: {format_duration(float(message.get('duration_seconds') or 0))}\n"
            f"Status: {status}"
        )
        self.result_detail.configure(text=detail)
        if status == "timeout":
            self.banner.set("The server ended the quiz because 120 seconds elapsed.")
        self._show("result")

    def _show_error(self, code: str, text: str) -> None:
        self.waiting = False
        self.connect_btn.configure(state="normal", text="Connect")
        if code in {"DUPLICATE_USERNAME", "BAD_USERNAME"}:
            self._close_quiet()
            self._set_connected(False, "Disconnected")
            self._show("home")
            self.home_error.configure(text=text)
            return
        if code == "TIME_EXPIRED":
            self.banner.set(text)
            self.banner_label.configure(fg=WARN)
            return
        if self.phase == "home":
            self.home_error.configure(text=text)
        else:
            self.banner.set(text)
            self.banner_label.configure(fg=BAD)
            self.submit_btn.configure(state="normal")

    def _fail(self, text: str) -> None:
        self._close_quiet()
        self._set_connected(False, "Disconnected")
        self.waiting = False
        self.connect_btn.configure(state="normal", text="Connect")
        self._show("home")
        self.home_error.configure(text=text)

    def _start_quiz(self) -> None:
        if not self.session_id:
            self._fail("Missing session. Connect again.")
            return
        self.banner.set("")
        self._send({"type": protocol.START_QUIZ, "session_id": self.session_id})

    def _submit(self) -> None:
        if self.waiting or self.question is None or not self.session_id:
            return
        selected = self.choice.get()
        if selected not in {"A", "B", "C", "D"}:
            self.banner.set("Select an option before submitting.")
            self.banner_label.configure(fg=WARN)
            return
        self.waiting = True
        self.submit_btn.configure(state="disabled")
        self._send(
            {
                "type": protocol.SUBMIT_ANSWER,
                "session_id": self.session_id,
                "question_id": self.question.get("question_id"),
                "answer": selected,
            }
        )

    def _request_board(self, back_to: str) -> None:
        if not self.session_id:
            return
        self.return_phase = back_to
        self._send({"type": protocol.GET_LEADERBOARD, "session_id": self.session_id})

    def _refresh_board(self) -> None:
        if self.session_id:
            self._send({"type": protocol.GET_LEADERBOARD, "session_id": self.session_id})

    def _back_from_board(self) -> None:
        target = self.return_phase if self.return_phase in self.screens else "lobby"
        self._show(target)

    def _fill_board(self, entries: object) -> None:
        self.tree.delete(*self.tree.get_children())
        if not isinstance(entries, list) or not entries:
            self.tree.insert("", "end", values=("-", "No finished attempts yet", "-", "-", "-"))
            return
        for row in entries:
            if not isinstance(row, dict):
                continue
            self.tree.insert(
                "",
                "end",
                values=(
                    row.get("rank", ""),
                    row.get("username", ""),
                    row.get("score", ""),
                    format_duration(float(row.get("duration_seconds") or 0)),
                    row.get("status", ""),
                ),
            )

    def disconnect(self) -> None:
        if self.stream is not None and self.session_id:
            try:
                with self.send_lock:
                    self.stream.send(
                        {"type": protocol.DISCONNECT, "session_id": self.session_id}
                    )
            except (OSError, protocol.ProtocolError):
                pass
        self._fail("Disconnected.")

    def _close_quiet(self) -> None:
        self.alive = False
        sock = self.sock
        self.sock = None
        self.stream = None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def _on_close(self) -> None:
        self.disconnect()
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    QuizNetApp().run()


if __name__ == "__main__":
    main()
