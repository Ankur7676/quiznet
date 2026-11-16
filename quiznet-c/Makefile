CC ?= gcc
CFLAGS = -std=c11 -Wall -Wextra -O2 -D_POSIX_C_SOURCE=200809L
LDFLAGS = -pthread

.PHONY: all clean

all: server client

server: server.c common.c common.h
	$(CC) $(CFLAGS) -o server server.c common.c $(LDFLAGS)

client: client.c common.c common.h
	$(CC) $(CFLAGS) -o client client.c common.c $(LDFLAGS)

clean:
	rm -f server client
