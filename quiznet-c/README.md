# QuizNet in C

A college Computer Networks quiz. One C server owns the paper, the answer key, the 120-second clock, and the scores. Each student runs a C client. They talk over TCP. The client never has the answer key and never marks itself.

Messages are one JSON object per line, the same idea as the Python version: `JOIN`, `START_QUIZ`, `QUESTION`, `SUBMIT_ANSWER`, `ANSWER_FEEDBACK`, `QUIZ_RESULT`, `GET_LEADERBOARD`.

## What you need

- A C compiler: `gcc` on Linux, or MinGW-w64 on Windows (`gcc` on the PATH).
- No extra libraries. Scores are stored in `quiznet_scores.csv` next to the server.

## Build

Linux, in this folder:

```bash
make
```

Windows, in this folder, from a MinGW prompt:

```bat
build.bat
```

## Run on one computer

Terminal 1:

```bash
./server 127.0.0.1 5000
```

Terminal 2 and terminal 3:

```bash
./client
```

Type the IP `127.0.0.1`, port `5000`, and a different name in each window. Then `s` to start, `A`–`D` to answer, `l` for the leaderboard, `q` to quit.

On Windows the programs are `server.exe` and `client.exe`.

## Two computers on the same Wi-Fi

On the server PC:

```bash
./server 0.0.0.0 5000
```

Find that PC's IPv4 address (`ipconfig` on Windows, `ip -4 addr` on Linux). On the other PC, run the client and type that address and port `5000`. Do not type `127.0.0.1` on the second computer. Allow the program through the firewall if asked. Guest Wi-Fi often blocks this.

## What the server checks

- The name is unique while that student is connected.
- The answer is for the question the server just sent.
- The 120 seconds have not run out. The clock is on the server.
- A right answer is 10 points. A wrong answer is 0. Ten questions, so 100 is a full paper.
- The leaderboard ranks a higher score first. A tie goes to the shorter time.

Closing one client does not stop the others.
