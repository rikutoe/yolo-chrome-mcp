import assert from "node:assert/strict";
import test from "node:test";
import { publishChromeWebStore } from "./cws-publish.mjs";

const env = {
  CWS_ACCESS_TOKEN: "test-token",
  CWS_PUBLISHER_ID: "publisher-id",
  CWS_EXTENSION_ID: "extension-id",
  CWS_ZIP_PATH: "/tmp/extension.zip",
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test("uploads and submits a completed extension", async () => {
  const requests = [];
  const bodies = [
    response({ uploadState: "SUCCEEDED", crxVersion: "0.3.2" }),
    response({ state: "PENDING_REVIEW" }),
  ];
  const result = await publishChromeWebStore({
    env,
    readFileImpl: async () => Buffer.from("zip"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return bodies.shift();
    },
  });

  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /upload\/v2\/publishers\/publisher-id\/items\/extension-id:upload$/);
  assert.match(requests[1].url, /v2\/publishers\/publisher-id\/items\/extension-id:publish$/);
  assert.equal(requests[1].options.method, "POST");
  assert.equal(result.upload.crxVersion, "0.3.2");
});

test("waits for asynchronous upload processing before publishing", async () => {
  const states = [
    response({ uploadState: "IN_PROGRESS" }),
    response({ lastAsyncUploadState: "SUCCEEDED" }),
    response({ state: "PENDING_REVIEW" }),
  ];
  let waits = 0;
  await publishChromeWebStore({
    env,
    readFileImpl: async () => Buffer.from("zip"),
    fetchImpl: async () => states.shift(),
    wait: async () => waits++,
  });
  assert.equal(waits, 1);
});

test("does not publish after a failed upload", async () => {
  await assert.rejects(
    publishChromeWebStore({
      env,
      readFileImpl: async () => Buffer.from("zip"),
      fetchImpl: async () => response({ uploadState: "FAILED" }),
    }),
    /upload ended in state: FAILED/,
  );
});
