#include "common.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET sock_t;
#define CLOSESOCK closesocket
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
typedef int sock_t;
#define CLOSESOCK close
#define INVALID_SOCKET (-1)
#endif

static int send_all(sock_t fd, const char *buf, size_t n) {
    size_t off = 0;
    while (off < n) {
#ifdef _WIN32
        int w = send(fd, buf + off, (int)(n - off), 0);
#else
        ssize_t w = send(fd, buf + off, n - off, MSG_NOSIGNAL);
#endif
        if (w <= 0) return -1;
        off += (size_t)w;
    }
    return 0;
}

static int send_text(sock_t fd, const char *text) {
    size_t n = strlen(text);
    if (send_all(fd, text, n) != 0) return -1;
    if (n == 0 || text[n - 1] != '\n') return send_all(fd, "\n", 1);
    return 0;
}

static int recv_line(sock_t fd, char *hold, size_t *hold_len, char *out, size_t cap) {
    for (;;) {
        char *nl = memchr(hold, '\n', *hold_len);
        if (nl) {
            size_t n = (size_t)(nl - hold);
            if (n >= cap) return -1;
            memcpy(out, hold, n);
            out[n] = '\0';
            if (n > 0 && out[n - 1] == '\r') out[n - 1] = '\0';
            size_t rest = *hold_len - (n + 1);
            memmove(hold, nl + 1, rest);
            *hold_len = rest;
            return 1;
        }
        if (*hold_len + 4096 > 65536) return -1;
#ifdef _WIN32
        int r = recv(fd, hold + *hold_len, 4096, 0);
#else
        ssize_t r = recv(fd, hold + *hold_len, 4096, 0);
#endif
        if (r == 0) return 0;
        if (r < 0) return -1;
        *hold_len += (size_t)r;
    }
}

static void trim(char *s) {
    size_t n = strlen(s);
    while (n > 0 && (s[n - 1] == '\n' || s[n - 1] == '\r' || s[n - 1] == ' ')) s[--n] = '\0';
}

static int wait_type(sock_t fd, char *hold, size_t *hold_len, char *line, size_t cap, const char *type) {
    char got[40];
    for (;;) {
        int rc = recv_line(fd, hold, hold_len, line, cap);
        if (rc <= 0) return -1;
        if (!json_find_string(line, "type", got, sizeof got)) continue;
        if (strcmp(got, "ERROR") == 0) {
            char msg[300];
            if (!json_find_string(line, "message", msg, sizeof msg)) snprintf(msg, sizeof msg, "The server rejected that.");
            fprintf(stderr, "Error: %s\n", msg);
            return -1;
        }
        if (strcmp(got, type) == 0) return 1;
        if (strcmp(got, "QUIZ_RESULT") == 0 && strcmp(type, "QUESTION") != 0) return 2;
        if (strcmp(type, "QUESTION") == 0 && strcmp(got, "QUIZ_RESULT") == 0) return 2;
    }
}

static void show_question(const char *line) {
    char text[QUIZ_TEXT_MAX], a[QUIZ_OPT_MAX], b[QUIZ_OPT_MAX], c[QUIZ_OPT_MAX], d[QUIZ_OPT_MAX];
    int number = 0, total = 0;
    json_find_int(line, "number", &number);
    json_find_int(line, "total", &total);
    json_find_string(line, "text", text, sizeof text);
    json_find_string(line, "A", a, sizeof a);
    json_find_string(line, "B", b, sizeof b);
    json_find_string(line, "C", c, sizeof c);
    json_find_string(line, "D", d, sizeof d);
    printf("\nQuestion %d of %d\n%s\n", number, total, text);
    printf("  A  %s\n  B  %s\n  C  %s\n  D  %s\n", a, b, c, d);
    fflush(stdout);
}

static void show_feedback(const char *line) {
    int correct = 0, score = 0;
    char opt[8];
    json_find_bool(line, "correct", &correct);
    json_find_int(line, "score", &score);
    json_find_string(line, "correct_option", opt, sizeof opt);
    if (correct) printf("Correct. Score %d.\n", score);
    else printf("Wrong. Right answer was %s. Score %d.\n", opt[0] ? opt : "?", score);
    fflush(stdout);
}

