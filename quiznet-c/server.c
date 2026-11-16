#include "common.h"

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET sock_t;
#define CLOSESOCK closesocket
#define SHUT_BOTH SD_BOTH
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
typedef int sock_t;
#define CLOSESOCK close
#define INVALID_SOCKET (-1)
#define SHUT_BOTH SHUT_RDWR
#endif

#define QUIZ_SECONDS 120
#define MAX_CLIENTS 64
#define SCORE_PATH "quiznet_scores.csv"

typedef struct {
    sock_t fd;
    int used;
    int joined;
    int started;
    int finished;
    int saved;
    int index;
    int score;
    int correct;
    int wrong;
    char name[QUIZ_NAME_MAX];
    char sid[24];
    long long start_ms;
    long long deadline_ms;
    int mu_ready;
    pthread_mutex_t mu;
} Client;

static Question g_bank[QUIZ_BANK_MAX];
static int g_bank_n;
static Question g_paper[QUIZ_PAPER];
static Client g_clients[MAX_CLIENTS];
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_file = PTHREAD_MUTEX_INITIALIZER;
static volatile sig_atomic_t g_stop = 0;
static sock_t g_listen = INVALID_SOCKET;

static int name_eq(const char *a, const char *b) {
    while (*a && *b) {
        unsigned char ca = (unsigned char)*a++;
        unsigned char cb = (unsigned char)*b++;
        if (ca >= 'A' && ca <= 'Z') ca = (unsigned char)(ca + 32);
        if (cb >= 'A' && cb <= 'Z') cb = (unsigned char)(cb + 32);
        if (ca != cb) return 0;
    }
    return *a == *b;
}

static void ignore_sigpipe(void) {
#ifndef _WIN32
    signal(SIGPIPE, SIG_IGN);
#endif
}

static void on_sigint(int sig) {
    (void)sig;
    g_stop = 1;
#ifndef _WIN32
    if (g_listen != INVALID_SOCKET) CLOSESOCK(g_listen);
#endif
}

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

