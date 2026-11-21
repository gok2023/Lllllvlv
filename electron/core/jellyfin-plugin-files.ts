import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
export const pluginVersion = z.string().regex(/^\d{1,9}(\.\d{1,9}){1,3}$/);
export const jellyfinGuid = z
  .string()
  .toLowerCase()
  .transform((value) =>
    value.replace(
      /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/,
      "$1-$2-$3-$4-$5",
    ),
  )
  .pipe(z.guid());
const simpleName = z.string().regex(/^[\w][\w. ()+-]*[\w.)]$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const catalogSchema = z.object({
  plugins: z.array(
    z.object({
      id: z.guid().transform((value) => value.toLowerCase()),
      name: z.string().min(1),
      description: z.string(),
      version: pluginVersion,
      targetAbi: pluginVersion,
      folder: simpleName,
      files: z.record(simpleName, sha256),
      recommendedConfiguration: z
        .object({
          filename: z.string().regex(/^Jellyfin\.Plugin\.[A-Za-z]+\.xml$/),
          sha256,
        })
        .optional(),
      dependencies: z.array(z.guid()).default([]),
      externalDependencies: z
        .record(
          z.guid(),
          z.object({
            name: z.string(),
            version: pluginVersion,
          }),
        )
        .default({}),
      sourceUrl: z.url().optional(),
      repositoryUrl: z.url().optional(),
      checksum: z
        .string()
        .regex(/^[0-9a-f]{32}$/i)
        .optional(),
      sourceSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      nameEn: z.string().optional(),
      descriptionEn: z.string().optional(),
      customized: z.boolean().default(false),
    }),
  ),
});
export type CatalogPlugin = z.infer<typeof catalogSchema>["plugins"][number];

const diskMetadata = z.object({
  guid: jellyfinGuid,
  version: pluginVersion,
  targetAbi: pluginVersion.optional(),
});

export function localAbsolutePath(path: string) {
  return isAbsolute(path) && (process.platform !== "win32" || /^[a-z]:[/\\]/i.test(path));
}

export async function pluginDirectory(path: string | undefined, manual = false) {
  if (!path || !localAbsolutePath(path)) return null;
  try {
    if (!(await lstat(path)).isDirectory()) return null;
    const directory = await realpath(path);
    if (basename(directory).toLowerCase() !== "plugins") return null;
    if (manual && !(await lstat(join(dirname(directory), "data"))).isDirectory()) return null;
    return directory;
  } catch {
    return null;
  }
}

export async function processPluginDirectory(serverUrl: string) {
  if (process.platform !== "win32") return null;
  const url = new URL(serverUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const script =
    `$owners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique); ` +
    '$items = @($owners | ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId = $_" | Select-Object Name,CommandLine }); ConvertTo-Json -InputObject $items -Compress';
  try {
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        timeout: 3500,
        windowsHide: true,
      },
    );
    const owners = z
      .array(z.object({ Name: z.string(), CommandLine: z.string().nullable() }))
      .parse(JSON.parse(stdout));
    if (owners.length !== 1 || owners[0].Name.toLowerCase() !== "jellyfin.exe") return null;
    const option = owners[0].CommandLine?.match(
      /(?:^|\s)(?:--datadir|-d)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i,
    );
    const data = option && (option[1] ?? option[2] ?? option[3]);
    return data && localAbsolutePath(data) ? pluginDirectory(join(data, "plugins")) : null;
  } catch {
    return null;
  }
}

export async function inspectPluginDirectory(directory: string) {
  const versions: { id: string; version: string; targetAbi?: string; folder: string }[] = [];
  const names = new Set<string>();
  let unknown = false;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    names.add(item.name.toLowerCase());
    if (item.name.toLowerCase() === "configurations") continue;
    if (item.isSymbolicLink()) {
      unknown = true;
      continue;
    }
    if (!item.isDirectory()) continue;
    const folder = join(directory, item.name);
    const metadata = join(folder, "meta.json");
    try {
      if (!(await lstat(metadata)).isFile()) throw new Error("Invalid plugin metadata");
      const parsed = diskMetadata.parse(
        JSON.parse((await readFile(metadata, "utf8")).replace(/^\uFEFF/, "")),
      );
      versions.push({
        id: parsed.guid,
        version: parsed.version,
        targetAbi: parsed.targetAbi,
        folder: item.name,
      });
    } catch {
      // A directory with assemblies but no verifiable identity could contain the same plugin.
      const contents = await readdir(folder, { recursive: true, withFileTypes: true });
      if (contents.some((entry) => entry.isSymbolicLink() || /\.dll$/i.test(entry.name)))
        unknown = true;
    }
  }
  return { versions, names, unknown };
}

