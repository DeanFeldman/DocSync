"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("docSync", Object.freeze({
  getThemePreference: () => ipcRenderer.sendSync("theme:get-preference"),
  setThemePreference: (preference) => ipcRenderer.send("theme:set-preference", preference),
  getSessionToken: () => ipcRenderer.invoke("session:get-token"),
  saveOutputs: (outputs) => ipcRenderer.invoke("files:save-outputs", outputs),
  openOAuth: (url) => ipcRenderer.invoke("auth:open-oauth", url),
  getAuthCallback: () => ipcRenderer.invoke("auth:callback"),
  onAuthCallback: (listener) => { const handler = (_event, code) => listener(code); ipcRenderer.on("auth:callback", handler); return () => ipcRenderer.removeListener("auth:callback", handler); },
  authStorage: Object.freeze({ get: (key) => ipcRenderer.invoke("auth-storage:get", key), set: (key, value) => ipcRenderer.invoke("auth-storage:set", key, value), remove: (key) => ipcRenderer.invoke("auth-storage:remove", key), clear: () => ipcRenderer.invoke("auth-storage:clear") }),
  activateAccount: (userId) => ipcRenderer.invoke("account:activate", userId), deactivateAccount: () => ipcRenderer.invoke("account:deactivate"),
}));
