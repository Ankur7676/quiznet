# QuizNet — Multiplayer Client–Server Quiz System

QuizNet is a college Computer Networks mini-project. A Python TCP server owns the question paper, the answer key, the 120-second clock, and the score. Any number of Tkinter clients (tested with several at once; the listen backlog accepts at least five) connect, answer, and read one shared SQLite leaderboard.

The client never contains the answer key and never awards its own points.

This is a networking demonstration. TCP gives reliable, ordered bytes. It does not encrypt them and it does not prove who a student is.

## Architecture

```text
+----------------+     TCP 5000      +----------------------+     SQL      +------------+
| client.py      |  JSON lines       | server.py            |              | quiznet.db |
| Tkinter GUI    | <---------------> | one thread / client  | -----------> | results    |
| no answer key  |   newline framed  | answer key + timer   |              +------------+
+----------------+                   +----------------------+
        ^                                      ^
        |                                      |
   another client.py                     protocol.py
   same messages                         database.py
                                         questions.json
```

1. The server creates a TCP socket, `bind`s it, `listen`s, and loops on `accept`.
2. The operating system completes the three-way handshake (SYN, SYN-ACK, ACK) before `accept` returns a connected socket.
3. Each connected socket is handed to its own thread. That thread reads one JSON object per line.
4. `JOIN` registers a unique username and a session id. `START_QUIZ` starts a 120-second monotonic deadline and sends question 1 **without** the correct option.
5. `SUBMIT_ANSWER` is checked on the server: right session, right question, a legal option, not a repeat, and not past the deadline. A correct choice adds 10 points.
6. The server then sends `ANSWER_FEEDBACK` (the key is revealed only now) and either the next `QUESTION` or `QUIZ_RESULT`.
7. The result is inserted once into SQLite. `GET_LEADERBOARD` reads the same table for every client.
8. If the client sends nothing and the deadline passes, a sweeper thread finalizes that session anyway.

TCP is a byte stream. One `recv` may contain half a JSON object or two objects. `protocol.py` keeps a buffer and splits on `\n`. Messages are rejected if they exceed 65,536 bytes. Nothing is unpickled or `eval`'d.

## Requirements

- Python 3.10 or newer. Python 3.11+ is the intended lab version. Only the standard library is used.
- Tkinter, which ships with python.org builds on Windows and macOS.
- On Debian/Ubuntu desktops: `sudo apt install python3-tk`.
- No `pip install` is required.

## Files

| File | CNS idea it demonstrates |
| --- | --- |
| `server.py` | Passive open, `bind` / `listen` / `accept`, concurrency, authoritative application state |
| `client.py` | Active open, request/response, GUI kept separate from scoring |
| `protocol.py` | Application-layer framing on top of TCP |
| `database.py` | Durable shared state; safe access from many threads |
| `questions.json` | Question bank. The paper is ids 1–10 in that order |
| `tests/` | Framing, scoring, duplicate answers, timeout, two live sockets |
| `docs/project_report.md` | Report, screenshot list, viva answers |

## Run the server

From the `quiznet` folder:

```bat
py -3 server.py
```

You should see a line like:

```text
11:40:01 INFO QuizNet listening on 127.0.0.1:5000  paper=10  bank=24  limit=120s  db=...\quiznet.db
```

Useful flags:

```bat
py -3 server.py --host 127.0.0.1 --port 5000
py -3 server.py --host 0.0.0.0 --port 5000
```

- `127.0.0.1` — only this computer. Use this when every client is on the server machine.
- `0.0.0.0` — all interfaces, so other computers on the LAN can connect. The server prints a warning. Do this only on a trusted network.
- In an interactive console, type `quit` and press Enter, or press Ctrl+C. The listening socket closes and client sockets are shut down. If stdin is not a terminal (a service, a log redirect), end-of-file is ignored so the server does not exit by accident.

## Run three clients on one Windows PC

