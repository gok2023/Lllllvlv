import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChartNoAxesColumnIncreasing,
  ChevronDown,
  FileCode2,
  FolderInput,
  FolderOpen,
  Images,
  LayoutDashboard,
  MoreHorizontal,
  PanelsTopLeft,
  Puzzle,
  RefreshCw,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState } from "react";
import { useAppTranslation } from "../../i18n";
import { useApp } from "../../runtime/context";
import type { MessageKey } from "../../shared/i18n";
import type { JellyfinPluginState } from "../../shared/jellyfin-plugins";
import type { DesktopAPI } from "../../shared/types";
import { OptionSelect } from "../shared/OptionSelect";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import {
  JellyfinThoroughUninstall,
  matches,
  useJellyfinThoroughUninstall,
} from "./JellyfinThoroughUninstall";

const accessMessages = {
  admin: "pluginAdminAccess",
  unauthenticated: "pluginSignInRequired",
  forbidden: "pluginAdminRequired",
  unreachable: "pluginServerUnreachable",
} satisfies Record<JellyfinPluginState["access"], MessageKey>;

const errorMessages = {
  "directory-invalid": "pluginDirectoryInvalid",
  "install-failed": "pluginInstallFailed",
  "recommended-configuration-failed": "pluginRecommendedConfigurationFailed",
  "restart-failed": "pluginRestartFailed",
  "restart-timeout": "pluginRestartTimeout",
  "plugin-load-failed": "pluginLoadFailed",
  "state-unavailable": "pluginStateUnavailable",
  "plugin-exists": "pluginAlreadyExists",
  "not-available": "pluginActionUnavailable",
} satisfies Record<NonNullable<JellyfinPluginState["error"]>, MessageKey>;

const installedStatusMessages: Record<string, MessageKey> = {
  active: "pluginActive",
  disabled: "pluginDisabled",
  deleted: "pluginPendingRemoval",
  malfunctioned: "pluginMalfunctioned",
  superseded: "pluginSuperseded",
  notsupported: "pluginUnsupported",
  restart: "pluginPendingRestart",
  "pending-install": "pluginPendingInstall",
};

type PluginAction = (api: DesktopAPI, serverId: string) => Promise<JellyfinPluginState>;
type Plugin = JellyfinPluginState["plugins"][number];
type Confirmation = { serverId: string; serverUrl: string };

const pluginGroups = [
  {
    title: "pluginVisualGroup",
    entries: [
      { id: "170a157f-ac6c-437a-abdd-ca9c25cebd39", icon: Images },
      { id: "b8298e01-2697-407a-b44d-aa8dc795e850", icon: LayoutDashboard },
      { id: "08f615ea-2107-4f04-89cc-091035f54448", icon: PanelsTopLeft },
    ],
  },
  {
    title: "pluginLibraryGroup",
    entries: [
      { id: "5c534381-91a3-43cb-907a-35aa02eb9d2c", icon: ChartNoAxesColumnIncreasing },
      { id: "347d2c09-78a1-4697-9c3d-e23566122144", icon: FolderInput },
    ],
  },
  {
    title: "pluginDependencyGroup",
    entries: [{ id: "5e87cc92-571a-4d8d-8d98-d2d4147f9f90", icon: FileCode2 }],
  },
] as const;

const groupPluginIds = new Set<string>(
  pluginGroups.flatMap(({ entries }) => entries.map(({ id }) => id)),
);

