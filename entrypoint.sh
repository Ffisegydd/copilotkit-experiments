#!/bin/bash
# Starts the three processes, each as its own user with only the env it needs.
# If any exits, the container exits.
set -euo pipefail

[ -n "${OPENAI_API_KEY:-}" ] || echo "[entrypoint] WARNING: OPENAI_API_KEY is not set; the chat agent will fail."

cd /app/agent
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  OPENAI_MODEL="${OPENAI_MODEL:-gpt-5.4}" \
  AGENT_DATABASE_URL="$AGENT_DATABASE_URL" \
  setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs \
  /app/agent/.venv/bin/python main.py &
AGENT_PID=$!

[ -n "${MCP_TOKEN:-}" ] || echo "[entrypoint] MCP_TOKEN is not set; the MCP server at /mcp is off."
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  OPENAI_MODEL="${OPENAI_MODEL:-gpt-5.4}" \
  APP_DATABASE_URL="$APP_DATABASE_URL" \
  AGENT_DATABASE_URL="$AGENT_DATABASE_URL" \
  MCP_TOKEN="${MCP_TOKEN:-}" \
  setpriv --reuid=api --regid=api --clear-groups --no-new-privs \
  /app/agent/.venv/bin/python api.py &
API_PID=$!

cd /app/web
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent NODE_ENV=production \
  HOSTNAME=0.0.0.0 PORT=3000 \
  AGENT_URL=http://127.0.0.1:8123 \
  setpriv --reuid=web --regid=web --clear-groups --no-new-privs \
  node server.js &
WEB_PID=$!

trap 'kill $AGENT_PID $API_PID $WEB_PID 2>/dev/null' TERM INT
wait -n $AGENT_PID $API_PID $WEB_PID