static int send_line(Client *c, const char *line) {
    pthread_mutex_lock(&c->mu);
    int rc = -1;
    if (c->used && c->fd != INVALID_SOCKET) {
        size_t n = strlen(line);
        rc = send_all(c->fd, line, n);
        if (rc == 0 && (n == 0 || line[n - 1] != '\n')) rc = send_all(c->fd, "\n", 1);
    }
    pthread_mutex_unlock(&c->mu);
    return rc;
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

static void make_sid(char *out) {
    unsigned x = (unsigned)time(NULL);
    unsigned y = (unsigned)rand();
    snprintf(out, 20, "%08x%08x", x ^ y, y * 17u + 1u);
}

static int name_taken(const char *name, const Client *self) {
    for (int i = 0; i < MAX_CLIENTS; i++) {
        const Client *c = &g_clients[i];
        if (!c->used || c == self || !c->joined) continue;
        if (name_eq(c->name, name)) return 1;
    }
    return 0;
}

static double remaining_of(const Client *c) {
    long long left = c->deadline_ms - quiz_now_ms();
    if (left < 0) left = 0;
    return (double)left / 1000.0;
}

static void send_error(Client *c, const char *code, const char *message) {
    char em[400];
    json_escape(message, em, sizeof em);
    char line[800];
    snprintf(line, sizeof line, "{\"type\":\"ERROR\",\"code\":\"%s\",\"message\":\"%s\"}\n", code, em);
    send_line(c, line);
}

static void send_question(Client *c) {
    if (c->index < 0 || c->index >= QUIZ_PAPER) return;
    const Question *q = &g_paper[c->index];
    char topic[128], text[QUIZ_TEXT_MAX * 2], oa[QUIZ_OPT_MAX * 2], ob[QUIZ_OPT_MAX * 2], oc[QUIZ_OPT_MAX * 2],
        od[QUIZ_OPT_MAX * 2];
    json_escape(q->topic, topic, sizeof topic);
    json_escape(q->text, text, sizeof text);
    json_escape(q->opt[0], oa, sizeof oa);
    json_escape(q->opt[1], ob, sizeof ob);
    json_escape(q->opt[2], oc, sizeof oc);
    json_escape(q->opt[3], od, sizeof od);
    char line[QUIZ_LINE_MAX];
    snprintf(line, sizeof line,
             "{\"type\":\"QUESTION\",\"session_id\":\"%s\",\"question_id\":%d,\"number\":%d,\"total\":%d,"
             "\"topic\":\"%s\",\"text\":\"%s\",\"options\":{\"A\":\"%s\",\"B\":\"%s\",\"C\":\"%s\",\"D\":\"%s\"},"
             "\"remaining_seconds\":%.1f}\n",
             c->sid, q->id, c->index + 1, QUIZ_PAPER, topic, text, oa, ob, oc, od, remaining_of(c));
    send_line(c, line);
}

static void save_row(const Client *c, const char *status) {
    int unanswered = QUIZ_PAPER - c->correct - c->wrong;
    if (unanswered < 0) unanswered = 0;
    long long dur = quiz_now_ms() - c->start_ms;
    if (dur < 0) dur = 0;
    pthread_mutex_lock(&g_file);
    FILE *f = fopen(SCORE_PATH, "a");
    if (f) {
        fprintf(f, "%s,%s,%d,%d,%d,%d,%lld,%s\n", c->sid, c->name, c->score, c->correct, c->wrong, unanswered, dur,
                status);
        fclose(f);
    }
    pthread_mutex_unlock(&g_file);
}

static void finish_client(Client *c, const char *status) {
    pthread_mutex_lock(&c->mu);
    if (!c->used || !c->started || c->finished) {
        pthread_mutex_unlock(&c->mu);
        return;
    }
    c->finished = 1;
    int score = c->score;
    int correct = c->correct;
    int wrong = c->wrong;
    int unanswered = QUIZ_PAPER - correct - wrong;
    if (unanswered < 0) unanswered = 0;
    long long dur = quiz_now_ms() - c->start_ms;
    if (dur < 0) dur = 0;
    char sid[24], name[QUIZ_NAME_MAX];
    snprintf(sid, sizeof sid, "%s", c->sid);
    snprintf(name, sizeof name, "%s", c->name);
    int already = c->saved;
    c->saved = 1;
    pthread_mutex_unlock(&c->mu);
    if (!already) save_row(c, status);
    double pct = (100.0 * score) / (QUIZ_PAPER * 10);
    char line[QUIZ_LINE_MAX];
    snprintf(line, sizeof line,
             "{\"type\":\"QUIZ_RESULT\",\"session_id\":\"%s\",\"username\":\"%s\",\"score\":%d,\"correct\":%d,"
             "\"wrong\":%d,\"unanswered\":%d,\"total\":%d,\"percentage\":%.1f,\"duration_seconds\":%.1f,"
             "\"status\":\"%s\"}\n",
             sid, name, score, correct, wrong, unanswered, QUIZ_PAPER, pct, (double)dur / 1000.0, status);
    send_line(c, line);
    printf("RESULT %s %s score=%d status=%s\n", name, sid, score, status);
    fflush(stdout);
}

static void send_leaderboard(Client *c) {
    typedef struct {
        char name[QUIZ_NAME_MAX];
        int score;
        long long dur;
        char status[24];
    } Row;
    Row rows[128];
    int n = 0;
    pthread_mutex_lock(&g_file);
    FILE *f = fopen(SCORE_PATH, "r");
    if (f) {
        char line[256];
        while (n < 128 && fgets(line, sizeof line, f)) {
            char sid[32], name[QUIZ_NAME_MAX], status[24];
            int score, correct, wrong, unanswered;
            long long dur;
            if (sscanf(line, "%31[^,],%31[^,],%d,%d,%d,%d,%lld,%23s", sid, name, &score, &correct, &wrong, &unanswered,
                       &dur, status) != 8)
                continue;
            if (strcmp(status, "completed") != 0 && strcmp(status, "timeout") != 0) continue;
            snprintf(rows[n].name, sizeof rows[n].name, "%s", name);
            rows[n].score = score;
            rows[n].dur = dur;
            snprintf(rows[n].status, sizeof rows[n].status, "%s", status);
            n++;
        }
        fclose(f);
    }
    pthread_mutex_unlock(&g_file);
    for (int i = 0; i < n; i++) {
        for (int j = i + 1; j < n; j++) {
            int swap = 0;
            if (rows[j].score > rows[i].score) swap = 1;
            else if (rows[j].score == rows[i].score && rows[j].dur < rows[i].dur) swap = 1;
            if (swap) {
                Row t = rows[i];
                rows[i] = rows[j];
                rows[j] = t;
            }
        }
    }
    char body[QUIZ_LINE_MAX];
    int wr = snprintf(body, sizeof body, "{\"type\":\"LEADERBOARD\",\"session_id\":\"%s\",\"entries\":[", c->sid);
    if (wr < 0) return;
    size_t used = (size_t)wr;
    int shown = n > 20 ? 20 : n;
    for (int i = 0; i < shown; i++) {
        char piece[192];
        snprintf(piece, sizeof piece,
                 "%s{\"rank\":%d,\"username\":\"%.31s\",\"score\":%d,\"duration_seconds\":%.1f,\"status\":\"%.23s\"}",
                 i ? "," : "", i + 1, rows[i].name, rows[i].score, (double)rows[i].dur / 1000.0, rows[i].status);
        size_t pn = strlen(piece);
        if (used + pn + 4 >= sizeof body) break;
        memcpy(body + used, piece, pn);
        used += pn;
    }
    if (used + 3 < sizeof body) {
        memcpy(body + used, "]}\n", 3);
        used += 3;
        body[used] = '\0';
        send_line(c, body);
    }
}

static void handle_line(Client *c, const char *line) {
    char type[40];
    if (!json_find_string(line, "type", type, sizeof type)) {
        send_error(c, "BAD_MESSAGE", "Each line must be a JSON object with a type.");
        return;
    }
    if (strcmp(type, "JOIN") == 0) {
        char name[QUIZ_NAME_MAX];
        if (!json_find_string(line, "username", name, sizeof name) || !name_ok(name)) {
            send_error(c, "BAD_USERNAME", "Use a name of 2 to 16 letters.");
            return;
        }
        pthread_mutex_lock(&g_lock);
        if (c->joined) {
            pthread_mutex_unlock(&g_lock);
            send_error(c, "ALREADY_JOINED", "This connection already has a name.");
            return;
        }
        if (name_taken(name, c)) {
            pthread_mutex_unlock(&g_lock);
            send_error(c, "DUPLICATE_USERNAME", "That name is already connected.");
            return;
        }
        snprintf(c->name, sizeof c->name, "%s", name);
        make_sid(c->sid);
        c->joined = 1;
        pthread_mutex_unlock(&g_lock);
        char line_out[400];
        snprintf(line_out, sizeof line_out,
                 "{\"type\":\"JOIN_ACK\",\"session_id\":\"%s\",\"username\":\"%s\","
                 "\"message\":\"Welcome to QuizNet, %s.\",\"quiz_seconds\":%d,\"question_count\":%d}\n",
                 c->sid, c->name, c->name, QUIZ_SECONDS, QUIZ_PAPER);
        send_line(c, line_out);
        printf("JOIN %s %s\n", c->name, c->sid);
        fflush(stdout);
        return;
    }
    char sid[32];
    if (!json_find_string(line, "session_id", sid, sizeof sid) || strcmp(sid, c->sid) != 0) {
        send_error(c, "BAD_SESSION", "Join first, then use the session id the server sent.");
        return;
    }
    if (strcmp(type, "START_QUIZ") == 0) {
        pthread_mutex_lock(&c->mu);
        if (c->started && !c->finished) {
            pthread_mutex_unlock(&c->mu);
            send_error(c, "ALREADY_STARTED", "This quiz is already running.");
            return;
        }
        c->started = 1;
        c->finished = 0;
        c->saved = 0;
        c->index = 0;
        c->score = 0;
        c->correct = 0;
        c->wrong = 0;
        c->start_ms = quiz_now_ms();
        c->deadline_ms = c->start_ms + (long long)QUIZ_SECONDS * 1000LL;
        pthread_mutex_unlock(&c->mu);
        printf("START %s\n", c->name);
        fflush(stdout);
        send_question(c);
        return;
    }
    if (strcmp(type, "SUBMIT_ANSWER") == 0) {
        int qid = 0;
        char ans[8];
        if (!json_find_int(line, "question_id", &qid) || !json_find_string(line, "answer", ans, sizeof ans)) {
            send_error(c, "BAD_MESSAGE", "Send question_id and answer.");
            return;
        }
        if (ans[0] < 'A' || ans[0] > 'D' || ans[1] != '\0') {
            send_error(c, "INVALID_OPTION", "Answer must be A, B, C, or D.");
            return;
        }
        pthread_mutex_lock(&c->mu);
        if (!c->started || c->finished) {
            pthread_mutex_unlock(&c->mu);
            send_error(c, "NOT_ACTIVE", "Start the quiz before answering.");
            return;
        }
        if (quiz_now_ms() >= c->deadline_ms) {
            pthread_mutex_unlock(&c->mu);
            finish_client(c, "timeout");
            return;
        }
        if (c->index < 0 || c->index >= QUIZ_PAPER || g_paper[c->index].id != qid) {
            pthread_mutex_unlock(&c->mu);
            send_error(c, "WRONG_QUESTION", "That question is already closed.");
            return;
        }
        const Question *q = &g_paper[c->index];
        int ok = ans[0] == q->answer;
        if (ok) {
            c->score += 10;
            c->correct += 1;
        } else {
            c->wrong += 1;
        }
        int score = c->score;
        char correct_opt = q->answer;
        int number = c->index + 1;
        c->index += 1;
        int done = c->index >= QUIZ_PAPER;
        double left = remaining_of(c);
        pthread_mutex_unlock(&c->mu);
        char line_out[512];
        snprintf(line_out, sizeof line_out,
                 "{\"type\":\"ANSWER_FEEDBACK\",\"session_id\":\"%s\",\"question_id\":%d,\"selected\":\"%c\","
                 "\"correct\":%s,\"correct_option\":\"%c\",\"score\":%d,\"remaining_seconds\":%.1f}\n",
                 c->sid, qid, ans[0], ok ? "true" : "false", correct_opt, score, left);
        send_line(c, line_out);
        printf("SUBMIT %s q=%d choice=%c ok=%d score=%d\n", c->name, number, ans[0], ok, score);
        fflush(stdout);
        if (done) finish_client(c, "completed");
        else send_question(c);
        return;
    }
    if (strcmp(type, "GET_LEADERBOARD") == 0) {
        send_leaderboard(c);
        return;
    }
    if (strcmp(type, "DISCONNECT") == 0) {
        send_line(c, "{\"type\":\"DISCONNECT\",\"message\":\"Goodbye.\"}\n");
        pthread_mutex_lock(&c->mu);
        if (c->fd != INVALID_SOCKET) shutdown(c->fd, SHUT_BOTH);
        pthread_mutex_unlock(&c->mu);
        return;
    }
    send_error(c, "BAD_MESSAGE", "Unknown message type.");
}

static void *client_thread(void *arg) {
    Client *c = (Client *)arg;
    char *hold = (char *)calloc(1, 65536);
    char *line = (char *)malloc(65536);
    if (!hold || !line) {
        free(hold);
        free(line);
        CLOSESOCK(c->fd);
        c->used = 0;
        return NULL;
    }
    size_t hold_len = 0;
    while (!g_stop) {
        int rc = recv_line(c->fd, hold, &hold_len, line, 65536);
        if (rc <= 0) break;
        if (line[0] == '\0') continue;
        handle_line(c, line);
    }
    if (c->started && !c->finished) finish_client(c, "disconnected");
    pthread_mutex_lock(&c->mu);
    if (c->fd != INVALID_SOCKET) {
        CLOSESOCK(c->fd);
        c->fd = INVALID_SOCKET;
    }
    pthread_mutex_unlock(&c->mu);
    pthread_mutex_lock(&g_lock);
    c->joined = 0;
    c->used = 0;
    c->name[0] = '\0';
    pthread_mutex_unlock(&g_lock);
    printf("CLOSE %s\n", c->sid);
    fflush(stdout);
    free(hold);
    free(line);
    return NULL;
}

static void *sweeper(void *arg) {
    (void)arg;
    while (!g_stop) {
#ifdef _WIN32
        Sleep(200);
#else
        struct timespec ts;
        ts.tv_sec = 0;
        ts.tv_nsec = 200000000L;
        nanosleep(&ts, NULL);
#endif
        long long now = quiz_now_ms();
        for (int i = 0; i < MAX_CLIENTS; i++) {
            Client *c = &g_clients[i];
            if (!c->used || !c->started || c->finished) continue;
            if (now >= c->deadline_ms) finish_client(c, "timeout");
        }
    }
    return NULL;
}

static Client *alloc_client(sock_t fd) {
    pthread_mutex_lock(&g_lock);
    Client *slot = NULL;
    for (int i = 0; i < MAX_CLIENTS; i++) {
        if (!g_clients[i].used) {
            slot = &g_clients[i];
            if (!slot->mu_ready) {
                pthread_mutex_init(&slot->mu, NULL);
                slot->mu_ready = 1;
            }
            slot->fd = fd;
            slot->used = 1;
            slot->joined = 0;
            slot->started = 0;
            slot->finished = 0;
            slot->saved = 0;
            slot->index = 0;
            slot->score = 0;
            slot->correct = 0;
            slot->wrong = 0;
            slot->name[0] = '\0';
            slot->sid[0] = '\0';
            slot->start_ms = 0;
            slot->deadline_ms = 0;
            break;
        }
    }
    pthread_mutex_unlock(&g_lock);
    return slot;
}

int main(int argc, char **argv) {
    const char *host = argc > 1 ? argv[1] : "127.0.0.1";
    int port = argc > 2 ? atoi(argv[2]) : 5000;
    if (port <= 0 || port > 65535) {
        fprintf(stderr, "Port must be 1-65535.\n");
        return 1;
    }
    ignore_sigpipe();
    signal(SIGINT, on_sigint);
#ifndef _WIN32
    signal(SIGTERM, on_sigint);
#endif
    srand((unsigned)time(NULL));

    g_bank_n = load_questions("questions.json", g_bank, QUIZ_BANK_MAX);
    if (g_bank_n < QUIZ_PAPER) {
        fprintf(stderr, "Need questions.json with at least %d questions (found %d).\n", QUIZ_PAPER, g_bank_n);
        return 1;
    }
    sort_questions(g_bank, g_bank_n);
    for (int i = 0; i < QUIZ_PAPER; i++) g_paper[i] = g_bank[i];

#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        fprintf(stderr, "WSAStartup failed.\n");
        return 1;
    }
#endif

    g_listen = socket(AF_INET, SOCK_STREAM, 0);
    if (g_listen == INVALID_SOCKET) {
        perror("socket");
        return 1;
    }
    int yes = 1;
    setsockopt(g_listen, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof yes);
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
        fprintf(stderr, "Bad host address: %s\n", host);
        return 1;
    }
    if (bind(g_listen, (struct sockaddr *)&addr, sizeof addr) != 0) {
        perror("bind");
        return 1;
    }
    if (listen(g_listen, 16) != 0) {
        perror("listen");
        return 1;
    }
    printf("QuizNet C server listening on %s:%d  paper=%d  bank=%d  limit=%ds\n", host, port, QUIZ_PAPER, g_bank_n,
           QUIZ_SECONDS);
    if (strcmp(host, "0.0.0.0") == 0) {
        printf("Bound to every interface. Use this only on a trusted LAN. Messages are not encrypted.\n");
    }
    fflush(stdout);

    pthread_t sweep;
    pthread_create(&sweep, NULL, sweeper, NULL);
    pthread_detach(sweep);

    while (!g_stop) {
        struct sockaddr_in peer;
        socklen_t plen = sizeof peer;
        sock_t fd = accept(g_listen, (struct sockaddr *)&peer, &plen);
        if (fd == INVALID_SOCKET) {
            if (g_stop) break;
            continue;
        }
        Client *c = alloc_client(fd);
        if (!c) {
            const char *full = "{\"type\":\"ERROR\",\"code\":\"FULL\",\"message\":\"The server is full.\"}\n";
            send_all(fd, full, strlen(full));
            CLOSESOCK(fd);
            continue;
        }
        pthread_t th;
        if (pthread_create(&th, NULL, client_thread, c) != 0) {
            CLOSESOCK(fd);
            c->used = 0;
            continue;
        }
        pthread_detach(th);
    }
    if (g_listen != INVALID_SOCKET) CLOSESOCK(g_listen);
    printf("Server stopped.\n");
    return 0;
}
