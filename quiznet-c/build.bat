@echo off
gcc -std=c11 -O2 -Wall -o server.exe server.c common.c -lws2_32 -lpthread
if errorlevel 1 exit /b 1
gcc -std=c11 -O2 -Wall -o client.exe client.c common.c -lws2_32
if errorlevel 1 exit /b 1
echo Built server.exe and client.exe
