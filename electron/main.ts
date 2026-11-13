import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  dialog,
  shell,
  nativeTheme,
  Menu,
  screen,
  safeStorage,
  clipboard,
  Tray,
  nativeImage,
  Notification,
  protocol,
  net,
  type IpcMainInvokeEvent,
} from "electron";
import { join, extname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { release } from "node:os";
import {
  writeFile,
  access,
  mkdir,
  copyFile,
  rename,
  unlink,
  stat,
  readdir,
} from "node:fs/promises";
import { constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  browserUserAgent,
  browserDeviceName,
  browserFetcher,
  guardServerAccess,
} from "./core/browser-http";
import { isLiveWindow, sendWindowState } from "./core/window-lifecycle";
import { SingleInstance } from "./core/single-instance";
import { z } from "zod";
import { SettingsStore, customPlayerInputSchema, normalizeWebServiceUrl } from "./core/settings";
import {
  visualThemeIds,
  visualThemes,
  resolveVisualTheme,
  visualBackgroundIds,
} from "../src/shared/visual-themes";
import {
  WindowStateStore,
  defaultWindowSize,
  minimumWindowSize,
  fitWindowBounds,
} from "./core/window-state";
import {
  customPlayerExecutable,
  discoverPlayers,
  manualPlayer,
  playerGuides,
} from "./core/players";
import { PlaybackManager } from "./core/playback-manager";
import { ProviderRegistry } from "./providers/registry";
import { embyProvider } from "./providers/emby";
import { jellyfinProvider } from "./providers/jellyfin";
import { plexProvider } from "./providers/plex";
import type { PlaybackClient } from "./providers/types";
import {
  translate,
  localizeError,
  resolveLocale,
  UserFacingError,
  errorToken,
  type MessageKey,
} from "../src/shared/i18n";
import { MediaProxy } from "./core/media-proxy";
import type { AppState, AppPage, SettingsPage, Platform, Server } from "../src/shared/types";
import { showProductLinks } from "../src/shared/product-links";
import { redact } from "./core/redact";
import { CredentialStore, credentialsSchema, credentialOriginMatches } from "./core/credentials";
import { loadFavicon } from "./core/favicon";
import { diagnosticSnapshot, productLink } from "./core/diagnostics";
import { applicationDirectories, openApplicationDirectory } from "./core/app-directories";
import { UserDataLocation } from "./core/user-data-location";
import { AppLifecycle } from "./core/app-lifecycle";
import { UpdateManager, hasMacUpdateSignature, updateDisabledReason } from "./core/updates";
import { autoUpdater } from "electron-updater";
import { WatchStatisticsStore } from "./core/watch-statistics";
import { WatchStatisticsPathLocator } from "./core/watch-statistics-path";
import type {
  WatchStatisticsSettings,
  WatchStatisticsSnapshot,
} from "../src/shared/watch-statistics";

protocol.registerSchemesAsPrivileged([
  { scheme: "freebo-startup", privileges: { standard: true, secure: true, stream: true } },
]);

app.setName("Lllllvlv");
const isolatedUserData = !app.isPackaged && !!process.env.FREEBO_USER_DATA_DIR;
const userDataLocation = new UserDataLocation(
  app.getPath("appData"),
  join(app.getPath("appData"), "Freebo"),
);
let userDataPath: string;
try {
  userDataPath = isolatedUserData
    ? process.env.FREEBO_USER_DATA_DIR!
    : process.platform === "win32"
      ? userDataLocation.resolve()
      : join(app.getPath("appData"), "Freebo");
} catch (error) {
  dialog.showErrorBox("Lllllvlv 数据目录不可访问", String(error));
  process.exit(1);
}
mkdirSync(userDataPath, { recursive: true });
app.setPath("userData", userDataPath);
const instance = new SingleInstance(app, showMainWindow);
if (!instance.primary) app.quit();
const store = new SettingsStore(join(userDataPath, "settings.json"), (event) => {
  if (event.type === "reset") log(t("settingsReset"));
  else
    log(
      t(event.type === "read-failed" ? "settingsReadFailed" : "settingsResetFailed", {
        reason: event.reason,
      }),
    );
});
const windowStateStore = new WindowStateStore(join(userDataPath, "window-state.json"));
const watchPathLocator = new WatchStatisticsPathLocator(userDataPath);
const watchStatistics = new WatchStatisticsStore(userDataPath, watchPathLocator);
let watchRefresh: Promise<unknown> | undefined;
let watchRefreshMode: "full" | "incremental" | "import" | undefined;
let watchQueuedFull: Promise<WatchStatisticsSnapshot> | undefined;
let watchAuth:
  | { serverId: string; auth: { baseUrl: string; userId: string; token: string } }
  | undefined;
let watchImportPath: string | undefined;
const pendingWatchUserId = "00000000000000000000000000000000";
let watchPlaying = false;
let watchStoppedAt = 0;
let watchLastCheck = 0;
let watchLastFallback = 0;
let watchError: string | undefined;
let watchBinding: Promise<void> | undefined;
function watchStatus() {
  return { playing: watchPlaying, syncing: !!watchRefresh || !!watchQueuedFull, error: watchError };
}
function publishWatchStatus() {
  if (isLiveWindow(window)) window.webContents.send("app:watch-statistics-status", watchStatus());
}
const watchUserPath = join(userDataPath, "watch-statistics", "current-user.json");
function selectedWatchServer() {
  const selected = store.value.servers.find(
    (item) => item.id === store.value.activeServerId && item.providerId === "jellyfin",
  );
  return selected ?? store.value.servers.find(
    (item) => item.id === watchAuth?.serverId && item.providerId === "jellyfin",
  ) ?? store.value.servers.find((item) => item.providerId === "jellyfin");
}
function watchServer() {
  const server = selectedWatchServer();
  if (!server) throw new Error("请先选择 Jellyfin 服务");
  return server;
}
async function rememberWatchUser(serverId: string, userId: string) {
  await mkdir(join(userDataPath, "watch-statistics"), { recursive: true });
  await writeFile(watchUserPath, JSON.stringify({ serverId, userId }));
}
async function watchUserId(serverId: string) {
  if (watchAuth?.serverId === serverId) return watchAuth.auth.userId;
  try {
    const remembered = JSON.parse(
      await (await import("node:fs/promises")).readFile(watchUserPath, "utf8"),
    );
    if (
      remembered.serverId === serverId &&
      typeof remembered.userId === "string" &&
      /^[0-9a-f]{32}$/i.test(remembered.userId.replace(/-/g, ""))
    )
      return remembered.userId;
  } catch {
    /* Existing snapshots predate the current-user hint. */
  }
  try {
    const files = (await readdir(join(userDataPath, "watch-statistics"))).filter(
      (name) =>
        name.startsWith(`${serverId}-`) &&
        /^[0-9a-f]{32}\.json$/i.test(name.slice(serverId.length + 1)),
    );
    if (files.length === 1) {
      const userId = files[0].slice(serverId.length + 1, -5);
      if (/^[0-9a-f]{32}$/i.test(userId)) return userId;
    }
  } catch {
    /* No local statistics yet. */
  }
  return undefined;
}
async function watchIdentity() {
  const server = watchServer();
  let auth: { baseUrl: string; userId: string; token: string } | undefined;
  const watchView = serverViews.get(server.id)?.view;
  if (watchView && !watchView.webContents.isDestroyed()) {
    try {
      auth = await watchView.webContents.executeJavaScript(
        `(() => { const api = window.ApiClient; return api && {baseUrl:api.serverAddress?.(),userId:api.getCurrentUserId?.(),token:api.accessToken?.()}; })()`,
      );
    } catch {
      /* Jellyfin may still be loading. */
    }
  }
  if (!auth?.baseUrl || !auth?.userId || !auth?.token)
    auth = watchAuth?.serverId === server.id ? watchAuth.auth : undefined;
  if (
    !auth?.baseUrl ||
    !auth?.userId ||
    !auth?.token ||
    new URL(auth.baseUrl).origin !== new URL(server.url).origin
  )
    throw new Error("请先在「服务」中登录 Jellyfin");
  if (!/^[0-9a-f]{32}$/i.test(auth.userId.replace(/-/g, "")))
    throw new Error("Jellyfin 用户 ID 无效");
  const previousWatchServerId = watchAuth?.serverId;
  watchAuth = { serverId: server.id, auth };
  if (previousWatchServerId !== server.id) publish();
  void rememberWatchUser(server.id, auth.userId).catch((error) => log(String(error)));
  if (!watchBinding) {
    watchBinding = watchStatistics
      .bindImported(server.id, pendingWatchUserId, auth.userId)
      .then(async (snapshot) => {
        if (snapshot) await publishWatch(snapshot, auth.userId);
      })
      .finally(() => {
        watchBinding = undefined;
      });
  }
  await watchBinding;
  return { server, auth };
}
async function publishWatch(snapshot: WatchStatisticsSnapshot, userId: string) {
  if (!isLiveWindow(window)) return;
  try {
    const view = await watchStatistics.getView(snapshot.serverId, userId);
    if (view && isLiveWindow(window)) window.webContents.send("app:watch-statistics-updated", view);
  } catch (error) {
    log(`观影统计更新事件失败：${String(error)}`);
  }
}
async function syncWatch(mode: "full" | "incremental"): Promise<WatchStatisticsSnapshot> {
  if (watchRefresh) {
    if (watchRefreshMode === "import") {
      await watchRefresh.catch(() => {});
      return syncWatch(mode);
    }
    if (mode === "incremental") return watchRefresh as Promise<WatchStatisticsSnapshot>;
    if (watchRefreshMode === "full") return watchRefresh as Promise<WatchStatisticsSnapshot>;
    if (!watchQueuedFull) {
      watchQueuedFull = watchRefresh.catch(() => {}).then(() => syncWatch("full"));
      void watchQueuedFull
        .finally(() => {
          watchQueuedFull = undefined;
        })
        .catch(() => {});
    }
    return watchQueuedFull;
  }
  const task = (async () => {
    const { server, auth } = await watchIdentity();
    const previous = await watchStatistics.get(server.id, auth.userId);
    const result = await watchStatistics.refresh(
      server.id,
      auth,
      browserFetcher(session.fromPartition(servicePartition(server)), server.url) as typeof fetch,
      mode,
    );
    if (
      !previous ||
      JSON.stringify([previous.records, previous.media, previous.backfill, previous.libraries]) !==
        JSON.stringify([result.records, result.media, result.backfill, result.libraries])
    )
      await publishWatch(result, auth.userId);
    return result;
  })();
  watchRefresh = task;
  watchRefreshMode = mode;
  watchError = undefined;
  publishWatchStatus();
  try {
    return await task;
  } catch (error) {
    watchError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (watchRefresh === task) {
      watchRefresh = undefined;
      watchRefreshMode = undefined;
      publishWatchStatus();
    }
  }
}
async function watchTick() {
  if (lifecycle.isQuitting || !store.value.setupCompleted) return;
  let server: Server;
  try {
    server = watchServer();
  } catch {
    return;
  }
  const now = Date.now();
  const statisticsOpen = page === "settings" && settingsPage === "statistics";
  if (now - watchLastCheck < (statisticsOpen ? 60_000 : 120_000)) return;
  watchLastCheck = now;
  let active = false;
  try {
    const { auth } = await watchIdentity();
    const fetcher = browserFetcher(
      session.fromPartition(servicePartition(server)),
      server.url,
    ) as typeof fetch;
    const response = await fetcher(`${auth.baseUrl.replace(/\/$/, "")}/Sessions`, {
      headers: { "X-Emby-Token": auth.token },
    });
    if (response.ok) {
      const sessions = (await response.json()) as { UserId?: string; NowPlayingItem?: unknown }[];
      active = sessions.some(
        (item) =>
          item.UserId?.replace(/-/g, "").toLowerCase() ===
            auth.userId.replace(/-/g, "").toLowerCase() && !!item.NowPlayingItem,
      );
    }
  } catch {
    /* The incremental fallback also covers unavailable session data. */
  }
  if (active) {
    watchPlaying = true;
    publishWatchStatus();
    if (statisticsOpen) void syncWatch("incremental").catch((error) => log(String(error)));
  } else if (watchPlaying) {
    watchPlaying = false;
    publishWatchStatus();
    watchStoppedAt = now;
    setTimeout(() => {
      if (!watchPlaying && watchStoppedAt === now) {
        watchStoppedAt = 0;
        void syncWatch("incremental").catch((error) => log(String(error)));
      }
    }, 30_000).unref();
  }
  if (watchStoppedAt && now - watchStoppedAt >= 30_000) {
    watchStoppedAt = 0;
    void syncWatch("incremental").catch((error) => log(String(error)));
  } else if (now - watchLastFallback >= (statisticsOpen ? 60_000 : 300_000)) {
    watchLastFallback = now;
    void syncWatch("incremental").catch((error) => log(String(error)));
  }
}
const startupVideoDirectory = join(userDataPath, "startup-video");
let startupVideoAvailable = true;
let startupVideoFullscreen = false;
let startupVideoMutation: Promise<unknown> = Promise.resolve();
function mutateStartupVideo<T>(action: () => Promise<T>): Promise<T> {
  const result = startupVideoMutation.then(action, action);
  startupVideoMutation = result.catch(() => {});
  return result;
}
function startupVideoPath() {
  const name = store.value.startupVideoFile;
  return name ? join(startupVideoDirectory, name) : undefined;
}
async function setStartupVideo(source: string) {
  const extension = extname(source).toLowerCase();
  if (extension !== ".mp4" && extension !== ".webm") throw new UserFacingError("invalidInput");
  if (!(await stat(source)).isFile()) throw new UserFacingError("invalidInput");
  await mkdir(startupVideoDirectory, { recursive: true });
  const targetName = `${randomUUID()}${extension}`;
  const target = join(startupVideoDirectory, targetName);
  const temporary = join(startupVideoDirectory, `${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    const previous = startupVideoPath();
    const previousName = store.value.startupVideoName;
    const previousFile = store.value.startupVideoFile;
    await rename(temporary, target);
    try {
      await store.save({
        ...store.value,
        startupVideoFile: targetName,
        startupVideoName: basename(source),
      });
    } catch (error) {
      if (store.value.startupVideoFile === targetName) {
        store.value.startupVideoFile = previousFile;
        store.value.startupVideoName = previousName;
      }
      await unlink(target).catch(() => {});
      throw error;
    }
    if (previous && previous !== target) await unlink(previous).catch(() => {});
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
const credentials = new CredentialStore(join(userDataPath, "credentials.json"), {
  available: async () => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
    // Linux's basic fallback uses a hardcoded key rather than a system secret store.
    return (
      process.platform !== "linux" ||
      (safeStorage.isEncryptionAvailable() &&
        safeStorage.getSelectedStorageBackend() !== "basic_text")
    );
  },
  encrypt: (value) => safeStorage.encryptStringAsync(value),
  decrypt: async (value) => (await safeStorage.decryptStringAsync(value)).result,
});
let credentialsAvailable = false;
const windowIcon = join(
  __dirname,
  process.env.FREEBO_DEV_URL ? "../public/icon.png" : "../dist/icon.png",
);
const providers = new ProviderRegistry([embyProvider, jellyfinProvider, plexProvider]);
const servicePartition = (server: Server) =>
  server.providerId === "web" ? `persist:web-${server.id}` : providers.partition(server);
const playback = new PlaybackManager();
function locale() {
  return resolveLocale(store.value.language, app.getLocale());
}
function t(key: MessageKey, params?: Record<string, string | number>) {
  return translate(locale(), key, params);
}
const proxy = new MediaProxy((message) => log(message));
let window: BrowserWindow;
function finishStartupVideo() {
  if (!startupVideoFullscreen || !window || window.isDestroyed()) return;
  startupVideoFullscreen = false;
  if (window.isFullScreen()) {
    window.once("leave-full-screen", () => {
      if (!window.isDestroyed()) window.maximize();
    });
    window.setFullScreen(false);
  } else window.maximize();
}
type ServerViewState = {
  server: Server;
  view: WebContentsView;
  webStatus: AppState["webStatus"];
  webError?: string;
  adapterStatus?: AppState["adapterStatus"];
  bootstrapRetries: number;
};
const serverViews = new Map<string, ServerViewState>();
let activeView: ServerViewState | undefined;
let shown = false;
let page: AppPage = "home";
let settingsPage: SettingsPage = "servers";
let playbackPopup: BrowserWindow | undefined;
let serverPopup: BrowserWindow | undefined;
type PopupAnchor = { x: number; y: number; width: number; height: number };
let serverPopupAnchor: PopupAnchor | undefined;
let serverPopupLoading: Promise<void> | undefined;
let playbackPopupLoading: Promise<void> | undefined;
let mainWindowClosing = false;
let tray: Tray | undefined;
let updates: UpdateManager | undefined;
let updateTimer: ReturnType<typeof setInterval> | undefined;
const lifecycle = new AppLifecycle(async () => {
  clearInterval(updateTimer);
  try {
    await playback.flush();
  } catch (error) {
    log(`Playback shutdown failed: ${String(error)}`);
  }
  try {
    await proxy.close();
  } catch (error) {
    log(`Media proxy shutdown failed: ${String(error)}`);
  }
});
const popupReadiness = new Map<number, { promise: Promise<void>; resolve(): void }>();
function waitForPopupRenderer(panel: BrowserWindow): Promise<void> {
  const id = panel.webContents.id;
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  popupReadiness.set(id, { promise, resolve });
  panel.once("closed", () => {
    popupReadiness.get(id)?.resolve();
    popupReadiness.delete(id);
  });
  return promise;
}
let serverPopupBlurTimer: ReturnType<typeof setTimeout> | undefined;
let playbackServer: Server | undefined;
let playbackClient: PlaybackClient | undefined;
let popupAnchor: { x: number; y: number; width: number; height: number } | undefined;
let popupBlurTimer: ReturnType<typeof setTimeout> | undefined;
let errorVisible = false;
function viewForSender(sender: Electron.WebContents) {
  return [...serverViews.values()].find((entry) => entry.view.webContents === sender);
}
function isRegistered(entry: ServerViewState) {
  return serverViews.get(entry.server.id) === entry && !entry.view.webContents.isDestroyed();
}
function publishView(entry: ServerViewState) {
  if (activeView === entry) {
    layout();
    publish();
  }
}
const serverFavicons = new Map<string, { url: string; icon: string }>();
const diagnostics: { time: string; message: string }[] = [];
function log(message: string) {
  diagnostics.push({ time: new Date().toISOString(), message: redact(message) });
  if (diagnostics.length > 200) diagnostics.shift();
}
function getDiagnostics() {
  return diagnosticSnapshot(
    state(),
    {
      arch: process.arch,
      osRelease: release(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    },
    diagnostics,
  );
}
let stateRevision = 0;
function state(): AppState {
  const contents = activeView && isRegistered(activeView) ? activeView.view.webContents : undefined;
  return {
    revision: ++stateRevision,
    settings: store.value,
    playback: playback.state,
    platform: process.platform as Platform,
    version: app.getVersion(),
    updates: updates?.state ?? { status: "disabled", reason: "fork-disabled" },
    webStatus: activeView?.webStatus ?? "closed",
    webError: activeView?.webError,
    credentialsAvailable,
    serverFavicons: Object.fromEntries(
      store.value.servers.flatMap((server) => {
        const saved = serverFavicons.get(server.id);
        return saved?.url === server.url ? [[server.id, saved.icon]] : [];
      }),
    ),
    adapterStatus: activeView?.adapterStatus,
    watchStatisticsServerId: selectedWatchServer()?.id,
    locale: locale(),
    providers: [
      ...providers.list(),
      { id: "web", name: translate(locale(), "webService"), supportsCredentials: false },
    ],
    page,
    settingsPage,
    playbackPopupOpen: isLiveWindow(playbackPopup) && playbackPopup.isVisible(),
    serverPopupOpen: isLiveWindow(serverPopup) && serverPopup.isVisible(),
    playbackSource:
      playbackServer && playback.state.queue[playback.state.index]
        ? { serverId: playbackServer.id, itemId: playback.state.queue[playback.state.index].id }
        : undefined,
    browser: {
      url: contents?.getURL() ?? "",
      serverId: activeView?.server.id,
      openServerIds: [...serverViews.keys()],
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
    },
    fullscreen: window && !window.isDestroyed() ? window.isFullScreen() : false,
  };
}
function publish() {
  if (mainWindowClosing || !isLiveWindow(window)) return;
  const snapshot = state();
  for (const target of [window, playbackPopup, serverPopup]) sendWindowState(target, snapshot);
}
function layout() {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  const top = 88 + (activeView?.webError || errorVisible ? 64 : 0);
  activeView?.view.setBounds({
    x: 0,
    y: shown ? top : height,
    width,
    height: Math.max(0, height - top),
  });
}
function own(event: IpcMainInvokeEvent) {
  const contents = [window, playbackPopup, serverPopup].find(
    (target) => isLiveWindow(target) && event.sender === target.webContents,
  )?.webContents;
  if (!contents || event.senderFrame !== contents.mainFrame)
    throw new UserFacingError("invalidOrigin");
}
const idSchema = z.string().min(1).max(200);
const kindSchema = z.enum([
  "iina",
  "mpv",
  "mpvnet",
  "vlc",
  "potplayer",
  "mpc-hc",
  "mpc-be",
  "cine",
]);
const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["pause", "next", "previous", "stop"]) }),
  z.object({ action: z.literal("seek"), seconds: z.number().finite().min(0) }),
  z.object({ action: z.literal("jump"), index: z.number().int().min(0) }),
]);
let scanning: Promise<void> | undefined;
async function scan() {
  if (scanning) return scanning;
  scanning = performScan().finally(() => {
    scanning = undefined;
  });
  return scanning;
}
async function performScan() {
  const players = await discoverPlayers(process.platform as Platform, store.value.players);
  const defaultPlayerId = players.some((p) => p.id === store.value.defaultPlayerId)
    ? store.value.defaultPlayerId
    : players[0]?.id;
  await store.save({ ...store.value, players, defaultPlayerId, playerScanCompleted: true });
  publish();
}
function closeServerView(id: string) {
  const entry = serverViews.get(id);
  if (!entry) return;
  serverViews.delete(id);
  const wasActive = activeView === entry;
  if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view);
  if (activeView === entry) {
    activeView = [...serverViews.values()].at(-1);
    if (activeView && window && !window.isDestroyed())
      window.contentView.addChildView(activeView.view);
    if (!activeView && page === "library") {
      shown = false;
      page = "home";
    }
  }
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  if (wasActive) layout();
  publish();
}
function closeAllServerViews() {
  for (const id of [...serverViews.keys()]) closeServerView(id);
}
function activateView(entry: ServerViewState) {
  if (activeView !== entry) {
    if (activeView && isRegistered(activeView))
      window.contentView.removeChildView(activeView.view);
    activeView = entry;
    window.contentView.addChildView(entry.view);
  }
  shown = true;
  page = "library";
  layout();
}
async function openServer(id: string, destination?: string) {
  hideServerPopup();
  const server = store.value.servers.find((s) => s.id === id);
  if (!server) throw new UserFacingError("serverMissing");
  let existing = serverViews.get(id);
  if (existing && (existing.server.url !== server.url || existing.server.providerId !== server.providerId)) {
    closeServerView(id);
    existing = undefined;
  }
  if (existing && isRegistered(existing)) {
    activateView(existing);
    if (destination)
      void existing.view.webContents.loadURL(destination).catch((error) => log(String(error)));
    await store.save({ ...store.value, activeServerId: id });
    publish();
    return;
  }
  const isWeb = server.providerId === "web";
  const provider = isWeb ? undefined : providers.get(server.providerId);
  const ses = session.fromPartition(servicePartition(server));
  // Emby treats Electron as its own desktop client and requests a missing native plugin.
  ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const view = new WebContentsView({
    webPreferences: {
      ...(provider ? { preload: join(__dirname, provider.preload) } : {}),
      partition: servicePartition(server),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const entry: ServerViewState = { server, view, webStatus: "loading", bootstrapRetries: 0 };
  serverViews.set(id, entry);
  const faviconFetcher = provider
    ? guardServerAccess(browserFetcher(ses, provider.entryUrl(server)))
    : undefined;
  let faviconRevision = 0;
  let faviconKey: string | undefined;
  view.webContents.on("page-favicon-updated", (_event, favicons) => {
    if (!isRegistered(entry)) return;
    const key = favicons.join("\n");
    if (key === faviconKey) return;
    faviconKey = key;
    const revision = ++faviconRevision;
    if (!faviconFetcher) return;
    void loadFavicon(favicons, faviconFetcher).then((icon) => {
      if (!isRegistered(entry) || revision !== faviconRevision) return;
      if (icon) serverFavicons.set(server.id, { url: server.url, icon });
      else if (!favicons.length) serverFavicons.delete(server.id);
      publish();
    });
  });
  view.webContents.on("console-message", (event) => {
    if (event.level === "error") {
      log(`Emby: ${event.message}`);
      if (process.env.FREEBO_DEV_URL) console.warn(redact(`Emby: ${event.message}`));
    }
  });
  const origin = new URL(server.url).origin;
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb) {
      if (/^https?:\/\//i.test(url))
        void view.webContents.loadURL(url).catch((error) => log(String(error)));
      return { action: "deny" };
    }
    if (url.startsWith("https://") && new URL(url).origin !== origin) void shell.openExternal(url);
    return { action: "deny" };
  });
  const guardNavigation = (event: { preventDefault(): void }, url: string) => {
    if (isWeb && /^https?:\/\//i.test(url)) return;
    if (!/^https?:\/\//i.test(url) || new URL(url).origin !== origin) {
      event.preventDefault();
      entry.webError = errorToken("externalNavigation");
      publishView(entry);
    }
  };
  view.webContents.on("will-navigate", guardNavigation);
  view.webContents.on("will-redirect", guardNavigation);
  view.webContents.on("dom-ready", () => {
    if (!isRegistered(entry)) return;
    if (entry.webStatus !== "error" && !view.webContents.getURL().startsWith("chrome-error:")) {
      publishView(entry);
    }
    if (provider?.adapterScript)
      void view.webContents
        .executeJavaScript(provider.adapterScript)
        .catch((error) => log(String(error)));
  });
  view.webContents.on("did-start-loading", () => {
    if (!isRegistered(entry)) return;
    entry.webStatus = "loading";
    publishView(entry);
  });
  view.webContents.on("did-stop-loading", () => {
    if (!isRegistered(entry) || entry.webStatus === "error") return;
    entry.webStatus = "ready";
    publishView(entry);
  });
  view.webContents.on("did-start-navigation", (event) => {
    if (!isRegistered(entry) || !event.isMainFrame || event.isSameDocument) return;
    faviconRevision++;
    faviconKey = undefined;
    entry.webStatus = "loading";
    entry.webError = undefined;
    entry.adapterStatus = undefined;
    publishView(entry);
  });
  view.webContents.on("did-finish-load", () => {
    if (
      !isRegistered(entry) ||
      entry.webStatus === "error" ||
      view.webContents.getURL().startsWith("chrome-error:")
    )
      return;
    entry.webError = undefined;
    publishView(entry);
    if (server.providerId === "jellyfin") {
      setTimeout(() => {
        if (!isRegistered(entry)) return;
        if (watchServer().id !== entry.server.id) return;
        void watchIdentity()
          .then(() => syncWatch("incremental"))
          .catch(() => {});
      }, 3000);
    }
  });
  view.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (!mainFrame || code === -3 || !isRegistered(entry)) return;
    entry.webStatus = "error";
    entry.webError = errorToken("webFailed", { code });
    publishView(entry);
  });
  view.webContents.on("did-navigate-in-page", () => publishView(entry));
  view.webContents.on("did-navigate", () => publishView(entry));
  view.webContents.on("render-process-gone", () => {
    if (!isRegistered(entry)) return;
    entry.webStatus = "error";
    entry.webError = errorToken("webFailed", { code: "renderer" });
    publishView(entry);
  });
  activateView(entry);
  await store.save({ ...store.value, activeServerId: id });
  publish();
  if (isRegistered(entry))
    void view.webContents
      .loadURL(destination ?? (provider ? provider.entryUrl(server) : server.url))
      .catch((error) => log(String(error)));
}

function hidePlaybackPopup() {
  clearTimeout(popupBlurTimer);
  if (isLiveWindow(playbackPopup)) playbackPopup.hide();
  publish();
}
function positionPlaybackPopup() {
  if (!isLiveWindow(playbackPopup) || !popupAnchor || !isLiveWindow(window)) return;
  const bounds = window.getContentBounds();
  const area = screen.getDisplayMatching(window.getBounds()).workArea;
  const width = Math.min(420, area.width - 24);
  const height = Math.min(640, Math.max(320, bounds.height - 104), area.height - 24);
  playbackPopup.setBounds({
    width,
    height,
    x: Math.max(
      area.x + 12,
      Math.min(
        bounds.x + popupAnchor.x + popupAnchor.width - width,
        area.x + area.width - width - 12,
      ),
    ),
    y: Math.max(
      area.y + 12,
      Math.min(
        bounds.y + popupAnchor.y + popupAnchor.height + 8,
        area.y + area.height - height - 12,
      ),
    ),
  });
}
async function togglePlaybackPopup(anchor: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  if (mainWindowClosing || !isLiveWindow(window)) return;
  hideServerPopup();
  clearTimeout(popupBlurTimer);
  if (playbackPopup?.isVisible()) {
    hidePlaybackPopup();
    return;
  }
  popupAnchor = anchor;
  if (!playbackPopup || playbackPopup.isDestroyed()) {
    const panel = (playbackPopup = new BrowserWindow({
      parent: window,
      width: 420,
      height: 640,
      frame: false,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: nativePalette().background,
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    }));
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("will-navigate", (event) => event.preventDefault());
    panel.on("blur", () => {
      popupBlurTimer = setTimeout(hidePlaybackPopup, 150);
    });
    panel.on("closed", () => {
      playbackPopup = undefined;
      publish();
    });
    const ready = waitForPopupRenderer(panel);
    if (process.env.FREEBO_DEV_URL) {
      const url = new URL(process.env.FREEBO_DEV_URL);
      url.searchParams.set("surface", "playback");
      playbackPopupLoading = Promise.all([panel.loadURL(url.toString()), ready]).then(() => {});
    } else
      playbackPopupLoading = Promise.all([
        panel.loadFile(join(__dirname, "../dist/index.html"), {
          query: { surface: "playback" },
        }),
        ready,
      ]).then(() => {});
  }
  await playbackPopupLoading;
  if (mainWindowClosing || !isLiveWindow(window) || !isLiveWindow(playbackPopup)) return;
  positionPlaybackPopup();
  playbackPopup.show();
  publish();
}

function hideServerPopup() {
  clearTimeout(serverPopupBlurTimer);
  serverPopupAnchor = undefined;
  if (isLiveWindow(serverPopup)) serverPopup.hide();
  publish();
}
function positionServerPopup() {
  if (!isLiveWindow(serverPopup) || !serverPopupAnchor || !isLiveWindow(window)) return;
  const bounds = window.getContentBounds();
  const area = screen.getDisplayMatching(window.getBounds()).workArea;
  const width = Math.min(360, area.width - 24);
  const height = Math.min(
    496,
    Math.max(160, 101 + store.value.servers.length * 64),
    bounds.height - 64,
    area.height - 24,
  );
  serverPopup.setBounds({
    width,
    height,
    x: Math.max(
      area.x + 12,
      Math.min(bounds.x + serverPopupAnchor.x, area.x + area.width - width - 12),
    ),
    y: Math.max(
      area.y + 12,
      Math.min(
        bounds.y + serverPopupAnchor.y + serverPopupAnchor.height + 6,
        area.y + area.height - height - 12,
      ),
    ),
  });
}
async function toggleServerPopup(anchor: PopupAnchor) {
  if (mainWindowClosing || !isLiveWindow(window)) return;
  clearTimeout(serverPopupBlurTimer);
  if (serverPopupAnchor) {
    hideServerPopup();
    return;
  }
  hidePlaybackPopup();
  serverPopupAnchor = anchor;
  if (!serverPopup || serverPopup.isDestroyed()) {
    const panel = (serverPopup = new BrowserWindow({
      parent: window,
      width: 360,
      height: 240,
      frame: false,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: nativePalette().card,
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    }));
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("will-navigate", (event) => event.preventDefault());
    panel.on("blur", () => {
      serverPopupBlurTimer = setTimeout(hideServerPopup, 150);
    });
    panel.on("closed", () => {
      serverPopup = undefined;
      serverPopupAnchor = undefined;
      publish();
    });
    const ready = waitForPopupRenderer(panel);
    if (process.env.FREEBO_DEV_URL) {
      const url = new URL(process.env.FREEBO_DEV_URL);
      url.searchParams.set("surface", "servers");
      serverPopupLoading = Promise.all([panel.loadURL(url.toString()), ready]).then(() => {});
    } else
      serverPopupLoading = Promise.all([
        panel.loadFile(join(__dirname, "../dist/index.html"), {
          query: { surface: "servers" },
        }),
        ready,
      ]).then(() => {});
  }
  await serverPopupLoading;
  if (
    mainWindowClosing ||
    !isLiveWindow(window) ||
    !isLiveWindow(serverPopup) ||
    !serverPopupAnchor
  )
    return;
  positionServerPopup();
  serverPopup.show();
  publish();
}

function setupIPC() {
  const handle = (channel: string, callback: (input: any) => unknown) =>
    ipcMain.handle(channel, async (event, input) => {
      own(event);
      try {
        return await callback(input);
      } catch (error) {
        log(String(error));
        if (channel.startsWith("app:watch-statistics-path-") && error instanceof Error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") throw new Error("数据库文件不存在，请重新选择");
          if (code === "EACCES" || code === "EPERM")
            throw new Error("无法读取数据库文件，请检查访问权限");
          if (code === "EBUSY") throw new Error("数据库文件正被占用，请稍后重试");
          if (
            [
              "本机数据库",
              "请选择 Playback Reporting",
              "所选文件",
              "远程 Jellyfin",
              "Playback Reporting 接口不可用",
              "无法核实",
              "无法自动定位",
            ].some((prefix) => error.message.startsWith(prefix))
          )
            throw new Error(error.message);
          throw new Error("无法读取 Playback Reporting 数据库，请检查所选文件");
        }
        if (channel.startsWith("app:watch-statistics") && error instanceof Error)
          throw new Error(
            channel.includes("import") || channel.includes("export") || channel.includes("review")
              ? error.message
              : [
                    "Jellyfin 请求失败",
                    "Jellyfin 媒体",
                    "请先",
                    "Playback Reporting",
                    "播放记录缺少必需字段",
                    "播放记录日期无效",
                    "Jellyfin 用户 ID 无效",
                  ].some((prefix) => error.message.startsWith(prefix))
                ? error.message
                : "观影统计刷新失败，请检查 Jellyfin 和 Playback Reporting",
          );
        if (error instanceof UserFacingError) throw error;
        throw new UserFacingError(error instanceof z.ZodError ? "invalidInput" : "actionFailed");
      }
    });
  handle("app:state", () => state());
  handle("app:watch-statistics", async () => {
    const server = watchServer();
    await watchIdentity().catch(() => {});
    const userId = await watchUserId(server.id);
    return userId ? watchStatistics.getView(server.id, userId) : null;
  });
  handle("app:watch-statistics-correct-library", async (input) => {
    const parsed = z
      .object({
        recordId: z.string().min(1),
        libraryId: z.string().min(1).nullable(),
        remember: z.boolean(),
      })
      .parse(input);
    const server = watchServer();
    await watchIdentity().catch(() => {});
    const userId = await watchUserId(server.id);
    if (!userId) throw new Error("请先在「服务」中登录 Jellyfin");
    const snapshot = await watchStatistics.correctLibrary(
      server.id,
      userId,
      parsed.recordId,
      parsed.libraryId,
      parsed.remember,
    );
    await publishWatch(snapshot, userId);
    return snapshot;
  });
  handle("app:watch-statistics-status", () => watchStatus());
  const batchReviewSchema = z.object({
    action: z.literal("batch"),
    itemIds: z.array(z.string().min(1)).min(1),
    mode: z.enum(["set", "increase", "decrease", "estimate"]),
    totalCount: z.number().int().min(0).max(100).optional(),
    estimate: z.boolean().optional(),
    estimated: z.boolean().optional(),
  });
  handle("app:watch-statistics-review-preview", async (input) => {
    const parsed = batchReviewSchema.parse(input);
    const server = watchServer();
    await watchIdentity().catch(() => {});
    const userId = await watchUserId(server.id);
    if (!userId) throw new Error("请先在「服务」中登录 Jellyfin");
    return watchStatistics.previewReview(server.id, userId, parsed);
  });
  handle("app:watch-statistics-review", async (input) => {
    const parsed = z
      .discriminatedUnion("action", [
        z.object({
          action: z.enum(["confirm", "ignore", "later", "confirmDirect"]),
          itemIds: z.array(z.string()).min(1),
        }),
        z.object({
          action: z.literal("manual"),
          itemIds: z.array(z.string()).min(1),
          totalCount: z.number().int().min(1).max(100),
          estimate: z.boolean(),
        }),
        z.object({ action: z.literal("revoke"), confirmationId: z.string().min(1) }),
        batchReviewSchema.extend({ token: z.string().min(1), operationId: z.string().uuid() }),
      ])
      .parse(input);
    const server = watchServer();
    await watchIdentity().catch(() => {});
    const userId = await watchUserId(server.id);
    if (!userId) throw new Error("请先在「服务」中登录 Jellyfin");
    const snapshot = await watchStatistics.review(server.id, userId, parsed);
    if (snapshot) await publishWatch(snapshot, userId);
    return snapshot;
  });
  handle("app:watch-statistics-path-status", () => {
    const server = watchServer();
    return watchPathLocator.status(server.id, server.url);
  });
  handle("app:watch-statistics-path-choose", async () => {
    const server = watchServer();
    const chosen = await dialog.showOpenDialog(window!, {
      properties: ["openFile"],
      filters: [{ name: "Playback Reporting 数据库", extensions: ["db"] }],
    });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    await watchPathLocator.setManual(server.id, server.url, chosen.filePaths[0]);
    return watchPathLocator.status(server.id, server.url);
  });
  handle("app:watch-statistics-path-discover", async () => {
    const server = watchServer();
    await watchPathLocator.discover(server.id, server.url, true);
    return watchPathLocator.status(server.id, server.url);
  });
  handle("app:watch-statistics-path-clear", async () => {
    const server = watchServer();
    await watchPathLocator.clearManual(server.id, server.url);
    return watchPathLocator.status(server.id, server.url);
  });
  handle("app:watch-statistics-refresh", () => {
    void syncWatch("full").catch((error) => log(String(error)));
  });
  handle("app:watch-statistics-settings", async (input) => {
    const settings = z
      .object({
        gapMinutes: z.number().min(0).max(240),
        includeBackfill: z.boolean(),
        excludeShort: z.boolean(),
        rewatchMinutes: z.number().int().min(1).max(240).optional(),
      })
      .parse(input) as WatchStatisticsSettings;
    const server = watchServer();
    await watchIdentity().catch(() => {});
    const userId = await watchUserId(server.id);
    if (!userId) throw new Error("请先在「服务」中登录 Jellyfin");
    const snapshot = await watchStatistics.settings(server.id, userId, settings);
    if (snapshot) await publishWatch(snapshot, userId);
    return snapshot ? watchStatistics.getView(server.id, userId) : null;
  });
  handle("app:watch-statistics-import-preview", async () => {
    const chosen = await dialog.showOpenDialog(window!, {
      properties: ["openFile"],
      filters: [{ name: "观影统计备份", extensions: ["json"] }],
    });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    watchImportPath = chosen.filePaths[0];
    return watchStatistics.previewImport(watchImportPath);
  });
  handle("app:watch-statistics-import", async (input) => {
    z.literal("replace").parse(input);
    if (!watchImportPath) throw new Error("请先选择导入文件");
    const server = watchServer();
    await watchIdentity().catch(() => {});
    const userId = await watchUserId(server.id);
    const targetUserId = userId ?? pendingWatchUserId;
    const path = watchImportPath;
    watchImportPath = undefined;
    const previous = watchRefresh;
    const task =
      previous
        ?.catch(() => {})
        .then(() => watchStatistics.importData(server.id, targetUserId, path)) ??
      watchStatistics.importData(server.id, targetUserId, path);
    watchRefresh = task;
    watchRefreshMode = "import";
    let snapshot: WatchStatisticsSnapshot;
    try {
      snapshot = await task;
    } finally {
      if (watchRefresh === task) {
        watchRefresh = undefined;
        watchRefreshMode = undefined;
      }
    }
    await publishWatch(snapshot, targetUserId);
    void syncWatch("incremental").catch((error) => log(String(error)));
    return (await watchStatistics.getView(server.id, targetUserId)) ?? snapshot;
  });
  handle("app:watch-statistics-export", async () => {
    const server = watchServer();
    await watchIdentity().catch(() => {});
    const userId = await watchUserId(server.id);
    if (!userId) throw new Error("请先在「服务」中登录 Jellyfin");
    if (watchRefresh) await watchRefresh.catch(() => {});
    const chosen = await dialog.showSaveDialog(window!, {
      defaultPath: `Lllllvlv-观影统计-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "观影统计备份", extensions: ["json"] }],
    });
    if (chosen.canceled || !chosen.filePath) return null;
    await watchStatistics.exportData(server.id, userId, chosen.filePath);
    return chosen.filePath;
  });
  handle("app:restart", async () => {
    if (lifecycle.isQuitting) return;
    await lifecycle.prepareToQuit();
    if (process.env.FREEBO_DEV_URL) app.exit(42);
    else {
      app.relaunch();
      app.quit();
    }
  });
  handle("app:get-startup-video", async () => {
    if (!startupVideoAvailable) {
      finishStartupVideo();
      return null;
    }
    startupVideoAvailable = false;
    const path = startupVideoPath();
    if (!store.value.startupVideoEnabled || !path) {
      finishStartupVideo();
      return null;
    }
    try {
      if (!(await stat(path)).isFile()) {
        finishStartupVideo();
        return null;
      }
      return "freebo-startup://video/current";
    } catch {
      finishStartupVideo();
      return null;
    }
  });
  handle("app:startup-video-done", finishStartupVideo);
  handle("app:choose-startup-video", async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [{ name: "Video", extensions: ["mp4", "webm"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    await mutateStartupVideo(() => setStartupVideo(result.filePaths[0]));
    publish();
    return state();
  });
  handle("app:set-startup-video", async (input) => {
    await mutateStartupVideo(() => setStartupVideo(z.string().min(1).parse(input)));
    publish();
    return state();
  });
  handle("app:clear-startup-video", async () => {
    await mutateStartupVideo(async () => {
      const previous = startupVideoPath();
      const previousFile = store.value.startupVideoFile;
      const previousName = store.value.startupVideoName;
      try {
        await store.save({
          ...store.value,
          startupVideoFile: undefined,
          startupVideoName: undefined,
        });
      } catch (error) {
        if (
          store.value.startupVideoFile === undefined &&
          store.value.startupVideoName === undefined
        ) {
          store.value.startupVideoFile = previousFile;
          store.value.startupVideoName = previousName;
        }
        throw error;
      }
      if (previous) await unlink(previous).catch(() => {});
    });
    publish();
    return state();
  });
  ipcMain.handle("app:surface-ready", (event, input) => {
    own(event);
    const surface = z.enum(["servers", "playback"]).parse(input);
    const panel = surface === "servers" ? serverPopup : playbackPopup;
    if (!isLiveWindow(panel) || panel.webContents !== event.sender)
      throw new UserFacingError("invalidOrigin");
    popupReadiness.get(event.sender.id)?.resolve();
  });
  handle("app:error-visible", (input) => {
    errorVisible = z.boolean().parse(input);
    layout();
  });
  handle("app:save-server", async (input) => {
    const server = z
      .object({
        id: z.uuid().optional(),
        name: z.string(),
        url: z.string(),
        providerId: z.string(),
        credentials: credentialsSchema.optional(),
      })
      .parse(input);
    const provider = server.providerId === "web" ? undefined : providers.get(server.providerId);
    if (server.credentials && (!provider || provider.supportsCredentials === false))
      throw new UserFacingError("plexWebSignIn");
    const savedServer = await store.upsertServer(
      {
        ...server,
        url: provider ? provider.normalizeUrl(server.url) : normalizeWebServiceUrl(server.url),
      },
      async (saved) => {
        const previous = store.value.servers.find((entry) => entry.id === saved.id);
        if (server.credentials !== undefined) await credentials.set(saved, server.credentials);
        else if (
          previous &&
          (previous.url !== saved.url || previous.providerId !== saved.providerId)
        )
          await credentials.set(saved, null);
      },
    );
    const opened = serverViews.get(savedServer.id);
    if (opened && (server.credentials !== undefined || opened.server.url !== savedServer.url || opened.server.providerId !== savedServer.providerId))
      closeServerView(savedServer.id);
    publish();
    return state();
  });
  handle("app:server-credentials", async (input) => {
    const server = store.value.servers.find((server) => server.id === idSchema.parse(input));
    if (!server) throw new UserFacingError("serverMissing");
    return credentials.get(server);
  });
  handle("app:test-server-connection", async (input) => {
    const request = z
      .object({
        id: z.uuid().optional(),
        url: z.string(),
        providerId: z.string(),
        credentials: credentialsSchema.optional(),
      })
      .parse(input);
    const provider = request.providerId === "web" ? undefined : providers.get(request.providerId);
    if (!provider?.testConnection) throw new UserFacingError("providerMissing");
    const url = provider.normalizeUrl(request.url);
    const registered = store.value.servers.find(
      (server) =>
        server.id === request.id && server.url === url && server.providerId === provider.id,
    );
    const ses = session.fromPartition(
      registered ? providers.partition(registered) : "freebo-connection-test",
    );
    ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
    return provider.testConnection(
      url,
      request.credentials,
      browserFetcher(
        ses,
        provider.entryUrl({ id: "connection-test", name: "", url, providerId: provider.id }),
      ),
      {
        deviceId: createHash("sha256")
          .update(`${app.getPath("userData")}\0${url}`)
          .digest("hex"),
        deviceName: browserDeviceName(ses.getUserAgent()),
      },
    );
  });
  handle("app:remove-server", async (input) => {
    const id = idSchema.parse(input);
    const server = store.value.servers.find((entry) => entry.id === id);
    if (!server) throw new UserFacingError("serverMissing");
    await credentials.set(server, null);
    serverFavicons.delete(id);
    closeServerView(id);
    const servers = store.value.servers.filter((s) => s.id !== id);
    await store.save({
      ...store.value,
      servers,
      activeServerId:
        store.value.activeServerId === id ? servers[0]?.id : store.value.activeServerId,
    });
    publish();
    return state();
  });
  handle("app:open-server", async (input) => {
    await openServer(idSchema.parse(input));
    return state();
  });
  handle("app:close-server", (input) => {
    closeServerView(idSchema.parse(input));
    return state();
  });
  handle("app:page", (input) => {
    const request = z
      .object({
        page: z.enum(["home", "library", "settings", "setup"]),
        section: z
          .enum(["players", "general", "servers", "statistics", "diagnostics", "about"])
          .optional(),
      })
      .parse(input);
    page = request.page;
    if (request.section) settingsPage = request.section;
    shown = page === "library";
    hidePlaybackPopup();
    hideServerPopup();
    layout();
    publish();
  });
  handle("app:playback-popup", async (input) => {
    if (input === null) {
      hidePlaybackPopup();
      return;
    }
    const coordinate = z.number().finite().min(0).max(100_000);
    const anchor = z
      .object({ x: coordinate, y: coordinate, width: coordinate, height: coordinate })
      .parse(input);
    await togglePlaybackPopup(anchor);
  });
  handle("app:server-popup", async (input) => {
    if (input === null) {
      hideServerPopup();
      return;
    }
    const coordinate = z.number().finite().min(0).max(100_000);
    const anchor = z
      .object({ x: coordinate, y: coordinate, width: coordinate, height: coordinate })
      .parse(input);
    await toggleServerPopup(anchor);
  });
  handle("app:add-server", () => {
    hideServerPopup();
    hidePlaybackPopup();
    page = "settings";
    settingsPage = "servers";
    shown = false;
    layout();
    publish();
    window.webContents.send("app:add-server");
    window.show();
    window.focus();
  });
  handle("app:playback-item", async () => {
    const server = store.value.servers.find((server) => server.id === playbackServer?.id);
    const item = playback.state.queue[playback.state.index];
    if (!server || !item) throw new UserFacingError("itemMissing");
    const destination = await playbackClient?.itemUrl?.(item.id);
    if (!destination) throw new UserFacingError("providerMissing");
    hidePlaybackPopup();
    await openServer(server.id, destination);
    window.show();
    window.focus();
  });
  handle("app:discover-players", async () => {
    await scan();
    return state();
  });
  handle("app:choose-player", async (input) => {
    const kind = kindSchema.parse(input);
    const result = await dialog.showOpenDialog(window, {
      title: t("selectPlayerTitle", { name: playerGuides[kind].name }),
      properties: ["openFile"],
      ...(process.platform === "darwin"
        ? { filters: [{ name: t("playerApp"), extensions: ["app", "*"] }] }
        : {}),
    });
    if (!result.canceled && result.filePaths[0]) {
      const player = manualPlayer(kind, result.filePaths[0]);
      await access(
        player.executable,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      await store.save({
        ...store.value,
        players: store.value.players.filter((p) => p.id !== player.id).concat(player),
        defaultPlayerId: player.id,
        playerScanCompleted: true,
      });
    }
    publish();
    return state();
  });
  handle("app:remove-player", async (input) => {
    await store.removePlayer(z.string().min(1).parse(input));
    publish();
    return state();
  });
  handle("app:choose-player-executable", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t("choosePlayerExecutable"),
      properties: ["openFile"],
      ...(process.platform === "darwin"
        ? { filters: [{ name: t("playerApp"), extensions: ["app", "*"] }] }
        : {}),
    });
    return result.canceled || !result.filePaths[0]
      ? null
      : customPlayerExecutable(result.filePaths[0]);
  });
  handle("app:save-custom-player", async (input) => {
    const parsed = customPlayerInputSchema.parse(input);
    const executable = await customPlayerExecutable(parsed.executable);
    await store.upsertCustomPlayer({ ...parsed, executable });
    publish();
    return state();
  });
  handle("app:settings", async (input) => {
    const settings = z
      .object({
        defaultPlayerId: z.string().optional(),
        autoNext: z.boolean().optional(),
        fullscreen: z.boolean().optional(),
        theme: z.enum(["system", "dark", "light"]).optional(),
        visualTheme: z
          .custom<(typeof visualThemeIds)[number]>((value) =>
            visualThemeIds.some((id) => id === value),
          )
          .optional(),
        visualBackground: z
          .custom<(typeof visualBackgroundIds)[number]>((value) =>
            visualBackgroundIds.some((id) => id === value),
          )
          .optional(),
        language: z.enum(["system", "zh", "en"]).optional(),
        setupCompleted: z.boolean().optional(),
        runInBackground: z.boolean().optional(),
        remindOnClose: z.boolean().optional(),
        startupVideoEnabled: z.boolean().optional(),
        startupVideoSoundEnabled: z.boolean().optional(),
        startupVideoVolume: z.number().min(0).max(100).optional(),
      })
      .strict()
      .parse(input);
    if (
      settings.defaultPlayerId &&
      !store.value.players.some((p) => p.id === settings.defaultPlayerId)
    )
      throw new UserFacingError("playerMissing");
    await store.save({ ...store.value, ...settings });
    if (settings.setupCompleted && page === "setup") page = "home";
    nativeTheme.themeSource = store.value.theme;
    updateChrome();
    buildMenu();
    syncTray();
    publish();
    return state();
  });
  handle("app:control", async (input) => {
    await playback.control(controlSchema.parse(input));
  });
  handle("app:navigate", (input) => {
    const action = z
      .enum(["back", "forward", "reload", "forceReload", "stop", "home"])
      .parse(input);
    const entry = activeView;
    if (page !== "library" || !entry || !isRegistered(entry)) return;
    const { view, server } = entry;
    if (action === "home")
      void view.webContents.loadURL(
        server.providerId === "web"
          ? server.url
          : providers.get(server.providerId).entryUrl(server, true),
      );
    else if (action === "reload" || action === "forceReload") {
      entry.webError = undefined;
      entry.webStatus = "loading";
      entry.bootstrapRetries = 0;
      layout();
      publish();
      if (action === "forceReload") view.webContents.reloadIgnoringCache();
      else view.webContents.reload();
    } else if (action === "stop") {
      view.webContents.stop();
      if (entry.webStatus !== "error") entry.webStatus = "ready";
      publish();
    } else if (action === "back" && view.webContents.navigationHistory.canGoBack())
      view.webContents.navigationHistory.goBack();
    else if (action === "forward" && view.webContents.navigationHistory.canGoForward())
      view.webContents.navigationHistory.goForward();
  });
  handle("app:reset-session", async (input) => {
    const id = idSchema.parse(input);
    const server = store.value.servers.find((s) => s.id === id);
    if (!server) throw new UserFacingError("serverMissing");
    closeServerView(id);
    await session.fromPartition(servicePartition(server)).clearStorageData();
    publish();
    return state();
  });
  handle("app:guide", async (input) => {
    await shell.openExternal(playerGuides[kindSchema.parse(input)].url);
  });
  handle("app:diagnostics", async () => {
    const result = await dialog.showSaveDialog(window, {
      defaultPath: "Lllllvlv-diagnostics.json",
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, JSON.stringify(getDiagnostics(), null, 2));
    return result.filePath;
  });
  handle("app:get-diagnostics", () => ({
    ...getDiagnostics(),
    directories: applicationDirectories(app),
    dataMigration: {
      available: process.platform === "win32" && !isolatedUserData,
      error: userDataLocation.error,
    },
  }));
  handle("app:choose-data-directory", async () => {
    if (process.platform !== "win32" || isolatedUserData)
      throw new Error("此运行环境不支持迁移数据目录");
    const chosen = await dialog.showOpenDialog(window!, { properties: ["openDirectory"] });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    return userDataLocation.targetFor(chosen.filePaths[0], userDataPath);
  });
  handle("app:migrate-data-directory", async (target) => {
    if (process.platform !== "win32" || isolatedUserData || typeof target !== "string")
      throw new Error("此运行环境不支持迁移数据目录");
    userDataLocation.prepare(userDataPath, target);
    await lifecycle.prepareToQuit();
    app.relaunch();
    app.quit();
  });
  handle("app:open-directory", (input) =>
    openApplicationDirectory(app, input, (path) => shell.openPath(path)),
  );
  handle("app:copy-diagnostics", async () => {
    await clipboard.writeText(JSON.stringify(getDiagnostics(), null, 2));
  });
  handle("app:open-link", async (input) => {
    if (!showProductLinks && (input === "product" || input === "github")) return;
    await shell.openExternal(
      productLink(z.enum(["product", "github", "issue"]).parse(input), getDiagnostics()),
    );
  });
  ipcMain.on("server:ready", (event, status) => {
    const entry = viewForSender(event.sender);
    if (
      entry &&
      entry.server.providerId !== "web" &&
      event.senderFrame === entry.view.webContents.mainFrame
    ) {
      const result = z.enum(["waiting", "sign-in", "ready", "error", "stalled"]).safeParse(status);
      if (result.success) {
        if (result.data === "stalled") {
          if (entry.bootstrapRetries++ === 0) {
            log("Initial server bootstrap stalled; retrying once");
            entry.view.webContents.reload();
          } else entry.adapterStatus = "error";
          publishView(entry);
          return;
        }
        entry.adapterStatus = result.data;
        publishView(entry);
      }
    }
  });
  ipcMain.handle("server:credentials", async (event) => {
    const entry = viewForSender(event.sender);
    const view = entry?.view;
    const server = entry?.server;
    const frame = event.senderFrame;
    if (
      !view ||
      !server ||
      server.providerId === "web" ||
      event.sender !== view.webContents ||
      frame !== view.webContents.mainFrame ||
      !frame ||
      !credentialOriginMatches(server, frame.url)
    )
      throw new UserFacingError("invalidOrigin");
    const frameUrl = frame.url;
    const saved = await credentials.get(server);
    // A pending keychain read must not deliver secrets to a newly navigated page.
    if (!entry || !isRegistered(entry) || frame.isDestroyed() || frame.url !== frameUrl) return null;
    return saved;
  });
  ipcMain.handle("server:play", async (event, input) => {
    const entry = viewForSender(event.sender);
    if (
      !entry ||
      entry.server.providerId === "web" ||
      event.senderFrame !== entry.view.webContents.mainFrame
    )
      throw new UserFacingError("invalidOrigin");
    const provider = providers.get(entry.server.providerId);
    const request = provider.parsePlayback(input, entry.server);
    const { intent } = request;
    const player = store.value.players.find((p) => p.id === store.value.defaultPlayerId);
    if (!player) {
      shown = false;
      page = "settings";
      settingsPage = "players";
      layout();
      playback.state = {
        ...playback.state,
        status: "error",
        error: errorToken("noPlayer"),
      };
      publish();
      return;
    }
    const server = entry.server;
    playbackServer = server;
    const browserSession = entry.view.webContents.session;
    const fetch = guardServerAccess(browserFetcher(browserSession, entry.view.webContents.getURL()));
    const fetcher = async (url: string, init?: RequestInit) => {
      const response = await fetch(url, init);
      if (!response.ok) {
        const message = `${provider.name} API ${init?.method ?? "GET"} ${new URL(url).pathname}: ${response.status}, ${response.headers.get("content-type")}, ${response.headers.get("cf-mitigated") ?? ""}`;
        log(message);
        if (process.env.FREEBO_DEV_URL) console.warn(message);
      }
      return response;
    };
    const client = request.createClient(fetcher);
    playbackClient = client;
    const originalPrepare = client.prepare.bind(client);
    client.prepare = async (...args) => {
      const media = await originalPrepare(...args);
      if (player.kind === "potplayer") {
        // PotPlayer's documented control messages do not select embedded tracks.
        // Do not report Emby's chosen indices as though the player applied them.
        media.audioStreamIndex = undefined;
        if (!media.subtitleUrl) media.subtitleStreamIndex = undefined;
      }
      media.url = proxy.register(media.url, fetcher, media.headers);
      if (media.subtitleUrl)
        media.subtitleUrl = proxy.register(media.subtitleUrl, fetcher, media.headers, "subtitle");
      media.headers = {};
      return media;
    };
    // Keep old proxy routes while queued stop reports are draining; playback replaces the queue.
    void playback.play(client, intent, player, store.value);
  });
}

