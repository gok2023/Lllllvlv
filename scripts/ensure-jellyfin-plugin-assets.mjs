import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  loadPluginAssets,
  localPayloadDir,
  resourceDir,
  writePluginAssets,
} from "./jellyfin-plugin-assets.mjs";

const execFileAsync = promisify(execFile);
const bundleUrl =
  "https://github.com/gok2023/Lllllvlv/releases/download/jellyfin-plugins-20261121/jellyfin-plugins-windows-20261121.zip";
const maxZipBytes = 256 * 1024 * 1024;
const allowedRedirectHosts = new Set(["github.com", "release-assets.githubusercontent.com"]);

const extractCommand = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$catalog = Get-Content -LiteralPath $env:FREEBO_PLUGIN_CATALOG -Raw -Encoding UTF8 | ConvertFrom-Json
$allowed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($plugin in $catalog.plugins) {
  $folder = [string]$plugin.folder
  if ($folder -match '[/\\]' -or $folder -eq '.' -or $folder -eq '..') { throw 'Invalid catalog folder' }
  [void]$allowed.Add("$folder/")
  foreach ($file in $plugin.files.PSObject.Properties.Name) {
    if ($file -match '[/\\]' -or $file -eq '.' -or $file -eq '..') { throw 'Invalid catalog file' }
    [void]$allowed.Add("$folder/$file")
  }
}
$zip = [System.IO.Compression.ZipFile]::OpenRead($env:FREEBO_PLUGIN_ZIP)
try {
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $total = [long]0
  if ($zip.Entries.Count -gt 1000) { throw 'Too many ZIP entries' }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if ($name.Contains('\') -or -not $allowed.Contains($name) -or -not $seen.Add($name)) { throw "Unexpected ZIP entry: $name" }
    if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw "ZIP symlink: $name" }
    if ($entry.Length -gt 268435456) { throw "Oversized ZIP entry: $name" }
    $total += $entry.Length
    if ($total -gt 1073741824) { throw 'Oversized ZIP contents' }
  }
} finally { $zip.Dispose() }
[System.IO.Compression.ZipFile]::ExtractToDirectory($env:FREEBO_PLUGIN_ZIP, $env:FREEBO_PLUGIN_EXTRACT)
`;

async function downloadBundle(destination, expectedSha256) {
  let url = bundleUrl;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    for (let redirect = 0; redirect <= 5; redirect++) {
      const current = new URL(url);
      if (current.protocol !== "https:" || !allowedRedirectHosts.has(current.hostname)) {
        throw new Error(`Untrusted plugin bundle URL: ${url}`);
      }
      const response = await fetch(url, { redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirect === 5) throw new Error("Plugin bundle redirect limit exceeded");
        url = new URL(location, url).href;
        await response.body?.cancel();
        continue;
      }
      if (!response.ok || !response.body)
        throw new Error(`Plugin bundle download failed: HTTP ${response.status}`);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > maxZipBytes)
        throw new Error("Plugin bundle is too large");
      const file = await open(destination, "wx");
      const hash = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > maxZipBytes) throw new Error("Plugin bundle is too large");
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
            if (bytesWritten === 0) throw new Error("Plugin bundle download stalled");
            offset += bytesWritten;
          }
        }
      } finally {
        await file.close();
      }
      if (hash.digest("hex") !== expectedSha256) throw new Error("Plugin bundle SHA-256 mismatch");
      return;
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureJellyfinPluginAssets() {
  try {
    return await loadPluginAssets(localPayloadDir, false);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const bundle = JSON.parse(await readFile(path.join(resourceDir, "bundle.json"), "utf8"));
  if (bundle.url !== bundleUrl || !/^[a-f0-9]{64}$/.test(bundle.sha256)) {
    throw new Error("Invalid pinned Jellyfin plugin bundle metadata");
  }
  const localDir = fileURLToPath(new URL("../.local/", import.meta.url));
  await mkdir(localDir, { recursive: true });
  const temporary = await mkdtemp(path.join(localDir, "jellyfin-plugins-"));
  try {
    const zip = path.join(temporary, "bundle.zip");
    const extracted = path.join(temporary, "extracted");
    await downloadBundle(zip, bundle.sha256);
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", extractCommand],
      {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          FREEBO_PLUGIN_ZIP: zip,
          FREEBO_PLUGIN_EXTRACT: extracted,
          FREEBO_PLUGIN_CATALOG: path.join(resourceDir, "catalog.json"),
        },
      },
    );
    const assets = await loadPluginAssets(extracted, false);
    await writePluginAssets(localPayloadDir, assets);
    return assets;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