export function JellyfinPluginSettings() {
  const { state, runtime, update, isPending } = useApp();
  const { t, locale } = useAppTranslation();
  const queryClient = useQueryClient();
  const [serverChoice, setServerChoice] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [configOptOut, setConfigOptOut] = useState<ReadonlySet<string>>(new Set());
  const servers = state.settings.servers.filter((server) => server.providerId === "jellyfin");
  const server =
    servers.find((entry) => entry.id === serverChoice) ??
    servers.find((entry) => entry.id === state.settings.activeServerId) ??
    servers[0];
  const open = state.settings.jellyfinPluginsExpanded ?? false;
  const queryKey = ["jellyfin-plugins", server?.id, server?.url] as const;
  const query = useQuery({
    queryKey,
    enabled: open,
    queryFn: server ? () => runtime.api.jellyfinPluginsGet(server.id) : skipToken,
  });
  const mutation = useMutation({
    mutationFn: ({
      action,
      serverId,
    }: {
      action: PluginAction;
      serverId: string;
      key: typeof queryKey;
    }) => action(runtime.api, serverId),
    onSuccess: (next, { key }) => queryClient.setQueryData(key, next),
  });
  const pluginState = query.data;
  const thorough = useJellyfinThoroughUninstall(
    runtime.api,
    server,
    open && pluginState?.local === true,
  );
  const regularBusy = query.isFetching || mutation.isPending;
  const busy = regularBusy || thorough.busy;
  const actionsBlocked = busy || thorough.hasPendingPlan;
  const execute = (action: PluginAction) => {
    if (server && !actionsBlocked) mutation.mutate({ action, serverId: server.id, key: queryKey });
  };
  const feedback = pluginState?.error && errorMessages[pluginState.error];
  const failed = mutation.isError || query.isError || Boolean(feedback);
  const installedCount = pluginState?.plugins.filter(
    (plugin) => plugin.installed.length > 0,
  ).length;
  const summary = thorough.hasPendingPlan
    ? t("pluginThoroughPending")
    : pluginState?.pendingRestart
      ? t("pluginPendingRestart")
      : !server
        ? t("pluginNoServer")
        : pluginState?.access === "admin" && !query.isError
          ? t("pluginInstalledCount", { count: installedCount ?? 0 })
          : t("pluginManageJellyfin");

  const confirmingCurrentServer = Boolean(
    confirmation && confirmation.serverId === server?.id && confirmation.serverUrl === server.url,
  );

  function renderPlugin(plugin: Plugin, Icon: typeof Puzzle) {
    if (!pluginState) return null;
    const name = plugin.nameEn ?? plugin.name;
    const description =
      locale === "en" ? (plugin.descriptionEn ?? plugin.description) : plugin.description;
    const uninstalled = plugin.installed.length === 0;
    const installable = uninstalled && !!plugin.installation;
    const configKey = JSON.stringify([server?.id, server?.url, plugin.id]);
    const useRecommendedConfiguration =
      plugin.recommendedConfiguration === true && !configOptOut.has(configKey);
    const listAvailable = pluginState.access === "admin" && !pluginState.error;
    const metadata: string[] = [];
    if (plugin.installation) {
      metadata.push(t(plugin.installation === "online" ? "pluginOnline" : "pluginOffline"));
    }
    return (
      <li
        key={plugin.id}
        className="flex min-w-0 flex-col gap-2 rounded-md border bg-card/90 p-2.5 text-card-foreground backdrop-blur-sm"
      >
        <div className="flex min-w-0 items-start gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h5 className="text-sm font-semibold wrap-anywhere">{name}</h5>
            <p className="text-xs wrap-anywhere text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="mt-auto space-y-1.5 text-xs wrap-anywhere text-muted-foreground">
          {uninstalled && <p>{t("pluginCatalogVersion", { version: plugin.version })}</p>}
          <Collapsible>
            <CollapsibleTrigger className="text-xs text-muted-foreground underline underline-offset-2">
              {t("pluginDetails")}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-1 pt-1">
              <p>ABI {plugin.targetAbi}</p>
              {plugin.installed.map((entry) => (
                <p key={entry.version}>
                  ABI {entry.targetAbi ?? t("pluginAbiUnknown")} · {entry.version}
                </p>
              ))}
              {plugin.buildMatches !== null && plugin.buildMatches !== undefined && (
                <p>{t(plugin.buildMatches ? "pluginBuildMatches" : "pluginBuildDiffers")}</p>
              )}
              {plugin.availableBuilds && plugin.availableBuilds.length > 1 && (
                <p>
                  {t("pluginBuilds", {
                    builds: plugin.availableBuilds
                      .map(
                        (build) =>
                          `${build.version} / ABI ${build.targetAbi} (${t(build.compatible ? "pluginBuildCompatible" : "pluginBuildIncompatible")})`,
                      )
                      .join("; "),
                  })}
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>
          {uninstalled && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <PluginStatus>
                  {t(listAvailable ? "pluginNotInstalled" : "pluginStatusUnknown")}
                </PluginStatus>
                <span>{metadata.join(" · ")}</span>
              </div>
              {installable && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={actionsBlocked}
                  aria-label={t("pluginInstallNamed", { name })}
                  onClick={() =>
                    execute((api, id) =>
                      api.jellyfinPluginsInstall(id, plugin.id, useRecommendedConfiguration),
                    )
                  }
                >
                  {t("pluginInstall")}
                </Button>
              )}
            </div>
          )}
          {installable && plugin.recommendedConfiguration && (
            <label className="flex w-fit items-start gap-1.5 text-foreground">
              <input
                type="checkbox"
                className="mt-0.5 size-3.5 shrink-0 accent-primary"
                checked={useRecommendedConfiguration}
                disabled={actionsBlocked}
                onChange={({ currentTarget: { checked } }) =>
                  setConfigOptOut((previous) => {
                    const next = new Set(previous);
                    if (checked) next.delete(configKey);
                    else next.add(configKey);
                    return next;
                  })
                }
              />
              {t("pluginRecommendedConfiguration")}
            </label>
          )}
          {plugin.installed.map((entry) => (
            <div key={entry.version} className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <PluginStatus status={entry.status}>
                  {t(
                    Object.hasOwn(installedStatusMessages, entry.status)
                      ? installedStatusMessages[entry.status]
                      : "pluginStatusUnknown",
                  )}
                </PluginStatus>
                <span>{entry.version}</span>
              </div>
              {pluginState.local && entry.canThoroughUninstall && (
                <PluginVersionActions
                  name={name}
                  version={entry.version}
                  disabled={actionsBlocked}
                  selected={thorough.selections.some((selection) =>
                    matches(selection, {
                      pluginId: plugin.id,
                      version: entry.version,
                    }),
                  )}
                  onToggle={() => thorough.toggle({ pluginId: plugin.id, version: entry.version })}
                />
              )}
            </div>
          ))}
          {plugin.updateAvailable && <p>{t("pluginUpdateAvailable")}</p>}
          {pluginState.serverVersion &&
            !plugin.compatible &&
            !plugin.installed.some((entry) => entry.status === "active") && (
              <p className="text-destructive">{t("pluginIncompatible")}</p>
            )}
          {listAvailable &&
            plugin.compatible &&
            !installable &&
            uninstalled &&
            plugin.missingDependencies.length > 0 && (
              <p>
                {t("pluginInstallDependencies", {
                  names: new Intl.ListFormat(locale).format(
                    plugin.missingDependencies.map(({ id, name, version }) => {
                      const bundled = pluginState.plugins.find((entry) => entry.id === id);
                      return `${bundled ? pluginName(bundled, locale) : name} ≥ ${version}`;
                    }),
                  ),
                })}
              </p>
            )}
          {!pluginState.local && plugin.customized && uninstalled && <p>{t("pluginLocalOnly")}</p>}
          {pluginState.local &&
            !plugin.bundled &&
            !installable &&
            plugin.compatible &&
            uninstalled && <p>{t("pluginOfflinePackageMissing")}</p>}
        </div>
      </li>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={(expanded) => update({ jellyfinPluginsExpanded: expanded })}
      className="mt-4 min-w-0"
    >
      <h3>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            disabled={isPending("settings")}
            className="group h-auto w-full justify-start gap-3 py-3 text-left whitespace-normal focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1 wrap-anywhere">{t("builtInPlugins")}</span>
            <span className="min-w-0 text-right text-xs font-normal wrap-anywhere text-muted-foreground">
              {summary}
            </span>
            <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="space-y-4 px-3 pt-3">
        {server && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-52">
              <label htmlFor="jellyfin-plugin-server" className="mb-1.5 block text-sm">
                {t("pluginJellyfinServer")}
              </label>
              <OptionSelect
                id="jellyfin-plugin-server"
                label={t("pluginJellyfinServer")}
                className="w-full min-w-0"
                disabled={mutation.isPending || thorough.running}
                value={server.id}
                options={servers.map((entry) => ({ value: entry.id, label: entry.name }))}
                onValueChange={(id) => {
                  mutation.reset();
                  thorough.reset();
                  setServerChoice(id);
                }}
              />
            </div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                mutation.reset();
                thorough.refresh();
                void query.refetch();
              }}
            >
              <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
              {t("refreshDiagnostics")}
            </Button>
          </div>
        )}
        {server && (
          <div role="status" className="space-y-1 text-xs text-muted-foreground">
            {pluginState?.serverVersion && (
              <p>{t("pluginServerVersion", { version: pluginState.serverVersion })}</p>
            )}
            {pluginState && pluginState.access !== "admin" && !thorough.expectDisconnect && (
              <p>{t(accessMessages[pluginState.access])}</p>
            )}
            {mutation.isPending && (
              <p>
                {t(
                  mutation.variables?.action === restartServer
                    ? "pluginRestarting"
                    : "pluginWorking",
                )}
              </p>
            )}
            {query.isFetching && !thorough.expectDisconnect && <p>{t("pluginChecking")}</p>}
            {failed && !busy && !thorough.expectDisconnect && (
              <p className="wrap-anywhere text-destructive">
                {t(feedback || "pluginStateUnavailable")}
              </p>
            )}
            {!busy && !failed && pluginState?.result === "restarted" && (
              <p>{t("pluginRestarted")}</p>
            )}
          </div>
        )}
        {pluginState?.local && pluginState.access === "admin" && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1 basis-52">
              <p className="text-sm">{t("pluginFolder")}</p>
              <p className="text-xs wrap-anywhere text-muted-foreground">
                {pluginState.directory || t("pluginChooseFolderHelp")}
              </p>
            </div>
            {(!pluginState.directorySource || pluginState.directorySource === "manual") && (
              <Button
                variant="outline"
                size="sm"
                disabled={actionsBlocked}
                onClick={() => execute((api, id) => api.jellyfinPluginsChooseDirectory(id))}
              >
                <FolderOpen />
                {t("pluginChooseFolder")}
              </Button>
            )}
          </div>
        )}
        {(pluginState?.local || thorough.plan) && (
          <JellyfinThoroughUninstall workflow={thorough} disabled={regularBusy} />
        )}
        {pluginState && pluginState.plugins.length > 0 && (
          <>
            {pluginGroups.map(({ title, entries }) => {
              const plugins = entries.flatMap(({ id, icon }) => {
                const plugin = pluginState.plugins.find((entry) => entry.id === id);
                return plugin ? [{ plugin, icon }] : [];
              });
              return plugins.length > 0 ? (
                <section key={title} className="space-y-2">
                  <h4 className="text-sm font-medium text-foreground">{t(title)}</h4>
                  <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] items-stretch gap-2">
                    {plugins.map(({ plugin, icon }) => renderPlugin(plugin, icon))}
                  </ul>
                </section>
              ) : null;
            })}
            {pluginState.plugins.some(({ id }) => !groupPluginIds.has(id)) && (
              <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-2">
                {pluginState.plugins
                  .filter(({ id }) => !groupPluginIds.has(id))
                  .map((plugin) => renderPlugin(plugin, Puzzle))}
              </ul>
            )}
            {pluginState.plugins.some(
              (plugin) => plugin.customized && plugin.installed.length > 0,
            ) && <p className="text-xs text-muted-foreground">{t("pluginCheckAutoUpdate")}</p>}
          </>
        )}
        {pluginState?.pendingRestart && !thorough.expectDisconnect && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-medium">{t("pluginPendingRestart")}</p>
            <p className="text-xs text-muted-foreground">{t("pluginBatchRestartHelp")}</p>
            {!pluginState.canRestart && pluginState.access === "admin" && (
              <p className="text-xs text-muted-foreground">{t("pluginManualRestart")}</p>
            )}
            <Button
              size="sm"
              disabled={actionsBlocked || !pluginState.canRestart}
              onClick={() => {
                if (server) setConfirmation({ serverId: server.id, serverUrl: server.url });
              }}
            >
              {t("pluginRestartServer")}
            </Button>
          </div>
        )}
      </CollapsibleContent>
      <AlertDialog
        open={confirmingCurrentServer}
        onOpenChange={(shown) => {
          if (!shown) setConfirmation(undefined);
        }}
      >
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pluginRestartServer")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pluginConfirmRestart", { name: server?.name ?? "Jellyfin" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-wrap">
            <AlertDialogCancel>{t("pluginRestartLater")}</AlertDialogCancel>
            <AlertDialogAction disabled={actionsBlocked} onClick={() => execute(restartServer)}>
              {t("pluginRestartNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  );
}

const restartServer: PluginAction = (api, id) => api.jellyfinPluginsRestart(id);
function pluginName(plugin: Plugin, locale: "zh" | "en") {
  return locale === "en" ? (plugin.nameEn ?? plugin.name) : plugin.name;
}

function PluginStatus({ children, status }: { children: string; status?: string }) {
  const palette =
    status === "malfunctioned" || status === "notsupported"
      ? "bg-destructive/10 text-destructive"
      : status === "active" ||
          status === "pending-install" ||
          status === "restart" ||
          status === "deleted"
        ? "bg-accent text-accent-foreground"
        : "bg-muted text-muted-foreground";
  return <span className={`rounded-full px-2 py-0.5 font-medium ${palette}`}>{children}</span>;
}

function PluginVersionActions({
  name,
  version,
  disabled,
  selected,
  onToggle,
}: {
  name: string;
  version: string;
  disabled: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useAppTranslation();
  const itemClass =
    "cursor-pointer rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-50";
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button
          size={selected ? "xs" : "icon-xs"}
          variant={selected ? "secondary" : "ghost"}
          disabled={disabled}
          aria-label={t("pluginVersionActions", { name, version })}
        >
          <MoreHorizontal />
          {selected && t("pluginThoroughSelected")}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 max-w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenu.CheckboxItem
            className={itemClass}
            checked={selected}
            onCheckedChange={onToggle}
          >
            <DropdownMenu.ItemIndicator>{"✓ "}</DropdownMenu.ItemIndicator>
            {t("pluginUninstall")}
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