function nativePalette() {
  const theme = visualThemes[resolveVisualTheme(store.value.visualTheme)];
  return nativeTheme.shouldUseDarkColors ? theme.native.dark : theme.native.light;
}

function updateChrome() {
  if (!window || window.isDestroyed()) return;
  window.setTitle(t("brand"));
  window.setBackgroundColor(nativePalette().background);
  if (playbackPopup && !playbackPopup.isDestroyed())
    playbackPopup.setBackgroundColor(nativePalette().background);
  if (serverPopup && !serverPopup.isDestroyed())
    serverPopup.setBackgroundColor(nativePalette().card);
  if (process.platform !== "darwin")
    window.setTitleBarOverlay({
      height: 40,
      color: nativePalette().tab,
      symbolColor: nativePalette().symbol,
    });
}
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: t("brand"),
        submenu: [
          { role: "about", label: t("about") },
          { type: "separator" },
          { role: "quit", label: t("quit") },
        ],
      },
      {
        label: t("editMenu"),
        submenu: [
          { role: "undo", label: t("undo") },
          { role: "redo", label: t("redo") },
          { type: "separator" },
          { role: "cut", label: t("cut") },
          { role: "copy", label: t("copy") },
          { role: "paste", label: t("paste") },
          { role: "selectAll", label: t("selectAll") },
        ],
      },
      {
        label: t("viewMenu"),
        submenu: [
          { role: "resetZoom", label: t("resetZoom") },
          { role: "zoomIn", label: t("zoomIn") },
          { role: "zoomOut", label: t("zoomOut") },
          { role: "togglefullscreen", label: t("toggleFullscreen") },
        ],
      },
      {
        label: t("windowMenu"),
        submenu: [
          { role: "minimize", label: t("minimize") },
          { role: "close", label: t("closeWindow") },
        ],
      },
      ...(process.env.FREEBO_DEV_URL && process.env.FREEBO_CAPTURE_DIR
        ? [
            {
              label: t("development"),
              submenu: [
                {
                  label: "Minimum window (820 × 600)",
                  accelerator: "CmdOrCtrl+Shift+1",
                  click: () => window.setSize(820, 600),
                },
                {
                  label: "Standard window (1280 × 850)",
                  accelerator: "CmdOrCtrl+Shift+2",
                  click: () => window.setSize(1280, 850),
                },
                {
                  label: t("capture"),
                  accelerator: "CmdOrCtrl+Shift+S",
                  click: async () => {
                    const directory = process.env.FREEBO_CAPTURE_DIR!;
                    await mkdir(directory, { recursive: true });
                    const filename = `app-${Date.now()}`;
                    await writeFile(
                      join(directory, `${filename}.png`),
                      (await window.capturePage()).toPNG(),
                    );
                    await writeFile(
                      join(directory, `${filename}.json`),
                      JSON.stringify(
                        {
                          bounds: window.getBounds(),
                          locale: locale(),
                          theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
                        },
                        null,
                        2,
                      ),
                    );
                  },
                },
              ],
            },
          ]
        : []),
    ]),
  );
}

