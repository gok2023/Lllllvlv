import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { Server } from "../../src/shared/types";
import type {
  JellyfinThoroughUninstallError,
  JellyfinThoroughUninstallSelection,
  JellyfinThoroughUninstallState,
} from "../../src/shared/jellyfin-plugins";
import {
  jellyfinGuid,
  pluginDirectory,
  pluginVersion,
  type CatalogPlugin,
} from "./jellyfin-plugin-files";

type Context = {
  local: boolean;
  admin: boolean;
  directory: string | null;
  jellyfinId?: string;
  catalog: CatalogPlugin[];
  installed: { Id: string; Version: string; Status?: string }[] | null;
  shutdown?: () => Promise<boolean>;
};

export type ThoroughAction =
  | { type: "get" | "continue" | "cancel" }
  | { type: "prepare"; selections: JellyfinThoroughUninstallSelection[] };

type Enqueue = (work: () => Promise<void>) => void;
type State = JellyfinThoroughUninstallState;

const run = promisify(execFile);
const processIdentity = z.object({
  pid: z.number().int().positive(),
  started: z.string().min(1),
});
const trayIdentity = processIdentity.extend({ executable: z.string().min(1) });
const processSchema = z.object({
  pid: z.number().int().positive(),
  started: z.string().min(1),
  executable: z.string().min(1),
  service: z.string().min(1).nullish(),
  tray: z.string().min(1).nullish(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish(),
  dataRoot: z.string().nullish(),
  trayProcess: trayIdentity.nullish(),
  trayArguments: z.boolean().optional(),
});
const selectionSchema = z.object({
  pluginId: jellyfinGuid,
  version: pluginVersion,
  name: z.string(),
  paths: z.array(z.object({ originalPath: z.string(), backupPath: z.string() })).min(1),
});
const recordSchema = z.object({
  url: z.string(),
  jellyfinId: z.string(),
  directory: z.string(),
  backupDirectory: z.string(),
  phase: z.enum(["confirm", "stop-manually", "start-manually", "complete"]),
  process: processSchema,
  launched: processIdentity.optional(),
  acknowledged: z.boolean().optional(),
  startAttempted: z.boolean().optional(),
  selections: z.array(selectionSchema).min(1),
});
type Removal = z.infer<typeof recordSchema>;
const metadataSchema = z.object({ guid: jellyfinGuid, version: pluginVersion });
const fileTransformationId = "5e87cc92-571a-4d8d-8d98-d2d4147f9f90";
const pluginPagesId = "5b6550fa-a014-4f4c-8a2c-59a43680ac6d";

class UninstallError extends Error {
  constructor(readonly code: JellyfinThoroughUninstallError) {
    super(code);
  }
}

const windowsInspection = String.raw`
$ErrorActionPreference = 'Stop'
function Get-JellyfinDataRoot([string]$commandLine) {
  if ($commandLine -match '(?i)(?:^|\s)(?:--datadir|-d)(?:=|\s+)(?:"([^"]+)"|([^\s]+))') {
    $data = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    if ($data -match '^[A-Za-z]:[/\\]') {
      try { return [IO.Path]::GetFullPath($data).TrimEnd('\') } catch {}
    }
  }
  return $null
}
# Enumerate all listeners so an unused port is a successful empty result.
$owners = @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $env:FREEBO_JELLYFIN_PORT | Select-Object -ExpandProperty OwningProcess -Unique)
$target = $env:FREEBO_JELLYFIN_PID
if (!$target -and $owners.Count -eq 1) { $target = $owners[0] }
$process = if ($target) { Get-CimInstance Win32_Process -Filter "ProcessId = $target" }
$replacement = $false
if ($env:FREEBO_JELLYFIN_DATA) {
  $instances = @(Get-CimInstance Win32_Process -Filter "Name = 'jellyfin.exe'")
  foreach ($instance in $instances) {
    if ($instance.ProcessId -eq $target) { continue }
    $data = Get-JellyfinDataRoot $instance.CommandLine
    if ($data) {
      if ($data -ieq $env:FREEBO_JELLYFIN_DATA) { $replacement = $true }
    } elseif (!$instance.ExecutablePath -or $instance.ExecutablePath -ieq $env:FREEBO_JELLYFIN_EXECUTABLE) {
      # The same executable without an explicit data argument may be respawning with defaults.
      $replacement = $true
    }
  }
}
$serviceState = $null
if ($env:FREEBO_JELLYFIN_SERVICE) {
  $expectedService = @(Get-Service | Where-Object Name -eq $env:FREEBO_JELLYFIN_SERVICE)
  if ($expectedService.Count -eq 1) { $serviceState = [string]$expectedService[0].Status }
}
$record = $null
if ($process -and $process.Name -ieq 'jellyfin.exe' -and $process.ExecutablePath) {
  $service = $null
  $tray = $null
  $trayProcess = $null
  try {
    $matches = @(Get-CimInstance Win32_Service -Filter "ProcessId = $($process.ProcessId) AND State = 'Running'")
    if ($matches.Count -eq 1) { $service = $matches[0].Name }
    if (!$matches.Count -and $process.ParentProcessId -gt 0) {
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)"
      if ($parent -and $parent.CreationDate -le $process.CreationDate -and $parent.Name -ieq 'jellyfin.windows.tray.exe') {
        $tray = $parent.ExecutablePath
        if ($tray) {
          $trayProcess = @{ pid = $parent.ProcessId; started = $parent.CreationDate.ToUniversalTime().ToString('o'); executable = $tray }
        }
      }
      if ($parent -and $parent.CreationDate -le $process.CreationDate -and $parent.Name -iin @('nssm.exe', 'jellyfin-service.exe')) {
        $matches = @(Get-CimInstance Win32_Service -Filter "ProcessId = $($parent.ProcessId) AND State = 'Running'")
        if ($matches.Count -eq 1) { $service = $matches[0].Name }
      }
    }
  } catch {}
  $fingerprint = $null
  if ($process.CommandLine) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $fingerprint = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($process.CommandLine))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
  }
  $dataRoot = Get-JellyfinDataRoot $process.CommandLine
  $trayArguments = $process.CommandLine -match '(?i)^(?:"([^"]+)"|([^\s"]+))\s+--datadir\s+"([^"]+)"\s*$' -and
    ($Matches[1] -ieq $process.ExecutablePath -or $Matches[2] -ieq $process.ExecutablePath) -and
    $Matches[3] -ieq $dataRoot
  $record = @{ pid = $process.ProcessId; started = $process.CreationDate.ToUniversalTime().ToString('o'); executable = $process.ExecutablePath; service = $service; tray = $tray; trayProcess = $trayProcess; trayArguments = $trayArguments; fingerprint = $fingerprint; dataRoot = $dataRoot }
}
$expectedTray = if ($env:FREEBO_JELLYFIN_TRAY_PID) { Get-CimInstance Win32_Process -Filter "ProcessId = $env:FREEBO_JELLYFIN_TRAY_PID" }
$trayPresent = $expectedTray -and $expectedTray.ExecutablePath -ieq $env:FREEBO_JELLYFIN_TRAY_EXE -and
  $expectedTray.CreationDate.ToUniversalTime().ToString('o') -eq $env:FREEBO_JELLYFIN_TRAY_STARTED
ConvertTo-Json -InputObject @{ owners = $owners; pidPresent = [bool]$process; process = $record; replacement = $replacement; serviceState = $serviceState; trayPresent = [bool]$trayPresent } -Compress
`;

function trayEnvironment(tray: Removal["process"]["trayProcess"]) {
  return {
    FREEBO_JELLYFIN_TRAY_PID: tray ? String(tray.pid) : "",
    FREEBO_JELLYFIN_TRAY_EXE: tray?.executable ?? "",
    FREEBO_JELLYFIN_TRAY_STARTED: tray?.started ?? "",
  };
}

function listenerPort(url: string) {
  const parsed = new URL(url);
  return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
}

async function inspectProcess(url: string, pid?: number, original?: Removal) {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", windowsInspection],
      {
        timeout: 6000,
        windowsHide: true,
        env: {
          ...process.env,
          ...trayEnvironment(original?.process.trayProcess),
          FREEBO_JELLYFIN_PORT: listenerPort(url),
          FREEBO_JELLYFIN_PID: pid ? String(pid) : "",
          FREEBO_JELLYFIN_DATA: original ? dirname(original.directory) : "",
          FREEBO_JELLYFIN_EXECUTABLE: original?.process.executable ?? "",
          FREEBO_JELLYFIN_SERVICE: original?.process.service ?? "",
        },
      },
    );
    return z
      .object({
        owners: z.array(z.number().int().positive()),
        pidPresent: z.boolean(),
        process: processSchema.nullable(),
        replacement: z.boolean(),
        serviceState: z.string().nullable(),
        trayPresent: z.boolean(),
      })
      .parse(JSON.parse(stdout));
  } catch {
    return null;
  }
}

