"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { onlyOfficeStartup } = require("./onlyoffice-startup.cjs");
const { workspaceChoices, selectInitialWorkspace, rememberWorkspace,
  stageLocation, moveImportedWorkspace } = require("./device-workspaces.cjs");
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
  ipcMain,
  session,
  shell,
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
const developmentWebUrl = process.env.DOCUMENTSYNC_WEB_DEV_URL || "";
const externalBackendOrigin = process.env.DOCUMENTSYNC_BACKEND_ORIGIN || "";
const officeControlToken = crypto.randomBytes(32).toString("base64url");
const officeDirectory = app.isPackaged
  ? path.join(process.resourcesPath, "onlyoffice")
  : path.join(__dirname, "..", "..", "scripts");
const managedOffice = process.platform === "win32" && !externalBackendOrigin &&
  !(process.env.DOCSYNC_ONLYOFFICE_URL && process.env.DOCSYNC_ONLYOFFICE_SECRET);
const officeStartup = managedOffice ? onlyOfficeStartup({
  probePath: path.join(officeDirectory, "resolve-onlyoffice.ps1"),
  createRelay: require(path.join(officeDirectory, "onlyoffice-wsl-relay.cjs")).createOfficeRelay,
  getBackend: () => backendProcess && backendSessionToken
    ? { origin: backendOrigin, sessionToken: backendSessionToken, controlToken: officeControlToken }
    : null,
}) : null;
const THEME_PREFERENCE_KEY = "docsync-theme";

function themePreferencePath() {
  return path.join(app.getPath("userData"), "preferences.json");
}

