import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { JellyfinPluginError, JellyfinPluginState } from "../../src/shared/jellyfin-plugins";
import type { Server } from "../../src/shared/types";
import type { Fetcher } from "../providers/types";
import { JellyfinThoroughUninstall, type ThoroughAction } from "./jellyfin-plugin-uninstall";
import {
  catalogSchema,
  copyApprovedPlugin,
  copyRecommendedConfiguration,
  inspectPluginDirectory,
  jellyfinGuid,
  localAbsolutePath,
  payloadPresent,
  pluginDirectory,
  pluginVersion,
  processPluginDirectory,
  type CatalogPlugin,
} from "./jellyfin-plugin-files";

const serverInfoSchema = z.object({
  Id: z.string().min(1),
  Version: pluginVersion,
  ProductName: z.string().optional(),
  ProgramDataPath: z.string().optional(),
  CanSelfRestart: z.boolean().optional(),
  HasPendingRestart: z.boolean().optional(),
});
const installedSchema = z.array(
  z.object({
    Id: jellyfinGuid,
    Version: pluginVersion,
    Status: z.string().optional(),
  }),
);
const packageSchema = z.object({
  guid: jellyfinGuid,
  versions: z.array(
    z.object({
      version: pluginVersion,
      targetAbi: z.string().optional(),
      sourceUrl: z.string(),
      checksum: z.string(),
      repositoryUrl: z.string().optional(),
    }),
  ),
});
const repositoriesSchema = z.array(
  z.object({
    Url: z.string().nullish(),
    Enabled: z.boolean(),
  }),
);
const journalSchema = z.record(
  z.string(),
  z.object({
    url: z.string(),
    jellyfinId: z.string(),
    directory: z.string().optional(),
    pending: z.array(
      z.object({
        pluginId: z.guid(),
        version: pluginVersion,
        action: z.enum(["online-install", "offline-install", "uninstall"]),
      }),
    ),
  }),
);

type Journal = z.infer<typeof journalSchema>;
type Pending = Journal[string]["pending"][number];
type Request = (path: string, method?: string, timeout?: number) => Promise<Response>;
type ServerInfo = z.infer<typeof serverInfoSchema>;
type Installed = z.infer<typeof installedSchema>;
type Snapshot = {
  state: JellyfinPluginState;
  info?: ServerInfo;
  plugins: CatalogPlugin[];
  installed: Installed | null;
  request?: Request;
  record?: Journal[string];
  online: Map<string, string>;
};
type Action =
  | { type: "get" | "directory" | "restart" }
  | { type: "install"; pluginId: string; useRecommendedConfiguration?: boolean };

function versionParts(version: string) {
  return version.split(".").map(Number);
}

