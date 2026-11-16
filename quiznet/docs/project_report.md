# QuizNet — Multiplayer Client–Server Quiz System

**Course:** Computer Networks (CNS)  
**Type:** Mini-project  
**Stack:** Python 3, TCP sockets, threads, newline-delimited JSON, Tkinter, SQLite  

---

## Abstract

QuizNet is a multiplayer quiz in which a single server is the only component allowed to know the answer key, award marks, and stop the clock. Students run a desktop client that connects over TCP, receives questions as JSON, and submits a letter A–D. The server checks the letter, adds 10 points for a correct choice, and refuses a second answer to the same question. Every student gets the same ten questions in the same order and an independent 120-second limit. When the paper is finished or the deadline passes, the server writes one row to SQLite and can show that row on a shared leaderboard. The work is a teaching implementation of the client–server model, TCP’s byte stream, application-layer framing, and concurrency. It is not an encrypted examination platform.

## 1. Introduction

A quiz that grades itself inside the program the student is running can be edited. The student, or a modified client, can read the key or submit a score. Moving the key to a server does not help if the “server” is only a function call in the same process. The communication has to leave the process, go through the network stack, and come back.

QuizNet does that with TCP. The client calls `socket.create_connection`. The kernel performs the three-way handshake. The server, blocked in `accept`, receives a new connected socket and starts a thread. From that moment the only things that cross the socket are UTF-8 JSON lines defined by this project. The client renders whatever the server sends. It does not import `questions.json`.

The same server can talk to several clients because each client has its own socket and its own thread. Closing one socket does not close the listening socket and does not close the others.

## 2. Objectives

1. Show a working client–server application using the Python `socket` API and TCP.
2. Keep questions, answers, scores, and the timer under server control.
3. Serve at least five clients concurrently with threads, without races on the username table or double inserts in SQLite.
4. Define a small application protocol on top of TCP’s byte stream, including framing.
5. Give each student an independent session and a fair paper: the same ten questions in a fixed order.
6. Persist results and rank them by score, then by time.
7. Survive a client that disconnects, sends garbage, repeats an answer, or goes silent until the deadline.

## 3. Existing system and proposed system

| | Paper quiz or a local GUI | QuizNet |
| --- | --- | --- |
| Where the key lives | On the desk, or inside the student program | Only in the server process |
| Who computes the mark | A human, or the same program that displays the buttons | The server, after it receives the choice |
| Simultaneous students | Separate copies, no live board | Many TCP clients, one leaderboard |
| Time limit | A clock the student can see and sometimes change | `time.monotonic` deadline on the server |
| Failure of one student | Irrelevant to others | One thread ends; the accept loop continues |
| Record | A sheet that can be rewritten | One SQLite row per session id |

The proposed system still trusts the network. A person who can read packets can read questions after they are sent, and can read the correct letter after that question has been marked. That is stated on purpose. Adding TLS would hide the bytes but would not teach the socket calls the course asks for, and it would be easy to describe badly. The report does not claim encryption.

## 4. Hardware and software requirements

**Hardware**

- One computer for the server. The same computer can also run clients.
- Optional: a second computer or phone-tethered laptop on the same LAN.
- No special NIC. Any interface with an IPv4 address is enough.

**Software**

- Python 3.10 or newer (3.11+ recommended). Standard library only: `socket`, `threading`, `json`, `tkinter`, `sqlite3`, `time`, `datetime`, `logging`, `argparse`, `secrets`.
- Windows: the python.org installer includes Tkinter. Command Prompt is enough.
- Linux desktop: the `python3-tk` package if the client is used.
- A text editor. No database server, no web framework, no third-party package.

**Network**

- Loopback `127.0.0.1` for clients on the server PC.
- A private IPv4 address and TCP port 5000 for LAN use.
- Firewall permission for inbound TCP 5000 when other machines connect.

## 5. Architecture

### 5.1 Processes

- **Server.** One process. One listening socket. N connected sockets. N handler threads plus one timeout sweeper.
- **Client.** One process per student. One connected socket. The GUI thread draws Tkinter widgets. A second thread blocks in `recv` and posts events back with `after()`, because Tkinter widgets must be touched on the thread that created them.

### 5.2 Data flow

```text
client GUI
   |  user picks option B
   |  SUBMIT_ANSWER {session_id, question_id, answer:"B"}
   v
TCP sendall ---- byte stream ----> server handler thread
                                      | validate session, question, option, time
                                      | compare with private answer map
                                      | score += 10 or 0
                                      v
                                   ANSWER_FEEDBACK  (correct letter included)
                                   QUESTION or QUIZ_RESULT
                                      |
                                   if finished: INSERT into SQLite once
   ^
TCP recv <---- byte stream ----+
   |
client shows the text the server sent
```

### 5.3 Session rules

- Login requires a non-empty username matching a small character set, length 1–20.
- The username must be unique among live connections. Comparison ignores case.
- `START_QUIZ` moves that connection from the lobby into an active attempt and records `deadline = monotonic_now + 120`.
- The paper is questions 1 through 10 of `questions.json`, sorted by id. The bank has 24 questions so the file is more than a hard-coded list of ten; every live attempt still sees the same ten, in the same order, which keeps the leaderboard comparable.
- Submissions must name the session bound to **this socket**. A guessed session id from another student is rejected.
- The question id must be the one the server is currently waiting for. Repeating a previous id is a duplicate. Skipping ahead is out of order. `Z` or `1` is an invalid option and does not advance the paper.
- On the tenth accepted answer the server finalizes with status `completed`.
- If the deadline passes, status is `timeout`. Remaining questions count as unanswered and score 0. Finalization is idempotent: a second call does not change the score and does not insert a second row.
- A dropped socket during an active attempt is stored as `disconnected` and is kept out of the public ranking, so leaving early cannot win a time tie.
- After a result, `START_QUIZ` creates a new session id on the same connection.

### 5.4 Protocol

The application protocol is line-delimited JSON.

| Direction | Type | Role |
| --- | --- | --- |
| C → S | `JOIN` | Request a username |
| S → C | `JOIN_ACK` | Session id and welcome |
| C → S | `START_QUIZ` | Begin or restart an attempt |
| S → C | `QUESTION` | Stem, four options, time left. No key |
| C → S | `SUBMIT_ANSWER` | Letter for the current question |
| S → C | `ANSWER_FEEDBACK` | Right or wrong, running score, key now revealed |
| S → C | `QUIZ_RESULT` | Totals, percentage, duration, status |
| C → S | `GET_LEADERBOARD` | Ask for the board |
| S → C | `LEADERBOARD` | Ranked rows |
| S → C | `ERROR` | Machine-readable `code` plus a sentence |
| Either | `DISCONNECT` | Clean close |

Maximum frame size is 65,536 bytes. Sockets use timeouts so a blocked `recv` still wakes up to notice the deadline or a shutdown.

### 5.5 Concurrency and storage

The set of connected usernames is guarded by a lock. Session fields for one student are guarded by that handler’s lock, which both the handler and the sweeper take. Sends on one socket take a separate lock so two threads cannot interleave bytes of two JSON lines.

SQLite connections are opened per operation and closed before the function returns. Threads therefore do not share a connection object. `INSERT OR IGNORE` plus a `UNIQUE` session id stops a double finalization from creating two rows. Ranking query:

```sql
SELECT ... FROM results
WHERE completion_status IN ('completed', 'timeout')
ORDER BY score DESC, duration_seconds ASC, id ASC
```

### 5.6 What runs where in the three-way handshake

The Python program does not send SYN itself. `connect()` and `accept()` are the API. The OS sends SYN from the client, SYN-ACK from the server, and ACK from the client, then `accept` returns. Only after that does the client write the `JOIN` line. Reliability after the handshake (retransmission, ordering, checksums) is also the OS and TCP, which is why the application still has to define message boundaries itself.

## 6. Implementation notes

- `protocol.MessageReader.feed` appends a chunk, splits on `\n`, and leaves a partial line in the buffer. `SocketStream` queues extra objects when one segment contains two lines.
- `server.QuizSession.submit` is the only place a point is added. The Tkinter client updates its score label from `ANSWER_FEEDBACK.score`.
- `server.ClientHandler.check_timeout` is called from the handler’s own loop and from the sweeper, so a silent client still ends.
- `client.py` connects on a background thread so a five-second refusal does not freeze the window. Received messages are queued and applied with `root.after`.
- Logging goes to the console and to `server.log`: joins, the active-name list, each submission, each result, and disconnects.
- `--host 0.0.0.0` logs a warning that the port is reachable on the LAN and that traffic is not encrypted.

## 7. Screenshots to capture

Take these during the demonstration and paste them into the printed report:

