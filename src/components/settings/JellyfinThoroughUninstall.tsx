import {
  skipToken,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useAppTranslation } from "../../i18n";
import type { MessageKey } from "../../shared/i18n";
import type {
  JellyfinThoroughUninstallSelection,
  JellyfinThoroughUninstallState,
} from "../../shared/jellyfin-plugins";
import type { DesktopAPI, Server } from "../../shared/types";
import { Button } from "../ui/button";

type Selection = JellyfinThoroughUninstallSelection;
type Operation = "prepare" | "continue" | "cancel";
type Phase = JellyfinThoroughUninstallState["phase"];

const progressMessages: Partial<Record<Phase, MessageKey>> = {
  stopping: "pluginThoroughStopping",
  moving: "pluginThoroughMoving",
  starting: "pluginRestarting",
  "start-manually": "pluginRestarting",
  verifying: "pluginThoroughVerifying",
};

function isInProgress(phase: Phase | undefined) {
  return phase !== undefined && (phase in progressMessages || phase === "stop-manually");
}

const errors = {
  "not-local": "pluginThoroughLocalRequired",
  "not-admin": "pluginAdminRequired",
  "directory-unavailable": "pluginThoroughCannotPreview",
  "identity-unverified": "pluginThoroughIdentityUnverified",
  "selection-not-found": "pluginThoroughCannotPreview",
  "dependency-in-use": "pluginThoroughDependencyInUse",
  "exit-unverified": "pluginThoroughExitUnverified",
  "move-failed": "pluginThoroughMoveFailed",
  "start-failed": "pluginThoroughStartFailed",
  "verification-failed": "pluginThoroughVerificationFailed",
  "state-changed": "pluginThoroughStateChanged",
} satisfies Record<NonNullable<JellyfinThoroughUninstallState["error"]>, MessageKey>;

export function useJellyfinThoroughUninstall(
  api: DesktopAPI,
  server: Server | undefined,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const key = ["jellyfin-thorough-uninstall", server?.id, server?.url] as const;
  const [queued, setQueued] = useState<{
    serverId: string;
    serverUrl: string;
    values: Selection[];
  }>();
  const selections =
    queued && queued.serverId === server?.id && queued.serverUrl === server.url
      ? queued.values
      : [];
  const query = useQuery({
    queryKey: key,
    queryFn: server ? () => api.jellyfinPluginsThoroughGet(server.id) : skipToken,
    enabled,
    retry: false,
    refetchInterval: ({ state }) => (isInProgress(state.data?.phase) ? 750 : false),
    refetchIntervalInBackground: true,
  });
  const running = Boolean(useIsMutating({ mutationKey: key, exact: true }));
  const mutation = useMutation({
    mutationKey: key,
    mutationFn: ({
      operation,
      serverId,
      selected,
    }: {
      operation: Operation;
      serverId: string;
      serverUrl: string;
      selected: Selection[];
    }) => {
      switch (operation) {
        case "prepare":
          return api.jellyfinPluginsThoroughPrepare(serverId, selected);
        case "continue":
          return api.jellyfinPluginsThoroughContinue(serverId);
        case "cancel":
          return api.jellyfinPluginsThoroughCancel(serverId);
      }
    },
    onMutate: ({ serverId, serverUrl }) =>
      queryClient.cancelQueries({ queryKey: ["jellyfin-thorough-uninstall", serverId, serverUrl] }),
    onSuccess: (next, { operation, serverId, serverUrl }) => {
      queryClient.setQueryData(["jellyfin-thorough-uninstall", serverId, serverUrl], next);
      if (operation === "prepare" && next?.phase === "confirm") setQueued(undefined);
      if (operation === "cancel" && next === null) {
        void queryClient.invalidateQueries({
          queryKey: ["jellyfin-plugins", serverId, serverUrl],
        });
      }
    },
  });
  const plan = query.data;
  const inProgress = isInProgress(plan?.phase);
  const expectDisconnect = inProgress || (running && mutation.variables?.operation === "continue");
  const hasPendingPlan = plan?.phase === "confirm" || inProgress;
  const busy = (query.isFetching && plan === undefined) || running;
  const serverId = server?.id;
  const serverUrl = server?.url;
  const phase = plan?.phase;
  useEffect(() => {
    if (phase === "complete" || phase === "error") {
      void queryClient.invalidateQueries({ queryKey: ["jellyfin-plugins", serverId, serverUrl] });
    }
  }, [phase, queryClient, serverId, serverUrl]);
  function updateSelections(update: (values: Selection[]) => Selection[]) {
    if (server && !busy && !hasPendingPlan) {
      mutation.reset();
      setQueued({ serverId: server.id, serverUrl: server.url, values: update(selections) });
    }
  }
  return {
    busy,
    running,
    expectDisconnect,
    hasPendingPlan,
    plan,
    selections,
    error: mutation.isError || query.isError,
    runningOperation: mutation.isPending ? mutation.variables.operation : undefined,
    toggle(selection: Selection) {
      updateSelections((values) =>
        values.some((value) => matches(value, selection))
          ? values.filter((value) => !matches(value, selection))
          : [...values, selection],
      );
    },
    clear() {
      updateSelections(() => []);
      queryClient.setQueryData(key, null);
    },
    reset: mutation.reset,
    refresh() {
      mutation.reset();
      if (enabled) void query.refetch();
    },
    execute(operation: Operation) {
      if (server && enabled && !busy)
        mutation.mutate({
          operation,
          serverId: server.id,
          serverUrl: server.url,
          selected: selections,
        });
    },
  };
}