export async function compareInstalledBuild(
  directory: string,
  folders: { id: string; version: string; folder: string }[],
  plugin: CatalogPlugin,
): Promise<boolean | null> {
  const matching = folders.filter(
    (entry) => entry.id === plugin.id && entry.version === plugin.version,
  );
  if (matching.length !== 1) return null;
  const files = Object.entries(plugin.files).filter(([name]) => /\.dll$|\.deps\.json$/i.test(name));
  if (!files.some(([name]) => /\.dll$/i.test(name))) return null;
  let equal = true;
  try {
    for (const [name, checksum] of files) {
      const path = join(directory, matching[0].folder, name);
      if (!(await lstat(path)).isFile()) return null;
      if (
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex") !== checksum
      )
        equal = false;
    }
  } catch {
    return null;
  }
  return equal;
}

export async function payloadPresent(root: string, plugin: CatalogPlugin) {
  try {
    const files = Object.keys(plugin.files);
    if (!files.includes("meta.json") || !files.some((file) => /\.dll$/i.test(file))) return false;
    const folder = join(root, "payload", plugin.folder);
    return (
      await Promise.all(files.map(async (file) => (await lstat(join(folder, file))).isFile()))
    ).every(Boolean);
  } catch {
    return false;
  }
}

export async function copyApprovedPlugin(root: string, directory: string, plugin: CatalogPlugin) {
  const source = join(root, "payload", plugin.folder);
  const temporary = await mkdtemp(join(dirname(directory), ".freebo-plugin-"));
  try {
    for (const [file, checksum] of Object.entries(plugin.files)) {
      const path = join(source, file);
      if (!(await lstat(path)).isFile()) throw new Error("Invalid plugin asset");
      const bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== checksum)
        throw new Error("Plugin asset hash mismatch");
      if (file === "meta.json") {
        const meta = diskMetadata.parse(JSON.parse(bytes.toString("utf8")));
        if (
          meta.guid !== plugin.id ||
          meta.version !== plugin.version ||
          meta.targetAbi !== plugin.targetAbi
        )
          throw new Error("Plugin asset identity mismatch");
      }
      await writeFile(join(temporary, file), bytes, { flag: "wx" });
    }
    if ((await pluginDirectory(directory)) !== directory) throw new Error("Plugin directory moved");
    const disk = await inspectPluginDirectory(directory);
    const folderName = plugin.folder.toLowerCase();
    const prefix = folderName.slice(0, folderName.lastIndexOf("_") + 1);
    if (
      disk.unknown ||
      disk.versions.some(({ id }) => id === plugin.id) ||
      disk.names.has(folderName) ||
      (prefix && [...disk.names].some((name) => name.startsWith(prefix)))
    )
      return false;
    await rename(temporary, join(directory, plugin.folder));
    return true;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

export async function copyRecommendedConfiguration(
  root: string,
  directory: string,
  plugin: CatalogPlugin,
) {
  const config = plugin.recommendedConfiguration;
  if (!config) return;
  const source = join(root, "recommended-configurations", plugin.folder, config.filename);
  if (!(await lstat(source)).isFile()) throw new Error("Invalid plugin configuration asset");
  const bytes = await readFile(source);
  if (createHash("sha256").update(bytes).digest("hex") !== config.sha256)
    throw new Error("Plugin configuration hash mismatch");

  if ((await pluginDirectory(directory)) !== directory) throw new Error("Plugin directory moved");
  const configurations = join(directory, "configurations");
  await mkdir(configurations).catch((failure: NodeJS.ErrnoException) => {
    if (failure.code !== "EEXIST") throw failure;
  });
  const original = await lstat(configurations);
  if (!original.isDirectory() || (await realpath(configurations)) !== configurations)
    throw new Error("Plugin configurations directory is redirected");

  const temporary = await mkdtemp(join(dirname(directory), ".freebo-plugin-config-"));
  try {
    const staged = join(temporary, config.filename);
    await writeFile(staged, bytes, { flag: "wx" });
    const current = await lstat(configurations);
    if (
      !current.isDirectory() ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      (await realpath(configurations)) !== configurations
    )
      throw new Error("Plugin configurations directory moved");
    // Publish atomically without ever opening, following, or replacing an existing target.
    await link(staged, join(configurations, config.filename)).catch(
      (failure: NodeJS.ErrnoException) => {
        if (failure.code !== "EEXIST") throw failure;
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
