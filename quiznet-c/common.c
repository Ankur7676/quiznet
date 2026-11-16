#include "common.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

long long quiz_now_ms(void) {
#ifdef _WIN32
    return (long long)GetTickCount64();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
#endif
}

static const char *skip_ws(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}

int json_find_string(const char *json, const char *key, char *out, size_t n) {
    char pat[80];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p || n == 0) return 0;
    p = skip_ws(p + strlen(pat));
    if (*p != ':') return 0;
    p = skip_ws(p + 1);
    if (*p != '"') return 0;
    p++;
    size_t o = 0;
    while (*p && *p != '"') {
        char c = *p++;
        if (c == '\\' && *p) {
            char e = *p++;
            if (e == 'n') c = '\n';
            else if (e == 't') c = '\t';
            else c = e;
        }
        if (o + 1 < n) out[o++] = c;
    }
    out[o] = '\0';
    return *p == '"';
}

int json_find_int(const char *json, const char *key, int *out) {
    char pat[80];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p) return 0;
    p = skip_ws(p + strlen(pat));
    if (*p != ':') return 0;
    p = skip_ws(p + 1);
    if (*p == '"') p++;
    char *end = NULL;
    long v = strtol(p, &end, 10);
    if (end == p) return 0;
    *out = (int)v;
    return 1;
}

int json_find_bool(const char *json, const char *key, int *out) {
    char pat[80];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p) return 0;
    p = skip_ws(p + strlen(pat));
    if (*p != ':') return 0;
    p = skip_ws(p + 1);
    if (strncmp(p, "true", 4) == 0) {
        *out = 1;
        return 1;
    }
    if (strncmp(p, "false", 5) == 0) {
        *out = 0;
        return 1;
    }
    return 0;
}

void json_escape(const char *in, char *out, size_t n) {
    size_t o = 0;
    if (n == 0) return;
    for (; *in && o + 2 < n; in++) {
        unsigned char c = (unsigned char)*in;
        if (c == '"' || c == '\\') {
            out[o++] = '\\';
            out[o++] = (char)c;
        } else if (c == '\n') {
            out[o++] = '\\';
            out[o++] = 'n';
        } else if (c < 0x20) {
            continue;
        } else {
            out[o++] = (char)c;
        }
    }
    out[o] = '\0';
}

static int copy_slice_string(const char *slice, const char *key, char *out, size_t n) {
    return json_find_string(slice, key, out, n);
}

int load_questions(const char *path, Question *out, int cap) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return -1;
    }
    long sz = ftell(f);
    if (sz < 0 || sz > 1024 * 1024) {
        fclose(f);
        return -1;
    }
    rewind(f);
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        return -1;
    }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) {
        free(buf);
        fclose(f);
        return -1;
    }
    buf[sz] = '\0';
    fclose(f);

    int count = 0;
    const char *p = buf;
    while (count < cap && (p = strstr(p, "\"id\"")) != NULL) {
        const char *next = strstr(p + 4, "\"id\"");
        size_t len = next ? (size_t)(next - p) : strlen(p);
        if (len > 3500) len = 3500;
        char slice[3600];
        memcpy(slice, p, len);
        slice[len] = '\0';
        Question q;
        memset(&q, 0, sizeof q);
        if (!json_find_int(slice, "id", &q.id)) {
            p += 4;
            continue;
        }
        copy_slice_string(slice, "topic", q.topic, sizeof q.topic);
        copy_slice_string(slice, "text", q.text, sizeof q.text);
        copy_slice_string(slice, "A", q.opt[0], sizeof q.opt[0]);
        copy_slice_string(slice, "B", q.opt[1], sizeof q.opt[1]);
        copy_slice_string(slice, "C", q.opt[2], sizeof q.opt[2]);
        copy_slice_string(slice, "D", q.opt[3], sizeof q.opt[3]);
        char ans[8];
        if (!copy_slice_string(slice, "answer", ans, sizeof ans) || ans[0] < 'A' || ans[0] > 'D') {
            p += 4;
            continue;
        }
        if (!q.text[0] || !q.opt[0][0]) {
            p += 4;
            continue;
        }
        q.answer = ans[0];
        out[count++] = q;
        p = next ? next : p + len;
        if (!next) break;
    }
    free(buf);
    return count;
}

static int by_id(const void *a, const void *b) {
    const Question *qa = (const Question *)a;
    const Question *qb = (const Question *)b;
    return qa->id - qb->id;
}

void sort_questions(Question *items, int count) {
    qsort(items, (size_t)count, sizeof(Question), by_id);
}

int name_ok(const char *name) {
    size_t n = strlen(name);
    if (n < 2 || n > 16) return 0;
    if (!isalpha((unsigned char)name[0])) return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)name[i];
        if (!(isalnum(c) || c == ' ')) return 0;
    }
    return 1;
}