Open three more Command Prompt windows in the `quiznet` folder:

```bat
py -3 client.py
```

```bat
py -3 client.py
```

```bat
py -3 client.py
```

In each window:

1. Server IP: `127.0.0.1`
2. Port: `5000`
3. A different username, for example Asha, Rohan, Meera
4. Connect → Start Quiz

`start` can open extra windows from one prompt:

```bat
start py -3 client.py
start py -3 client.py
start py -3 client.py
```

## Two computers on one Wi-Fi or lab LAN

1. On the machine that will be the server:

   ```bat
   py -3 server.py --host 0.0.0.0 --port 5000
   ipconfig
   ```

2. Note the **IPv4 Address** of the Wi-Fi (or Ethernet) adapter, not the address that starts with `127.`. Example: `192.168.1.20`.
3. If Windows asks, allow Python on **private** networks.
4. On the other computer, run `py -3 client.py`. Enter `192.168.1.20` and port `5000`.
5. The server machine can also run a client pointed at `127.0.0.1` or at its own LAN address.

Both machines must be on the same network. College guest Wi-Fi often isolates clients from each other; use the lab LAN if connections time out. Find the server IP on macOS/Linux with `ipconfig getifaddr en0` or `ip -4 addr`.

## Two students at the same time

1. Start the server once.
2. Connect Asha and Rohan from two client processes.
3. Both press Start. They receive the same question id and the same wording. Neither message contains `answer` or `correct_option`.
4. Let Asha pick one option and Rohan pick another, including at the same moment.
5. The server log shows two `SUBMIT` lines. Each feedback carries only that student's score.
6. Finish, or wait for timeout. Both rows are stored. Either client can press Leaderboard and see both names. Rank is highest score, then shortest duration.
7. Close Asha's window. Rohan's question stays on screen and Rohan can still submit. The server log shows one disconnect and lists Rohan as the remaining client.

A fresh quiz after the result screen uses a new session id. The previous row stays in the database.

## Message catalogue

Every frame is UTF-8 JSON plus `\n`.

Client to server:

```json
{"type":"JOIN","username":"Asha"}
{"type":"START_QUIZ","session_id":"ab12cd34ef567890"}
{"type":"SUBMIT_ANSWER","session_id":"ab12cd34ef567890","question_id":1,"answer":"A"}
{"type":"GET_LEADERBOARD","session_id":"ab12cd34ef567890"}
{"type":"DISCONNECT","session_id":"ab12cd34ef567890"}
```

Server to client:

```json
{"type":"JOIN_ACK","session_id":"ab12cd34ef567890","username":"Asha","message":"Welcome to QuizNet, Asha.","quiz_seconds":120,"question_count":10}
{"type":"QUESTION","session_id":"ab12cd34ef567890","question_id":1,"number":1,"total":10,"topic":"Computer Networks","text":"Before application data flows, TCP establishes a connection using which sequence?","options":{"A":"SYN, SYN-ACK, ACK","B":"ACK, SYN, FIN","C":"FIN, FIN-ACK, ACK","D":"ARP, DNS, DHCP"},"remaining_seconds":118.4}
{"type":"ANSWER_FEEDBACK","session_id":"ab12cd34ef567890","question_id":1,"selected":"A","correct":true,"correct_option":"A","score":10,"remaining_seconds":110.2}
{"type":"QUIZ_RESULT","session_id":"ab12cd34ef567890","username":"Asha","score":80,"correct":8,"wrong":1,"unanswered":1,"total":10,"percentage":80.0,"duration_seconds":95.2,"status":"completed"}
{"type":"LEADERBOARD","session_id":"ab12cd34ef567890","entries":[{"rank":1,"username":"Asha","score":80,"duration_seconds":95.2,"status":"completed"}]}
{"type":"ERROR","code":"DUPLICATE_USERNAME","message":"Asha is already connected. Choose another name."}
```

