"use strict";

const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const backendOrigin = "http://127.0.0.1:8001";
const webOrigin = "http://127.0.0.1:5173";
const developmentDataDirectory = process.env.DOCUMENTSYNC_DATA_DIR
  || path.join(repositoryRoot, ".artifacts", "dev-workspace");
const children = new Set();
let stopping = false;

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function waitForUrl(url, child, timeoutMs = 60_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error(`${url} stopped before it became ready.`));
        return;
      }
      const request = http.get(url, { timeout: 1_000 }, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
      });
      request.once("timeout", () => request.destroy());
      request.once("error", retry);
    }

    function retry() {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`${url} did not become ready within ${timeoutMs / 1000} seconds.`));
      } else {
        setTimeout(attempt, 200);
      }
    }

    attempt();
  });
}

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  process.exitCode = exitCode;
  setTimeout(() => process.exit(exitCode), 250);
}

async function main() {
  const python = process.env.DOCUMENTSYNC_PYTHON || "python";
  const api = start(
    python,
    [path.join(repositoryRoot, "apps", "api", "desktop_backend.py")],
    {
      cwd: path.join(repositoryRoot, "apps", "api"),
      env: {
        ...process.env,
        DOCUMENTSYNC_PORT: "8001",
        DOCUMENTSYNC_DATA_DIR: developmentDataDirectory,
        DOCUMENTSYNC_SESSION_TOKEN: "",
        DOCUMENTSYNC_CORS_ORIGINS: webOrigin,
      },
    },
  );
  const web = start(
    process.execPath,
    [
      path.join(repositoryRoot, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
    ],
    { cwd: path.join(repositoryRoot, "apps", "web") },
  );

  await Promise.all([
    waitForUrl(`${backendOrigin}/api/health`, api),
    waitForUrl(webOrigin, web),
  ]);

  const electronExecutable = require("electron");
  const electronEnvironment = {
    ...process.env,
    DOCUMENTSYNC_BACKEND_ORIGIN: backendOrigin,
    DOCUMENTSYNC_WEB_DEV_URL: webOrigin,
    DOCUMENTSYNC_DATA_DIR: developmentDataDirectory,
  };
  delete electronEnvironment.ELECTRON_RUN_AS_NODE;
  const desktop = start(electronExecutable, [repositoryRoot], {
    env: electronEnvironment,
  });
  desktop.once("exit", (code) => stopAll(code || 0));
}

process.once("SIGINT", () => stopAll(0));
process.once("SIGTERM", () => stopAll(0));
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  stopAll(1);
});
