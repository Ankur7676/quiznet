const VIVA: { q: string; a: string }[] = [
  {
    q: "What is a socket?",
    a: "A socket is one end of a network conversation. The operating system identifies it by protocol, IP address, and port, and the program uses it to send and receive bytes.",
  },
  {
    q: "What is a port number?",
    a: "A port is a 16-bit number that picks the program on a host. QuizNet uses 5000. Port 80 is HTTP and 443 is HTTPS. The IP address finds the machine; the port finds the process.",
  },
  {
    q: "How do TCP and UDP differ, and why does QuizNet use TCP?",
    a: "TCP is connection-oriented, ordered, and reliable: lost segments are retransmitted. UDP is connectionless and does not promise delivery. A lost question or answer would break the quiz, so the project uses TCP.",
  },
  {
    q: "What is the TCP three-way handshake?",
    a: "The client sends SYN, the server replies SYN-ACK, and the client sends ACK. Both sides agree on sequence numbers before application data. socket.create_connection() makes the operating system do this before JOIN is sent.",
  },
  {
    q: "What is the client-server model?",
    a: "Clients request a service. The server owns the shared state. Here the server owns the paper, the answer key, the deadline, the score, and the leaderboard. A client is only a display and a place to type.",
  },
  {
    q: "What do listen() and accept() do?",
    a: "listen() turns a bound socket into a passive socket and sets how many unaccepted connections may wait. accept() returns a new connected socket for one client. The listening socket stays open for the next student.",
  },
  {
    q: "Why is 127.0.0.1 different from 0.0.0.0?",
    a: "127.0.0.1 is loopback: only programs on this computer can connect. 0.0.0.0 means every local interface, so classmates on the LAN can connect. That is not encryption. Use it only on a trusted network.",
  },
  {
    q: "What is an application-layer protocol?",
    a: "It is the set of message meanings sitting above TCP. TCP delivers a byte stream. QuizNet's own rules say each line is one JSON object with a type such as JOIN or SUBMIT_ANSWER.",
  },
  {
    q: "Why do we frame JSON with newlines?",
    a: "TCP can split one message across recv() calls or glue two messages into one. A newline marks the end of a JSON object, and the reader keeps leftover bytes until the rest arrives.",
  },
  {
    q: "Why threads, and what do we lock?",
    a: "The accept loop must not get stuck inside one student's quiz. Each connection has a handler thread. The username table is locked so two people cannot claim the same name. Each SQLite call opens its own connection.",
  },
  {
    q: "Why is the timer on the server?",
    a: "A student could pause or change a client clock. The server stores a monotonic deadline when the quiz starts and finalizes the attempt even if the client sends nothing else.",
  },
  {
    q: "Does TCP make this a secure exam?",
    a: "No. TCP gives reliable, ordered bytes, not secrecy or identity proof. Anyone who can see the packets can read the JSON. Do not use pickle, and do not treat this as a production exam system.",
  },
  {
    q: "What happens if one client crashes?",
    a: "That socket reports a close or an error. Its handler finalizes the attempt, releases the username, and exits. The listening socket and the other handler threads keep running.",
  },
  {
    q: "Why are SQL statements parameterized?",
    a: "The username is data, not part of the SQL text. A placeholder (?) stops a crafted name from changing the query. The session id is unique, so the same attempt cannot be inserted twice.",
  },
  {
    q: "Where is the answer key?",
    a: "Only in the server process, loaded from questions.json. QUESTION messages omit it. ANSWER_FEEDBACK may reveal the correct letter after that question has been accepted, when it is too late to change the choice.",
  },
  {
    q: "How does the leaderboard break ties?",
    a: "Higher score ranks first. If scores are equal, the shorter server-measured duration ranks first. Disconnects are stored but not ranked.",
  },
];

export function StudyGuide() {
  return (
    <div className="mt-10 space-y-8 text-sm leading-relaxed">
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">How a question crosses the network</h2>
        <pre className="overflow-x-auto rounded-lg border border-line bg-surface p-4 font-mono text-xs leading-relaxed text-muted">{`Student A                         QuizNet server                         Student B
   |  TCP connect + handshake             |                                    |
   |  JOIN {"username":"Asha"}            |                                    |
   |<---------- JOIN_ACK session -------->|                                    |
   |  START_QUIZ                          |                                    |
   |<--- QUESTION (no answer key) --------|                                    |
   |  SUBMIT_ANSWER question_id, "B"      |                                    |
   |<--- ANSWER_FEEDBACK + next QUESTION  |  score lives only here             |
   |  ... 10 questions or 120 seconds ... |                                    |
   |<--- QUIZ_RESULT -------------------->|---- SQLite insert --------------->|
   |  GET_LEADERBOARD                     |<-------- same rows --------------->|`}</pre>
        <p className="text-muted">
          The browser cannot open a raw TCP socket. Each desk on this page asks the lab process to open one real TCP
          connection to <span className="text-fg">quiznet/server.py</span> and to copy newline-delimited JSON both ways.
          Scoring still happens only in that Python process. The Tkinter file <span className="text-fg">client.py</span> is
          the socket client you run on a lab PC; it speaks the same messages with no relay.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">What each file is teaching</h2>
        <ul className="space-y-2 text-muted">
          <li>
            <span className="text-fg">server.py</span> — listening socket, accept loop, one thread per client, session rules, monotonic deadline.
          </li>
          <li>
            <span className="text-fg">client.py</span> — active opener of the TCP connection, Tkinter screens, a receive thread, and no answer key.
          </li>
          <li>
            <span className="text-fg">protocol.py</span> — application framing on top of TCP's byte stream. JSON only, never pickle or eval.
          </li>
          <li>
            <span className="text-fg">database.py</span> — persistent results, parameterized queries, one connection per call so threads do not share a handle.
          </li>
          <li>
            <span className="text-fg">questions.json</span> — the bank. The lowest ten ids, in order, are the paper every student receives.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Run it on Windows</h2>
        <ol className="list-decimal space-y-2 pl-5 text-muted">
          <li>Install Python 3.11 or newer from python.org and tick “Add python.exe to PATH”. Tkinter is included.</li>
          <li>Unzip the source. Open Command Prompt in the <span className="text-fg">quiznet</span> folder.</li>
          <li>
            Start the server: <code className="text-fg">py -3 server.py</code>
          </li>
          <li>
            Open two more prompts and run <code className="text-fg">py -3 client.py</code> in each. A third window is the same command again.
          </li>
          <li>Use server IP <span className="text-fg">127.0.0.1</span>, port <span className="text-fg">5000</span>, and a different username in each window.</li>
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Two computers on the same Wi-Fi</h2>
        <ol className="list-decimal space-y-2 pl-5 text-muted">
          <li>
            On the server PC: <code className="text-fg">py -3 server.py --host 0.0.0.0 --port 5000</code>
          </li>
          <li>
            Run <code className="text-fg">ipconfig</code> and read the IPv4 address on the Wi-Fi adapter, for example 192.168.1.20.
          </li>
          <li>Allow Python through the Windows firewall for private networks when prompted.</li>
          <li>On the other PC, run client.py and type that IPv4 address and port 5000. Do not type 127.0.0.1 on the second computer.</li>
          <li>Both names must be unique. Answer at the same time. Closing one window must leave the other quiz running. Then open the leaderboard on both.</li>
        </ol>
        <p className="text-muted">
          Binding to 0.0.0.0 publishes the service on the LAN. Do it only on a network you trust. Guest Wi-Fi often blocks device-to-device traffic. This project does not encrypt packets.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">If it will not connect</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>Connection refused: server.py is not running, or the port does not match.</li>
          <li>Timed out: wrong IP, a firewall, or the two machines are not on the same LAN.</li>
          <li>Address already in use: another QuizNet is still bound to 5000. Stop it or pass <code className="text-fg">--port 5001</code> and use that port in the client.</li>
          <li>Duplicate username: that name is still connected. Disconnect, or pick another name.</li>
          <li>Time expired: the server already stored the attempt. Start a new quiz; do not expect the client to add points locally.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Viva, short answers</h2>
        <div className="space-y-2">
          {VIVA.map((item) => (
            <details key={item.q} className="rounded-lg border border-line bg-card px-4 py-3">
              <summary className="cursor-pointer font-medium">{item.q}</summary>
              <p className="mt-2 text-muted">{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