async function startService(service: string) {
  const script =
    "$ErrorActionPreference = 'Stop'; $services = @(Get-Service | Where-Object Name -eq $env:FREEBO_JELLYFIN_SERVICE); if ($services.Count -ne 1 -or $services[0].Status -ne 'Stopped') { throw 'Unexpected service state' }; Start-Service -InputObject $services[0]";
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 20_000,
    windowsHide: true,
    env: { ...process.env, FREEBO_JELLYFIN_SERVICE: service },
  });
}

const windowsTrayStart = String.raw`
$ErrorActionPreference = 'Stop'
$tray = Get-CimInstance Win32_Process -Filter "ProcessId = $env:FREEBO_JELLYFIN_TRAY_PID"
if (!$tray -or $tray.Name -ine 'jellyfin.windows.tray.exe' -or
    $tray.ExecutablePath -ine $env:FREEBO_JELLYFIN_TRAY_EXE -or
    $tray.CreationDate.ToUniversalTime().ToString('o') -ne $env:FREEBO_JELLYFIN_TRAY_STARTED -or
    $tray.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'Tray changed' }
$trayOwner = Invoke-CimMethod -InputObject $tray -MethodName GetOwnerSid
if ($trayOwner.ReturnValue -ne 0 -or $trayOwner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Different tray user' }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class FreeboElevation {
    [DllImport("advapi32", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int type, out int value, int size, out int length);
    [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
    public static int Get(IntPtr process) {
        IntPtr token;
        if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception();
        try {
            int elevation, size;
            if (!GetTokenInformation(token, 20, out elevation, 4, out size)) throw new Win32Exception();
            return elevation;
        } finally { CloseHandle(token); }
    }
}
'@
if ([FreeboElevation]::Get([Diagnostics.Process]::GetProcessById([int]$tray.ProcessId).Handle) -ne
    [FreeboElevation]::Get([Diagnostics.Process]::GetCurrentProcess().Handle)) { throw 'Different tray elevation' }
$registry = Get-ItemProperty -LiteralPath 'HKLM:\Software\WOW6432Node\Jellyfin\Server'
$executable = $env:FREEBO_JELLYFIN_EXECUTABLE
$data = $env:FREEBO_JELLYFIN_DATA
if ($executable -notmatch '^[A-Za-z]:\\' -or $data -notmatch '^[A-Za-z]:\\[^"]*[^\\"]$' -or
    (Join-Path $registry.InstallFolder 'jellyfin.exe') -ine $executable -or
    $registry.DataFolder -ine $data -or
    !(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Tray configuration changed' }
if (@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $env:FREEBO_JELLYFIN_PORT).Count -gt 0 -or
    @(Get-CimInstance Win32_Process -Filter "Name = 'jellyfin.exe'").Count -gt 0) {
  throw 'Jellyfin is already running or the port is in use'
}
# Match the official tray's executable-mode Start command while keeping the tray alive.
$startup = [Diagnostics.ProcessStartInfo]::new()
$startup.FileName = $executable
$startup.Arguments = '--datadir "' + $data + '"'
$startup.UseShellExecute = $true
$startup.CreateNoWindow = $true
$startup.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$started = [Diagnostics.Process]::Start($startup)
$instance = Get-CimInstance Win32_Process -Filter "ProcessId = $($started.Id)"
if (!$instance -or $instance.ExecutablePath -ine $executable) { throw 'Cannot identify started process' }
ConvertTo-Json -InputObject @{ pid = $instance.ProcessId; started = $instance.CreationDate.ToUniversalTime().ToString('o') } -Compress
`;

