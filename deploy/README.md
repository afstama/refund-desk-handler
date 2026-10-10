# Deploying the Refund Desk

The service is one Node process (Fastify). The database is Neon (Postgres). The web service runs on Render's free plan.
Nothing secret is in this repository: the four secrets are typed into Render's dashboard.

## What is here

| File | What it is |
|---|---|
| `../render.yaml` | The Render Blueprint: service name, Frankfurt, free plan, build and start commands, `/health` as the health check, manual deploys, the environment variables (secrets marked `sync: false`) |
| `../.node-version` | The Node version Render uses (24) |
| `../.env.example` | The settings, without values |
| `../.github/workflows/keepwarm.yml` | A GitHub Actions workflow that calls `/health` every 10 minutes. It does nothing until the repository variable `SERVICE_URL` is set, so it only runs in the repository where Ana sets it (see the comments in the file for the limits of a private repository) |

## Settings

| Name | Where | Meaning |
|---|---|---|
| `DATABASE_URL` | secret | Neon connection string of the branch to use |
| `WEBHOOK_SECRET` | secret | the key Qure signs events with |
| `APPROVER_TOKEN` | secret | the token for approve and reject, and the approval screen's password |
| `ANTHROPIC_API_KEY` | secret | used only when `TRIAGE_LIVE` is `1` |
| `NODE_ENV` | `render.yaml` | `production` |
| `TRIAGE_LIVE` | `render.yaml` | `1`: the model is called |
| `TRIAGE_MODEL` | `render.yaml` | `claude-haiku-5-5` |
| `TRIAGE_BUDGET_USD` | `render.yaml` | all-time spending ceiling of the service on the model |
| `PORT` | Render sets it | the service listens on it |

The service creates and migrates its tables when it starts (`migrations/`), so a new, empty Neon branch needs no
other preparation.

## Checking a deployment

1. `GET /health` answers `{"ok":true,"db":true}`.
2. `node selfcheck.mjs --url https://YOUR-SERVICE.onrender.com` (Qure's smoke test; it sends the first 40 events).
3. `npm run replay -- --url https://YOUR-SERVICE.onrender.com` (all 421 deliveries; see `HANDOFF.md` for the numbers
   the ledger must show).

Do both only against a database that is allowed to hold test data (a staging branch). Qure's own replay must meet an
empty database: events that were already received count as duplicates.