1. Server console showing `QuizNet listening` on port 5000.
2. Client home screen: title QuizNet, IP, port, username, Connect, and the disconnected status.
3. Connected status and the instructions / Start Quiz screen.
4. A question with four options, the progress bar, and the countdown.
5. Feedback after Submit, including a wrong answer that names the server’s correct letter, with the radios disabled.
6. Result screen: score, correct, wrong, unanswered, percentage, time, status.
7. Leaderboard with at least two usernames, ranks, scores, and durations.
8. Two client windows side by side, different usernames, same question number.
9. Server log at that moment showing two `SUBMIT` lines and `Active clients (2)`.
10. One client closed, the other still on a question, server log showing a single disconnect.
11. Optional LAN proof: `ipconfig` on the server and the second PC’s home screen with that IPv4 address filled in.
12. Optional: Wireshark filter `tcp.port == 5000` showing the handshake and then JSON payloads. Do not do this on a network where other people’s traffic would be captured.

## 8. Testing

Automated tests live in `tests/` and use only `unittest`.

| Case | Expected |
| --- | --- |
| One JSON line | One object |
| Two lines in one chunk | Two objects, in order |
| A line split across two feeds | Nothing, then one object |
| Invalid JSON, a JSON array, an oversized buffer | `ProtocolError` |
| Ten correct answers | Score 100, and a second finalize returns nothing |
| Wrong answer | 0 points; key absent from `QUESTION`, present in feedback |
| Option `Z`, future id, repeated id | Rejected; invalid option does not advance |
| Deadline | Status `timeout`, 10 unanswered, duration capped at 120, one row |
| Two SQLite rows with score 80 | Shorter duration ranks first; a disconnected row is not ranked |
| Two live sockets | Same first question, different session ids, independent scores |
| Second `JOIN` with the same name | `DUPLICATE_USERNAME` |
| `session_id` copied from the other student | `INVALID_SESSION` |
| Client starts and then sends nothing | Server pushes `QUIZ_RESULT` |
| Asha disconnects | Rohan can still answer; the name Asha can join again |

A separate scripted pass answered all ten questions on two sockets: one scored 100, the other 50, and the leaderboard returned them in that order.

Manual checks for the viva:

- Start the server, then three clients on `127.0.0.1`.
- Answer one question on two clients before either has finished.
- Pull the network cable or close a window mid-quiz and show the other client still works.
- Let a client sit on question 1 until the server sends a timeout result.
- Open the leaderboard from a client that has not started, and again after two results exist.

## 9. Results

The server binds, accepts concurrent clients, and rejects a duplicate live username. Question messages observed on the wire do not contain the answer field. Correct answers add 10, wrong answers add 0, and a complete paper sums to 100. A silent client is finalized once by the server. SQLite keeps a single row per session id. The leaderboard order follows score, then duration. Closing one socket releases only that username.

The Tkinter client is the program a student runs on a lab PC. The socket behaviour above was executed against `server.py` directly, which is the authoritative path the GUI uses as well.

## 10. Conclusion

QuizNet meets the aim of a CNS mini-project: several clients, one server, real TCP, an explicit application protocol, shared state protected against simple races, and a score the client cannot invent. The design stays inside the standard library so it can be read in an exam and run on a lab image without a package install.

The important limit is honesty about security. Reliability is not confidentiality. A demonstration port bound to `0.0.0.0` is visible to the local network. The project is fit for a lab. It is not fit for a graded university examination without transport security, authentication, and a locked-down client image.

## 11. Future scope

- TLS on the same message protocol, with a note that TLS sits between TCP and the JSON.
- A short-lived token after `JOIN` so a session id is not the only check.
- A seeded shuffle stored on the server when the process starts, still identical for every student in that sitting.
- An admin command to load a different paper id range from the bank.
- IPv6 dual-stack listen.
- A small Wireshark colouring rule and a packet-capture appendix.

## 12. Viva questions

1. **What is a socket?**  
   One end of a communication, identified by protocol, IP address, and port. The program reads and writes bytes on it. The kernel does the packet work.

2. **What is a port?**  
   A 16-bit number that selects the process on a host. QuizNet’s application port is 5000. Ports 80 and 443 are the usual HTTP and HTTPS ports. An IP address selects the host.

3. **TCP versus UDP?**  
   TCP is connection-oriented, ordered, and retransmitted. UDP is connectionless and may drop or reorder datagrams. QuizNet uses TCP so a question or an answer is not silently lost.

4. **Describe the three-way handshake.**  
   Client SYN, server SYN-ACK, client ACK. Both sides synchronize sequence numbers. It finishes inside `connect` / `accept`, before the `JOIN` line is written.

