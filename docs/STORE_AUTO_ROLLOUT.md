# Chrome Web Store auto-rollout

Once set up, pushing a `v*` tag publishes to **npm AND the Chrome Web Store**
automatically (via `.github/workflows/release.yml`). This is the one-time setup.

The store step is skipped until the four `CWS_*` repo secrets exist, so the
release workflow keeps working before this is done.

## Prerequisites

- The extension must already exist on the store (do the **first upload manually**
  — that's what assigns the Extension ID). Use
  `build/yolo-chrome-mcp-extension-store-v*.zip` at
  https://chrome.google.com/webstore/devconsole/.

## One-time steps (Rikuto's Google login required)

### 1. Get the Extension ID
On the dashboard, open the item → the ID is the long string in the URL
(`.../devconsole/.../<EXTENSION_ID>/`). Copy it.

### 2. Enable the Chrome Web Store API
1. https://console.cloud.google.com/ → create/select a project.
2. APIs & Services → Library → enable **Chrome Web Store API**.

### 3. Create OAuth credentials
1. APIs & Services → OAuth consent screen → External → add yourself as a
   **Test user** (no verification needed for personal use).
2. Credentials → Create Credentials → **OAuth client ID** → type **Desktop app**.
3. Copy the **Client ID** and **Client secret**.

### 4. Generate a refresh token (one-time)
In a terminal, with CLIENT_ID / CLIENT_SECRET from step 3:

```bash
# Open this URL in a browser, approve, copy the ?code=... from the redirect:
open "https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&approval_prompt=force&redirect_uri=urn:ietf:wg:oauth:2.0:oob&client_id=CLIENT_ID"

# Exchange the code for a refresh token:
curl -s "https://accounts.google.com/o/oauth2/token" \
  -d "client_id=CLIENT_ID" \
  -d "client_secret=CLIENT_SECRET" \
  -d "code=PASTE_CODE_HERE" \
  -d "grant_type=authorization_code" \
  -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob"
# → the JSON response contains "refresh_token".
```

> If the `oob` redirect is rejected (Google is deprecating it), use the
> `chrome-webstore-upload-keys` helper: `npx chrome-webstore-upload-keys` walks
> through the same flow with a localhost redirect.

### 5. Add the four GitHub secrets
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `CWS_EXTENSION_ID` | from step 1 |
| `CWS_CLIENT_ID` | from step 3 |
| `CWS_CLIENT_SECRET` | from step 3 |
| `CWS_REFRESH_TOKEN` | from step 4 |

## After setup

Cut a release the normal way — bump version, push a `v*` tag. The workflow
uploads the freshly-built zip and submits it for publishing. Google still runs
its review; the item goes live once that passes (usually automatic for updates).
