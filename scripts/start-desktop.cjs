"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const electronEnvironment = { ...process.env };
delete electronEnvironment.ELECTRON_RUN_AS_NODE;

const desktop = spawn(require("electron"), [repositoryRoot], {
  cwd: repositoryRoot,
  env: electronEnvironment,
  stdio: "inherit",
  windowsHide: false,
});

function stop() {
  if (desktop.exitCode === null && desktop.signalCode === null) desktop.kill();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
desktop.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
desktop.once("exit", (code) => {
  process.exitCode = code || 0;
});
