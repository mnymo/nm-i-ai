#!/usr/bin/env bash
# Runs the test suite when a grocery-bot src or test file is edited.
# Receives Claude Code PostToolUse JSON payload on stdin.

REPO=/home/magnus/Git/nm-i-ai

# Parse file_path from stdin JSON using node
FILE=$(node -e "
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(d);
      const fp = (payload.tool_input || {}).file_path || '';
      process.stdout.write(fp);
    } catch (_) {}
  });
")

# Only run tests for changes inside grocery-bot/src or grocery-bot/test
case "$FILE" in
  *grocery-bot/src/*|*grocery-bot/test/*)
    echo ""
    echo "--- Tests triggered by: $FILE ---"
    cd "$REPO" && node --test tools/grocery-bot/test/*.test.mjs 2>&1
    echo "---"
    ;;
esac
