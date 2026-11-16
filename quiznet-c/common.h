#ifndef QUIZNET_COMMON_H
#define QUIZNET_COMMON_H

#include <stddef.h>

#define QUIZ_BANK_MAX 32
#define QUIZ_PAPER 10
#define QUIZ_NAME_MAX 32
#define QUIZ_TEXT_MAX 400
#define QUIZ_OPT_MAX 180
#define QUIZ_LINE_MAX 8192

typedef struct {
    int id;
    char topic[64];
    char text[QUIZ_TEXT_MAX];
    char opt[4][QUIZ_OPT_MAX];
    char answer;
} Question;

long long quiz_now_ms(void);

int json_find_string(const char *json, const char *key, char *out, size_t n);
int json_find_int(const char *json, const char *key, int *out);
int json_find_bool(const char *json, const char *key, int *out);
void json_escape(const char *in, char *out, size_t n);

int load_questions(const char *path, Question *out, int cap);
void sort_questions(Question *items, int count);

int name_ok(const char *name);

#endif
