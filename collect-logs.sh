#!/usr/bin/env bash
# Snapshot mycod logs into _myco_/logs/ for periodic analysis (paired
# with the /loop tick that consumes the files).
#
# Two sources:
#   1. Local mycod — `GET /logs?n=N` against http://127.0.0.1:$MYCO_PORT
#      (in-memory rolling buffer, capped at server/src/logCapture.js
#      CAPACITY=500). Bearer auth: latest unexpired session for
#      MYCO_LOG_LOGIN from /data/auth-sessions.json.
#      Output: _myco_/logs/mycod-<UTC-date>.log
#
#   2. mycobeta — `ssh kkrazy@mycobeta.labxnow.ai docker logs myco
#      --since=<marker> --timestamps`. Marker tracks the last fetch so
#      consecutive ticks don't re-pull 24h of logs.
#      Output: _myco_/logs/mycobeta-<UTC-date>.log
#
# Both phases dedup against the existing per-day file. Phase 2 (mycobeta
# SSH) is best-effort — its failure prints a warning but doesn't abort
# phase 1.
#
# Usage:
#   ./collect-logs.sh                       # both sources, defaults
#   ./collect-logs.sh --skip-mycobeta       # local only
#   ./collect-logs.sh --skip-local          # mycobeta only
#   ./collect-logs.sh --mycobeta-since 24h  # override --since for mycobeta

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="${DIR}/_myco_/logs"

PORT="${MYCO_PORT:-3000}"
AUTH_FILE="${MYCO_AUTH_FILE:-/data/auth-sessions.json}"
LOGIN="${MYCO_LOG_LOGIN:-kkrazy}"
N="500"

MYCOBETA_HOST="${MYCO_BETA_HOST:-kkrazy@mycobeta.labxnow.ai}"
MYCOBETA_CONTAINER="${MYCO_BETA_CONTAINER:-myco}"
MYCOBETA_OVERLAP=10
mycobeta_since_override=""

skip_local=0
skip_mycobeta=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --n)              N="$2"; shift 2 ;;
    --login)          LOGIN="$2"; shift 2 ;;
    --auth-file)      AUTH_FILE="$2"; shift 2 ;;
    --port)           PORT="$2"; shift 2 ;;
    --mycobeta-host)  MYCOBETA_HOST="$2"; shift 2 ;;
    --mycobeta-since) mycobeta_since_override="$2"; shift 2 ;;
    --skip-local)     skip_local=1; shift ;;
    --skip-mycobeta)  skip_mycobeta=1; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOGS_DIR"
day="$(date -u +%Y-%m-%d)"
now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── helpers ─────────────────────────────────────────────────────────────────

# Pick the newest unexpired bearer for the local /logs endpoint.
pick_local_token() {
  node -e '
    const fs = require("fs");
    const [path, login] = [process.argv[1], process.argv[2]];
    let store; try { store = JSON.parse(fs.readFileSync(path, "utf8")); }
    catch (e) { process.stderr.write("auth-sessions read failed: " + e.message + "\n"); process.exit(1); }
    const now = Date.now();
    let bestTok = null, bestExp = -1;
    for (const [tok, rec] of Object.entries(store)) {
      if (!rec || rec.login !== login) continue;
      if (typeof rec.expiresAt !== "number" || rec.expiresAt <= now) continue;
      if (rec.expiresAt > bestExp) { bestExp = rec.expiresAt; bestTok = tok; }
    }
    if (!bestTok) { process.stderr.write("no unexpired session for login=" + login + "\n"); process.exit(2); }
    process.stdout.write(bestTok);
  ' "$AUTH_FILE" "$LOGIN"
}

# Dedup `$1` (tab-delimited "ts\tlevel\tmsg" lines) against existing file `$2`,
# overwrite `$1` with the unique-to-fresh set, and return the count appended.
# Both files must exist (the caller created `$1`).
dedup_and_append() {
  local fresh="$1" outfile="$2"
  if [[ ! -s "$fresh" ]]; then echo 0; return; fi
  if [[ -s "$outfile" ]]; then
    comm -23 <(sort -u "$fresh") <(sort -u "$outfile") > "${fresh}.new"
    mv "${fresh}.new" "$fresh"
  fi
  if [[ -s "$fresh" ]]; then
    sort -k1,1 "$fresh" >> "$outfile"
    wc -l < "$fresh" | tr -d ' '
  else
    echo 0
  fi
}

# ─── phase 1: local mycod ───────────────────────────────────────────────────

fetch_local() {
  local token outfile fresh_json fresh_flat http_code appended
  outfile="${LOGS_DIR}/mycod-${day}.log"
  fresh_json="$(mktemp)"; fresh_flat="$(mktemp)"

  token="$(pick_local_token)" || { echo "[collect-logs] local: no usable bearer token — skipping" >&2; rm -f "$fresh_json" "$fresh_flat"; return 1; }

  http_code="$(curl -sS -o "$fresh_json" -w '%{http_code}' \
    -H "Authorization: Bearer $token" \
    "http://127.0.0.1:${PORT}/logs?n=${N}" 2>/dev/null)" || {
    echo "[collect-logs] local: curl failed" >&2; rm -f "$fresh_json" "$fresh_flat"; return 1
  }
  if [[ "$http_code" != "200" ]]; then
    echo "[collect-logs] local: /logs returned HTTP ${http_code}" >&2
    rm -f "$fresh_json" "$fresh_flat"; return 1
  fi

  node -e '
    const fs = require("fs");
    const entries = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(entries)) process.exit(0);
    for (const e of entries) {
      if (!e || !e.ts) continue;
      const msg = String(e.msg || "").replace(/\r?\n/g, " ⏎ ");
      process.stdout.write(`${e.ts}\t${e.level || "info"}\t${msg}\n`);
    }
  ' "$fresh_json" > "$fresh_flat"

  appended="$(dedup_and_append "$fresh_flat" "$outfile")"
  rm -f "$fresh_json" "$fresh_flat"
  echo "$now_iso" > "${LOGS_DIR}/.last-fetch.mycod"
  echo "[collect-logs] local:    +${appended} → ${outfile}  (fetched ${N})"
}

# ─── phase 2: mycobeta via SSH ──────────────────────────────────────────────

# Compute --since for docker logs from the per-source marker. Default 1h
# on first run. The script subtracts an OVERLAP to avoid dropping a line
# at the boundary; dedup handles the resulting duplicate.
compute_mycobeta_since() {
  if [[ -n "$mycobeta_since_override" ]]; then echo "$mycobeta_since_override"; return; fi
  local marker="${LOGS_DIR}/.last-fetch.mycobeta"
  if [[ -f "$marker" ]]; then
    local last
    last="$(cat "$marker" 2>/dev/null || true)"
    if [[ -n "$last" ]]; then
      # BusyBox `date -d` doesn't grok RFC3339 with the 'T' or 'Z', so
      # parse via node which handles ISO-8601 natively. Subtract a small
      # OVERLAP so a line landing exactly on the marker boundary isn't
      # dropped (dedup handles the resulting duplicates cheaply).
      node -e '
        const t = Date.parse(process.argv[1]);
        if (!Number.isFinite(t)) process.exit(1);
        const since = new Date(t - (parseInt(process.argv[2], 10) * 1000));
        process.stdout.write(since.toISOString().replace(/\.\d{3}Z$/, "Z"));
      ' "$last" "$MYCOBETA_OVERLAP" 2>/dev/null && return
    fi
  fi
  echo "1h"
}

fetch_mycobeta() {
  local outfile since raw fresh_flat appended ssh_rc
  outfile="${LOGS_DIR}/mycobeta-${day}.log"
  raw="$(mktemp)"; fresh_flat="$(mktemp)"
  since="$(compute_mycobeta_since)"

  # `docker logs --timestamps` prefixes "<RFC3339> <line>" on stdout (and
  # stderr both interleaved when 2>&1). Capture and reshape into the
  # same "ts\tlevel\tmsg" form phase 1 uses.
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$MYCOBETA_HOST" \
    "docker logs --since='${since}' --timestamps ${MYCOBETA_CONTAINER} 2>&1" \
    > "$raw" 2>/dev/null
  ssh_rc=$?
  if [[ $ssh_rc -ne 0 ]]; then
    echo "[collect-logs] mycobeta: ssh/docker-logs failed (rc=${ssh_rc}) — skipping" >&2
    rm -f "$raw" "$fresh_flat"; return 1
  fi

  # docker timestamps look like 2026-05-14T15:41:16.123456789Z. Truncate
  # to millisecond + 'Z' to match local mycod's format (so dedup across
  # sources is consistent if a line happens to land in both — won't
  # happen here, but cheap to keep formats aligned).
  awk -F' ' '
    NF >= 2 {
      ts = $1
      sub(/\..*Z$/, "Z", ts)
      sub(/\.[0-9]+Z?$/, "Z", ts)
      $1 = ""
      sub(/^ /, "")
      msg = $0
      gsub(/\r/, "", msg)
      printf "%s\tinfo\t%s\n", ts, msg
    }
  ' "$raw" > "$fresh_flat"

  appended="$(dedup_and_append "$fresh_flat" "$outfile")"
  rm -f "$raw" "$fresh_flat"
  echo "$now_iso" > "${LOGS_DIR}/.last-fetch.mycobeta"
  echo "[collect-logs] mycobeta: +${appended} → ${outfile}  (since=${since})"
}

# ─── run ────────────────────────────────────────────────────────────────────

local_rc=0; beta_rc=0
[[ $skip_local    -eq 1 ]] || { fetch_local    || local_rc=$?; }
[[ $skip_mycobeta -eq 1 ]] || { fetch_mycobeta || beta_rc=$?; }

# Exit non-zero only when BOTH sources failed AND neither was opted out.
if [[ $skip_local -eq 0 && $skip_mycobeta -eq 0 && $local_rc -ne 0 && $beta_rc -ne 0 ]]; then
  echo "[collect-logs] both sources failed" >&2
  exit 1
fi
exit 0
