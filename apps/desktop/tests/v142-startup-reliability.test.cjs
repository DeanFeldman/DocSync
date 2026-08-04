"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");
const {
  BackendStartupFailure,
  PACKAGED_STARTUP_TIMEOUT_MS,
  formatStartupFailure,
  redactBackendOutput,
  startupTimeoutMs,
  waitForHealthy,
} = require("../startup-supervision.cjs");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("packaged startup uses the required 120 second readiness budget", () => {
  assert.equal(PACKAGED_STARTUP_TIMEOUT_MS, 120_000);
  assert.equal(startupTimeoutMs(true), 120_000);
  assert.ok(startupTimeoutMs(false) < startupTimeoutMs(true));
});

test("an early backend exit reports its exit code and signal immediately", async () => {
  await assert.rejects(
    waitForHealthy({
      requestHealth: async () => {
        throw new Error("should not run");
      },
      isRunning: () => false,
      getExitDetails: () => ({ exitCode: 7, signal: "SIGTERM" }),
      timeoutMs: 120_000,
    }),
    (error) => {
      assert.ok(error instanceof BackendStartupFailure);
      assert.equal(error.kind, "exit");
      assert.equal(error.details.exitCode, 7);
      assert.equal(error.details.signal, "SIGTERM");
      return true;
    },
  );
});

test("a live process that never becomes healthy reports a timeout", async () => {
  let clock = 0;
  await assert.rejects(
    waitForHealthy({
      requestHealth: async () => {
        throw new Error("not ready");
      },
      isRunning: () => true,
      getExitDetails: () => ({ exitCode: null, signal: null }),
      timeoutMs: 1_000,
      pollIntervalMs: 500,
      now: () => clock,
      delay: async (duration) => {
        clock += duration;
      },
    }),
    (error) => {
      assert.ok(error instanceof BackendStartupFailure);
      assert.equal(error.kind, "timeout");
      return true;
    },
  );
});

test("startup diagnostics are bounded, redact secrets, and include recovery context", () => {
  const token = "private-session-token";
  const safe = redactBackendOutput(
    `DOCUMENTSYNC_SESSION_TOKEN=${token}\nreplacement_text=private clause`,
    [token],
  );
  assert.doesNotMatch(safe, /private-session-token|private clause/);

  const message = formatStartupFailure(
    new BackendStartupFailure("exit", "Backend stopped.", {
      exitCode: 9,
      signal: null,
    }),
    {
      workspacePath: "C:\\DocSync\\workspace",
      stderr: `failure ${token}`,
      secrets: [token],
    },
  );
  assert.match(message, /Exit code: 9/);
  assert.match(message, /Workspace: C:\\DocSync\\workspace/);
  assert.match(message, /\[REDACTED\]/);
  assert.doesNotMatch(message, new RegExp(token));
});

test("version badge is injected from the root package and precedes the theme control", () => {
  const rootPackage = JSON.parse(read("package.json"));
  const vite = read("apps/web/vite.config.ts");
  const app = read("apps/web/src/App.tsx");
  const styles = read("apps/web/src/styles.css");

  assert.equal(rootPackage.version, "1.6.0");
  assert.match(vite, /new URL\("\.\.\/\.\.\/package\.json", import\.meta\.url\)/);
  assert.match(vite, /__DOCSYNC_VERSION__/);
  assert.match(vite, /valid semantic version/);
  assert.match(app, /aria-label=\{`DocSync version \$\{__DOCSYNC_VERSION__\}`\}/);
  assert.match(app, />\s*v\{__DOCSYNC_VERSION__\}\s*<\/span>/);
  assert.ok(
    app.indexOf('className="version-badge"') <
      app.indexOf('className="theme-toggle"'),
  );
  assert.match(styles, /:root\[data-theme="dark"\] \.version-badge/);
});

test("Windows workflows smoke the exact PyInstaller output before packaging", () => {
  const smoke = read("scripts/smoke-packaged-backend.ps1");
  for (const workflowPath of [
    ".github/workflows/phase3-desktop.yml",
    ".github/workflows/release.yml",
  ]) {
    const workflow = read(workflowPath);
    assert.ok(
      workflow.indexOf("npm run smoke:api:win") <
        workflow.indexOf("npm run package:win"),
    );
  }
  assert.match(
    smoke,
    /apps\/api\/dist\/docsync-api\/docsync-api\.exe/,
  );
  assert.match(smoke, /\/api\/health/);
  assert.match(smoke, /Stop-Process/);
  assert.match(smoke, /Remove-Item -LiteralPath \$resolvedTemporaryRoot -Recurse/);
});