5. **What is a client–server architecture?**  
   Clients request a service. The server holds the service’s state. In QuizNet the server holds the paper, the key, the clock, and the leaderboard. Clients do not trust each other and are not trusted with the key.

6. **What do `bind`, `listen`, and `accept` do?**  
   `bind` attaches the socket to an address and port. `listen` marks it passive and sets a backlog. `accept` returns a new socket for one client. The listening socket remains.

7. **Why can `recv` return half a message?**  
   TCP is a stream of bytes, not a stream of JSON objects. The sender’s two `sendall` calls may arrive as one chunk, or one object may arrive in two chunks. Newline framing rebuilds the objects.

8. **Why not pickle?**  
   Unpickling bytes from the network can execute code the sender chose. `json.loads` only builds strings, numbers, lists, and dicts. The project also refuses `eval`.

9. **What is 127.0.0.1? What is 0.0.0.0?**  
   127.0.0.1 is loopback, reachable only on this machine. Binding to `0.0.0.0` accepts connections on every IPv4 interface. That exposes the lab to the LAN. It still does not encrypt.

10. **Why a thread per client?**  
    If the accept loop itself blocked inside one student’s `recv`, nobody else could join or answer. Threads let one socket wait while another runs. The username set is locked. SQLite is not shared as one connection across threads.

11. **Why is the timer not in Tkinter?**  
    The student controls that process. They can pause it or patch it. The server records a monotonic deadline and finalizes the session even when no further message arrives.

12. **How is a duplicate answer stopped?**  
    The session remembers answered ids and the index of the open question. A repeat raises `DUPLICATE_ANSWER` and does not add points. Finalization uses a unique session id so the database row cannot be inserted twice.

13. **What is an application-layer protocol?**  
    The rules for the meaning of bytes carried by the transport layer. HTTP is one. QuizNet’s JSON types (`JOIN`, `QUESTION`, `SUBMIT_ANSWER`, and the rest) are another, a small one written for this project.

14. **Does reliable delivery mean the quiz is secure?**  
    No. TCP detects corruption and recovers from loss. It does not hide bytes from someone on the path, and it does not stop a modified client from trying illegal messages. The server checks those messages; it does not encrypt them.

15. **What happens when one client disconnects?**  
    That handler sees `recv` return empty or raise, saves an active attempt as disconnected, drops the username, and closes its socket. `accept` and every other handler continue.

16. **How are equal scores ordered?**  
    The higher score wins. If scores match, the smaller server-measured duration wins. The duration cannot be chosen by the client.

## 13. References

1. James F. Kurose and Keith W. Ross, *Computer Networking: A Top-Down Approach* — application protocols, transport services, sockets.
2. Behrouz A. Forouzan, *Data Communications and Networking* — TCP connection management, ports, client–server.
3. W. Richard Stevens, *UNIX Network Programming* — `bind`, `listen`, `accept`, byte streams.
4. Python Software Foundation, *socket*, *threading*, *json*, *sqlite3*, and *tkinter* documentation.
5. RFC 793, Transmission Control Protocol — handshake, reliability, stream semantics.

## Appendix A. How to demonstrate in the lab

1. `py -3 server.py` and show the listening line.
2. Two clients, two usernames, `127.0.0.1`, port 5000.
3. Start both. Show that the question text matches and that the JSON you describe has no answer key. If a capture is allowed, filter `tcp.port == 5000`.
4. Submit different letters. Show two scores in the server log.
5. Finish one client or wait for time. Open the leaderboard on the other.
6. Close one client. Submit on the remaining client.
7. For the LAN step, restart the server with `--host 0.0.0.0`, read `ipconfig`, and connect the second PC to that IPv4 address.

## Appendix B. Verification checklist

- [ ] `py -3 -m unittest discover -s quiznet/tests -v` passes.
- [ ] Server prints the listening address and port.
- [ ] Client home screen connects and shows the username.
- [ ] A second client with the same username is rejected.
- [ ] Both clients can be on a question at the same time.
- [ ] A wrong letter scores 0 and the feedback names the server’s letter.
- [ ] The tenth answer or the deadline produces one result, not two.
- [ ] `quiznet.db` has one row for that session id.
- [ ] Leaderboard order is score, then time.
- [ ] Closing client A does not disconnect client B.
- [ ] A LAN client uses the server’s LAN IPv4 address, not `127.0.0.1`.
- [ ] The server was not described as encrypted.
