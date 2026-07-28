"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const {
  appendBounded,
  formatStartupFailure,
  startupTimeoutMs,
  waitForHealthy,
} = require("./startup-supervision.cjs");
const {
  app,
  BrowserWindow,
  dialog,
  session,
} = require("electron");

app.enableSandbox();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let backendProcess = null;
let backendPort = null;
let backendOrigin = null;
let backendErrorLog = "";
let backendOutputLog = "";
let backendExitDetails = { exitCode: null, signal: null };
let backendSessionToken = "";
let backendWorkspacePath = "";
let mainWindow = null;

function applicationPaths() {
  if (app.isPackaged) {
    return {
      executable: path.join(process.resourcesPath, "phase2-api", "docsync-api.exe"),
      args: [],
      workingDirectory: path.join(process.resourcesPath, "phase2-api"),
      webDist: path.join(process.resourcesPath, "web"),
      renderScript: path.join(process.resourcesPath, "phase2-api", "scripts", "render_docx_to_pdf.ps1"),
    };
  }

  const repositoryRoot = path.resolve(__dirname, "../..");
  const apiDirectory = path.join(repositoryRoot, "apps", "api");
  return {
    executable: process.env.DOCUMENTSYNC_PYTHON || "python",
    args: [path.join(apiDirectory, "desktop_backend.py")],
    workingDirectory: apiDirectory,
    webDist: path.join(repositoryRoot, "apps", "web", "dist"),
    renderScript: path.join(apiDirectory, "scripts", "render_docx_to_pdf.ps1"),
  };
}

function reserveAvailablePort() {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.unref();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      const port = typeof address === "object" && address ? address.port : null;
      reservation.close((error) => {
        if (error) reject(error);
        else if (!Number.isInteger(port)) reject(new Error("Windows did not allocate a local port."));
        else resolve(port);
      });
    });
  });
}

async function findAvailablePort(maxAttempts = 3) {
  let latestError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await reserveAvailablePort();
    } catch (error) {
      latestError = error;
    }
  }
  throw latestError || new Error("Windows did not allocate a local port.");
}

function healthRequest() {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { hostname: "127.0.0.1", port: backendPort, path: "/api/health", timeout: 1_500 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body = appendBounded(body, chunk, 1_000);
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`The local service health check returned ${response.statusCode}.`));
            return;
          }
          try {
            const payload = JSON.parse(body);
            if (payload.status === "ok") resolve();
            else reject(new Error("The local service health response was not ready."));
          } catch {
            reject(new Error("The local service health response was invalid."));
          }
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("The local service health check timed out.")));
    request.once("error", reject);
  });
}

async function startBackend() {
  const paths = applicationPaths();
  backendPort = await findAvailablePort();
  backendOrigin = `http://127.0.0.1:${backendPort}`;
  backendSessionToken = crypto.randomBytes(32).toString("base64url");
  backendWorkspacePath = path.join(app.getPath("userData"), "workspace");
  backendErrorLog = "";
  backendOutputLog = "";
  backendExitDetails = { exitCode: null, signal: null };

  backendProcess = spawn(paths.executable, paths.args, {
    cwd: paths.workingDirectory,
    env: {
      ...process.env,
      DOCUMENTSYNC_DATA_DIR: backendWorkspacePath,
      DOCUMENTSYNC_WEB_DIST: paths.webDist,
      DOCUMENTSYNC_RENDER_SCRIPT: paths.renderScript,
      DOCUMENTSYNC_SESSION_TOKEN: backendSessionToken,
      DOCUMENTSYNC_CORS_ORIGINS: backendOrigin,
      DOCUMENTSYNC_PORT: String(backendPort),
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  backendProcess.stdout.on("data", (chunk) => {
    backendOutputLog = appendBounded(backendOutputLog, chunk.toString("utf8"));
  });
  backendProcess.stderr.on("data", (chunk) => {
    backendErrorLog = appendBounded(backendErrorLog, chunk.toString("utf8"));
  });
  backendProcess.once("error", (error) => {
    backendErrorLog = appendBounded(backendErrorLog, `\n${error.message}`);
    backendExitDetails = {
      exitCode: error.code || "spawn error",
      signal: null,
    };
  });
  backendProcess.once("exit", (exitCode, signal) => {
    backendExitDetails = { exitCode, signal };
  });

  await session.defaultSession.cookies.set({
    url: backendOrigin,
    name: "docsync_session",
    value: backendSessionToken,
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "strict",
  });
  await waitForHealthy({
    requestHealth: healthRequest,
    isRunning: () => Boolean(
      backendProcess &&
      backendExitDetails.exitCode === null &&
      backendExitDetails.signal === null &&
      backendProcess.exitCode === null &&
      !backendProcess.killed
    ),
    getExitDetails: () => backendExitDetails,
    timeoutMs: startupTimeoutMs(app.isPackaged),
  });
}

function isTrustedUrl(targetUrl) {
  if (!backendOrigin) return false;
  try {
    return new URL(targetUrl).origin === backendOrigin;
  } catch {
    return false;
  }
}

function configureSession() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (event, item) => {
    if (!isTrustedUrl(item.getURL())) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      title: "Save updated DocSync documents",
      buttonLabel: "Save",
      defaultPath: item.getFilename(),
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "DocSync",
    width: 1440,
    height: 940,
    minWidth: 760,
    minHeight: 640,
    show: false,
    backgroundColor: "#edf2f7",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedUrl(targetUrl)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("app-command", (_event, command) => {
    if (command !== "browser-backward") return;

    void mainWindow.webContents.executeJavaScript(
      'if (window.history.state?.view === "workspace") window.history.back();',
    );
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.loadURL(backendOrigin).catch((error) => {
    dialog.showErrorBox("DocSync could not open", error.message);
  });
}

function stopBackend() {
  if (!backendProcess) return;
  if (backendProcess.exitCode === null && !backendProcess.killed) {
    backendProcess.kill();
  }
  backendProcess = null;
}

if (hasSingleInstanceLock) {
  app.setAppUserModelId("za.co.docsync.desktop");

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    configureSession();
    try {
      await startBackend();
      createWindow();
    } catch (error) {
      dialog.showErrorBox(
        "DocSync could not start",
        formatStartupFailure(error, {
          workspacePath: backendWorkspacePath,
          stderr: backendErrorLog,
          stdout: backendOutputLog,
          secrets: [backendSessionToken],
        }),
      );
      app.quit();
    }
  });

  app.on("before-quit", () => {
    stopBackend();
  });
  app.on("window-all-closed", () => app.quit());
}

module.exports = { applicationPaths, findAvailablePort, isTrustedUrl };
