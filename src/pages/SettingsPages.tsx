import { Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  Bug,
  ExternalLink,
  Globe2,
  Info,
  Settings2,
  ChartNoAxesCombined,
  MonitorPlay,
  Plus,
  RefreshCw,
  FolderOpen,
  Volume2,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Slider } from "../components/ui/slider";
import { OptionSelect } from "../components/shared/OptionSelect";
import { SettingRow } from "../components/settings/SettingRow";
import { PlayerSetup } from "../components/players/PlayerSetup";
import { CustomPlayerForm } from "../components/players/CustomPlayerForm";
import { ServerForm } from "../components/servers/ServerForm";
import { ServerManagementRow } from "../components/servers/ServerManagementRow";
import { BrandLogo, BrandName } from "../components/shared/Brand";
import { DiagnosticsPanel } from "../components/settings/DiagnosticsPanel";
import { UpdateSettings } from "../components/settings/UpdateSettings";
import { useApp } from "../runtime/context";
import { useAppTranslation } from "../i18n";
import {
  visualThemeIds,
  visualThemes,
  resolveVisualBackground,
  backgroundsForTheme,
  elysiumBackgrounds,
  type VisualThemeId,
} from "../shared/visual-themes";
import { settingsPaths } from "../routing";
import { showProductLinks } from "../shared/product-links";

