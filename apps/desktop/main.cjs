"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { accountWorkspacePath, deviceId } = require("./account-workspace.cjs");
const { copyToStaging, declineMigration, finalizeStaging, migrationStatus, validateStagingLayout } = require("./legacy-workspace-migration.cjs");
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
  safeStorage,
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
let activeAccountId = null;
let activeAccountWorkspaceWasNew = false;
const developmentWebUrl = process.env.DOCUMENTSYNC_WEB_DEV_URL || "";
const externalBackendOrigin = process.env.DOCUMENTSYNC_BACKEND_ORIGIN || "";
const publicSupabaseUrl = process.env.DOCUMENTSYNC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://lrgsqwkgokzpurdsvtag.supabase.co";
const THEME_PREFERENCE_KEY = "docsync-theme";
let pendingAuthCode = null;
function authStoragePath() { return path.join(app.getPath("userData"), "auth-session.bin"); }
function validAuthStorageKey(key) { return typeof key === "string" && key.length > 0 && key.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(key); }
function validAuthStorageValue(value) { return typeof value === "string" && value.length <= 65_536; }
function readAuthStorageEntries() {
  if (!safeStorage.isEncryptionAvailable()) return {};
  try {
    const entries = JSON.parse(safeStorage.decryptString(fs.readFileSync(authStoragePath())));
    if (!entries || Array.isArray(entries) || typeof entries !== "object") return {};
    return Object.fromEntries(Object.entries(entries).filter(([key, value]) => validAuthStorageKey(key) && validAuthStorageValue(value)));
  } catch { return {}; }
}
function writeAuthStorageEntries(entries) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try { fs.mkdirSync(app.getPath("userData"), { recursive: true }); fs.writeFileSync(authStoragePath(), safeStorage.encryptString(JSON.stringify(entries))); return true; } catch { return false; }
}
function getAuthStorageEntry(key) { return validAuthStorageKey(key) ? readAuthStorageEntries()[key] || null : null; }
function setAuthStorageEntry(key, value) {
  if (!validAuthStorageKey(key) || !validAuthStorageValue(value)) return false;
  const entries = readAuthStorageEntries();
  if (!(key in entries) && Object.keys(entries).length >= 50) return false;
  entries[key] = value;
  return writeAuthStorageEntries(entries);
}
function removeAuthStorageEntry(key) {
  if (!validAuthStorageKey(key)) return false;
  const entries = readAuthStorageEntries(); delete entries[key];
  if (Object.keys(entries).length === 0) return clearAuthStorage();
  return writeAuthStorageEntries(entries);
}
function clearAuthStorage() { try { fs.rmSync(authStoragePath(), { force: true }); return true; } catch { return false; } }
function authenticatedUserId() { try { for (const value of Object.values(readAuthStorageEntries())) { const token = JSON.parse(value).access_token; const payload = token && JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); if (payload && /^[0-9a-f-]{36}$/i.test(payload.sub || "")) return payload.sub.toLowerCase(); } } catch {} return null; }
function authCallback(url) {
  try { const value = new URL(url); if (value.protocol !== "za.co.docsync:" || value.hostname !== "auth" || value.pathname !== "/callback") return null; const code = value.searchParams.get("code"); return code && /^[A-Za-z0-9._~-]+$/.test(code) ? code : null; } catch { return null; }
}
function deliverAuthCallback(url) { const code = authCallback(url); if (!code) return false; pendingAuthCode = code; if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); mainWindow.webContents.send("auth:callback", code); } return true; }
function trustedOAuthUrl(value) { try { const url = new URL(value); return url.protocol === "https:" && /(^|\.)supabase\.co$/i.test(url.hostname) && url.pathname === "/auth/v1/authorize"; } catch { return false; } }
function registerProtocolClient() {
  if (process.defaultApp) {
    if (process.argv.length < 2) return false;
    return app.setAsDefaultProtocolClient("za.co.docsync", process.execPath, [path.resolve(process.argv[1])]);
  }
  return app.setAsDefaultProtocolClient("za.co.docsync");
}

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
  backendWorkspacePath = backendWorkspacePath || path.join(app.getPath("userData"), "bootstrap");
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
      DOCUMENTSYNC_WORD_WORKER_SCRIPT: paths.wordWorkerScript,
      DOCUMENTSYNC_SESSION_TOKEN: backendSessionToken,
      DOCUMENTSYNC_CORS_ORIGINS: backendOrigin,
      DOCUMENTSYNC_PORT: String(backendPort),
      DOCUMENTSYNC_SUPABASE_URL: publicSupabaseUrl,
      DOCUMENTSYNC_ACCOUNT_USER_ID: activeAccountId || "",
      DOCUMENTSYNC_DEVICE_ID: activeAccountId ? deviceId(app.getPath("userData")) : "",
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
    if (!exited) throw new Error("The previous account workspace did not stop in time.");
  }
  backendProcess = null;
  backendSessionToken = "";
}
function cloudStatePath() { return activeAccountId ? path.join(app.getPath("userData"), "accounts", activeAccountId, "cloud-backup-state.json") : null; }
function readCloudState() { try { const target = cloudStatePath(); return target ? JSON.parse(fs.readFileSync(target, "utf8")) : {}; } catch { return {}; } }
function writeCloudState(value) { const target = cloudStatePath(); if (!target || !value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 4096) return false; fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(value), "utf8"); return true; }

