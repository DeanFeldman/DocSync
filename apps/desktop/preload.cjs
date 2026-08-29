"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("docSync", Object.freeze({
  getThemePreference: () => ipcRenderer.sendSync("theme:get-preference"),
  setThemePreference: (preference) => ipcRenderer.send("theme:set-preference", preference),
  getSessionToken: () => ipcRenderer.invoke("session:get-token"),
  saveOutputs: (outputs) => ipcRenderer.invoke("files:save-outputs", outputs),
}));