const settingPages = [
  { id: "servers", icon: Globe2 },
  { id: "players", icon: MonitorPlay },
  { id: "general", icon: Settings2 },
  { id: "statistics", icon: ChartNoAxesCombined },
  { id: "diagnostics", icon: Bug },
  { id: "about", icon: Info },
] as const;
function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-5 [&_p]:mt-[7px] [&>span]:text-xs [&>span]:text-muted-foreground">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
export function SettingsLayout() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.settingsCollapsed = String(collapsed);
    return () => {
      delete document.documentElement.dataset.settingsCollapsed;
    };
  }, [collapsed]);
  const { state, clearError } = useApp();
  const { t } = useAppTranslation();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  return (
    <div
      className={cn(
        "settings-layout grid",
        pathname === settingsPaths.statistics ? "h-full min-h-0" : "min-h-full",
      )}
    >
      <aside className="sticky top-0 flex h-[calc(100vh-88px)] flex-col px-3 py-6 max-[650px]:px-2 max-[650px]:py-5 [&>h1]:mx-4 [&>h1]:mb-6 [&>h1]:text-xl [&>nav]:flex [&>nav]:flex-col [&>nav]:gap-[3px]">
        <div
          className={cn(
            "settings-sidebar-heading flex items-center justify-between gap-1 mb-6",
            collapsed ? "px-0" : "px-2",
          )}
        >
          {!collapsed && <h1 className="text-xl">{t("settings")}</h1>}
          <Button
            variant="ghost"
            size="icon"
            aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
            title={collapsed ? t("expandSidebar") : t("collapseSidebar")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </Button>
        </div>
        <nav className="-ml-3 max-[650px]:-ml-2" aria-label={t("settings")}>
          {settingPages.map(({ id, icon: Icon }) => (
            <Button
              variant="ghost"
              key={id}
              className={cn(
                "h-auto justify-start gap-3 rounded-l-none rounded-r-[22px] py-3 text-[13px] text-muted-foreground has-[>svg]:pl-6 max-[650px]:has-[>svg]:pl-5",
                pathname.startsWith(settingsPaths[id]) && "bg-accent text-primary",
              )}
              aria-current={pathname.startsWith(settingsPaths[id]) ? "page" : undefined}
              aria-label={t(id)}
              title={t(id)}
              onClick={() => {
                clearError();
                void navigate({ to: settingsPaths[id] });
              }}
            >
              <Icon size={17} />
              {!collapsed && (
                <span className="min-w-0 text-left leading-normal whitespace-normal">{t(id)}</span>
              )}
            </Button>
          ))}
        </nav>
        {!collapsed && (
          <span className="mx-4 mt-auto pt-6 text-[11px] leading-[1.8] text-muted-foreground">
            <BrandName className="text-sm" />
            <br />v{state.version}
          </span>
        )}
      </aside>
      <div
        className={cn(
          "mx-auto w-full",
          pathname === settingsPaths.statistics
            ? "flex min-h-0 min-w-0 flex-col py-4 pr-5 pb-4 pl-2 max-[1000px]:p-3"
            : "max-w-[880px] px-10 pt-7 pb-10 max-[1000px]:p-7 max-[650px]:p-5",
        )}
      >
        <section
          className={cn(
            "mb-6 min-w-0 scroll-mt-[30px]",
            pathname === settingsPaths.statistics && "flex min-h-0 flex-1 flex-col mb-0",
          )}
        >
          <Outlet />
        </section>
      </div>
    </div>
  );
}
export function ServersPage() {
  const { state, run, isPending } = useApp();
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  return (
    <>
      <Heading title={t("serverManagement")}>
        <Button onClick={() => void navigate({ to: "/settings/servers/new" })}>
          <Plus size={16} />
          {t("addServer")}
        </Button>
      </Heading>
      <ul>
        {state.settings.servers.map((server) => (
          <ServerManagementRow
            key={server.id}
            server={server}
            disabled={isPending("remove") || isPending("reset")}
            onEdit={() =>
              void navigate({
                to: "/settings/servers/$serverId/edit",
                params: { serverId: server.id },
              })
            }
            onOpen={() =>
              void navigate({ to: "/library/$serverId", params: { serverId: server.id } })
            }
            onSignOut={() => void run("reset", (api) => api.resetSession(server.id))}
            onRemove={() => void run("remove", (api) => api.removeServer(server.id))}
          />
        ))}
      </ul>
      {!state.settings.servers.length && <p className="mt-2.5">{t("noServers")}</p>}
    </>
  );
}
export function ServerEditorPage() {
  const { state, runtime, run, isPending } = useApp();
  const { t } = useAppTranslation();
  const { serverId } = useParams({ strict: false });
  const server = serverId ? state.settings.servers.find((server) => server.id === serverId) : {};
  const navigate = useNavigate();
  if (!server) return <p role="alert">{t("serverMissing")}</p>;
  return (
    <>
      <Heading title={t(serverId ? "editServer" : "addServer")} />
      <ServerForm
        key={serverId ?? "new"}
        server={server}
        providers={state.providers}
        credentialsAvailable={state.credentialsAvailable}
        loadCredentials={runtime.api.getServerCredentials}
        testConnection={runtime.api.testServerConnection}
        saving={isPending("save")}
        onCancel={() => void navigate({ to: "/settings/servers" })}
        onSave={(input) =>
          void run("save", async (api) => {
            const updated = await api.saveServer(input);
            runtime.applyState(updated);
            await navigate({ to: "/settings/servers" });
            return updated;
          })
        }
      />
    </>
  );
}
export function PlayersPage() {
  const { state, run, update, isPending } = useApp();
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  return (
    <>
      <Heading title={t("players")}>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            disabled={isPending("scan")}
            onClick={() => void run("scan", (api) => api.discoverPlayers())}
          >
            <RefreshCw size={15} className={isPending("scan") ? "animate-spin" : ""} />
            {t("scan")}
          </Button>
          <Button onClick={() => void navigate({ to: "/settings/players/new" })}>
            <Plus size={16} />
            {t("addCustomPlayer")}
          </Button>
        </div>
      </Heading>
      <PlayerSetup
        state={state}
        run={run}
        update={update}
        onEdit={(player) =>
          void navigate({
            to: "/settings/players/$playerId/edit",
            params: { playerId: player.id },
          })
        }
      >
        <SettingRow title={t("autoNext")} description={t("autoNextDescription")}>
          <Switch
            aria-label={t("autoNext")}
            checked={state.settings.autoNext}
            onCheckedChange={(checked) => update({ autoNext: checked })}
          />
        </SettingRow>
        <SettingRow title={t("fullscreen")}>
          <Switch
            aria-label={t("fullscreen")}
            checked={state.settings.fullscreen}
            onCheckedChange={(checked) => update({ fullscreen: checked })}
          />
        </SettingRow>
      </PlayerSetup>
    </>
  );
}
export function PlayerEditorPage() {
  const { state, runtime, run, isPending } = useApp();
  const { t } = useAppTranslation();
  const { playerId } = useParams({ strict: false });
  const player = state.settings.players.find(
    (entry) => entry.id === playerId && entry.kind === "custom",
  );
  const navigate = useNavigate();
  if (playerId && !player) return <p role="alert">{t("playerMissing")}</p>;
  return (
    <>
      <Heading title={t(playerId ? "editCustomPlayer" : "addCustomPlayer")} />
      <CustomPlayerForm
        key={playerId ?? "new"}
        player={player}
        saving={isPending("save-custom-player")}
        chooseExecutable={async () => {
          let selected: string | null = null;
          await run("choose-custom-player", async (api) => {
            selected = await api.choosePlayerExecutable();
          });
          return selected;
        }}
        onCancel={() => void navigate({ to: "/settings/players" })}
        onSave={(input) =>
          void run("save-custom-player", async (api) => {
            const updated = await api.saveCustomPlayer(input);
            runtime.applyState(updated);
            await navigate({ to: "/settings/players" });
            return updated;
          })
        }
      />
    </>
  );
}
export function GeneralPage() {
  const { state, update, isPending, run } = useApp();
  const { t } = useAppTranslation();
  const [videoVolume, setVideoVolume] = useState(state.settings.startupVideoVolume);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setVideoVolume(state.settings.startupVideoVolume));
    return () => cancelAnimationFrame(frame);
  }, [state.settings.startupVideoVolume]);
  return (
    <>
      <Heading title={t("general")} />
      <SettingRow title={t("theme")}>
        <OptionSelect
          label={t("theme")}
          value={state.settings.theme}
          onValueChange={(theme) => update({ theme })}
          options={[
            { value: "system", label: t("system") },
            { value: "light", label: t("light") },
            { value: "dark", label: t("dark") },
          ]}
        />
      </SettingRow>
      <SettingRow title={t("visualTheme")}>
        <OptionSelect
          label={t("visualTheme")}
          value={state.settings.visualTheme}
          onValueChange={(visualTheme) => update({ visualTheme: visualTheme as VisualThemeId })}
          options={visualThemeIds.map((id) => ({ value: id, label: visualThemes[id].name }))}
        />
      </SettingRow>
      {backgroundsForTheme(state.settings.visualTheme) && (
        <SettingRow title={t("visualBackground")}>
          <OptionSelect
            label={t("visualBackground")}
            value={
              resolveVisualBackground(
                state.settings.visualTheme,
                state.settings.visualBackground,
              ) ?? ""
            }
            onValueChange={(visualBackground) => update({ visualBackground })}
            options={Object.entries(backgroundsForTheme(state.settings.visualTheme) ?? {}).map(
              ([id, preset]) => ({ value: id, label: preset.name }),
            )}
          />
        </SettingRow>
      )}
      <SettingRow title={t("language")}>
        <OptionSelect
          label={t("language")}
          value={state.settings.language}
          onValueChange={(language) => update({ language })}
          options={[
            { value: "system", label: t("system") },
            { value: "zh", label: "中文" },
            { value: "en", label: "English" },
          ]}
        />
      </SettingRow>
      <SettingRow title={t("startupVideo")}>
        <div
          className="flex flex-wrap items-center justify-end gap-2 rounded-md border border-dashed p-2"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file)
              void run("settings", (api) => api.setStartupVideo(api.startupVideoPath(file)));
          }}
        >
          <Switch
            aria-label={t("startupVideo")}
            checked={state.settings.startupVideoEnabled}
            disabled={isPending("settings")}
            onCheckedChange={(checked) => update({ startupVideoEnabled: checked })}
          />
          <Button
            variant="outline"
            disabled={isPending("settings")}
            onClick={() => void run("settings", (api) => api.chooseStartupVideo())}
          >
            <FolderOpen className="size-4" />
            {t(state.settings.startupVideoName ? "startupVideoReplace" : "startupVideoChoose")}
          </Button>
          {state.settings.startupVideoName && (
            <>
              <span className="max-w-52 truncate text-sm" title={state.settings.startupVideoName}>
                {state.settings.startupVideoName}
              </span>
              <Button
                variant="ghost"
                disabled={isPending("settings")}
                onClick={() => void run("settings", (api) => api.clearStartupVideo())}
              >
                {t("startupVideoClear")}
              </Button>
            </>
          )}
          <span className="w-full text-right text-xs text-muted-foreground">
            {t("startupVideoDrop")}
          </span>
        </div>
      </SettingRow>
      <SettingRow title={t("startupVideoSound")}>
        <Switch
          aria-label={t("startupVideoSound")}
          checked={state.settings.startupVideoSoundEnabled}
          disabled={!state.settings.startupVideoEnabled || isPending("settings")}
          onCheckedChange={(checked) => update({ startupVideoSoundEnabled: checked })}
        />
      </SettingRow>
      <SettingRow title={t("startupVideoVolume")}>
        <div className="flex w-56 items-center gap-3">
          <Volume2 className="size-4 shrink-0 text-muted-foreground" />
          <Slider
            aria-label={t("startupVideoVolume")}
            value={[videoVolume]}
            min={0}
            max={100}
            step={5}
            disabled={
              !state.settings.startupVideoEnabled ||
              !state.settings.startupVideoSoundEnabled ||
              isPending("settings")
            }
            onValueChange={([value]) => setVideoVolume(value)}
            onValueCommit={([value]) => update({ startupVideoVolume: value })}
          />
          <span className="w-10 text-right text-sm tabular-nums">{videoVolume}%</span>
        </div>
      </SettingRow>
      <SettingRow title={t("runInBackground")} description={t("runInBackgroundDescription")}>
        <Switch
          aria-label={t("runInBackground")}
          checked={state.settings.runInBackground}
          disabled={isPending("settings")}
          onCheckedChange={(checked) => update({ runInBackground: checked })}
        />
      </SettingRow>
      <SettingRow title={t("remindOnClose")} description={t("remindOnCloseDescription")}>
        <Switch
          aria-label={t("remindOnClose")}
          checked={state.settings.remindOnClose}
          disabled={!state.settings.runInBackground || isPending("settings")}
          onCheckedChange={(checked) => update({ remindOnClose: checked })}
        />
      </SettingRow>
    </>
  );
}
export function StatisticsPage() {
  return null;
}
export function StatisticsFrame({ visible }: { visible: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { runtime, state } = useApp();
  const serverId = state.settings.activeServerId;
  const syncVisualTheme = () => {
    const selected = resolveVisualBackground(
      "elysium",
      state.settings.visualBackground,
    ) as keyof typeof elysiumBackgrounds;
    const preset = elysiumBackgrounds[selected];
    frame.current?.contentWindow?.postMessage(
      {
        channel: "watch-statistics",
        event: "visual-theme",
        theme: state.settings.visualTheme === "elysium" ? "elysium" : "original",
        colors: {
          contentTint: preset.contentTint,
          controlTint: preset.controlTint,
          foreground: preset.foreground,
          mutedForeground: preset.mutedForeground,
        },
      },
      "*",
    );
  };
  useEffect(syncVisualTheme, [state.settings.visualTheme, state.settings.visualBackground]);
  useEffect(() => {
    const unsubscribe = runtime.api.onWatchStatisticsUpdated((snapshot) => {
      if (snapshot.serverId !== serverId) return;
      frame.current?.contentWindow?.postMessage(
        { channel: "watch-statistics", event: "updated", snapshot },
        "*",
      );
    });
    const unsubscribeStatus = runtime.api.onWatchStatisticsStatus((status) => {
      frame.current?.contentWindow?.postMessage(
        { channel: "watch-statistics", event: "status", status },
        "*",
      );
    });
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = event.data;
      if (!message || message.channel !== "watch-statistics" || typeof message.id !== "number")
        return;
      const reply = (response: { result?: unknown; error?: string }) =>
        frame.current?.contentWindow?.postMessage(
          { channel: "watch-statistics", id: message.id, ...response },
          "*",
        );
      let operation: Promise<unknown>;
      switch (message.method) {
        case "getWatchStatistics":
          operation = runtime.api.getWatchStatistics();
          break;
        case "correctWatchLibrary":
          operation = runtime.api.correctWatchLibrary(message.args?.[0]);
          break;
        case "refreshWatchStatistics":
          operation = runtime.api.refreshWatchStatistics();
          break;
        case "getWatchStatisticsStatus":
          operation = runtime.api.getWatchStatisticsStatus();
          break;
        case "getWatchStatisticsPathStatus":
          operation = runtime.api.getWatchStatisticsPathStatus();
          break;
        case "autoDiscoverWatchStatisticsPath":
          operation = runtime.api.autoDiscoverWatchStatisticsPath();
          break;
        case "chooseWatchStatisticsPath":
          operation = runtime.api.chooseWatchStatisticsPath();
          break;
        case "saveWatchStatisticsSettings":
          operation = runtime.api.saveWatchStatisticsSettings(message.args?.[0]);
          break;
        case "exportWatchStatistics":
          operation = runtime.api.exportWatchStatistics();
          break;
        case "previewWatchStatisticsImport":
          operation = runtime.api.previewWatchStatisticsImport();
          break;
        case "importWatchStatistics":
          operation = runtime.api.importWatchStatistics("replace");
          break;
        default:
          return;
      }
      void operation.then(
        (result) => reply({ result }),
        (error) => reply({ error: String(error) }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      unsubscribe();
      unsubscribeStatus();
    };
  }, [runtime, serverId]);
  useEffect(() => {
    if (visible)
      frame.current?.contentWindow?.postMessage(
        { channel: "watch-statistics", event: "recheck" },
        "*",
      );
  }, [visible]);
  return (
    <div
      className={cn(
        "statistics-frame absolute inset-y-0 right-0 z-10 flex min-h-0 min-w-0 flex-col bg-background py-4 pr-5 pl-2 max-[1000px]:p-3",
        !visible && "hidden",
      )}
    >
      <iframe
        ref={frame}
        title="观影统计"
        src="./watch-statistics.html"
        onLoad={syncVisualTheme}
        className="min-h-0 w-full flex-1 rounded-lg border border-border bg-[#090b0e]"
      />
    </div>
  );
}
export function DiagnosticsPage() {
  const { state, run } = useApp();
  const { t } = useAppTranslation();
  return (
    <>
      <Heading title={t("diagnostics")} />
      <DiagnosticsPanel state={state} run={run} />
    </>
  );
}
export function AboutPage() {
  const { state, run } = useApp();
  const { t } = useAppTranslation();
  return (
    <>
      <Heading title={t("about")} />
      <div className="mt-6 flex flex-col items-start gap-5 [&_p]:mt-1.5">
        <BrandLogo width={230} />
        <p>v{state.version} · Apache-2.0</p>
        {showProductLinks && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void run("product", (api) => api.openLink("product"))}
            >
              {t("productPage")}
              <ExternalLink size={14} />
            </Button>
            <Button
              variant="outline"
              onClick={() => void run("github", (api) => api.openLink("github"))}
            >
              {t("githubRepository")}
              <ExternalLink size={14} />
            </Button>
          </div>
        )}
      </div>
      <UpdateSettings state={state} run={run} />
    </>
  );
}
export function LibraryPage() {
  const { state } = useApp();
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-background">
      {state.webStatus === "closed" && (
        <Button onClick={() => void navigate({ to: "/" })}>{t("chooseServer")}</Button>
      )}
    </div>
  );
}
