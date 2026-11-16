#!/bin/sh
# Resolve the checkout so this works both locally and in the preview workspace.
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 1
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
nohup npm run dev > /tmp/quiznet-dev.log 2>&1 < /dev/null &
