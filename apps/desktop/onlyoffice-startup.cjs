"use strict";

const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: sleep } = require("node:timers/promises");

const execute = promisify(execFile);
const setupMessage = "Set up local ONLYOFFICE Docs, then try again. DocSync can start it automatically after setup.";

async function healthy(origin, signal) {
  try {
    const response = await fetch(origin + "/healthcheck", {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(1800)]),
    });
    return response.ok && (await response.text()).trim() === "true";
  } catch {
    return false;
  }
}

function onlyOfficeStartup({ probePath, createRelay, getBackend }) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const distribution = process.env.DOCSYNC_ONLYOFFICE_WSL_DISTRIBUTION || "Ubuntu";
  const container = process.env.DOCSYNC_ONLYOFFICE_CONTAINER;
  let configuration;
  let daemonHolder;
  let relay;
  let inFlight;
  let registeredSession;

  async function discover() {
    if (!daemonHolder || daemonHolder.exitCode !== null) {
      daemonHolder = spawn("wsl.exe", ["-d", distribution, "--", "sleep", "infinity"], {
        windowsHide: true, stdio: "ignore",
      });
      daemonHolder.on("error", () => { daemonHolder = undefined; });
    }
    let connection;
    try {
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probePath,
        "-Distribution", distribution];
      if (container) args.push("-Container", container);
      const { stdout } = await execute("powershell.exe", args, {
        windowsHide: true, timeout: 45_000, signal, maxBuffer: 8192,
      });
      connection = JSON.parse(stdout.trim());
      if (
        typeof connection.origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(connection.origin) ||
        !/^(\d{1,3}\.){3}\d{1,3}$/.test(connection.relayHost) ||
        typeof connection.secret !== "string" || connection.secret.length < 24
      ) throw new Error();
    } catch {
      // Child-process errors can contain stdout. Keep the signing secret out of the UI and logs.
      throw new Error(setupMessage);
    }

    const deadline = Date.now() + 75_000;
    while (!await healthy(connection.origin, signal)) {
      if (Date.now() >= deadline) {
        throw new Error("ONLYOFFICE is taking longer than expected to start. Try again in a moment.");
      }
      await sleep(750, undefined, { signal });
    }
    return connection;
  }

  async function prepare() {
    if (!configuration || !await healthy(configuration.origin, signal)) {
      configuration = await discover();
      registeredSession = undefined;
      if (relay) {
        relay.close();
        relay = undefined;
      }
    }

    if (!relay) {
      const service = createRelay(() => {
        const backend = getBackend();
        return backend ? Number(new URL(backend.origin).port) : null;
      });
      try {
        await new Promise((resolve, reject) => {
          service.once("error", reject);
          service.listen(0, configuration.relayHost, resolve);
        });
      } catch {
        throw new Error("DocSync could not connect to the WSL network. Try again or check the Windows setup guide.");
      }
      relay = service;
    }

    const backend = getBackend();
    if (!backend) throw new Error("DocSync is changing workspaces. Try again in a moment.");
    if (registeredSession !== backend.sessionToken) {
      const response = await fetch(backend.origin + "/api/onlyoffice/runtime", {
        method: "PUT",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Cookie: "docsync_session=" + backend.sessionToken,
          Authorization: "Bearer " + backend.controlToken,
        },
        body: JSON.stringify({ ...configuration, relayPort: relay.address().port }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error("DocSync could not connect to ONLYOFFICE. Try again.");
      registeredSession = backend.sessionToken;
    }
  }

  return {
    prepare() {
      inFlight ??= prepare().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    close() {
      lifetime.abort();
      relay?.close();
      daemonHolder?.kill();
    },
  };
}

module.exports = { onlyOfficeStartup };