async function startTrayServer(record: Removal) {
  if (!record.process.trayProcess || !record.process.trayArguments || !record.process.dataRoot)
    throw new UninstallError("start-failed");
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", windowsTrayStart],
    {
      timeout: 12_000,
      windowsHide: true,
      env: {
        ...process.env,
        ...trayEnvironment(record.process.trayProcess),
        FREEBO_JELLYFIN_PORT: listenerPort(record.url),
        FREEBO_JELLYFIN_EXECUTABLE: record.process.executable,
        FREEBO_JELLYFIN_DATA: record.process.dataRoot,
      },
    },
  );
  return processIdentity.parse(JSON.parse(stdout));
}

async function localIdentity(directory: string, jellyfinId: string) {
  try {
    if ((await pluginDirectory(directory, true)) !== directory) return false;
    const identityPath = join(dirname(directory), "data", "device.txt");
    const entry = await lstat(identityPath);
    if (!entry.isFile() || entry.size > 256) return false;
    return (
      jellyfinGuid.safeParse((await readFile(identityPath, "utf8")).trim()).data ===
      jellyfinGuid.parse(jellyfinId)
    );
  } catch {
    return false;
  }
}

async function metadata(path: string) {
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path) return null;
  const file = join(path, "meta.json");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 128 * 1024) return null;
  return (
    metadataSchema.safeParse(JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")))
      .data ?? null
  );
}

