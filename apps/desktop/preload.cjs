"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("docSync", Object.freeze({
  getThemePreference: () => ipcRenderer.sendSync("theme:get-preference"),
  setThemePreference: (preference) => ipcRenderer.send("theme:set-preference", preference),
  getSessionToken: () => ipcRenderer.invoke("session:get-token"),
  saveOutputs: (outputs) => ipcRenderer.invoke("files:save-outputs", outputs),
  localData: Object.freeze({
    listWorkspaces: () => ipcRenderer.invoke("device-data:list"),
    openWorkspace: (id) => ipcRenderer.invoke("device-data:open", id),
    finishImport: (id) => ipcRenderer.invoke("device-data:import", id),
    discardImport: (id) => ipcRenderer.invoke("device-data:discard", id),
  }),
}));