type Workflow = ReturnType<typeof useJellyfinThoroughUninstall>;

export function JellyfinThoroughUninstall({
  workflow,
  disabled,
}: {
  workflow: Workflow;
  disabled: boolean;
}) {
  const { t } = useAppTranslation();
  const { plan, selections, hasPendingPlan, running, runningOperation, error } = workflow;
  if (!plan && selections.length === 0 && !running && !error) return null;
  const unavailable = disabled || workflow.busy;
  const phase = plan?.phase;
  const workingMessage =
    (phase && progressMessages[phase]) ??
    (runningOperation === "prepare"
      ? "pluginThoroughPreviewing"
      : runningOperation === "continue"
        ? "pluginThoroughRunning"
        : undefined);
  return (
    <section className="space-y-3 rounded-md border bg-card p-3 text-card-foreground">
      <h4 className="text-sm font-medium">{t("pluginUninstall")}</h4>
      <div role="status" className="space-y-1 text-xs">
        {workingMessage && (
          <p className="flex items-center gap-2">
            <LoaderCircle
              className="size-3.5 shrink-0 motion-safe:animate-spin"
              aria-hidden="true"
            />
            {t(workingMessage)}
          </p>
        )}
        {error && !running && <p className="text-destructive">{t("pluginThoroughFailed")}</p>}
        {plan?.error && !running && <p className="text-destructive">{t(errors[plan.error])}</p>}
        {phase === "complete" && <p>{t("pluginThoroughDone")}</p>}
        {phase === "start-manually" && (
          <p>
            {t(plan?.mode === "tray" ? "pluginThoroughTrayStart" : "pluginThoroughManualStart")}
          </p>
        )}
        {phase === "stop-manually" && <p>{t("pluginThoroughManualStop")}</p>}
      </div>
      {!hasPendingPlan && phase !== "complete" && selections.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 basis-24 text-xs">
            {t("pluginThoroughSelection", { count: selections.length })}
          </p>
          <Button size="sm" variant="ghost" disabled={unavailable} onClick={() => workflow.clear()}>
            {t("pluginThoroughClear")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={unavailable}
            onClick={() => workflow.execute("prepare")}
          >
            {t("pluginThoroughReview")}
          </Button>
        </div>
      )}
      {plan && phase !== "error" && (
        <>
          {phase !== "complete" && (
            <p className="text-xs">{t("pluginThoroughPreviewDescription")}</p>
          )}
          <ul className="space-y-2 divide-y divide-border">
            {plan.selections.map((selection) => (
              <li key={`${selection.pluginId}:${selection.version}`} className="space-y-1 pt-2">
                <p className="text-xs font-medium wrap-anywhere text-foreground">
                  {selection.name} {selection.version}
                </p>
                {selection.paths.map(({ originalPath, backupPath }) => (
                  <dl
                    key={originalPath}
                    className="grid gap-x-3 gap-y-1 text-xs text-muted-foreground min-[900px]:grid-cols-[max-content_minmax(0,1fr)]"
                  >
                    {phase !== "complete" && (
                      <>
                        <dt>{t("pluginThoroughOriginal")}</dt>
                        <dd className="wrap-anywhere">{originalPath}</dd>
                      </>
                    )}
                    <dt>{t("pluginThoroughBackup")}</dt>
                    <dd className="wrap-anywhere">{backupPath}</dd>
                  </dl>
                ))}
              </li>
            ))}
          </ul>
          {phase === "confirm" && (
            <p className="text-xs">
              {t(
                plan.mode === "tray"
                  ? "pluginThoroughTrayStop"
                  : plan.mode === "manual"
                    ? "pluginThoroughManualStop"
                    : "pluginThoroughAutoStop",
              )}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {(phase === "confirm" || phase === "stop-manually" || phase === "complete") && (
              <Button
                size="sm"
                variant="outline"
                disabled={unavailable}
                onClick={() => workflow.execute("cancel")}
              >
                {t(phase === "complete" ? "pluginThoroughDoneClose" : "cancel")}
              </Button>
            )}
            {(phase === "confirm" ||
              (phase === "stop-manually" && plan.error === "move-failed")) && (
              <Button
                size="sm"
                disabled={unavailable}
                variant="destructive"
                onClick={() => workflow.execute("continue")}
              >
                {t(
                  phase === "confirm" ? "pluginThoroughConfirm" : "pluginThoroughContinueAfterStop",
                )}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function matches(left: Selection, right: Selection) {
  return left.pluginId === right.pluginId && left.version === right.version;
}