async function diskPackages(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  const packages = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase() !== "configurations")
      .map(async (entry) => {
        const path = join(directory, entry.name);
        const identity = await metadata(path).catch(() => null);
        return identity ? { ...identity, path } : null;
      }),
  );
  return packages.filter((entry) => entry !== null);
}

async function accessible(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

function publicState(
  server: Server,
  removal: Removal,
  error?: JellyfinThoroughUninstallError,
  phase: State["phase"] = removal.phase,
): JellyfinThoroughUninstallState {
  return {
    serverId: server.id,
    phase,
    mode: removal.process.service ? "service" : removal.process.tray ? "tray" : "manual",
    selections: removal.selections,
    backupDirectory: removal.backupDirectory,
    error,
  };
}

export class JellyfinThoroughUninstall {
  private readonly active = new Map<string, State["phase"]>();
  private readonly errors = new Map<string, JellyfinThoroughUninstallError>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly journalPath: string,
    private readonly inspect: (server: Server) => Promise<Context>,
    private readonly isCurrent: (server: Server) => boolean,
  ) {}

  private async read() {
    try {
      return z
        .record(z.string(), recordSchema)
        .parse(JSON.parse(await readFile(this.journalPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      // A corrupt journal may describe a partial move. Preserve it for recovery.
      throw error;
    }
  }

  private async save(serverId: string, record: Removal | null) {
    const records = await this.read();
    if (record) records[serverId] = record;
    else delete records[serverId];
    const temporary = `${this.journalPath}.tmp`;
    await writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
    await rename(temporary, this.journalPath);
  }

  async run(
    server: Server,
    action: ThoroughAction,
    enqueue?: Enqueue,
  ): Promise<JellyfinThoroughUninstallState | null> {
    const current = (await this.read())[server.id];
    if (action.type === "get" || action.type === "continue") {
      if (!current || current.acknowledged) return null;
      if (current.url !== server.url || !this.isCurrent(server))
        return publicState(server, current, "state-changed");
      if (enqueue && !this.active.has(server.id)) {
        if (action.type === "continue") this.schedule(server, current, enqueue, true);
        else this.monitor(server, current, enqueue);
      }
      return publicState(server, current, this.errors.get(server.id), this.active.get(server.id));
    }
    if (action.type === "prepare") {
      if (current && current.phase !== "complete") return publicState(server, current);
      try {
        const next = await this.prepare(server, action.selections, current);
        await this.save(server.id, next);
        this.errors.delete(server.id);
        return publicState(server, next);
      } catch (error) {
        return {
          serverId: server.id,
          phase: "error",
          mode: "manual",
          selections: [],
          backupDirectory: null,
          error: error instanceof UninstallError ? error.code : "identity-unverified",
        };
      }
    }
    if (!current) return null;
    if (action.type === "cancel") {
      if (this.active.has(server.id)) return publicState(server, current);
      const listener =
        current.phase === "stop-manually" && !(await accessible(current.backupDirectory))
          ? await inspectProcess(current.url, current.process.pid)
          : null;
      const mayCancel =
        current.phase === "confirm" ||
        current.phase === "complete" ||
        (listener?.process?.started === current.process.started &&
          listener.owners.includes(current.process.pid));
      if (!mayCancel) return publicState(server, current, "state-changed");
      await this.save(
        server.id,
        current.phase === "complete" && current.launched
          ? { ...current, acknowledged: true }
          : null,
      );
      this.errors.delete(server.id);
      return null;
    }
    return null;
  }

  private monitor(server: Server, record: Removal, enqueue: Enqueue) {
    if (this.timers.has(server.id) || this.active.has(server.id)) return;
    const error = this.errors.get(server.id);
    if (
      record.phase !== "start-manually" &&
      (record.phase !== "stop-manually" || (error && error !== "exit-unverified"))
    )
      return;
    const timer = setTimeout(() => {
      this.timers.delete(server.id);
      if (this.isCurrent(server)) this.schedule(server, record, enqueue, false);
    }, 3_000);
    timer.unref();
    this.timers.set(server.id, timer);
  }

  private schedule(server: Server, record: Removal, enqueue: Enqueue, interactive: boolean) {
    if (record.phase === "complete" || this.active.has(server.id)) return;
    clearTimeout(this.timers.get(server.id));
    this.timers.delete(server.id);
    this.active.set(
      server.id,
      interactive ? (record.phase === "start-manually" ? "verifying" : "stopping") : record.phase,
    );
    if (interactive) this.errors.delete(server.id);
    enqueue(async () => {
      let next: Removal | undefined;
      try {
        next = (await this.read())[server.id];
        if (!next || next.url !== server.url || !this.isCurrent(server)) return;
        await this.advance(server, next, interactive);
      } catch (error) {
        this.errors.set(server.id, error instanceof UninstallError ? error.code : "state-changed");
      } finally {
        this.active.delete(server.id);
        const latest = await this.read().catch(() => null);
        next = latest?.[server.id];
        if (next?.url === server.url && this.isCurrent(server)) this.monitor(server, next, enqueue);
      }
    });
  }

  private async prepare(
    server: Server,
    selected: JellyfinThoroughUninstallSelection[],
    previous?: Removal,
  ) {
    if (!this.isCurrent(server)) throw new UninstallError("state-changed");
    const context = await this.inspect(server);
    if (!context.local) throw new UninstallError("not-local");
    if (!context.admin || !context.installed) throw new UninstallError("not-admin");
    const { directory, jellyfinId } = context;
    if (!directory) throw new UninstallError("directory-unavailable");
    if (!jellyfinId || !(await localIdentity(directory, jellyfinId)))
      throw new UninstallError("identity-unverified");
    const listener = await inspectProcess(server.url, undefined, previous);
    if (
      !listener?.process ||
      listener.owners.length !== 1 ||
      listener.process.pid !== listener.owners[0] ||
      (listener.process.dataRoot &&
        listener.process.dataRoot.toLowerCase() !== dirname(directory).toLowerCase())
    )
      throw new UninstallError("identity-unverified");
    const process = listener.process;
    if (
      !process.service &&
      !process.tray &&
      previous?.url === server.url &&
      previous.launched?.pid === process.pid &&
      previous.launched.started === process.started &&
      listener.trayPresent
    ) {
      process.tray = previous.process.tray;
      process.trayProcess = previous.process.trayProcess;
    }
    const disk = await diskPackages(directory);
    // A sibling of plugins stays on the same volume and outside Jellyfin's plugin discovery.
    const backupDirectory = join(dirname(directory), `freebo-plugin-backup-${randomUUID()}`);
    const selections = selected.map((item) => {
      const plugin = context.catalog.find(({ id }) => id === item.pluginId);
      const matches = disk.filter(
        ({ guid, version }) => guid === item.pluginId && version === item.version,
      );
      if (!plugin || matches.length === 0) throw new UninstallError("selection-not-found");
      return {
        ...item,
        name: plugin.name,
        paths: matches.map(({ path }) => ({
          originalPath: path,
          backupPath: join(backupDirectory, basename(path)),
        })),
      };
    });
    this.checkDependencies(selections, context, disk);
    if (!this.isCurrent(server)) throw new UninstallError("state-changed");
    return {
      url: server.url,
      jellyfinId,
      directory,
      backupDirectory,
      process,
      phase: "confirm" as const,
      selections,
    };
  }

  private checkDependencies(
    selections: Removal["selections"],
    context: Context,
    disk: Awaited<ReturnType<typeof diskPackages>>,
  ) {
    const removing = (id: string, version: string) =>
      selections.some((entry) => entry.pluginId === id && entry.version === version);
    const remaining = [
      ...disk.map(({ guid, version }) => ({ id: guid, version })),
      ...(context.installed ?? []).map(({ Id, Version }) => ({ id: Id, version: Version })),
    ].filter(({ id, version }) => !removing(id, version));
    const relationships = [
      ...context.catalog,
      { id: pluginPagesId, dependencies: [fileTransformationId] },
    ];
    for (const entry of selections) {
      if (
        relationships.some(
          ({ id, dependencies }) =>
            dependencies.includes(entry.pluginId) && remaining.some((plugin) => plugin.id === id),
        )
      )
        throw new UninstallError("dependency-in-use");
    }
  }

  private async hasExited(server: Server, record: Removal) {
    const inspection = await inspectProcess(server.url, record.process.pid, record);
    return (
      !!inspection &&
      !inspection.pidPresent &&
      !inspection.replacement &&
      inspection.owners.length === 0 &&
      (!record.process.service || inspection.serviceState === "Stopped")
    );
  }

  private async waitForExit(server: Server, record: Removal) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && this.isCurrent(server)) {
      if (await this.hasExited(server, record)) return true;
      await delay(500);
    }
    return false;
  }

  private async verifyAfterStart(server: Server, record: Removal) {
    if (!this.isCurrent(server)) return false;
    const listener = await inspectProcess(server.url, undefined, record);
    const running = listener?.process;
    if (
      !running ||
      listener.owners.length !== 1 ||
      running.started <= record.process.started ||
      running.executable.toLowerCase() !== record.process.executable.toLowerCase() ||
      (running.dataRoot ?? undefined)?.toLowerCase() !== record.process.dataRoot?.toLowerCase() ||
      (running.service ?? null) !== (record.process.service ?? null)
    )
      return false;
    const launched =
      !!record.launched &&
      running.pid === record.launched.pid &&
      running.started === record.launched.started &&
      !!running.trayArguments &&
      listener.trayPresent;
    if (!launched && running.tray?.toLowerCase() !== record.process.tray?.toLowerCase())
      return false;
    const context = await this.inspect(server);
    if (
      !context.admin ||
      context.jellyfinId !== record.jellyfinId ||
      context.directory !== record.directory ||
      !context.installed ||
      context.installed.some(({ Id, Version }) =>
        record.selections.some(({ pluginId, version }) => pluginId === Id && version === Version),
      )
    )
      return false;
    const disk = await diskPackages(record.directory).catch(() => null);
    if (
      !disk ||
      disk.some(({ guid, version }) =>
        record.selections.some((item) => item.pluginId === guid && item.version === version),
      ) ||
      !(await localIdentity(record.directory, record.jellyfinId)) ||
      !this.isCurrent(server)
    )
      return false;
    await this.validatePaths(record, true);
    await this.save(server.id, {
      ...record,
      launched: launched ? record.launched : undefined,
      phase: "complete",
    });
    this.errors.delete(server.id);
    return true;
  }

  private async restart(server: Server, record: Removal) {
    if (record.startAttempted !== false || (!record.process.service && !record.process.tray)) {
      await this.verifyAfterStart(server, record);
      return;
    }
    this.active.set(server.id, "starting");
    if (!this.isCurrent(server) || !(await this.hasExited(server, record))) {
      if (!(await this.verifyAfterStart(server, record))) throw new UninstallError("start-failed");
      return;
    }
    record = { ...record, startAttempted: true };
    await this.save(server.id, record);
    if (record.process.service) {
      await startService(record.process.service).catch(() => {
        throw new UninstallError("start-failed");
      });
    } else {
      const launched = await startTrayServer(record).catch(() => {
        throw new UninstallError("start-failed");
      });
      record = { ...record, launched };
      await this.save(server.id, record);
    }
    this.active.set(server.id, "verifying");
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && this.isCurrent(server)) {
      if (await this.verifyAfterStart(server, record)) return;
      await delay(750);
    }
    throw new UninstallError("verification-failed");
  }

  private async advance(server: Server, record: Removal, interactive: boolean) {
    if (record.phase === "complete") return;
    if (record.phase === "start-manually") return this.restart(server, record);
    if (record.phase === "confirm" && !interactive) return;
    const exited = record.phase === "stop-manually" && (await this.hasExited(server, record));
    if (interactive && !exited) {
      const context = await this.inspect(server);
      const listener = await inspectProcess(server.url, record.process.pid, record);
      if (
        !context.admin ||
        context.jellyfinId !== record.jellyfinId ||
        context.directory !== record.directory ||
        listener?.owners.length !== 1 ||
        listener.owners[0] !== record.process.pid ||
        listener.process?.started !== record.process.started ||
        listener.process.service !== record.process.service ||
        (listener.process.tray !== record.process.tray && !listener.trayPresent) ||
        listener.process.fingerprint !== record.process.fingerprint ||
        !(await localIdentity(record.directory, record.jellyfinId))
      )
        throw new UninstallError(record.phase === "confirm" ? "state-changed" : "exit-unverified");
      this.checkDependencies(record.selections, context, await diskPackages(record.directory));
      if (record.phase === "confirm") {
        if (await accessible(record.backupDirectory)) throw new UninstallError("state-changed");
        await this.validatePaths(record);
        record = { ...record, phase: "stop-manually" };
        await this.save(server.id, record);
      }
      if (!this.isCurrent(server)) throw new UninstallError("state-changed");
      this.active.set(server.id, "stopping");
      try {
        await context.shutdown?.();
      } catch {
        // The server can close the API connection during shutdown.
      }
      if (!(await this.waitForExit(server, record))) throw new UninstallError("exit-unverified");
    }
    if (!interactive && !exited) return;
    await this.move(server, record);
    record = { ...record, phase: "start-manually", startAttempted: false };
    await this.save(server.id, record);
    this.errors.delete(server.id);
    await this.restart(server, record);
  }

  private async move(server: Server, record: Removal) {
    this.active.set(server.id, "moving");
    try {
      if (!(await this.hasExited(server, record))) throw new UninstallError("exit-unverified");
      if (!(await localIdentity(record.directory, record.jellyfinId)) || !this.isCurrent(server))
        throw new UninstallError("state-changed");
      this.checkDependencies(
        record.selections,
        {
          catalog: (await this.inspect(server)).catalog,
          local: true,
          admin: false,
          directory: null,
          installed: null,
        },
        await diskPackages(record.directory),
      );
      await this.validatePaths(record);
      await mkdir(record.backupDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (
        (await realpath(record.backupDirectory)) !== record.backupDirectory ||
        !(await lstat(record.backupDirectory)).isDirectory()
      )
        throw new UninstallError("move-failed");
      for (const item of record.selections) {
        for (const path of item.paths) {
          if (!this.isCurrent(server)) throw new UninstallError("state-changed");
          if (!(await this.hasExited(server, record))) throw new UninstallError("exit-unverified");
          if (!(await accessible(path.originalPath))) continue; // Verified prior move in validatePaths.
          if (await accessible(path.backupPath)) throw new UninstallError("move-failed");
          const info = await metadata(path.originalPath);
          if (info?.guid !== item.pluginId || info.version !== item.version)
            throw new UninstallError("state-changed");
          await rename(path.originalPath, path.backupPath);
        }
      }
    } catch (error) {
      throw error instanceof UninstallError ? error : new UninstallError("move-failed");
    }
  }

  private async validatePaths(record: Removal, moved = false) {
    if (
      dirname(record.backupDirectory) !== dirname(record.directory) ||
      !/^freebo-plugin-backup-[a-f0-9-]+$/i.test(basename(record.backupDirectory))
    )
      throw new UninstallError("state-changed");
    for (const item of record.selections) {
      for (const { originalPath, backupPath } of item.paths) {
        if (
          dirname(originalPath) !== record.directory ||
          dirname(backupPath) !== record.backupDirectory ||
          basename(originalPath) !== basename(backupPath) ||
          basename(originalPath).toLowerCase() === "configurations"
        )
          throw new UninstallError("state-changed");
        const source = await accessible(originalPath);
        const backup = await accessible(backupPath);
        if (source === backup || (moved && source)) throw new UninstallError("state-changed");
        const info = await metadata(source ? originalPath : backupPath);
        if (info?.guid !== item.pluginId || info.version !== item.version)
          throw new UninstallError("state-changed");
      }
    }
  }
}
