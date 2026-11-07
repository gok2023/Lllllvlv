import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { networkInterfaces, hostname } from "node:os";
import { hasPlaybackActivityColumns } from "./watch-statistics-playback-reporting";

const run = promisify(execFile);
type SavedPath = { serverId: string; origin: string; path: string; manual: boolean };
type ProcessInfo = { CommandLine?: string; ExecutablePath?: string; Name?: string };

export class WatchStatisticsPathLocator {
  private needsManualPath = new Set<string>();
  constructor(private readonly userDataPath: string) {}
  private key(serverId: string, serverUrl: string) {
    return `${serverId}\u0000${this.origin(serverUrl)}`;
  }
  markApiSuccess(serverId: string, serverUrl: string) {
    this.needsManualPath.delete(this.key(serverId, serverUrl));
  }
  private get configPath() {
    return join(this.userDataPath, "watch-statistics", "playback-reporting-paths.json");
  }
  private origin(serverUrl: string) {
    return new URL(serverUrl).href.replace(/\/+$/, "");
  }
  private async saved(): Promise<SavedPath[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.configPath, "utf8"));
      return Array.isArray(value)
        ? value.filter(
            (item): item is SavedPath =>
              !!item &&
              typeof item.serverId === "string" &&
              typeof item.origin === "string" &&
              typeof item.path === "string" &&
              typeof item.manual === "boolean",
          )
        : [];
    } catch {
      return [];
    }
  }
  private async save(entries: SavedPath[]) {
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, JSON.stringify(entries));
  }
  isLocal(url: string) {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === hostname().toLowerCase()
    )
      return true;
    return Object.values(networkInterfaces())
      .flat()
      .some((address) => address?.address.toLowerCase() === host);
  }
  validate(path: string): string {
    const file = resolve(path);
    if (process.platform !== "win32") throw new Error("本机数据库自动定位目前仅支持 Windows");
    if (!/playback_reporting\.db$/i.test(file))
      throw new Error("请选择 Playback Reporting 数据库文件");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(PlaybackActivity)").all() as { name: string }[];
      const names = new Set(columns.map((column) => column.name));
      if (!hasPlaybackActivityColumns(names))
        throw new Error("所选文件不是有效的 Playback Reporting 数据库");
    } finally {
      db.close();
    }
    return file;
  }
  async setManual(serverId: string, serverUrl: string, path: string): Promise<string> {
    if (!this.isLocal(serverUrl)) throw new Error("远程 Jellyfin 不能使用本机数据库");
    const valid = this.validate(path);
    const entries = (await this.saved()).filter(
      (item) => item.serverId !== serverId || item.origin !== this.origin(serverUrl),
    );
    entries.push({ serverId, origin: this.origin(serverUrl), path: valid, manual: true });
    await this.save(entries);
    this.needsManualPath.delete(this.key(serverId, serverUrl));
    return valid;
  }
  async clearManual(serverId: string, serverUrl: string): Promise<void> {
    await this.save(
      (await this.saved()).filter(
        (item) => item.serverId !== serverId || item.origin !== this.origin(serverUrl),
      ),
    );
  }
  async status(serverId: string, serverUrl: string) {
    const entry = (await this.saved()).find(
      (item) => item.serverId === serverId && item.origin === this.origin(serverUrl),
    );
    return {
      local: this.isLocal(serverUrl),
      path: entry?.path,
      manual: entry?.manual ?? false,
      needsManualPath: this.needsManualPath.has(this.key(serverId, serverUrl)),
    };
  }
  async discover(
    serverId: string,
    serverUrl: string,
    force = false,
    programDataPath?: string,
  ): Promise<string> {
    if (!this.isLocal(serverUrl))
      throw new Error("Playback Reporting 接口不可用；远程服务器不能读取本机数据库");
    if (process.platform !== "win32") throw new Error("本机数据库自动定位目前仅支持 Windows");
    const entries = await this.saved();
    const saved = entries.find(
      (item) => item.serverId === serverId && item.origin === this.origin(serverUrl),
    );
    if (saved?.manual && !force) {
      try {
        const valid = this.validate(saved.path);
        this.needsManualPath.delete(this.key(serverId, serverUrl));
        return valid;
      } catch {
        /* An old manual selection may have moved. */
      }
    }
    const url = new URL(serverUrl);
    if (programDataPath) {
      try {
        const valid = this.validate(join(programDataPath, "data", "playback_reporting.db"));
        await this.save([
          ...entries.filter(
            (item) => item.serverId !== serverId || item.origin !== this.origin(serverUrl),
          ),
          { serverId, origin: this.origin(serverUrl), path: valid, manual: false },
        ]);
        this.needsManualPath.delete(this.key(serverId, serverUrl));
        return valid;
      } catch {
        /* Continue with process configuration and saved path. */
      }
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const script = `$port = ${port}; $owners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); $items = @($owners | ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId = $_" -ErrorAction SilentlyContinue | Select-Object Name,CommandLine,ExecutablePath }); ConvertTo-Json -InputObject $items -Compress`;
    let processes: ProcessInfo[] = [];
    try {
      const { stdout } = await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 8000, windowsHide: true },
      );
      const parsed: unknown = JSON.parse(stdout);
      processes = Array.isArray(parsed) ? (parsed as ProcessInfo[]) : [];
    } catch {
      /* No accessible local listener. */
    }
    const owner = processes.find(
      (item) =>
        /jellyfin/i.test(item.Name ?? "") || /jellyfin(?:\.exe)?/i.test(item.ExecutablePath ?? ""),
    );
    if (!owner) {
      this.needsManualPath.add(this.key(serverId, serverUrl));
      throw new Error(
        "无法核实当前端口对应的本机 Jellyfin 进程，请手动选择 Playback Reporting 数据库或检查服务连接",
      );
    }
    const candidates: string[] = [];
    const command = owner.CommandLine ?? "";
    const option = command.match(
      /(?:^|\s)(?:--datadir|-d)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i,
    );
    if (option) candidates.push(option[1] ?? option[2] ?? option[3]);
    if (process.env.JELLYFIN_DATA_DIR) candidates.push(process.env.JELLYFIN_DATA_DIR);
    try {
      const { stdout } = await run(
        "reg.exe",
        ["query", "HKLM\\SOFTWARE\\WOW6432Node\\Jellyfin\\Server", "/v", "DataFolder"],
        { timeout: 3000, windowsHide: true },
      );
      const match = stdout.match(/DataFolder\s+REG_\w+\s+(.+)/i);
      if (match) candidates.push(match[1].trim());
    } catch {
      /* Registry setting is optional. */
    }
    if (process.env.ProgramData)
      candidates.push(join(process.env.ProgramData, "Jellyfin", "Server"));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "jellyfin"));
    if (saved && !force) candidates.push(saved.path);
    for (const candidate of candidates) {
      const path = /playback_reporting\.db$/i.test(candidate)
        ? candidate
        : join(candidate, "data", "playback_reporting.db");
      try {
        const valid = this.validate(path);
        if (!saved || saved.path !== valid) {
          await this.save([
            ...entries.filter(
              (item) => item.serverId !== serverId || item.origin !== this.origin(serverUrl),
            ),
            { serverId, origin: this.origin(serverUrl), path: valid, manual: false },
          ]);
        }
        this.needsManualPath.delete(this.key(serverId, serverUrl));
        return valid;
      } catch {
        /* Try the next known configuration source. */
      }
    }
    this.needsManualPath.add(this.key(serverId, serverUrl));
    throw new Error("无法自动定位 Playback Reporting 数据库，请手动选择数据库文件");
  }
}
