'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  state: () => ipcRenderer.invoke('app-state'),
  readResult: name => ipcRenderer.invoke('read-result', name),
  collect: input => ipcRenderer.invoke('collect', input),
  mcp: request => ipcRenderer.invoke('mcp', request),
  automation: request => ipcRenderer.invoke('automation', request),
  feature: packet => ipcRenderer.invoke('feature', packet),
  openExport: file => ipcRenderer.invoke('open-export', file),
  openTarget: target => ipcRenderer.invoke('open-target', target),
  automationLog: id => ipcRenderer.invoke('automation-log', id),
  openFolder: which => ipcRenderer.invoke('open-folder', which),
  openJSON: () => ipcRenderer.invoke('open-json'),
  onLog: callback => { ipcRenderer.on('collector-log', (_, value) => callback(value)); },
  onStatus: callback => { ipcRenderer.on('collector-status', (_, value) => callback(value)); },
  onResult: callback => { ipcRenderer.on('collector-result', (_, value) => callback(value)); },
  onError: callback => { ipcRenderer.on('collector-error', (_, value) => callback(value)); }
});