`correct_option` is sent only inside `ANSWER_FEEDBACK`, after the choice is locked. A wrong or unknown option does not consume the question. An old or future `question_id` is rejected. A `session_id` from another connection is rejected. The same session is inserted into SQLite at most once.

Scoring: 10 points per correct answer, 0 for wrong or blank, maximum 100. Status is `completed`, `timeout`, or `disconnected`. Only completed and timed-out attempts are ranked.

## Sample server log

```text
11:40:01 INFO QuizNet listening on 127.0.0.1:5000  paper=10  bank=24  limit=120s  db=quiznet.db
11:40:12 INFO JOIN Asha from ('127.0.0.1', 51002) session=ab12cd34ef567890
11:40:12 INFO Active clients (1): Asha
11:40:18 INFO JOIN Rohan from ('127.0.0.1', 51008) session=98ff0011aabbccdd
11:40:18 INFO Active clients (2): Asha, Rohan
11:40:21 INFO START Asha session=ab12cd34ef567890 limit=120s
11:40:22 INFO START Rohan session=98ff0011aabbccdd limit=120s
11:40:30 INFO SUBMIT ab12cd34ef567890 q=1 answer=A correct=True score=10
11:40:31 INFO SUBMIT 98ff0011aabbccdd q=1 answer=C correct=False score=0
11:42:05 INFO RESULT Asha score=100 status=completed duration=40.12s correct=10 wrong=0 unanswered=0
11:42:20 INFO DISCONNECT Rohan from ('127.0.0.1', 51008)
11:42:20 INFO Active clients (1): Asha
```

A full local run of the automated checks produced Asha 100/100 (10 correct) and Rohan 50/100 (5 correct), with Asha ranked first on the shared leaderboard. Those two clients were independent sockets.

## Rules the server enforces

- Username required, at most 20 characters, letters, digits, spaces, `.`, `_`, `-`, must start with a letter or digit.
- Usernames are unique among **currently connected** students, compared without case. `Asha` and `asha` conflict. The name can be used again after disconnect.
- Each connection has its own session. A second quiz after a result gets a new session id.
- Total time is 120 seconds from `START_QUIZ`, using `time.monotonic`, not the client clock.
- Unanswered questions score 0 when the deadline hits or the socket drops mid-quiz.
- Finalizing a session twice does not insert a second database row.

## Tests

From the project root (the folder that contains `quiznet/`):

```bat
py -3 -m unittest discover -s quiznet/tests -v
```

The tests cover split and coalesced TCP frames, illegal JSON, oversized frames, a perfect score of 100, wrong answers, duplicate submissions, invalid options, out-of-order ids, a single timeout finalization, leaderboard tie-break, duplicate inserts, two simultaneous sockets, a stolen session id, and a server-pushed timeout when the client stops sending.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| Connection refused | `server.py` is running. IP and port match. On a second PC you did not type `127.0.0.1`. |
| Timed out | Firewall, wrong IPv4 address, or Wi-Fi client isolation. |
| Address already in use | An old server still holds 5000. Close it or use `--port 5001` on both sides. |
| Duplicate username | That person is still connected. Disconnect them or change the name. |
| Tkinter import error | Install `python3-tk` on Linux. Reinstall Python from python.org on Windows. |
| Time expired immediately | The server deadline passed. The client countdown is only a display. |
| Leaderboard missing a disconnect | Mid-quiz disconnects are stored with status `disconnected` but are not ranked. |
| Someone on the LAN can read answers | Expected. There is no TLS. Do not put real exam marks on an open network. |

Inspect the database:

```bat
py -3 -c "import sqlite3; c=sqlite3.connect('quiznet.db'); print(c.execute('select username,score,completion_status,duration_seconds from results').fetchall())"
```

## What this project is not

It is not HTTPS, not a login system, and not safe against a classmate who can sniff the LAN or edit their own client. The defence is that the server ignores any score the client might invent, because the client is never asked for one.
