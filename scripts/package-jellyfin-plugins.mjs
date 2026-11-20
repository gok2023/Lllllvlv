import path from "node:path";
import { loadPluginAssets, localPayloadDir, writePluginAssets } from "./jellyfin-plugin-assets.mjs";

export default async function packageJellyfinPlugins({
  appOutDir,
  packager,
  electronPlatformName,
}) {
  if (
    electronPlatformName !== "win32" ||
    process.env.FREEBO_PACKAGE_LOCAL_JELLYFIN_PLUGINS !== "1"
  ) {
    return;
  }
  const assets = await loadPluginAssets(localPayloadDir, false);
  await writePluginAssets(
    path.join(packager.getResourcesDir(appOutDir), "jellyfin-plugins", "payload"),
    assets,
  );
}
