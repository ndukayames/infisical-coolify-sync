# Infisical → Coolify Sync Service

Receives webhooks from Infisical when secrets change, fetches the updated secrets, pushes them to the matching Coolify app, and triggers a redeploy. Zero dependencies — just Node.js 18+ built-ins.

## Endpoints

| Method | Path        | Description                   |
| ------ | ----------- | ----------------------------- |
| POST   | `/webhook`  | Infisical webhook receiver    |
| POST   | `/sync-all` | Manually sync all mapped apps |
| GET    | `/health`   | Health check                  |

---

## Setup

### 1. Create a Machine Identity in Infisical

This gives the sync service API access to read secrets.

1. Go to **Infisical** → **Organization Settings** → **Access Control** → **Identities**
2. Click **Create Identity**, name it `coolify-sync`
3. Under **Authentication**, add **Universal Auth** — copy the **Client ID** and **Client Secret**
4. Go to each **Infisical Project** → **Access Control** → **Machine Identities**
5. Add the `coolify-sync` identity with **Viewer** role (read-only access to secrets)

### 2. Get a Coolify API Token

1. Go to **Coolify** → **Keys & Tokens** → **API Tokens**
2. Create a new token — this will be used to update env vars and restart apps
3. The token must have access to all teams/apps you want to sync

### 3. Find your Coolify App UUIDs

Each app in Coolify has a UUID. You can find it:

- In the URL when viewing the app: `https://coolify.twingle.ng/project/.../application/<uuid>`
- Or via the API: `GET /api/v1/applications`

### 4. Find your Infisical Project ID

Go to **Infisical Project** → **Settings** → **General**. The Project ID is shown there.

### 5. Configure APP_MAPPING

The `APP_MAPPING` env var is a JSON array that tells the service which Infisical secret folder maps to which Coolify app:

```json
[
  {
    "workspaceId": "abc123-infisical-project-id",
    "environment": "production",
    "secretPath": "/twingle-backend",
    "coolifyAppUuid": "xyz789-coolify-app-uuid",
    "coolifyResourceType": "application"
  },
  {
    "workspaceId": "abc123-infisical-project-id",
    "environment": "production",
    "secretPath": "/twingle-frontend",
    "coolifyAppUuid": "def456-coolify-app-uuid",
    "coolifyResourceType": "application"
  }
]
```

- **workspaceId** — Infisical Project ID
- **environment** — e.g. `production`, `staging`, `development`
- **secretPath** — the folder path in Infisical (e.g. `/twingle-backend`)
- **coolifyAppUuid** — the Coolify application or service UUID
- **coolifyResourceType** — `"application"` (default) or `"service"`

### 6. Set up the Webhook in Infisical

1. Go to **Infisical Project** → **Settings** → **Webhooks**
2. Click **Add Webhook**
3. Set the URL to: `https://your-sync-service-domain/webhook`
4. Set the environment and secret path to match your mapping
5. _(Optional)_ Set a webhook secret — the service will verify signatures if `WEBHOOK_SECRET` is set

---

## Deploy on Coolify

1. Push this repo to GitHub (or use a private Git source in Coolify)
2. In Coolify, create a new **Application** from the repo
3. Set the build pack to **Dockerfile**
4. Add these env vars (reference `.env.example`):
   - `INFISICAL_URL`
   - `INFISICAL_CLIENT_ID`
   - `INFISICAL_CLIENT_SECRET`
   - `COOLIFY_URL`
   - `COOLIFY_API_TOKEN`
   - `WEBHOOK_SECRET` _(optional)_
   - `APP_MAPPING` _(the JSON array)_
   - `PORT` = `3000`
5. Set the domain (e.g. `sync.twingle.ng`) and the port to `3000`
6. Deploy

### Verify it works

```bash
# Health check
curl https://sync.twingle.ng/health

# Manual sync (syncs all mapped apps)
curl -X POST https://sync.twingle.ng/sync-all
```

---

## How It Works

```
Developer updates secret in Infisical
        ↓
Infisical fires webhook → POST /webhook
        ↓
Service verifies signature (if WEBHOOK_SECRET set)
        ↓
Service finds matching APP_MAPPING entries
        ↓
Fetches ALL secrets from that Infisical folder
        ↓
Pushes them as env vars to the Coolify app (bulk update)
        ↓
Triggers a redeploy on Coolify
        ↓
App restarts with new env vars
```

## Environment Variables

| Variable                  | Required | Description                                                |
| ------------------------- | -------- | ---------------------------------------------------------- |
| `INFISICAL_URL`           | Yes      | Infisical instance URL (e.g. `https://secrets.twingle.ng`) |
| `INFISICAL_CLIENT_ID`     | Yes      | Machine Identity Client ID                                 |
| `INFISICAL_CLIENT_SECRET` | Yes      | Machine Identity Client Secret                             |
| `COOLIFY_URL`             | Yes      | Coolify instance URL (e.g. `https://coolify.twingle.ng`)   |
| `COOLIFY_API_TOKEN`       | Yes      | Coolify API token                                          |
| `WEBHOOK_SECRET`          | No       | Shared secret for signature verification                   |
| `APP_MAPPING`             | Yes      | JSON array mapping Infisical folders → Coolify apps        |
| `PORT`                    | No       | Server port (default: `3000`)                              |