static void show_result(const char *line) {
    int score = 0, correct = 0, total = 0;
    char status[32];
    json_find_int(line, "score", &score);
    json_find_int(line, "correct", &correct);
    json_find_int(line, "total", &total);
    if (!json_find_string(line, "status", status, sizeof status)) snprintf(status, sizeof status, "done");
    printf("\nFinished (%s). Score %d. %d of %d correct.\n", status, score, correct, total);
    fflush(stdout);
}

static void show_board(const char *line) {
    printf("\nLeaderboard\n%s\n", line);
    fflush(stdout);
}

static int connect_to(const char *host, int port) {
    sock_t fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd == INVALID_SOCKET) return -1;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
        CLOSESOCK(fd);
        return -1;
    }
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
        CLOSESOCK(fd);
        return -1;
    }
    return (int)fd;
}

static int play_script(sock_t fd, const char *name, const char *answers) {
    char *hold = (char *)calloc(1, 65536);
    char *line = (char *)malloc(65536);
    if (!hold || !line) return 1;
    size_t hold_len = 0;
    char join[128];
    snprintf(join, sizeof join, "{\"type\":\"JOIN\",\"username\":\"%s\"}\n", name);
    if (send_text(fd, join) != 0) return 1;
    if (wait_type(fd, hold, &hold_len, line, 65536, "JOIN_ACK") != 1) return 1;
    char sid[32];
    if (!json_find_string(line, "session_id", sid, sizeof sid)) return 1;
    char start[128];
    snprintf(start, sizeof start, "{\"type\":\"START_QUIZ\",\"session_id\":\"%s\"}\n", sid);
    if (send_text(fd, start) != 0) return 1;
    size_t ai = 0;
    for (;;) {
        int kind = wait_type(fd, hold, &hold_len, line, 65536, "QUESTION");
        if (kind < 0) return 1;
        if (kind == 2) {
            show_result(line);
            break;
        }
        int qid = 0;
        json_find_int(line, "question_id", &qid);
        char choice = 'A';
        if (answers && answers[ai]) {
            choice = answers[ai];
            if (choice >= 'a' && choice <= 'd') choice = (char)(choice - 32);
            ai++;
        }
        if (choice < 'A' || choice > 'D') choice = 'A';
        char sub[160];
        snprintf(sub, sizeof sub, "{\"type\":\"SUBMIT_ANSWER\",\"session_id\":\"%s\",\"question_id\":%d,\"answer\":\"%c\"}\n",
                 sid, qid, choice);
        if (send_text(fd, sub) != 0) return 1;
        kind = wait_type(fd, hold, &hold_len, line, 65536, "ANSWER_FEEDBACK");
        if (kind < 0) return 1;
        if (kind == 2) {
            show_result(line);
            break;
        }
        show_feedback(line);
    }
    char board[128];
    snprintf(board, sizeof board, "{\"type\":\"GET_LEADERBOARD\",\"session_id\":\"%s\"}\n", sid);
    send_text(fd, board);
    if (wait_type(fd, hold, &hold_len, line, 65536, "LEADERBOARD") == 1) show_board(line);
    free(hold);
    free(line);
    return 0;
}

