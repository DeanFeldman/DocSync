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
  authStorage: Object.freeze({ get: () => ipcRenderer.invoke("auth-storage:get"), set: (value) => ipcRenderer.invoke("auth-storage:set", value), remove: () => ipcRenderer.invoke("auth-storage:remove") }),
}));