function readThemePreference() {
  try {
    const value = JSON.parse(fs.readFileSync(themePreferencePath(), "utf8"))[THEME_PREFERENCE_KEY];
    return value === "system" || value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function persistThemePreference(value) {
  if (!["system", "light", "dark"].includes(value)) return;
  let preferences = {};
  try { preferences = JSON.parse(fs.readFileSync(themePreferencePath(), "utf8")); } catch { /* First run. */ }
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(themePreferencePath(), JSON.stringify({ ...preferences, [THEME_PREFERENCE_KEY]: value }), "utf8");
}

function applicationPaths() {
  if (app.isPackaged) {
    return {
      executable: path.join(process.resourcesPath, "phase2-api", "docsync-api.exe"),
      args: [],
      workingDirectory: path.join(process.resourcesPath, "phase2-api"),
      webDist: path.join(process.resourcesPath, "web"),
      renderScript: path.join(process.resourcesPath, "phase2-api", "scripts", "render_docx_to_pdf.ps1"),
      wordWorkerScript: path.join(process.resourcesPath, "phase2-api", "scripts", "render_docx_worker.ps1"),
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
    wordWorkerScript: path.join(apiDirectory, "scripts", "render_docx_worker.ps1"),
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

async function startBackend(preferredPort = null) {
  if (externalBackendOrigin) {
    backendOrigin = new URL(externalBackendOrigin).origin;
    backendPort = Number(new URL(backendOrigin).port);
    backendWorkspacePath = process.env.DOCUMENTSYNC_DATA_DIR || "development workspace";
    await waitForHealthy({
      requestHealth: healthRequest,
      isRunning: () => true,
      getExitDetails: () => ({ exitCode: null, signal: null }),
      timeoutMs: startupTimeoutMs(false),
    });
    return;
  }
  const paths = applicationPaths();
  backendPort = preferredPort || await findAvailablePort();
  backendOrigin = `http://127.0.0.1:${backendPort}`;
  backendSessionToken = crypto.randomBytes(32).toString("base64url");
  backendWorkspacePath = backendWorkspacePath || selectInitialWorkspace(app.getPath("userData")).path;
  backendErrorLog = "";
  backendOutputLog = "";
  backendExitDetails = { exitCode: null, signal: null };

  backendProcess = spawn(paths.executable, paths.args, {
    cwd: paths.workingDirectory,
    env: {
      ...process.env,
      DOCUMENTSYNC_DATA_DIR: backendWorkspacePath,
      DOCUMENTSYNC_DATABASE_URL: "sqlite:///" + path.join(backendWorkspacePath, "documentsync.db").replaceAll("\\", "/"),
      DOCUMENTSYNC_WEB_DIST: paths.webDist,
      DOCUMENTSYNC_RENDER_SCRIPT: paths.renderScript,
      DOCUMENTSYNC_WORD_WORKER_SCRIPT: paths.wordWorkerScript,
      DOCUMENTSYNC_SESSION_TOKEN: backendSessionToken,
      DOCSYNC_ONLYOFFICE_CONTROL_TOKEN: officeStartup ? officeControlToken : "",
      DOCUMENTSYNC_CORS_ORIGINS: backendOrigin,
      DOCUMENTSYNC_PORT: String(backendPort),
      DOCUMENTSYNC_SUPABASE_URL: "",
      DOCUMENTSYNC_ACCOUNT_USER_ID: "",
      DOCUMENTSYNC_DEVICE_ID: "",
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
    timeoutMs: startupTimeoutMs(app.isPackaged || !developmentWebUrl),
  });
}

function isTrustedUrl(targetUrl) {
  if (!backendOrigin) return false;
  try {
    const origin = new URL(targetUrl).origin;
    return origin === backendOrigin || Boolean(developmentWebUrl && origin === new URL(developmentWebUrl).origin);
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
      title: "Save DocSync files",
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
      preload: path.join(__dirname, "preload.cjs"),
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
  mainWindow.loadURL(developmentWebUrl || backendOrigin).catch((error) => {
    dialog.showErrorBox("DocSync could not open", error.message);
  });
}

async function stopBackend() {
  if (!backendProcess) return;
  if (backendProcess.exitCode === null && !backendProcess.killed) {
    backendProcess.kill();
    const exited = await Promise.race([
      new Promise((resolve) => backendProcess.once("exit", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!exited) throw new Error("The previous workspace did not stop in time.");
  }
  backendProcess = null;
  backendSessionToken = "";
}
async function restartBackendForWorkspace(workspace) {
  const previousPort = backendPort;
  await stopBackend();
  backendWorkspacePath = workspace;
  await startBackend(previousPort);
}

if (hasSingleInstanceLock) {
  app.setAppUserModelId("za.co.docsync.desktop");

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    ipcMain.handle("office:prepare", async (event) => {
      if (!isTrustedUrl(event.senderFrame?.url)) throw new Error("Editor startup is unavailable.");
      try {
        await officeStartup?.prepare();
        return null;
      } catch (error) {
        return error.message;
      }
    });
    ipcMain.handle("office:setup-guide", (event) => {
      if (isTrustedUrl(event.senderFrame?.url)) {
        return shell.openExternal("https://github.com/DeanFeldman/DocSync/blob/main/docs/local-onlyoffice-windows.md");
      }
    });
    ipcMain.on("theme:get-preference", (event) => { event.returnValue = readThemePreference(); });
    ipcMain.on("theme:set-preference", (_event, preference) => persistThemePreference(preference));
    let workspaceChanging = false;
    const deviceRoot = app.getPath("userData");
    async function activateLocalWorkspace(choice) {
      if (externalBackendOrigin || workspaceChanging) throw new Error("A local workspace switch is unavailable.");
      workspaceChanging = true;
      const previous = backendWorkspacePath;
      try {
        await restartBackendForWorkspace(choice.path);
        rememberWorkspace(deviceRoot, choice.id);
      } catch (error) {
        await restartBackendForWorkspace(previous);
        throw error;
      } finally {
        workspaceChanging = false;
      }
    }
    function requireLocalSender(event) {
      if (event.sender !== mainWindow?.webContents ||
          event.senderFrame !== event.sender.mainFrame || !isTrustedUrl(event.senderFrame.url)) {
        throw new Error("The workspace request did not come from the local DocSync window.");
      }
    }
    ipcMain.handle("device-data:list", (event) => {
      requireLocalSender(event);
      if (externalBackendOrigin) return [];
      return workspaceChoices(deviceRoot).map(({ id, name, path }) => ({
        id, name, active: path === backendWorkspacePath,
      }));
    });
    ipcMain.handle("device-data:open", async (event, id) => {
      requireLocalSender(event);
      const choice = workspaceChoices(deviceRoot).find((item) => item.id === id);
      if (!choice) throw new Error("The selected workspace is unavailable.");
      if (choice.path !== backendWorkspacePath) await activateLocalWorkspace(choice);
    });
    ipcMain.handle("device-data:import", async (event, id) => {
      requireLocalSender(event);
      if (externalBackendOrigin || workspaceChanging) throw new Error("Local workspace import is unavailable.");
      const imported = moveImportedWorkspace(deviceRoot, backendWorkspacePath, id);
      try {
        await activateLocalWorkspace(imported);
      } catch (error) {
        fs.renameSync(imported.path, imported.staged);
        fs.rmdirSync(path.dirname(imported.path));
        throw error;
      }
      const settings = path.join(imported.path, "import-settings.json");
      try { fs.unlinkSync(settings); } catch { /* The imported workspace is already usable. */ }
      try { persistThemePreference(imported.appearance); } catch { /* Settings do not block a restore. */ }
    });
    ipcMain.handle("device-data:discard", (event, id) => {
      requireLocalSender(event);
      if (externalBackendOrigin || workspaceChanging) throw new Error("Local workspace import is unavailable.");
      const staging = stageLocation(backendWorkspacePath, id);
      if (fs.existsSync(path.join(staging, "import-settings.json"))) {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    });
    configureSession();
    try {
      backendWorkspacePath = selectInitialWorkspace(app.getPath("userData")).path;
      await startBackend();
      createWindow();
      void officeStartup?.prepare().catch(() => {});
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
    officeStartup?.close();
    stopBackend();
  });
  app.on("window-all-closed", () => app.quit());
}

module.exports = { applicationPaths, findAvailablePort, isTrustedUrl };
