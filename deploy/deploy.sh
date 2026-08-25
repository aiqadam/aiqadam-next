#!/bin/bash
# deploy.sh — forced-command target for the `deploy` CI user.
# Mirrors aiqadam/ai-qadam-platform's on-host deploy.sh contract exactly
# (see that repo's docs/04-development/infrastructure/runbooks/pro-data-tech-cicd.md).
#
# Expected invocation: ssh deploy@host "deploy:<40-or-7-char-hex-sha>"
#
# HARD RULE: this script must NEVER run `git clean`. The deploy/ directory
# is untracked-relative-to-the-running-checkout in the sense that .env (if
# ever added) must survive every deploy — do not add `git clean` under any
# circumstance.

set -euo pipefail

APP_DIR="/opt/apps/aiqadam-next-<env>"
COMPOSE_FILE="deploy/docker-compose.<env>.yml"
COMPOSE_PROJECT="aiqadam-next-<env>"
LAST_DEPLOYED_FILE="$APP_DIR/deploy/.last-deployed-commit"
LOG_PREFIX="[deploy.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)]"

echo "$LOG_PREFIX invoked; SSH_ORIGINAL_COMMAND=${SSH_ORIGINAL_COMMAND:-<unset>}"

if [[ -z "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  echo "$LOG_PREFIX ERROR: no SSH_ORIGINAL_COMMAND set; refusing to deploy" >&2
  exit 1
fi

if [[ "$SSH_ORIGINAL_COMMAND" =~ ^deploy:([0-9a-fA-F]{7,40})$ ]]; then
  REQUESTED_REF="${BASH_REMATCH[1]}"
else
  echo "$LOG_PREFIX ERROR: SSH_ORIGINAL_COMMAND did not match ^deploy:<7-40 hex chars>$, got: $SSH_ORIGINAL_COMMAND" >&2
  exit 1
fi

cd "$APP_DIR"

git fetch origin --quiet
if ! git cat-file -e "${REQUESTED_REF}^{commit}" 2>/dev/null; then
  echo "$LOG_PREFIX ERROR: ref $REQUESTED_REF not found after fetch; refusing to deploy" >&2
  exit 1
fi

PREVIOUS_COMMIT="$(git rev-parse HEAD)"
echo "$PREVIOUS_COMMIT" > "$LAST_DEPLOYED_FILE.previous"

git checkout --detach "$REQUESTED_REF" --quiet
git rev-parse HEAD > "$LAST_DEPLOYED_FILE"

docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --build

echo "$LOG_PREFIX deployed $REQUESTED_REF (was $PREVIOUS_COMMIT)"
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps
