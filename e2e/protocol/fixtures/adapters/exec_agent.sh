#!/bin/sh
# Protocol E2E fixture: a custom executable agent. It reads the prompt from
# standard input and prints "Echo: <prompt>". A prompt containing "hold" waits
# for $EXEC_FIXTURE_DIR/release first, so a spec can cancel the running turn.
input=$(cat)
printf '%s\n' "$input" >> "$EXEC_FIXTURE_DIR/prompts.txt"
case "$input" in
  *hold*)
    while [ ! -f "$EXEC_FIXTURE_DIR/release" ]; do sleep 0.05; done
    ;;
esac
printf 'Echo: %s' "$input"
