import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopAPI, AppState } from "../src/shared/types";

const api: DesktopAPI = {
  getWatchStatistics: () => ipcRenderer.invoke("app:watch-statistics"),
  correctWatchLibrary: (input) => ipcRenderer.invoke("app:watch-statistics-correct-library", input),
  refreshWatchStatistics: () => ipcRenderer.invoke("app:watch-statistics-refresh"),
  getWatchStatisticsStatus: () => ipcRenderer.invoke("app:watch-statistics-status"),
  getWatchStatisticsPathStatus: () => ipcRenderer.invoke("app:watch-statistics-path-status"),
  chooseWatchStatisticsPath: () => ipcRenderer.invoke("app:watch-statistics-path-choose"),
  autoDiscoverWatchStatisticsPath: () => ipcRenderer.invoke("app:watch-statistics-path-discover"),
  clearWatchStatisticsPath: () => ipcRenderer.invoke("app:watch-statistics-path-clear"),
  saveWatchStatisticsSettings: (settings) =>
    ipcRenderer.invoke("app:watch-statistics-settings", settings),
  previewWatchStatisticsImport: () => ipcRenderer.invoke("app:watch-statistics-import-preview"),
  importWatchStatistics: (mode) => ipcRenderer.invoke("app:watch-statistics-import", mode),
  exportWatchStatistics: () => ipcRenderer.invoke("app:watch-statistics-export"),
  onWatchStatisticsUpdated: (callback) => {
    const listener = (
      _event: unknown,
      snapshot: import("../src/shared/watch-statistics").WatchStatisticsSnapshot,
    ) => callback(snapshot);
    ipcRenderer.on("app:watch-statistics-updated", listener);
    return () => ipcRenderer.removeListener("app:watch-statistics-updated", listener);
  },
  onWatchStatisticsStatus: (callback) => {
    const listener = (
      _event: unknown,
      status: { playing: boolean; syncing: boolean; error?: string },
    ) => callback(status);
    ipcRenderer.on("app:watch-statistics-status", listener);
    return () => ipcRenderer.removeListener("app:watch-statistics-status", listener);
  },
  getState: () => ipcRenderer.invoke("app:state"),
  saveServer: (server) => ipcRenderer.invoke("app:save-server", server),
  getServerCredentials: (id) => ipcRenderer.invoke("app:server-credentials", id),
  testServerConnection: (server) => ipcRenderer.invoke("app:test-server-connection", server),
  removeServer: (id) => ipcRenderer.invoke("app:remove-server", id),
  openServer: (id) => ipcRenderer.invoke("app:open-server", id),
  showPage: (page, section) => ipcRenderer.invoke("app:page", { page, section }),
  togglePlaybackPopup: (anchor) => ipcRenderer.invoke("app:playback-popup", anchor),
  hidePlaybackPopup: () => ipcRenderer.invoke("app:playback-popup", null),
  toggleServerPopup: (anchor) => ipcRenderer.invoke("app:server-popup", anchor),
  hideServerPopup: () => ipcRenderer.invoke("app:server-popup", null),
  addServer: () => ipcRenderer.invoke("app:add-server"),
  openPlaybackItem: () => ipcRenderer.invoke("app:playback-item"),
  showError: (visible) => ipcRenderer.invoke("app:error-visible", visible),
  discoverPlayers: () => ipcRenderer.invoke("app:discover-players"),
  choosePlayer: (kind) => ipcRenderer.invoke("app:choose-player", kind),
  removePlayer: (id) => ipcRenderer.invoke("app:remove-player", id),
  choosePlayerExecutable: () => ipcRenderer.invoke("app:choose-player-executable"),
  chooseStartupVideo: () => ipcRenderer.invoke("app:choose-startup-video"),
  setStartupVideo: (path) => ipcRenderer.invoke("app:set-startup-video", path),
  startupVideoPath: (file) => webUtils.getPathForFile(file),
  clearStartupVideo: () => ipcRenderer.invoke("app:clear-startup-video"),
  getStartupVideo: () => ipcRenderer.invoke("app:get-startup-video"),
  finishStartupVideo: () => ipcRenderer.invoke("app:startup-video-done"),
  restartApp: () => ipcRenderer.invoke("app:restart"),
  saveCustomPlayer: (player) => ipcRenderer.invoke("app:save-custom-player", player),
  updateSettings: (settings) => ipcRenderer.invoke("app:settings", settings),
  control: (control) => ipcRenderer.invoke("app:control", control),
  surfaceReady: (surface) => ipcRenderer.invoke("app:surface-ready", surface),
  navigate: (action) => ipcRenderer.invoke("app:navigate", action),
  resetSession: (id) => ipcRenderer.invoke("app:reset-session", id),
  openGuide: (kind) => ipcRenderer.invoke("app:guide", kind),
  exportDiagnostics: () => ipcRenderer.invoke("app:diagnostics"),
  getDiagnostics: () => ipcRenderer.invoke("app:get-diagnostics"),
  openDirectory: (target) => ipcRenderer.invoke("app:open-directory", target),
  copyDiagnostics: () => ipcRenderer.invoke("app:copy-diagnostics"),
  openLink: (target) => ipcRenderer.invoke("app:open-link", target),
  checkForUpdates: () => ipcRenderer.invoke("app:check-updates"),
  installUpdate: () => ipcRenderer.invoke("app:install-update"),
  openReleases: () => ipcRenderer.invoke("app:open-releases"),
  onState: (callback) => {
    const listener = (_event: unknown, state: AppState) => callback(state);
    ipcRenderer.on("app:state", listener);
    return () => ipcRenderer.removeListener("app:state", listener);
  },
  onAddServer: (callback) => {
    ipcRenderer.on("app:add-server", callback);
    return () => ipcRenderer.removeListener("app:add-server", callback);
  },
};
contextBridge.exposeInMainWorld("desktop", api);
