const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gssLab", {
  ping: (host) => ipcRenderer.invoke("gss:ping", host),
  startLocalServer: (payload) => ipcRenderer.invoke("gss:server-start", payload),
  stopLocalServer: () => ipcRenderer.invoke("gss:server-stop"),
  updateDeviceStatus: (id, status) => ipcRenderer.invoke("gss:update-device-status", id, status),
  loadInfrastructure: () => ipcRenderer.invoke("gss:infrastructure-load"),
  saveInfrastructure: (payload) => ipcRenderer.invoke("gss:infrastructure-save", payload),
  cloudStatus: () => ipcRenderer.invoke("gss:cloud-status"),
  configureCloud: (apiKey) => ipcRenderer.invoke("gss:cloud-configure", apiKey),
  onTraffic: (callback) => ipcRenderer.on("gss:traffic", (_event, packet) => callback(packet)),
  onCloudStatus: (callback) => ipcRenderer.on("gss:cloud-status", (_event, status) => callback(status)),
});
