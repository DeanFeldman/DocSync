"use strict";

const PACKAGED_STARTUP_TIMEOUT_MS = 120_000;
const DEVELOPMENT_STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const MAX_DIAGNOSTIC_CHARS = 12_000;

class BackendStartupFailure extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = "BackendStartupFailure";
    this.kind = kind;
    this.details = details;
  }
}

function appendBounded(current, chunk, limit = MAX_DIAGNOSTIC_CHARS) {
  return `${current}${chunk}`.slice(-limit);
}

function redactBackendOutput(value, secrets = []) {
  let safe = String(value || "");
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }
  safe = safe
    .replace(
      /(DOCUMENTSYNC_SESSION_TOKEN|docsync_session)\s*[=:]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /(replacement_text|before_text|after_text|document_text)\s*[=:]\s*.+/gi,
      "$1=[REDACTED]",
    );
  return safe.slice(-MAX_DIAGNOSTIC_CHARS);
}

function startupTimeoutMs(isPackaged) {
  return isPackaged
    ? PACKAGED_STARTUP_TIMEOUT_MS
    : DEVELOPMENT_STARTUP_TIMEOUT_MS;
}

async function waitForHealthy({
  requestHealth,
  isRunning,
  getExitDetails,
  timeoutMs,
  pollIntervalMs = HEALTH_POLL_INTERVAL_MS,
  delay = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  now = () => Date.now(),
}) {
  const deadline = now() + timeoutMs;
  let latestError = null;

  while (now() < deadline) {
    if (!isRunning()) {
      const details = getExitDetails();
      throw new BackendStartupFailure(
        "exit",
        "The local document service exited before it became ready.",
        details,
      );
    }
    try {
      await requestHealth();
      return;
    } catch (error) {
      latestError = error;
    }
    await delay(pollIntervalMs);
  }

  throw new BackendStartupFailure(
    "timeout",
    "The local document service is still running, but workspace preparation exceeded the startup limit.",
    { latestHealthError: latestError?.message || "" },
  );
}

function formatStartupFailure(error, {
  workspacePath,
  stderr,
  stdout,
  secrets = [],
} = {}) {
  const kind = error instanceof BackendStartupFailure ? error.kind : "error";
  const details = error?.details || {};
  const lines = [error?.message || "The local document service could not start."];

  if (kind === "exit") {
    lines.push(
      `Exit code: ${details.exitCode ?? "not reported"}`,
      `Signal: ${details.signal ?? "not reported"}`,
    );
  } else if (kind === "timeout") {
    lines.push(
      "DocSync did not become ready in time. Close any other DocSync instances, then retry.",
    );
  }
  if (workspacePath) lines.push(`Workspace: ${workspacePath}`);

  const safeError = redactBackendOutput(stderr, secrets).trim();
  const safeOutput = redactBackendOutput(stdout, secrets).trim();
  const diagnostic = safeError || safeOutput;
  if (diagnostic) lines.push(`Recent service output:\n${diagnostic}`);
  return lines.join("\n\n");
}

module.exports = {
  BackendStartupFailure,
  DEVELOPMENT_STARTUP_TIMEOUT_MS,
  HEALTH_POLL_INTERVAL_MS,
  MAX_DIAGNOSTIC_CHARS,
  PACKAGED_STARTUP_TIMEOUT_MS,
  appendBounded,
  formatStartupFailure,
  redactBackendOutput,
  startupTimeoutMs,
  waitForHealthy,
};
