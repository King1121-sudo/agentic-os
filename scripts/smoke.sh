#!/usr/bin/env bash
# Live smoke test — boots against a REAL running API and exercises every route
# module, the auth guard, the command center branches and the SSE stream.
#
# The vitest suite uses app.inject() (in-process, no socket); this covers the
# things that only break over a real connection. Run it after a refactor that
# moves routes around.
#
#   npm run dev:api              # in one terminal (or any PORT)
#   bash scripts/smoke.sh        # in another
#   PORT=4000 bash scripts/smoke.sh
set -uo pipefail

BASE=${BASE:-http://localhost:${PORT:-4000}}
JAR=.smoke-cookies.txt
rm -f "$JAR"
pass=0; fail=0

check() { # method path expected_status label
  local m=$1 p=$2 want=$3 label=$4
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "$m" -b "$JAR" -c "$JAR" \
         -H 'Content-Type: application/json' "$BASE$p" 2>/dev/null)
  if [ "$code" = "$want" ]; then
    printf '  ok   %-3s %-42s %s\n' "$m" "$p" "$code"; pass=$((pass+1))
  else
    printf '  FAIL %-3s %-42s got %s want %s  (%s)\n' "$m" "$p" "$code" "$want" "$label"; fail=$((fail+1))
  fi
}

echo "── unauthenticated surface ─────────────────────────────"
check GET /api/health 200 "health"
check GET /api/agents 401 "auth guard active"

echo "── login ───────────────────────────────────────────────"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" \
       -H 'Content-Type: application/json' \
       -d '{"username":"admin","password":"admin123"}' "$BASE/api/auth/login")
if [ "$code" = "200" ]; then printf '  ok   POST /api/auth/login                            %s\n' "$code"; pass=$((pass+1));
else printf '  FAIL POST /api/auth/login                            got %s\n' "$code"; fail=$((fail+1)); fi
check GET /api/auth/me 200 "session established"

echo "── every split module ──────────────────────────────────"
check GET /api/agents 200 "agents"
check GET /api/models 200 "agents"
check GET /api/tools 200 "agents"
check GET /api/skills 200 "agents"
check GET /api/skills/metrics 200 "agents"
check GET /api/memory 200 "memory"
check GET /api/memory/vector-stats 200 "memory"
check GET /api/projects 200 "projects"
check GET /api/tasks 200 "projects"
check GET /api/sprints 200 "projects"
check GET /api/flows 200 "flows"
check GET /api/automations 200 "automations"
check GET /api/automation-runs 200 "automations"
check GET /api/integrations 200 "integrations"
check GET /api/integration-events 200 "integrations"
check GET /api/links 200 "graph"
check GET /api/entities 200 "graph"
check GET /api/graph 200 "graph"
check GET /api/approvals 200 "approvals"
check GET /api/notifications 200 "notifications"
check GET /api/dashboard/layout 200 "notifications"
check GET /api/notifications/prefs 200 "notifications"
check GET /api/generations 200 "telemetry"
check GET /api/events 200 "telemetry"
check GET /api/audit 200 "telemetry"
check GET "/api/search?q=pgvector" 200 "telemetry"
check GET /api/mobile/briefing 200 "supervision"
check GET /api/dashboard 200 "supervision"
check GET /api/executions 200 "executions"

echo "── command center (all 10 branches route) ──────────────"
for c in "good morning" "what are my agents doing" "what do you know about my preferences" \
         "status of project Agentic OS" "what's connected to pgvector"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR" -c "$JAR" \
         -H 'Content-Type: application/json' -d "{\"text\":\"$c\"}" "$BASE/api/command")
  if [ "$code" = "200" ]; then
    printf '  ok   POST /api/command  %-40s %s\n' "\"$c\"" "$code"; pass=$((pass+1))
  else
    printf '  FAIL POST /api/command  %-40s got %s\n' "\"$c\"" "$code"; fail=$((fail+1))
  fi
done

echo "── SSE stream opens ────────────────────────────────────"
sse=$(curl -s -N -b "$JAR" --max-time 3 "$BASE/api/stream" 2>/dev/null | head -c 60 | tr -d '\n')
if [ -n "$sse" ]; then printf '  ok   GET  /api/stream  (received %s bytes)\n' "${#sse}"; pass=$((pass+1));
else printf '  FAIL GET  /api/stream  no data\n'; fail=$((fail+1)); fi

echo ""
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