async function restartBackendForWorkspace(workspace) {
  const previousPort = backendPort;
  await stopBackend();
  backendWorkspacePath = workspace;
  await startBackend(previousPort);
}

if (hasSingleInstanceLock) {
  app.setAppUserModelId("za.co.docsync.desktop");
  registerProtocolClient();

  app.on("second-instance", (_event, argv) => {
    argv.forEach(deliverAuthCallback);
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    ipcMain.on("theme:get-preference", (event) => { event.returnValue = readThemePreference(); });
    ipcMain.on("theme:set-preference", (_event, preference) => persistThemePreference(preference));
    ipcMain.handle("auth:open-oauth", (_event, url) => {
      if (!trustedOAuthUrl(url)) return false;
      return shell.openExternal(url).then(() => true);
    });
    ipcMain.handle("auth:callback", () => { const code = pendingAuthCode; pendingAuthCode = null; return code; });
    ipcMain.handle("auth-storage:get", (_event, key) => getAuthStorageEntry(key));
    ipcMain.handle("auth-storage:set", (_event, key, value) => setAuthStorageEntry(key, value));
    ipcMain.handle("auth-storage:remove", (_event, key) => removeAuthStorageEntry(key));
    ipcMain.handle("auth-storage:clear", () => clearAuthStorage());
    ipcMain.handle("cloud-backup:get-state", () => readCloudState());
    ipcMain.handle("cloud-backup:set-state", (_event, value) => writeCloudState(value));
    ipcMain.handle("account:activate", async (_event, userId) => {
      if (authenticatedUserId() !== String(userId).toLowerCase()) throw new Error("Account activation does not match the authenticated session.");
      const workspace = accountWorkspacePath(app.getPath("userData"), userId);
      // The renderer only receives this IPC after Supabase has established the user;
      // Electron derives the path and never accepts a renderer filesystem path.
      activeAccountWorkspaceWasNew = !fs.existsSync(workspace);
      activeAccountId = userId.toLowerCase();
      await restartBackendForWorkspace(workspace);
      return { workspace_ready: true, ...migrationStatus({ userData: app.getPath("userData"), workspace, workspaceWasNew: activeAccountWorkspaceWasNew }), device_id: deviceId(app.getPath("userData")) };
    });
    ipcMain.handle("account:legacy-migration", () => {
      if (!activeAccountId) throw new Error("No authenticated account is active.");
      return migrationStatus({ userData: app.getPath("userData"), workspace: backendWorkspacePath, workspaceWasNew: activeAccountWorkspaceWasNew });
    });
    ipcMain.handle("account:decline-legacy-migration", () => {
      if (!activeAccountId) throw new Error("No authenticated account is active.");
      declineMigration(backendWorkspacePath);
      return migrationStatus({ userData: app.getPath("userData"), workspace: backendWorkspacePath, workspaceWasNew: activeAccountWorkspaceWasNew });
    });
    ipcMain.handle("account:import-legacy-workspace", async () => {
      if (!activeAccountId || authenticatedUserId() !== activeAccountId) throw new Error("Legacy import requires the active authenticated account.");
      const workspace = backendWorkspacePath;
      const status = migrationStatus({ userData: app.getPath("userData"), workspace, workspaceWasNew: activeAccountWorkspaceWasNew });
      if (!status.migration_ready) throw new Error(status.message || "Legacy import is not available for this account.");
      const { staging, sourceFingerprint } = copyToStaging({ userData: app.getPath("userData"), workspace });
      try {
        validateStagingLayout(staging);
        await restartBackendForWorkspace(staging); // Existing backend init/migrations validate the copied SQLite workspace.
        await stopBackend();
        finalizeStaging({ workspace, staging, sourceFingerprint });
        await startBackend(backendPort);
        activeAccountWorkspaceWasNew = false;
        return migrationStatus({ userData: app.getPath("userData"), workspace, workspaceWasNew: false });
      } catch (error) {
        await stopBackend();
        backendWorkspacePath = workspace;
        await startBackend(backendPort);
        throw error;
      }
    });
    ipcMain.handle("account:deactivate", async () => { await stopBackend(); activeAccountId = null; activeAccountWorkspaceWasNew = false; return true; });
    configureSession();
    try {
      backendWorkspacePath = path.join(app.getPath("userData"), "bootstrap");
      await startBackend();
      createWindow();
      process.argv.forEach(deliverAuthCallback);
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

module.exports = { applicationPaths, findAvailablePort, isTrustedUrl, registerProtocolClient, getAuthStorageEntry, setAuthStorageEntry, removeAuthStorageEntry, clearAuthStorage };