function showMainWindow() {
  if (lifecycle.isQuitting || !isLiveWindow(window)) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  publish();
}
function showUpdates() {
  showMainWindow();
  if (lifecycle.isQuitting) return;
  hidePlaybackPopup();
  hideServerPopup();
  shown = false;
  page = "settings";
  settingsPage = "about";
  layout();
  publish();
}
function buildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(t("brand"));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("showFreebo"), click: showMainWindow },
      {
        label: t(updates?.state.status === "downloaded" ? "updateReadyMenu" : "softwareUpdates"),
        click: showUpdates,
      },
      { type: "separator" },
      { label: t("quit"), click: () => app.quit() },
    ]),
  );
}
function createTray() {
  try {
    const directory = join(
      app.isPackaged ? process.resourcesPath : join(__dirname, "../resources"),
      "tray",
    );
    const image = nativeImage.createFromPath(join(directory, "trayColor.png"));
    if (image.isEmpty()) throw new Error("Tray icon is missing");
    tray = new Tray(image);
    tray.on("click", showMainWindow);
    tray.on("double-click", showMainWindow);
    buildTrayMenu();
  } catch (error) {
    // A machine without a usable tray must retain a way to exit the app.
    tray?.destroy();
    tray = undefined;
    log(`Could not create tray: ${String(error)}`);
  }
}
function syncTray() {
  if (store.value.runInBackground) {
    if (!tray || tray.isDestroyed()) createTray();
    else buildTrayMenu();
  } else {
    if (!lifecycle.isQuitting && isLiveWindow(window) && !window.isVisible()) showMainWindow();
    tray?.destroy();
    tray = undefined;
  }
}
let backgroundClosePending = false;
async function closeToBackground() {
  if (backgroundClosePending || lifecycle.isQuitting) return;
  const hide = () => {
    hidePlaybackPopup();
    hideServerPopup();
    window.hide();
  };
  if (!store.value.remindOnClose) {
    hide();
    return;
  }
  backgroundClosePending = true;
  try {
    const result = await dialog.showMessageBox(window, {
      type: "info",
      message: t("backgroundCloseTitle"),
      detail: t("backgroundDescription"),
      buttons: [t("continueInBackground"), t("quit"), t("cancel")],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: t("doNotRemindAgain"),
    });
    if (lifecycle.isQuitting || !isLiveWindow(window) || result.response === 2) return;
    if (result.checkboxChecked) {
      await store.save({ ...store.value, remindOnClose: false });
      publish();
    }
    if (lifecycle.isQuitting) return;
    if (result.response === 1 || !store.value.runInBackground || !tray || tray.isDestroyed())
      app.quit();
    else hide();
  } catch (error) {
    log(`Could not close to background: ${String(error)}`);
    if (!lifecycle.isQuitting && isLiveWindow(window))
      await dialog.showMessageBox(window, {
        type: "error",
        message: localizeError(locale(), error),
      });
  } finally {
    backgroundClosePending = false;
  }
}
async function setupUpdates() {
  // Keep the upstream updater integration available for a future release.
  const upstreamUpdatesEnabled = false;
  const packageType = join(process.resourcesPath, "package-type");
  const reason = !upstreamUpdatesEnabled
    ? "fork-disabled"
    : updateDisabledReason({
        packaged: app.isPackaged,
        platform: process.platform as Platform,
        portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
        appImage: Boolean(process.env.APPIMAGE),
        deb: existsSync(packageType) && readFileSync(packageType, "utf8").trim() === "deb",
        macSigned:
          process.platform !== "darwin" ||
          (app.isPackaged && (await hasMacUpdateSignature(process.execPath))),
      });
  updates = new UpdateManager(reason ? undefined : autoUpdater, reason, log);
  updates.on("install-failed", () => {
    void lifecycle
      .prepareToQuit()
      .then(async () => {
        if (!isLiveWindow(window)) {
          app.quit();
          return;
        }
        await proxy.open();
        lifecycle.resumeAfterFailedUpdate();
      })
      .catch((error) => {
        log(`Could not recover after update installation failed: ${String(error)}`);
        app.quit();
      });
  });
  let previousStatus = updates.state.status;
  updates.on("change", () => {
    publish();
    buildTrayMenu();
    if (
      updates?.state.status === "downloaded" &&
      previousStatus !== "downloaded" &&
      Notification.isSupported()
    ) {
      const notification = new Notification({
        title: t("brand"),
        body: t("updateDownloaded", { version: updates.state.version ?? "" }),
        icon: windowIcon,
      });
      notification.on("click", showUpdates);
      notification.show();
    }
    previousStatus = updates!.state.status;
  });
  ipcMain.handle("app:check-updates", (event) => {
    own(event);
    if (reason !== "fork-disabled" && !lifecycle.isQuitting) return updates?.check();
  });
  ipcMain.handle("app:install-update", (event) => {
    own(event);
    if (reason !== "fork-disabled" && !lifecycle.isQuitting)
      return updates?.install(() => lifecycle.prepareToQuit());
  });
  ipcMain.handle("app:open-releases", (event) => {
    own(event);
    if (reason === "fork-disabled") return;
    return shell.openExternal("https://github.com/gok2023/Lllllvlv/releases/latest");
  });
  buildTrayMenu();
  publish();
  if (!reason) {
    void updates.check();
    updateTimer = setInterval(
      () => {
        if (!lifecycle.isQuitting) void updates?.check();
      },
      6 * 60 * 60 * 1000,
    );
    updateTimer.unref();
  }
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});
void app.whenReady().then(async () => {
  if (!instance.primary) return;
  await store.load();
  protocol.handle("freebo-startup", (request) => {
    const url = new URL(request.url);
    if (url.host !== "video" || url.pathname !== "/current")
      return new Response(null, { status: 404 });
    const path = startupVideoPath();
    if (!path) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path).toString(), { headers: request.headers });
  });
  try {
    await credentials.load();
    credentialsAvailable = await credentials.available();
  } catch {
    log("System credential storage is unavailable");
  }
  await proxy.open();
  nativeTheme.themeSource = store.value.theme;
  page = store.value.setupCompleted ? "home" : "setup";
  const launchVideoPath = startupVideoPath();
  if (store.value.fullscreen && store.value.startupVideoEnabled && launchVideoPath) {
    try {
      startupVideoFullscreen = (await stat(launchVideoPath)).isFile();
    } catch {
      startupVideoFullscreen = false;
    }
  }
  const savedWindow = windowStateStore.load();
  const bounds = savedWindow
    ? fitWindowBounds(savedWindow.bounds, screen.getDisplayMatching(savedWindow.bounds).workArea)
    : defaultWindowSize;
  window = new BrowserWindow({
    ...bounds,
    fullscreen: startupVideoFullscreen,
    minWidth: minimumWindowSize.width,
    minHeight: minimumWindowSize.height,
    title: t("brand"),
    icon: windowIcon,
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 12, y: 13 } }
      : {
          titleBarOverlay: {
            height: 40,
            color: nativePalette().tab,
            symbolColor: nativePalette().symbol,
          },
        }),
    backgroundColor: nativePalette().background,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (!startupVideoFullscreen && (store.value.fullscreen || savedWindow?.maximized))
    window.maximize();
  let windowStateTimer: ReturnType<typeof setTimeout> | undefined;
  const saveWindowState = () => {
    clearTimeout(windowStateTimer);
    if (window.isDestroyed()) return;
    try {
      windowStateStore.save({ bounds: window.getNormalBounds(), maximized: window.isMaximized() });
    } catch {
      log("Could not save window geometry");
    }
  };
  const scheduleWindowState = () => {
    clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(saveWindowState, 400);
  };
  window.on("resize", scheduleWindowState);
  window.on("move", scheduleWindowState);
  window.on("maximize", scheduleWindowState);
  window.on("unmaximize", scheduleWindowState);
  window.on("close", saveWindowState);
  if (process.platform === "darwin") app.dock?.setIcon(windowIcon);
  buildMenu();
  syncTray();
  setupIPC();
  playback.on("state", () => {
    if (playback.state.status === "idle") proxy.clear();
    publish();
  });
  playback.on("report", (result: { event: string; status: string; error?: string }) => {
    log(
      `Playback sync ${result.event}: ${result.status}${result.error ? ` (${result.error})` : ""}`,
    );
  });
  playback.on("diagnostic", (message: string) => log(message));
  window.on("resize", () => {
    layout();
    if (playbackPopup?.isVisible()) positionPlaybackPopup();
    if (serverPopup?.isVisible()) positionServerPopup();
  });
  window.on("move", () => {
    if (playbackPopup?.isVisible()) positionPlaybackPopup();
    if (serverPopup?.isVisible()) positionServerPopup();
  });
  window.on("minimize", hidePlaybackPopup);
  window.on("minimize", hideServerPopup);
  window.on("close", (event) => {
    if (
      !lifecycle.close(
        event,
        Boolean(store.value.runInBackground && tray && !tray.isDestroyed()),
        () => {
          void closeToBackground();
        },
        () => app.quit(),
      )
    )
      return;
    mainWindowClosing = true;
    clearTimeout(popupBlurTimer);
    clearTimeout(serverPopupBlurTimer);
    popupAnchor = undefined;
    serverPopupAnchor = undefined;
    closeAllServerViews();
    if (isLiveWindow(playbackPopup)) playbackPopup.destroy();
    if (isLiveWindow(serverPopup)) serverPopup.destroy();
  });
  window.on("enter-full-screen", () => {
    layout();
    publish();
  });
  window.on("leave-full-screen", () => {
    layout();
    publish();
  });
  nativeTheme.on("updated", updateChrome);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) finishStartupVideo();
  });
  if (process.env.FREEBO_DEV_URL) await window.loadURL(process.env.FREEBO_DEV_URL);
  else await window.loadFile(join(__dirname, "../dist/index.html"));
  instance.windowReady();
  const startupServer = store.value.servers.find(
    (item) => item.id === store.value.activeServerId && item.providerId === "jellyfin",
  );
  if (startupServer) {
    void (async () => {
      const hidden = new BrowserWindow({
        show: false,
        webPreferences: {
          partition: servicePartition(startupServer),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      try {
        await hidden.loadURL(jellyfinProvider.entryUrl(startupServer));
        for (let attempt = 0; attempt < 10 && !lifecycle.isQuitting; attempt++) {
          const auth = await hidden.webContents.executeJavaScript(
            `(() => { const api = window.ApiClient; return api && {baseUrl:api.serverAddress?.(),userId:api.getCurrentUserId?.(),token:api.accessToken?.()}; })()`,
          );
          if (
            auth?.baseUrl &&
            auth?.userId &&
            auth?.token &&
            new URL(auth.baseUrl).origin === new URL(startupServer.url).origin
          ) {
            watchAuth = { serverId: startupServer.id, auth };
            await rememberWatchUser(startupServer.id, auth.userId);
            await syncWatch("incremental");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (error) {
        log(String(error));
      } finally {
        if (!hidden.isDestroyed()) hidden.destroy();
      }
    })();
  }
  const watchTimer = setInterval(() => void watchTick(), 30_000);
  watchTimer.unref();
  app.once("will-quit", () => clearInterval(watchTimer));
  await setupUpdates();
});
app.on("before-quit", (event) => {
  if (instance.primary) lifecycle.beforeQuit(event, () => app.quit());
});
app.on("will-quit", () => {
  tray?.destroy();
});
app.on("window-all-closed", () => {
  if (lifecycle.isQuitting || !tray || tray.isDestroyed()) app.quit();
});
