import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const resourceDir = fileURLToPath(new URL("../resources/jellyfin-plugins", import.meta.url));
export const localPayloadDir = path.join(resourceDir, "payload");

async function readVerifiedFile(directory, file, expected) {
  const source = path.join(directory, file);
  if (!(await lstat(source)).isFile()) {
    throw new Error(`Expected a regular plugin file: ${source}`);
  }
  return verifyBytes(await readFile(source), source, expected);
}

function verifyBytes(bytes, label, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error(`Plugin SHA-256 mismatch: ${label}`);
  }
  return bytes;
}

export async function loadPluginAssets(sourceDir, fromInstall) {
  const { plugins } = JSON.parse(await readFile(path.join(resourceDir, "catalog.json"), "utf8"));
  return Promise.all(
    plugins.map(async (plugin) => {
      const input = path.join(sourceDir, fromInstall ? plugin.importFolder : plugin.folder);
      if (!(await lstat(input)).isDirectory()) {
        throw new Error(`Expected a plugin directory: ${input}`);
      }
      const files = await Promise.all(
        Object.entries(plugin.files).map(async ([file, expected]) => {
          const bytes =
            fromInstall && file === "meta.json"
              ? verifyBytes(
                  Buffer.from(`${JSON.stringify(plugin.metadata, null, 2)}\n`),
                  plugin.folder,
                  expected,
                )
              : await readVerifiedFile(input, file, expected);
          return [file, bytes];
        }),
      );
      return { folder: plugin.folder, files };
    }),
  );
}

export async function writePluginAssets(destination, assets) {
  await mkdir(destination, { recursive: true });
  if (!(await lstat(destination)).isDirectory()) {
    throw new Error(`Expected a plugin destination directory: ${destination}`);
  }
  for (const { folder, files } of assets) {
    const directory = path.join(destination, folder);
    await mkdir(directory, { recursive: true });
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error(`Expected a plugin destination directory: ${directory}`);
    }
    for (const [file, bytes] of files) {
      const tempFile = path.join(directory, `.${randomUUID()}.tmp`);
      try {
        await writeFile(tempFile, bytes, { flag: "wx" });
        await rename(tempFile, path.join(directory, file));
      } finally {
        await rm(tempFile, { force: true });
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("Usage: pnpm jellyfin:import-plugins <Jellyfin plugins directory>");
    process.exitCode = 1;
  } else {
    try {
      const assets = await loadPluginAssets(path.resolve(process.argv[2]), true);
      await writePluginAssets(localPayloadDir, assets);
      console.log(`Imported ${assets.length} pinned plugins into ${localPayloadDir}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
