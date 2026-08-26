# Deploy Guide

Audience: FRONTEND-DEV (no dedicated DevOps role exists yet — see
`docs/agents/AGENT_SYSTEM.md` §3; if deploy work grows substantially beyond what's
described here, that's a trigger to add one).

## 1. Pipeline overview

```
push to any branch ──► build job (lint, build, docker build verification)
push to master      ──► + deploy-qa  ──► qa.aiqadam.org
workflow_dispatch    ──► + deploy-prod ──► aiqadam.org  (manual, explicit commit SHA)
```

Defined in [.github/workflows/ci-cd.yml](../../.github/workflows/ci-cd.yml).

- **build**: runs on every push to every branch and every PR into `master`. `npm ci` →
  `npm run lint` → `npm run build` → a Docker build (verification only, image isn't
  pushed anywhere from this job).
- **deploy-qa**: runs only on a push landing on `master`. SSHes to the QA host as the
  `deploy` user and invokes `deploy:<sha>` (the forced command bound to that key — see
  §3), then polls `https://qa.aiqadam.org/health` for up to 50s.
- **deploy-prod**: runs only via manual `workflow_dispatch` with an explicit `git_ref`
  input (7-40 hex chars) — never automatic. Same deploy mechanism against the prod host,
  then polls `https://aiqadam.org/health`.

Both deploy jobs require their environment's SSH host-key/deploy-key secrets
(GitHub Environments `qa` / `production`) — `QA_SSH_HOST_KEY`/`QA_SSH_DEPLOY_KEY` for
`deploy-qa`, `PROD_SSH_HOST_KEY`/`PROD_SSH_DEPLOY_KEY` for `deploy-prod` — and clean up
the private key file afterward regardless of outcome.

## 2. The Docker image

[Dockerfile](../../Dockerfile) — multi-stage, `node:22.14.0-alpine`:

1. **builder**: `npm ci` → `npm run build`.
2. **runtime**: copies `public/`, `.next/`, `node_modules/`, `package.json` from the
   builder; runs as the non-root `node` user; `CMD npm start`; listens on `PORT` (default
   `3000`).

If you change anything that affects the build output shape (`next.config.ts`, adding a
new required env var, changing the start command), verify the Docker build still works
locally: `docker build -t aiqadam-next:local .`

## 3. On-host deploy mechanism

[deploy/deploy.sh](../../deploy/deploy.sh) is a forced-command SSH target — it only
accepts an `SSH_ORIGINAL_COMMAND` matching `^deploy:<7-40 hex chars>$`. It:

1. Validates the ref format, `git fetch`, confirms the commit exists.
2. Records the previous commit to `deploy/.last-deployed-commit.previous` (manual
   rollback reference).
3. `git checkout --detach <sha>`.
4. `docker compose -p <project> -f <compose-file> up -d --build`.

**Hard rule, stated in the script itself: never add `git clean` to this script.** The
`deploy/` directory on the host may hold an untracked `.env` that must survive every
deploy.

[deploy/docker-compose.qa.yml](../../deploy/docker-compose.qa.yml) and
[deploy/docker-compose.prod.yml](../../deploy/docker-compose.prod.yml) both use
`network_mode: host`, differing only in `PORT` and project/container naming. Both define
a healthcheck hitting `/health` on the container's own port.

## 4. The `/health` route

[src/app/health/route.ts](../../src/app/health/route.ts) — a plain `GET` returning
`{ status: "ok", service: "aiqadam-next" }`. Used by both the Docker healthcheck and the
CI health-check polling step after deploy. If you ever need to make this check something
real (e.g. a future backend dependency), keep the response shape and the `200` status
contract — CI's polling logic depends on exactly that.

## 5. What to check before merging something deploy-relevant

- [ ] `docker build .` succeeds locally if `Dockerfile` or the build output changed
- [ ] `/health` still returns `200` with the expected JSON shape
- [ ] No new required env var was added without also adding it to both compose files and
      documenting where the host-side `.env` needs updating (coordinate with whoever has
      host access — this repo doesn't manage that file)
