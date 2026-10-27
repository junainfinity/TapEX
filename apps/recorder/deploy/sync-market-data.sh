#!/usr/bin/env bash
# Runs on the operator's PC, not on the server. Pulls closed market-log segments
# over SSH and commits them to the `market-data` branch of Q-Maya with the Git
# login already stored on this PC, so the shared server never holds a push credential.
# Closed segments are immutable .gz files, so every run only adds new files; a run
# missed while the PC is off is caught up by the next one.
set -euo pipefail

SERVER=${MAYA_SERVER:?set MAYA_SERVER, e.g. root@host}
KEY=${MAYA_SERVER_KEY:-$HOME/.ssh/quantellics_deploy}
LOG_DIR=${MAYA_MARKET_LOG:-/var/lib/quantellics/market-log}
REPO_DIR=${MAYA_MARKET_DATA_REPO:?set MAYA_MARKET_DATA_REPO to the local market-data clone}
REMOTE=${MAYA_MARKET_DATA_REMOTE:?set MAYA_MARKET_DATA_REMOTE to the market-data git remote}
BRANCH=market-data
WANTED='^\./(README\.md|[0-9]{4}-[0-9]{2}/[a-z0-9-]+-[0-9]{8}T[0-9]{4}Z\.(csv|jsonl)\.gz)$'
# Fail instead of waiting on a prompt nobody will see.
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) sync start"

if [ ! -d "$REPO_DIR/.git" ]; then
  git init -q -b "$BRANCH" "$REPO_DIR"
  git -C "$REPO_DIR" remote add origin "$REMOTE"
  git -C "$REPO_DIR" config user.name "Maya Recorder"
  git -C "$REPO_DIR" config user.email "maya-recorder@users.noreply.github.com"
  git -C "$REPO_DIR" config core.autocrlf false
  status=0
  git -C "$REPO_DIR" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null || status=$?
  if [ "$status" -eq 0 ]; then
    git -C "$REPO_DIR" fetch -q origin "$BRANCH"
    git -C "$REPO_DIR" reset -q --hard FETCH_HEAD
  elif [ "$status" -ne 2 ]; then
    echo "Cannot reach $REMOTE" >&2; rm -rf "$REPO_DIR"; exit 1
  fi
fi

remote=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$SERVER")
missing=()
while IFS= read -r file; do
  [[ "$file" =~ $WANTED ]] || continue
  if [ "$file" = ./README.md ] || [ ! -e "$REPO_DIR/$file" ]; then missing+=("$file"); fi
done < <("${remote[@]}" "cd '$LOG_DIR' && find . -type f \( -name '*.gz' -o -name README.md \) | sort")

if [ "${#missing[@]}" -gt 0 ]; then
  stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
  printf '%s\n' "${missing[@]}" | "${remote[@]}" "cd '$LOG_DIR' && tar -cf - -T -" | tar -xf - -C "$stage"
  for file in "${missing[@]}"; do
    # A cut-off transfer must never be committed as if it were a complete segment.
    case "$file" in *.gz) gzip -t "$stage/$file" ;; esac
    mkdir -p "$(dirname "$REPO_DIR/$file")"; mv -f "$stage/$file" "$REPO_DIR/$file"
  done
fi

git -C "$REPO_DIR" add -A
if git -C "$REPO_DIR" diff --cached --quiet; then
  echo "No new closed segments"
else
  latest=$(git -C "$REPO_DIR" diff --cached --name-only | grep -o '[0-9]\{8\}T[0-9]\{4\}Z' | sort | tail -n 1 || true)
  git -C "$REPO_DIR" commit -q -m "Market log through segment ${latest:-none (format notes only)}"
  echo "Committed through segment ${latest:-none}"
fi
# Also sends a commit that an earlier offline run could not push.
if git -C "$REPO_DIR" rev-parse -q --verify HEAD >/dev/null; then git -C "$REPO_DIR" push -q origin "$BRANCH"; echo "Pushed $BRANCH"; fi
