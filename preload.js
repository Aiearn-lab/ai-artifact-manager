'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  appInfo: () => ipcRenderer.invoke('app:info'),

  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickSave: (options) => ipcRenderer.invoke('dialog:pickSave', options),
  listDisks: () => ipcRenderer.invoke('disks:list'),
  appPaths: () => ipcRenderer.invoke('app:paths'),

  configGet: () => ipcRenderer.invoke('config:get'),
  configPatch: (patch) => ipcRenderer.invoke('config:patch', patch),

  scan: (payload) => ipcRenderer.invoke('scan:start', payload),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  lastScan: () => ipcRenderer.invoke('scan:last'),

  preview: (filePath) => ipcRenderer.invoke('file:preview', filePath),
  openFile: (filePath) => ipcRenderer.invoke('file:open', filePath),
  reveal: (filePath) => ipcRenderer.invoke('file:reveal', filePath),

  archive: (payload) => ipcRenderer.invoke('archive:run', payload),
  removeDuplicates: (payload) => ipcRenderer.invoke('duplicate:remove', payload),
  cleanupTrash: (payload) => ipcRenderer.invoke('cleanup:trash', payload),
  exportRun: (payload) => ipcRenderer.invoke('export:run', payload),
  renameFile: (payload) => ipcRenderer.invoke('file:rename', payload),
  openTrash: () => ipcRenderer.invoke('trash:open'),
  trashList: () => ipcRenderer.invoke('trash:list'),
  trashRestore: (payload) => ipcRenderer.invoke('trash:restore', payload),

  aiDetectLocal: () => ipcRenderer.invoke('ai:detectLocal'),
  aiSave: (cfg) => ipcRenderer.invoke('ai:save', cfg),
  aiTest: (cfg) => ipcRenderer.invoke('ai:test', cfg),
  aiSummarize: (payload) => ipcRenderer.invoke('ai:summarize', payload),
  aiRename: (payload) => ipcRenderer.invoke('ai:rename', payload),
  aiTags: (payload) => ipcRenderer.invoke('ai:tags', payload),
  aiCategory: (payload) => ipcRenderer.invoke('ai:category', payload),
  aiCompare: (payload) => ipcRenderer.invoke('ai:compare', payload),
  aiApplyCategory: (payload) => ipcRenderer.invoke('ai:applyCategory', payload),
  aiApplyTags: (payload) => ipcRenderer.invoke('ai:applyTags', payload),

  mcpInfo: () => ipcRenderer.invoke('mcp:info'),
  mcpStart: () => ipcRenderer.invoke('mcp:start'),
  mcpStop: () => ipcRenderer.invoke('mcp:stop'),
  mcpConfig: () => ipcRenderer.invoke('mcp:config'),

  ctxStatus: () => ipcRenderer.invoke('contextmenu:status'),
  ctxInstall: () => ipcRenderer.invoke('contextmenu:install'),
  ctxUninstall: () => ipcRenderer.invoke('contextmenu:uninstall'),

  openUrl: (url) => ipcRenderer.invoke('shell:openUrl', url),

  onProgress: (cb) => {
    ipcRenderer.on('scan:progress', (event, data) => cb(data));
  },
  onAutoScan: (cb) => {
    ipcRenderer.on('app:autoScan', (event, dir) => cb(dir));
  }
});
