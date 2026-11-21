import path from "node:path";
import { writePluginAssets } from "./jellyfin-plugin-assets.mjs";
import { ensureJellyfinPluginAssets } from "./ensure-jellyfin-plugin-assets.mjs";

export default async function packageJellyfinPlugins({
  appOutDir,
  packager,
  electronPlatformName,
}) {
  if (
    electronPlatformName !== "win32" ||
    process.env.FREEBO_PACKAGE_LOCAL_JELLYFIN_PLUGINS === "0"
  ) {
    return;
  }
  const assets = await ensureJellyfinPluginAssets();
  await writePluginAssets(
    path.join(packager.getResourcesDir(appOutDir), "jellyfin-plugins", "payload"),
    assets,
  );
}