static int play_interactive(sock_t fd, const char *name) {
    char *hold = (char *)calloc(1, 65536);
    char *line = (char *)malloc(65536);
    if (!hold || !line) return 1;
    size_t hold_len = 0;
    char join[128];
    snprintf(join, sizeof join, "{\"type\":\"JOIN\",\"username\":\"%s\"}\n", name);
    if (send_text(fd, join) != 0) return 1;
    if (wait_type(fd, hold, &hold_len, line, 65536, "JOIN_ACK") != 1) return 1;
    char sid[32];
    json_find_string(line, "session_id", sid, sizeof sid);
    printf("Connected as %s. Session %s.\n", name, sid);
    printf("Commands: s start, l leaderboard, q quit.\n");
    fflush(stdout);
    char cmd[64];
    for (;;) {
        printf("> ");
        fflush(stdout);
        if (!fgets(cmd, sizeof cmd, stdin)) break;
        trim(cmd);
        if (cmd[0] == 'q' || cmd[0] == 'Q') {
            char bye[128];
            snprintf(bye, sizeof bye, "{\"type\":\"DISCONNECT\",\"session_id\":\"%s\"}\n", sid);
            send_text(fd, bye);
            break;
        }
        if (cmd[0] == 'l' || cmd[0] == 'L') {
            char board[128];
            snprintf(board, sizeof board, "{\"type\":\"GET_LEADERBOARD\",\"session_id\":\"%s\"}\n", sid);
            send_text(fd, board);
            if (wait_type(fd, hold, &hold_len, line, 65536, "LEADERBOARD") == 1) show_board(line);
            continue;
        }
        if (cmd[0] != 's' && cmd[0] != 'S') {
            printf("Type s, l, or q.\n");
            continue;
        }
        char start[128];
        snprintf(start, sizeof start, "{\"type\":\"START_QUIZ\",\"session_id\":\"%s\"}\n", sid);
        if (send_text(fd, start) != 0) return 1;
        for (;;) {
            int kind = wait_type(fd, hold, &hold_len, line, 65536, "QUESTION");
            if (kind < 0) return 1;
            if (kind == 2) {
                show_result(line);
                break;
            }
            show_question(line);
            int qid = 0;
            json_find_int(line, "question_id", &qid);
            char ans[32];
            printf("Your answer (A-D): ");
            fflush(stdout);
            if (!fgets(ans, sizeof ans, stdin)) return 1;
            trim(ans);
            char choice = ans[0];
            if (choice >= 'a' && choice <= 'd') choice = (char)(choice - 32);
            if (choice < 'A' || choice > 'D') {
                printf("Type A, B, C, or D.\n");
                choice = 'A';
            }
            char sub[180];
            snprintf(sub, sizeof sub,
                     "{\"type\":\"SUBMIT_ANSWER\",\"session_id\":\"%s\",\"question_id\":%d,\"answer\":\"%c\"}\n", sid,
                     qid, choice);
            if (send_text(fd, sub) != 0) return 1;
            kind = wait_type(fd, hold, &hold_len, line, 65536, "ANSWER_FEEDBACK");
            if (kind == 2) {
                show_result(line);
                break;
            }
            if (kind < 0) return 1;
            show_feedback(line);
        }
    }
    free(hold);
    free(line);
    return 0;
}

int main(int argc, char **argv) {
    const char *host = "127.0.0.1";
    int port = 5000;
    const char *name = NULL;
    const char *answers = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--answers") == 0 && i + 1 < argc) {
            answers = argv[++i];
        } else if (!name && argv[i][0] != '-') {
            if (strchr(argv[i], '.') && !host) {
                host = argv[i];
            }
        }
    }
    /* positional: [host] [port] [name] [--answers ABCD] */
    int pos = 0;
    const char *p_host = NULL;
    const char *p_port = NULL;
    const char *p_name = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--answers") == 0) {
            i++;
            continue;
        }
        if (pos == 0) p_host = argv[i];
        else if (pos == 1) p_port = argv[i];
        else if (pos == 2) p_name = argv[i];
        pos++;
    }
    if (p_host && p_port && p_name) {
        host = p_host;
        port = atoi(p_port);
        name = p_name;
    }

#ifdef _WIN32
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
#endif

    if (!name) {
        char host_in[64], port_in[16], name_in[QUIZ_NAME_MAX];
        printf("QuizNet client\nServer IP [127.0.0.1]: ");
        fflush(stdout);
        if (!fgets(host_in, sizeof host_in, stdin)) return 1;
        trim(host_in);
        if (host_in[0]) host = host_in;
        printf("Port [5000]: ");
        fflush(stdout);
        if (!fgets(port_in, sizeof port_in, stdin)) return 1;
        trim(port_in);
        if (port_in[0]) port = atoi(port_in);
        printf("Your name: ");
        fflush(stdout);
        if (!fgets(name_in, sizeof name_in, stdin)) return 1;
        trim(name_in);
        name = name_in;
        if (!name_ok(name)) {
            fprintf(stderr, "Use 2 to 16 letters.\n");
            return 1;
        }
        int fd = connect_to(host, port);
        if (fd < 0) {
            fprintf(stderr, "Could not connect to %s:%d\n", host, port);
            return 1;
        }
        printf("Connected to %s:%d\n", host, port);
        int rc = play_interactive((sock_t)fd, name);
        CLOSESOCK(fd);
        return rc;
    }

    if (!name_ok(name)) {
        fprintf(stderr, "Use 2 to 16 letters.\n");
        return 1;
    }
    int fd = connect_to(host, port);
    if (fd < 0) {
        fprintf(stderr, "Could not connect to %s:%d\n", host, port);
        return 1;
    }
    int rc = answers ? play_script((sock_t)fd, name, answers) : play_interactive((sock_t)fd, name);
    CLOSESOCK(fd);
    return rc;
}