function versionAtLeast(actual: number[], expected: number[]) {
  for (let index = 0; index < 4; index++) {
    const difference = (actual[index] ?? 0) - (expected[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function compatible(server: string, target: string) {
  const actual = versionParts(server);
  const expected = versionParts(target);
  // ABI compatibility across server minor versions is not implied by the catalog minimum.
  return actual[0] === expected[0] && actual[1] === expected[1] && versionAtLeast(actual, expected);
}

const status = (value: string | undefined) => value?.toLowerCase() ?? "unknown";
const exact = (items: Installed, id: string, version: string) =>
  items.find((item) => item.Id === id && item.Version === version);

export class JellyfinPluginManager {
  private operations: Promise<unknown> = Promise.resolve();
  private catalog: Promise<CatalogPlugin[]> | undefined;
  private journal: Journal | undefined;
  private readonly thorough: JellyfinThoroughUninstall;

  constructor(
    private readonly paths: { resources: string; journal: string },
    private readonly connect: (server: Server) => Fetcher,
    private readonly getToken: (server: Server, jellyfinId: string) => Promise<string | undefined>,
    private readonly isLocal: (url: string) => boolean,
    private readonly chooseDirectory: (defaultPath?: string) => Promise<string | undefined>,
    private readonly isCurrent: (server: Server) => boolean,
    private readonly report: (event: string) => void,
  ) {
    this.thorough = new JellyfinThoroughUninstall(
      join(dirname(paths.journal), "jellyfin-plugin-uninstall.json"),
      async (server) => {
        const snapshot = await this.snapshot(server);
        return {
          local: snapshot.state.local,
          admin: snapshot.state.access === "admin",
          directory: snapshot.state.directory,
          jellyfinId: snapshot.info?.Id,
          catalog: snapshot.plugins,
          installed: snapshot.installed,
          shutdown:
            snapshot.request &&
            (async () => {
              const response = await snapshot.request!("System/Shutdown", "POST");
              return response.status === 204;
            }),
        };
      },
      isCurrent,
    );
  }

  run(server: Server, action: Action): Promise<JellyfinPluginState> {
    // Serialize the whole transaction, including directory probes and the durable restart journal.
    const next = this.operations.catch(() => {}).then(() => this.execute(server, action));
    this.operations = next;
    return next;
  }

  runThorough(server: Server, action: ThoroughAction) {
    if (action.type === "get" || action.type === "continue") {
      return this.thorough.run(server, action, (work) => {
        this.operations = this.operations.catch(() => {}).then(work);
      });
    }
    const next = this.operations.catch(() => {}).then(() => this.thorough.run(server, action));
    this.operations = next;
    return next;
  }

  private request(server: Server, token?: string): Request {
    const fetcher = this.connect(server);
    return (path, method = "GET", timeout = 7000) =>
      fetcher(`${server.url}/${path}`, {
        method,
        headers: token ? { "X-Emby-Token": token } : {},
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeout),
      });
  }

  private async readJournal() {
    this.journal ??= await readFile(this.paths.journal, "utf8")
      .then(
        (contents) => {
          const parsed = journalSchema.safeParse(JSON.parse(contents));
          if (!parsed.success) this.report("Jellyfin plugin journal is invalid");
          return parsed.success ? parsed.data : {};
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return {};
        },
      )
      .catch((error: unknown) => {
        if (!(error instanceof SyntaxError)) throw error;
        this.report("Jellyfin plugin journal is invalid");
        return {};
      });
    return this.journal;
  }

  private async saveRecord(id: string, record: Journal[string]) {
    const next = { ...(await this.readJournal()), [id]: record };
    const temporary = `${this.paths.journal}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, this.paths.journal);
    this.journal = next;
  }

  private async pending(server: Server, record: Journal[string], change: Pending) {
    await this.saveRecord(server.id, { ...record, pending: [...record.pending, change] });
  }

  private async findExactPackage(request: Request, plugin: CatalogPlugin, repositoryUrl: string) {
    if (!plugin.sourceUrl || !plugin.checksum || !plugin.sourceSha256 || plugin.customized)
      return false;
    try {
      const response = await request("Packages");
      if (!response.ok) return false;
      const packages = z.array(z.unknown()).parse(await response.json());
      const details = packageSchema.parse(
        packages.find(
          (entry) =>
            !!entry &&
            typeof entry === "object" &&
            "guid" in entry &&
            jellyfinGuid.safeParse(entry.guid).data === plugin.id,
        ),
      );
      const versions = details.versions.filter(({ version }) => version === plugin.version);
      // The install endpoint filters repositories by package, not by the selected release.
      // Permit the native path only when there is one unambiguous matching release.
      if (versions.length !== 1) return false;
      const [candidate] = versions;
      if (
        candidate.targetAbi !== plugin.targetAbi ||
        candidate.sourceUrl !== plugin.sourceUrl ||
        candidate.checksum.toLowerCase() !== plugin.checksum.toLowerCase() ||
        candidate.repositoryUrl !== repositoryUrl
      )
        return false;
      return true;
    } catch {
      return false;
    }
  }

  private async verifyApprovedDownload(plugin: CatalogPlugin) {
    if (
      !plugin.sourceUrl ||
      !plugin.sourceSha256 ||
      new URL(plugin.sourceUrl).protocol !== "https:"
    )
      return false;
    const response = await fetch(plugin.sourceUrl, {
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok || !response.body || new URL(response.url).protocol !== "https:") return false;
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return hash.digest("hex") === plugin.sourceSha256;
        size += value.length;
        if (size > 64 * 1024 * 1024) return false;
        hash.update(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  private async snapshot(server: Server): Promise<Snapshot> {
    this.catalog ??= readFile(join(this.paths.resources, "catalog.json"), "utf8")
      .then((contents) => catalogSchema.parse(JSON.parse(contents)).plugins)
      .catch(() => {
        this.report("Jellyfin bundled plugin catalog is unavailable");
        return [];
      });
    const plugins = await this.catalog;
    const state: JellyfinPluginState = {
      serverId: server.id,
      serverVersion: null,
      access: "unreachable",
      local: this.isLocal(server.url),
      directory: null,
      directorySource: null,
      pendingRestart: false,
      canRestart: false,
      plugins: [],
    };
    const result: Snapshot = { state, plugins, installed: null, online: new Map() };
    const saved = (await this.readJournal())[server.id];
    const remembered = saved?.url === server.url ? saved : undefined;
    state.pendingRestart = !!remembered?.pending.length;
    let info: ServerInfo | undefined;
    try {
      const response = await this.request(server)("System/Info/Public");
      if (!response.ok) throw new Error();
      info = serverInfoSchema.parse(await response.json());
      if (info.ProductName !== "Jellyfin Server" && info.ProductName !== "Jellyfin")
        throw new Error();
      state.serverVersion = info.Version;
      if (remembered?.jellyfinId !== info.Id) state.pendingRestart = false;
      result.info = info;
      result.record =
        remembered?.jellyfinId === info.Id
          ? remembered
          : { url: server.url, jellyfinId: info.Id, pending: [] };
      state.access = "unauthenticated";
      const token = await this.getToken(server, info.Id);
      if (token) {
        const request = this.request(server, token);
        const response = await request("Plugins");
        if (response.status === 401) state.access = "unauthenticated";
        else if (response.status === 403) state.access = "forbidden";
        else if (!response.ok) state.error = "state-unavailable";
        else {
          result.installed = installedSchema.parse(await response.json());
          result.request = request;
          state.access = "admin";
          const system = await request("System/Info");
          if (system.ok) {
            const details = serverInfoSchema.parse(await system.json());
            if (details.Id !== info.Id) throw new Error("Selected Jellyfin changed");
            info = details;
            result.info = details;
          }
        }
      }
    } catch {
      state.error = "state-unavailable";
      state.access = "unreachable";
      result.request = undefined;
      result.installed = null;
    }
    if (state.access === "admin" && state.local && info) {
      if (info.ProgramDataPath && localAbsolutePath(info.ProgramDataPath)) {
        state.directory = await pluginDirectory(join(info.ProgramDataPath, "plugins"));
        if (state.directory) state.directorySource = "server";
      }
      if (!state.directory && result.record?.directory) {
        state.directory = await pluginDirectory(result.record.directory, true);
        if (state.directory) state.directorySource = "manual";
      }
      if (!state.directory) {
        state.directory = await processPluginDirectory(server.url);
        if (state.directory) state.directorySource = "process";
      }
    }
    const disk = state.directory
      ? await inspectPluginDirectory(state.directory).catch(() => null)
      : null;
    const installed = result.installed;
    if (installed && result.record?.pending.length && info?.HasPendingRestart === false) {
      const pending = result.record.pending.filter((change) => {
        const plugin = exact(installed, change.pluginId, change.version);
        if (change.action === "uninstall") return !!plugin;
        if (change.action === "offline-install" && !plugin && disk && !disk.unknown)
          return disk.versions.some(
            ({ id, version }) => id === change.pluginId && version === change.version,
          );
        return !plugin || status(plugin.Status) === "restart";
      });
      if (pending.length !== result.record.pending.length) {
        result.record = { ...result.record, pending };
        await this.saveRecord(server.id, result.record);
      }
      state.pendingRestart = pending.length > 0;
    }
    state.canRestart = state.pendingRestart && !!result.request && info?.CanSelfRestart !== false;
    let repositories: Promise<string[]> | undefined;
    const request = result.request;
    // Native catalog reads reconcile installed manifests in Jellyfin, which can undo a scheduled deletion.
    const foreignDataPath =
      info?.ProgramDataPath &&
      (process.platform === "win32"
        ? /^\/(?!\/)/.test(info.ProgramDataPath)
        : /^[a-z]:[/\\]/i.test(info.ProgramDataPath));
    const canReadCatalog =
      request &&
      !installed?.some(({ Status }) => status(Status) === "deleted") &&
      !result.record?.pending.some(({ action }) => action === "uninstall") &&
      ((!state.directory && (!state.local || foreignDataPath)) || (disk && !disk.unknown));
    state.plugins = await Promise.all(
      plugins.map(async (plugin) => {
        const eligible = !!state.serverVersion && compatible(state.serverVersion, plugin.targetAbi);
        const bundled = await payloadPresent(this.paths.resources, plugin);
        const known = (installed ?? []).filter(({ Id }) => Id === plugin.id);
        const onDisk = disk?.versions.filter(({ id }) => id === plugin.id) ?? [];
        const versions = known.map((item) => ({
          version: item.Version,
          status: status(item.Status),
          canThoroughUninstall:
            process.platform === "win32" &&
            !!result.request &&
            onDisk.some(({ version }) => version === item.Version),
        }));
        for (const item of onDisk) {
          if (!versions.some(({ version }) => version === item.version))
            versions.push({
              version: item.version,
              status: result.record?.pending.some(
                (entry) =>
                  entry.pluginId === plugin.id &&
                  entry.version === item.version &&
                  entry.action === "offline-install",
              )
                ? "pending-install"
                : "unknown",
              canThoroughUninstall: process.platform === "win32" && !!result.request,
            });
        }
        const missingDependencies = plugin.dependencies.flatMap((dependency) => {
          const id = dependency.toLowerCase();
          const approved =
            plugins.find((entry) => entry.id === id) ?? plugin.externalDependencies[id];
          const version = approved?.version ?? "0.0.0.0";
          const expected = versionParts(version);
          const versionMatches = (value: string) => {
            const actual = versionParts(value);
            return actual[0] === expected[0] && versionAtLeast(actual, expected);
          };
          const listed = installed?.some(
            ({ Id, Version, Status }) =>
              Id === id &&
              versionMatches(Version) &&
              ["active", "restart"].includes(status(Status)) &&
              !result.record?.pending.some(
                (entry) =>
                  entry.pluginId === id &&
                  entry.version === Version &&
                  entry.action === "uninstall",
              ),
          );
          const queued = result.record?.pending.some(
            (entry) =>
              entry.pluginId === id &&
              entry.action === "offline-install" &&
              versionMatches(entry.version) &&
              disk?.versions.some((item) => item.id === id && item.version === entry.version),
          );
          return listed || queued ? [] : [{ id, name: approved?.name ?? id, version }];
        });
        let installation: "online" | "offline" | null = null;
        if (
          eligible &&
          result.request &&
          versions.length === 0 &&
          missingDependencies.length === 0 &&
          !result.record?.pending.some(({ pluginId }) => pluginId === plugin.id)
        ) {
          let repository: string | undefined;
          if (
            canReadCatalog &&
            plugin.sourceSha256 &&
            plugin.repositoryUrl &&
            !(bundled && disk && !disk.unknown)
          ) {
            repositories ??= request("Repositories")
              .then(async (response) =>
                response.ok
                  ? repositoriesSchema
                      .parse(await response.json())
                      .flatMap(({ Url, Enabled }) => (Url && Enabled ? [Url] : []))
                  : [],
              )
              .catch(() => []);
            repository = (await repositories).find((url) => url === plugin.repositoryUrl);
          }
          if (repository) {
            result.online.set(plugin.id, repository);
            installation = "online";
          } else if (bundled && disk && !disk.unknown) installation = "offline";
        }
        return {
          id: plugin.id,
          version: plugin.version,
          name: plugin.name,
          description: plugin.description,
          nameEn: plugin.nameEn,
          descriptionEn: plugin.descriptionEn,
          customized: plugin.customized,
          missingDependencies,
          compatible: eligible,
          bundled,
          installation,
          recommendedConfiguration:
            !!plugin.recommendedConfiguration &&
            !!state.directory &&
            (installation === "offline" ||
              (installation === "online" && state.directorySource !== "manual")),
          installed: versions,
        };
      }),
    );
    return result;
  }

  private async execute(server: Server, action: Action): Promise<JellyfinPluginState> {
    const snapshot = await this.snapshot(server);
    const { state, record, request } = snapshot;
    if (action.type === "get") return state;
    const error = (code: JellyfinPluginError) => ({ ...state, error: code });
    const removal = await this.thorough.run(server, { type: "get" });
    if (removal && removal.phase !== "complete") return error("not-available");
    if (!request || !record || !this.isCurrent(server)) return error("not-available");
    if (action.type === "directory") {
      if (!state.local) return error("not-available");
      const selected = await this.chooseDirectory(state.directory ?? undefined);
      if (!selected) return { ...state, result: "canceled" };
      const directory = await pluginDirectory(selected, true);
      if (!directory || !this.isCurrent(server)) return error("directory-invalid");
      await this.saveRecord(server.id, { ...record, directory });
      return (await this.snapshot(server)).state;
    }
    if (action.type === "restart") return this.restart(server, snapshot, request);
    if (!("pluginId" in action)) return error("not-available");
    const plugin = snapshot.plugins.find(({ id }) => id === action.pluginId);
    const display = state.plugins.find(({ id }) => id === action.pluginId);
    if (!plugin || !display) return error("not-available");
    if (display.installed.length > 0) return error("plugin-exists");
    try {
      if (display.installation === "online") {
        if (!(await this.verifyApprovedDownload(plugin))) return error("install-failed");
        const recheck = await request("Plugins");
        if (!recheck.ok) return error("install-failed");
        const installed = installedSchema.parse(await recheck.json());
        if (installed.some(({ Id }) => Id === plugin.id)) return error("plugin-exists");
        if (installed.some(({ Status }) => status(Status) === "deleted") || !this.isCurrent(server))
          return error("not-available");
        if (state.directory) {
          const disk = await inspectPluginDirectory(state.directory);
          if (disk.unknown || disk.versions.some(({ id }) => id === plugin.id))
            return error("plugin-exists");
        }
        const repositoryUrl = snapshot.online.get(plugin.id);
        if (!repositoryUrl || !(await this.findExactPackage(request, plugin, repositoryUrl)))
          return error("not-available");
        if (!this.isCurrent(server)) return error("not-available");
        const query = new URLSearchParams({
          assemblyGuid: plugin.id,
          version: plugin.version,
          repositoryUrl,
        });
        await this.pending(server, record, {
          pluginId: plugin.id,
          version: plugin.version,
          action: "online-install",
        });
        const response = await request(
          `Packages/Installed/${encodeURIComponent(plugin.name)}?${query}`,
          "POST",
          45_000,
        );
        if (response.status !== 204) {
          if (response.status < 500) await this.saveRecord(server.id, record);
          return { ...(await this.snapshot(server)).state, error: "install-failed" };
        }
      } else if (display.installation === "offline" && state.directory) {
        await this.pending(server, record, {
          pluginId: plugin.id,
          version: plugin.version,
          action: "offline-install",
        });
        const copied = await copyApprovedPlugin(
          this.paths.resources,
          state.directory,
          plugin,
        ).catch(async (failure: unknown) => {
          await this.saveRecord(server.id, record);
          throw failure;
        });
        if (!copied) {
          await this.saveRecord(server.id, record);
          return error("plugin-exists");
        }
      } else return error("not-available");
    } catch {
      this.report("Jellyfin plugin installation failed");
      return { ...(await this.snapshot(server)).state, error: "install-failed" };
    }
    if (
      action.type === "install" &&
      action.useRecommendedConfiguration !== false &&
      display.recommendedConfiguration &&
      state.directory
    ) {
      try {
        if (!this.isCurrent(server)) throw new Error("Jellyfin instance changed");
        if (display.installation === "online") {
          const current = await this.snapshot(server);
          if (
            current.info?.Id !== snapshot.info?.Id ||
            current.state.directory !== state.directory ||
            current.state.directorySource === "manual" ||
            !(await inspectPluginDirectory(state.directory)).versions.some(
              ({ id, version }) => id === plugin.id && version === plugin.version,
            )
          )
            throw new Error("Jellyfin plugin installation could not be verified");
        }
        await copyRecommendedConfiguration(this.paths.resources, state.directory, plugin);
      } catch {
        this.report("Jellyfin recommended plugin configuration could not be applied");
        return {
          ...(await this.snapshot(server)).state,
          result: "changed",
          error: "recommended-configuration-failed",
        };
      }
    }
    return { ...(await this.snapshot(server)).state, result: "changed" };
  }

  private async restart(
    server: Server,
    snapshot: Snapshot,
    request: Request,
  ): Promise<JellyfinPluginState> {
    const { state, info } = snapshot;
    if (!state.canRestart || !info) return { ...state, error: "restart-failed" };
    try {
      if ((await request("System/Restart", "POST")).status !== 204)
        return { ...state, error: "restart-failed" };
    } catch {
      // Some service hosts close the connection before sending a response.
    }
    let disconnected = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && this.isCurrent(server)) {
      await delay(750);
      const response = await request("System/Info", "GET", 2500).catch(() => null);
      if (!response) {
        disconnected = true;
        continue;
      }
      try {
        if (!response.ok) {
          if ([502, 503, 504].includes(response.status)) disconnected = true;
          continue;
        }
        const returned = serverInfoSchema.parse(await response.json());
        if (returned.Id !== info.Id || returned.HasPendingRestart === true) continue;
        const plugins = await request("Plugins", "GET", 2500);
        if (!plugins.ok) continue;
        const loaded = installedSchema.parse(await plugins.json());
        const queued = snapshot.record?.pending ?? [];
        const offlineLoaded = queued.some(
          (entry) =>
            entry.action === "offline-install" && !!exact(loaded, entry.pluginId, entry.version),
        );
        if (
          !disconnected &&
          !offlineLoaded &&
          !(info.HasPendingRestart === true && returned.HasPendingRestart === false)
        )
          continue;
        const after = (await this.snapshot(server)).state;
        if (!after.pendingRestart && after.access === "admin") {
          const failed = queued.some(
            (entry) =>
              entry.action !== "uninstall" &&
              status(exact(loaded, entry.pluginId, entry.version)?.Status) !== "active",
          );
          if (failed) return { ...after, error: "plugin-load-failed" };
          return { ...after, result: "restarted" };
        }
      } catch {
        // Startup and reverse proxies can return an incomplete or non-JSON response.
      }
    }
    return { ...(await this.snapshot(server)).state, error: "restart-timeout" };
  }
}
