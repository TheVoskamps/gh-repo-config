import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  CONVERGER_REQUIRED_PERMISSIONS,
  checkConvergerPermissions,
  runPreflightFromEnv,
  signAppJwt,
} from "../dist/index.js";

const FULL_GRANT = Object.fromEntries(
  Object.entries(CONVERGER_REQUIRED_PERMISSIONS).map(([key, p]) => [key, p.level]),
);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });

const ENV = {
  GH_REPO_CONFIG_ORG: "acme",
  GH_REPO_CONFIG_APP_SLUG: "acme-converger",
  GH_REPO_CONFIG_INSTALLATION_ID: "12345",
  GH_REPO_CONFIG_APP_CLIENT_ID: "Iv1.abc",
  GH_REPO_CONFIG_APP_PRIVATE_KEY: PEM,
  GITHUB_API_URL: "https://api",
};

function jsonResp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

test("the required map covers every permission the sweep's endpoints need", () => {
  assert.deepEqual(FULL_GRANT, {
    metadata: "read",
    contents: "write",
    workflows: "write",
    pull_requests: "write",
    checks: "read",
    statuses: "read",
    administration: "write",
    organization_administration: "read",
    organization_custom_properties: "write",
  });
});

test("a full grant has no shortfall", () => {
  assert.equal(checkConvergerPermissions(FULL_GRANT, "acme", "acme-converger"), undefined);
});

test("a higher grant than required has no shortfall", () => {
  assert.equal(
    checkConvergerPermissions(
      { ...FULL_GRANT, organization_custom_properties: "admin" },
      "acme",
      "acme-converger",
    ),
    undefined,
  );
});

test("the shortfall names each missing permission as the App settings page words it", () => {
  const { statuses: _absent, ...grant } = FULL_GRANT;
  const message = checkConvergerPermissions(
    { ...grant, contents: "read" },
    "acme",
    "acme-converger",
  );
  assert.ok(message);
  assert.match(
    message,
    /^ {2}Repository permissions > Commit statuses: Read-only \(needs Read-only, granted none\)$/m,
  );
  assert.match(
    message,
    /^ {2}Repository permissions > Contents: Read and write \(needs Read and write, granted Read-only\)$/m,
  );
  assert.doesNotMatch(message, /Workflows/);
});

test("the shortfall carries the settings URL and the acceptance step", () => {
  const message = checkConvergerPermissions(
    { ...FULL_GRANT, organization_administration: undefined },
    "acme",
    "acme-converger",
  );
  assert.match(message, /Organization permissions > Administration: Read-only/);
  assert.ok(
    message.includes(
      "https://github.com/organizations/acme/settings/apps/acme-converger/permissions",
    ),
  );
  assert.match(message, /org owner must accept the updated permissions on the App's installation/);
});

test("signAppJwt signs an RS256 JWT with iss, a backdated iat, and exp within 10 min", () => {
  const jwt = signAppJwt("Iv1.abc", PEM, 1_000_000);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "Iv1.abc");
  assert.equal(claims.iat, 1_000_000 - 60);
  assert.ok(claims.exp > 1_000_000 && claims.exp - claims.iat <= 600);
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
  );
});

test("runPreflightFromEnv makes one installation read and returns the shortfall", async () => {
  const calls = [];
  const doFetch = async (url, init) => {
    calls.push({ url, method: init.method ?? "GET", auth: init.headers.authorization });
    return jsonResp(200, { permissions: { ...FULL_GRANT, workflows: "read" } });
  };
  const message = await runPreflightFromEnv(ENV, doFetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api/app/installations/12345");
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.match(message, /Workflows: Read and write \(needs Read and write, granted Read-only\)/);
});

test("runPreflightFromEnv returns undefined on a full grant", async () => {
  const doFetch = async () => jsonResp(200, { permissions: FULL_GRANT });
  assert.equal(await runPreflightFromEnv(ENV, doFetch), undefined);
});

test("runPreflightFromEnv throws with the status and message on a failed read", async () => {
  const doFetch = async () => jsonResp(401, { message: "A JSON web token could not be decoded" });
  await assert.rejects(
    () => runPreflightFromEnv(ENV, doFetch),
    /401 .*A JSON web token could not be decoded/,
  );
});

test("runPreflightFromEnv requires every env value", async () => {
  for (const name of Object.keys(ENV).filter((k) => k !== "GITHUB_API_URL")) {
    const env = { ...ENV, [name]: "" };
    await assert.rejects(
      () => runPreflightFromEnv(env, async () => assert.fail("no fetch")),
      new RegExp(`${name} is required`),
    );
  }
});
