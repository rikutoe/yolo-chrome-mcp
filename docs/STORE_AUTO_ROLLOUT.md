# Chrome Web Store auto-rollout

Once set up, pushing a `v*` tag publishes to **npm AND the Chrome Web Store**
automatically (via `.github/workflows/release.yml`). This is the one-time setup.

The store step is skipped until `CWS_EXTENSION_ID` is configured, so the
release workflow keeps working before this is done.

## Current setup

- Dedicated Google Cloud project: `yolo-chrome-mcp`
- Chrome Web Store API: enabled on 2026-08-25
- Billing account: not linked because this API does not require it
- Service account: `chrome-webstore-publisher@yolo-chrome-mcp.iam.gserviceaccount.com`
- GitHub authentication: keyless and restricted to `rikutoe/yolo-chrome-mcp`
- Repository variables: configured
- Service account linked in the Developer Dashboard: completed 2026-08-25
- End-to-end keyless authentication check: passed 2026-08-25

## Prerequisites

- The extension must already exist on the store (do the **first upload manually**
  — that's what assigns the Extension ID). Use
  `build/yolo-chrome-mcp-extension-store-v*.zip` at
  https://chrome.google.com/webstore/devconsole/.

## One-time setup

### 1. Get the Extension ID
On the dashboard, open the item → the ID is the long string in the URL
(`.../devconsole/.../<EXTENSION_ID>/`). Copy it.

### 2. Enable the Chrome Web Store API

Completed in the dedicated `yolo-chrome-mcp` project.

### 3. Create keyless GitHub authentication

Completed with a dedicated service account and a workload identity provider.
No JSON key, OAuth client secret, or refresh token is stored.

### 4. Link the service account

Developer Dashboard → Publisher → Settings → Service account, then add:

`chrome-webstore-publisher@yolo-chrome-mcp.iam.gserviceaccount.com`

Chrome Web Store currently permits one service account per publisher.

### 5. Configure GitHub variables

The workflow reads these non-secret repository variables:

| Variable | Purpose |
|---|---|
| `CWS_EXTENSION_ID` | Store item to update |
| `CWS_PUBLISHER_ID` | Publisher that owns the item |
| `CWS_SERVICE_ACCOUNT` | Google identity used by the workflow |
| `CWS_WIF_PROVIDER` | Keyless GitHub authentication provider |

## After setup

Cut a release the normal way — bump version, push a `v*` tag. The workflow
uploads the freshly-built zip through the Chrome Web Store API v2 and submits it
for review. The item goes live after Google's review succeeds.
