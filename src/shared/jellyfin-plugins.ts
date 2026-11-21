export type JellyfinPluginError =
  | "directory-invalid"
  | "install-failed"
  | "recommended-configuration-failed"
  | "restart-failed"
  | "restart-timeout"
  | "plugin-load-failed"
  | "state-unavailable"
  | "plugin-exists"
  | "not-available";

export interface JellyfinPlugin {
  id: string;
  name: string;
  description: string;
  nameEn?: string;
  descriptionEn?: string;
  customized: boolean;
  version: string;
  targetAbi?: string;
  availableBuilds?: { version: string; targetAbi: string; compatible: boolean }[];
  bundled: boolean;
  buildMatches?: boolean | null;
  updateAvailable?: boolean;
  compatible: boolean;
  missingDependencies: { id: string; name: string; version: string }[];
  installation: "online" | "offline" | null;
  recommendedConfiguration?: boolean;
  installed: {
    version: string;
    targetAbi?: string;
    status: string;
    canThoroughUninstall: boolean;
  }[];
}

export interface JellyfinThoroughUninstallSelection {
  pluginId: string;
  version: string;
}

export type JellyfinThoroughUninstallError =
  | "not-local"
  | "not-admin"
  | "directory-unavailable"
  | "identity-unverified"
  | "selection-not-found"
  | "dependency-in-use"
  | "exit-unverified"
  | "move-failed"
  | "start-failed"
  | "verification-failed"
  | "state-changed";

export interface JellyfinThoroughUninstallState {
  serverId: string;
  phase:
    | "confirm"
    | "stopping"
    | "stop-manually"
    | "moving"
    | "starting"
    | "start-manually"
    | "verifying"
    | "complete"
    | "error";
  mode: "service" | "tray" | "manual";
  selections: (JellyfinThoroughUninstallSelection & {
    name: string;
    paths: { originalPath: string; backupPath: string }[];
  })[];
  backupDirectory: string | null;
  error?: JellyfinThoroughUninstallError;
}

export interface JellyfinPluginState {
  serverId: string;
  serverVersion: string | null;
  access: "admin" | "unauthenticated" | "forbidden" | "unreachable";
  local: boolean;
  directory: string | null;
  directorySource: "server" | "process" | "manual" | null;
  pendingRestart: boolean;
  canRestart: boolean;
  plugins: JellyfinPlugin[];
  error?: JellyfinPluginError;
  result?: "changed" | "canceled" | "restarted";
}
