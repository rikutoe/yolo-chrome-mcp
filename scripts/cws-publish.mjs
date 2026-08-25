import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://chromewebstore.googleapis.com";
const PROCESSING_STATES = new Set(["IN_PROGRESS", "UPLOAD_IN_PROGRESS"]);

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Chrome Web Store returned non-JSON (${response.status})`);
    }
  }
  if (!response.ok) {
    const message = body?.error?.message ?? text ?? response.statusText;
    throw new Error(`Chrome Web Store request failed (${response.status}): ${message}`);
  }
  return body;
}

export async function publishChromeWebStore({
  env = process.env,
  fetchImpl = fetch,
  readFileImpl = readFile,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const token = required(env, "CWS_ACCESS_TOKEN");
  const publisherId = required(env, "CWS_PUBLISHER_ID");
  const extensionId = required(env, "CWS_EXTENSION_ID");
  const zipPath = required(env, "CWS_ZIP_PATH");
  const item = `publishers/${publisherId}/items/${extensionId}`;
  const headers = { Authorization: `Bearer ${token}` };

  const upload = await requestJson(
    fetchImpl,
    `${API_ROOT}/upload/v2/${item}:upload`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/zip" },
      body: await readFileImpl(zipPath),
    },
  );

  let uploadState = upload.uploadState;
  for (let attempt = 0; PROCESSING_STATES.has(uploadState) && attempt < 24; attempt++) {
    await wait(5_000);
    const status = await requestJson(
      fetchImpl,
      `${API_ROOT}/v2/${item}:fetchStatus`,
      { headers },
    );
    uploadState = status.lastAsyncUploadState ?? status.uploadState;
  }
  if (uploadState !== "SUCCEEDED") {
    throw new Error(`Chrome Web Store upload ended in state: ${uploadState ?? "unknown"}`);
  }

  const published = await requestJson(
    fetchImpl,
    `${API_ROOT}/v2/${item}:publish`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        publishType: "DEFAULT_PUBLISH",
        blockOnWarnings: true,
      }),
    },
  );
  return { upload, published };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishChromeWebStore()
    .then(({ upload }) => {
      console.log(`Chrome Web Store submission created for ${upload.crxVersion ?? "new version"}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
