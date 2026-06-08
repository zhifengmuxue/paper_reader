const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  openPdfDialog: () => ipcRenderer.invoke("dialog:openPdf"),
  loadPdf: (filePath) => ipcRenderer.invoke("pdf:load", filePath),
  loadPdfBinary: (filePath) => ipcRenderer.invoke("pdf:binary", filePath),
  translateDocument: (request) => ipcRenderer.invoke("translation:start", request),
  getTranslationCacheInfo: (document) => ipcRenderer.invoke("translation:cacheInfo", document),
  loadCachedTranslation: (document) => ipcRenderer.invoke("translation:loadCached", document),
  onTranslationProgress: (listener) => {
    const wrapped = (_event, progress) => listener(progress);
    ipcRenderer.on("translation:progress", wrapped);
    return () => {
      ipcRenderer.removeListener("translation:progress", wrapped);
    };
  },
  listSkills: () => ipcRenderer.invoke("skills:list"),
  importSkills: () => ipcRenderer.invoke("skills:import"),
  openSkillsFolder: () => ipcRenderer.invoke("skills:openDirectory"),
  sendChat: (request) => ipcRenderer.invoke("chat:send", request)
};

contextBridge.exposeInMainWorld("paperReaderApi", api);
