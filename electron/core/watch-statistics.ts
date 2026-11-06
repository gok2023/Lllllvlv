import { readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WatchStatisticsPathLocator } from "./watch-statistics-path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  WatchStatisticsSnapshot,
  WatchStatisticsSettings,
  WatchMedia,
  WatchRecord,
  WatchStatisticsImportPreview,
  WatchReviewAction,
  WatchConfirmation,
  WatchCandidate,
  WatchBatchReviewInput,
  WatchBatchReviewPreview,
} from "../../src/shared/watch-statistics";

type Identity = { baseUrl: string; userId: string; token: string };
type RawItem = {
  Id: string;
  Name?: string;
  Type?: string;
  SeriesId?: string;
  SeriesName?: string;
  ParentId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  RunTimeTicks?: number;
  ProductionYear?: number;
  Genres?: string[];
  People?: { Name: string; Type: string }[];
  UserData?: {
    Played?: boolean;
    PlayCount?: number;
    LastPlayedDate?: string;
    PlaybackPositionTicks?: number;
  };
  ProviderIds?: Record<string, string>;
};
type RawActivity = {
  DateCreated: string;
  UserId: string;
  ItemId: string;
  ItemType: string;
  ItemName: string;
  PlayDuration: number;
  ClientName?: string;
  DeviceName?: string;
  PlaybackMethod?: string;
};
const defaults: WatchStatisticsSettings = {
  gapMinutes: 15,
  includeBackfill: true,
  excludeShort: false,
  rewatchMinutes: 10,
};
const seconds = (ticks?: number) => (ticks && ticks > 0 ? ticks / 10_000_000 : undefined);
const itemId = (value: string) => value.replace(/-/g, "").toLowerCase();
const reportDate = (value: string) => {
  // Playback Reporting stores DateTime.Now without an offset. Interpret it in the
  // Jellyfin host's local timezone (the local-server fallback uses this host).
  const timestamp = value.replace(" ", "T");
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) throw new Error("播放记录日期无效");
  return parsed.toISOString();
};
const rawDate = (value: string) => value.trim().replace("T", " ");
const mediaKey = (media: WatchMedia) => {
  const providers = media.providerIds ?? {};
  const entry = Object.entries(providers).find(
    ([key, value]) => /^(tmdb|imdb|tvdb)$/i.test(key) && value,
  );
  return entry ? `${media.type}:${entry[0].toLowerCase()}:${entry[1].toLowerCase()}` : undefined;
};
const providerKeys = (media: WatchMedia) =>
  Object.entries(media.providerIds ?? {})
    .filter(([key, value]) => /^(tmdb|imdb|tvdb)$/i.test(key) && value)
    .map(([key, value]) => `${media.type}:${key.toLowerCase()}:${value.toLowerCase()}`);
const optionalText = z.string().optional();
const mediaSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  seriesId: optionalText,
  seriesName: optionalText,
  seasonNumber: z.number().optional(),
  episodeNumber: z.number().optional(),
  libraryId: optionalText,
  libraryName: optionalText,
  runtimeSec: z.number().optional(),
  year: z.number().optional(),
  genres: z.array(z.string()),
  directors: z.array(z.string()),
  played: z.boolean(),
  playCount: z.number(),
  lastPlayedAt: optionalText,
  positionSec: z.number().optional(),
  providerIds: z.record(z.string(), z.string()).optional(),
  sourceId: optionalText,
});
const recordSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  itemName: z.string(),
  itemType: z.string(),
  startAt: z.iso.datetime({ offset: true }),
  durationSec: z.number().finite().nonnegative(),
  clientName: optionalText,
  deviceName: optionalText,
  playbackMethod: optionalText,
  userId: optionalText,
  rawDate: optionalText,
  sourceKey: optionalText,
});
const backfillSchema = z.object({
  itemId: z.string(),
  durationSec: z.number().finite().nonnegative(),
  watchedAt: optionalText,
  baselineRecordIds: z.array(z.string()).optional(),
  baselineAt: optionalText,
});
const confirmationSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  source: z.enum(["initial", "confirmed", "rewatch", "manual"]),
  confirmedAt: optionalText,
  evidenceIds: z.array(z.string()),
  estimatedDurationSec: z.number().finite().nonnegative().optional(),
  baselineAt: optionalText,
});
const candidateSchema = z.object({
  itemId: z.string(),
  evidenceIds: z.array(z.string()),
  status: z.enum(["accumulating", "pending", "later", "ignored"]),
});
const settingsSchema = z.object({
  gapMinutes: z.number().finite().nonnegative(),
  includeBackfill: z.boolean(),
  excludeShort: z.boolean(),
  rewatchMinutes: z.number().finite().nonnegative().optional(),
});
const snapshotSchema = z.object({
  serverId: z.string(),
  refreshedAt: z.string(),
  media: z.array(mediaSchema),
  records: z.array(recordSchema),
  backfill: z.array(backfillSchema),
  settings: settingsSchema,
  cursor: optionalText,
  libraries: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  confirmations: z.array(confirmationSchema).optional(),
  candidates: z.array(candidateSchema).optional(),
  appliedReviewIds: z.array(z.string()).optional(),
});
function planBatch(snapshot: WatchStatisticsSnapshot, input: WatchBatchReviewInput) {
  const ids = [...new Set(input.itemIds)].sort();
  if (!ids.length) throw new Error("请选择作品");
  if (
    input.mode === "set" &&
    (!Number.isInteger(input.totalCount) || input.totalCount! < 0 || input.totalCount! > 100)
  )
    throw new Error("目标次数无效");
  const media = new Map(snapshot.media.map((item) => [item.id, item]));
  const confirmations = (snapshot.confirmations ?? []).map((entry) => ({ ...entry }));
  const items: WatchBatchReviewPreview["items"] = [];
  for (const id of ids) {
    const item = media.get(id);
    if (!item || !["Movie", "Episode"].includes(item.type)) throw new Error("作品不存在");
    const existing = confirmations.filter((entry) => entry.itemId === id);
    const beforeCount = existing.length;
    const legacyEstimate = snapshot.backfill.find((entry) => entry.itemId === id && entry.durationSec > 0);
    const beforeEstimate = (legacyEstimate?.durationSec ?? 0) + existing.reduce(
      (sum, entry) => sum + (entry.estimatedDurationSec ?? 0),
      0,
    );
    const estimatedBeforeCount = Number(Boolean(legacyEstimate)) +
      existing.filter((entry) => entry.estimatedDurationSec !== undefined).length;
    if (input.mode === "estimate") {
      for (const entry of existing.filter((entry) => entry.source === "manual"))
        entry.estimatedDurationSec = input.estimated ? item.runtimeSec : undefined;
    } else {
      const target =
        input.mode === "set"
          ? input.totalCount!
          : Math.max(0, Math.min(100, beforeCount + (input.mode === "increase" ? 1 : -1)));
      if (target < beforeCount) {
        const priority = (entry: WatchConfirmation) =>
          entry.source === "manual"
            ? 0
            : entry.source === "rewatch"
              ? 1
              : entry.source === "confirmed"
                ? 2
                : 3;
        const removable = [...existing].sort(
          (a, b) =>
            priority(a) - priority(b) ||
            Number(Boolean(b.estimatedDurationSec) === Boolean(input.estimate)) -
              Number(Boolean(a.estimatedDurationSec) === Boolean(input.estimate)),
        );
        for (const entry of removable.slice(0, beforeCount - target))
          confirmations.splice(confirmations.indexOf(entry), 1);
      }
      for (let index = beforeCount; index < target; index++)
        confirmations.push({
          id: randomUUID(),
          itemId: id,
          source: "manual",
          evidenceIds: [],
          estimatedDurationSec: input.estimate ? item.runtimeSec : undefined,
        });
    }
    const after = confirmations.filter((entry) => entry.itemId === id);
    const estimateAfterSec = (legacyEstimate?.durationSec ?? 0) + after.reduce(
      (sum, entry) => sum + (entry.estimatedDurationSec ?? 0),
      0,
    );
    const estimatedAfterCount = Number(Boolean(legacyEstimate)) +
      after.filter((entry) => entry.estimatedDurationSec !== undefined).length;
    items.push({
      itemId: id,
      beforeCount,
      afterCount: after.length,
      estimateBeforeSec: beforeEstimate,
      estimateAfterSec,
      estimatedBeforeCount,
      estimatedAfterCount,
      estimateDeltaSec: estimateAfterSec - beforeEstimate,
      estimateUnavailable:
        !item.runtimeSec &&
        (input.mode === "estimate"
          ? Boolean(
              input.estimated &&
              existing.some(
                (entry) => entry.source === "manual" && entry.estimatedDurationSec === undefined,
              ),
            )
          : Boolean(input.estimate && after.length > beforeCount)),
      changed:
        beforeCount !== after.length ||
        beforeEstimate !== estimateAfterSec ||
        estimatedBeforeCount !== estimatedAfterCount,
    });
  }
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        input: {
          action: input.action,
          mode: input.mode,
          totalCount: input.totalCount,
          estimate: input.estimate,
          estimated: input.estimated,
          itemIds: ids,
        },
        state: ids.map((id) => ({
          id,
          runtimeSec: media.get(id)?.runtimeSec,
          confirmations: (snapshot.confirmations ?? []).filter((entry) => entry.itemId === id),
          backfill: snapshot.backfill.filter((entry) => entry.itemId === id),
        })),
      }),
    )
    .digest("hex");
  const countBefore = items.reduce((sum, entry) => sum + entry.beforeCount, 0);
  const countAfter = items.reduce((sum, entry) => sum + entry.afterCount, 0);
  const preview: WatchBatchReviewPreview = {
    token,
    itemCount: ids.length,
    changedCount: items.filter((entry) => entry.changed).length,
    countBefore,
    countAfter,
    countDelta: countAfter - countBefore,
    estimateBeforeSec: items.reduce((sum, entry) => sum + entry.estimateBeforeSec, 0),
    estimateAfterSec: items.reduce((sum, entry) => sum + entry.estimateAfterSec, 0),
    estimateDeltaSec: items.reduce((sum, entry) => sum + entry.estimateDeltaSec, 0),
    actualDurationDeltaSec: 0,
    items,
  };
  return { confirmations, preview };
}

export class WatchStatisticsStore {
  private writes = new Map<string, Promise<WatchStatisticsSnapshot>>();
  private correctionWrites = new Map<string, Promise<unknown>>();
  private currentSettings = new Map<string, WatchStatisticsSettings>();
  constructor(
    private readonly directory: string,
    private readonly pathLocator = new WatchStatisticsPathLocator(directory),
  ) {}
  private path(serverId: string, userId: string) {
    return join(this.directory, "watch-statistics", `${serverId}-${itemId(userId)}.json`);
  }
  private correctionPath(serverId: string, userId: string) {
    return `${this.path(serverId, userId)}.corrections.json`;
  }
  private async writeCorrections(
    serverId: string,
    userId: string,
    corrections: NonNullable<WatchStatisticsSnapshot["corrections"]>,
  ) {
    const path = this.correctionPath(serverId, userId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(corrections));
    const { rename } = await import("node:fs/promises");
    await rename(temporary, path);
  }
  async getView(serverId: string, userId: string): Promise<WatchStatisticsSnapshot | null> {
    const snapshot = await this.get(serverId, userId);
    if (!snapshot) return null;
    let corrections = {
      records: {} as Record<string, string>,
      items: {} as Record<string, string>,
    };
    try {
      const parsed = JSON.parse(await readFile(this.correctionPath(serverId, userId), "utf8"));
      const schema = z.object({
        records: z.record(z.string(), z.string()),
        items: z.record(z.string(), z.string()),
      });
      const result = schema.safeParse(parsed);
      if (result.success) corrections = result.data;
    } catch {
      /* Missing or malformed corrections leave the original snapshot usable. */
    }
    return { ...snapshot, corrections };
  }
  async correctLibrary(
    serverId: string,
    userId: string,
    recordId: string,
    libraryId: string | null,
    remember: boolean,
  ) {
    const path = this.correctionPath(serverId, userId);
    const prior = this.correctionWrites.get(path) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(async () => {
        const snapshot = await this.getView(serverId, userId);
        if (!snapshot) throw new Error("尚无观影统计数据");
        const record = snapshot.records.find((entry) => entry.id === recordId);
        if (!record) throw new Error("播放记录不存在");
        if (libraryId !== null && !snapshot.libraries?.some((entry) => entry.id === libraryId))
          throw new Error("媒体库不存在，请重新同步");
        const corrections = snapshot.corrections!;
        const key = itemId(record.itemId);
        if (libraryId === null) {
          delete corrections.records[recordId];
          if (remember) delete corrections.items[key];
        } else {
          corrections.records[recordId] = libraryId;
          if (remember) corrections.items[key] = libraryId;
        }
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(corrections));
        const { rename } = await import("node:fs/promises");
        await rename(temporary, path);
        return { ...snapshot, corrections };
      });
    this.correctionWrites.set(path, next);
    try {
      return await next;
    } finally {
      if (this.correctionWrites.get(path) === next) this.correctionWrites.delete(path);
    }
  }
  async get(serverId: string, userId: string): Promise<WatchStatisticsSnapshot | null> {
    try {
      return JSON.parse(
        await readFile(this.path(serverId, userId), "utf8"),
      ) as WatchStatisticsSnapshot;
    } catch {
      return null;
    }
  }
  async exportData(serverId: string, userId: string, path: string): Promise<void> {
    const snapshot = await this.getView(serverId, userId);
    if (!snapshot) throw new Error("尚无可导出的观影统计数据");
    await writeFile(
      path,
      JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), snapshot }),
    );
  }
  private async readImport(path: string) {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("导入文件格式无效");
    const archive = parsed as { version?: unknown; exportedAt?: unknown; snapshot?: unknown };
    if (
      ![1, 2].includes(Number(archive.version)) ||
      !archive.snapshot ||
      typeof archive.snapshot !== "object"
    )
      throw new Error("不支持的统计文件版本");
    const result = snapshotSchema.safeParse(archive.snapshot);
    if (!result.success)
      throw new Error(`统计文件内容无效：${result.error.issues[0]?.path.join(".") ?? "未知字段"}`);
    const snapshot = result.data as WatchStatisticsSnapshot;
    const corrections = z
      .object({
        records: z.record(z.string(), z.string()),
        items: z.record(z.string(), z.string()),
      })
      .safeParse((archive.snapshot as WatchStatisticsSnapshot).corrections);
    if (corrections.success) snapshot.corrections = corrections.data;
    return {
      snapshot,
      exportedAt: typeof archive.exportedAt === "string" ? archive.exportedAt : undefined,
    };
  }
  async previewImport(path: string): Promise<WatchStatisticsImportPreview> {
    const { snapshot, exportedAt } = await this.readImport(path);
    const dates = snapshot.records.map((r) => r.startAt).sort();
    return {
      version: 2,
      records: snapshot.records.length,
      backfill: snapshot.backfill.length,
      media: snapshot.media.length,
      earliestAt: dates[0],
      latestAt: dates.at(-1),
      exportedAt,
    };
  }
  async importData(
    serverId: string,
    userId: string,
    path: string,
  ): Promise<WatchStatisticsSnapshot> {
    const { snapshot } = await this.readImport(path);
    const destination = this.path(serverId, userId);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await copyFile(destination, `${destination}.${Date.now()}.backup`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const imported: WatchStatisticsSnapshot = {
      ...snapshot,
      serverId,
      cursor: undefined,
      records: snapshot.records.map((r) => ({ ...r, userId })),
      refreshedAt: new Date().toISOString(),
    };
    this.currentSettings.delete(this.path(serverId, userId));
    await this.save(serverId, userId, imported);
    if (snapshot.corrections) {
      const correctionsPath = this.correctionPath(serverId, userId);
      try {
        await copyFile(correctionsPath, `${correctionsPath}.${Date.now()}.backup`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.writeCorrections(serverId, userId, snapshot.corrections);
    }
    return imported;
  }
  async bindImported(
    serverId: string,
    fromUserId: string,
    toUserId: string,
  ): Promise<WatchStatisticsSnapshot | null> {
    const imported = await this.get(serverId, fromUserId);
    if (!imported) return this.get(serverId, toUserId);
    const existing = await this.get(serverId, toUserId);
    const destination = this.path(serverId, toUserId);
    await mkdir(dirname(destination), { recursive: true });
    if (existing) await copyFile(destination, `${destination}.${Date.now()}.backup`);
    const merged: WatchStatisticsSnapshot = {
      ...imported,
      serverId,
      cursor: undefined,
      refreshedAt: new Date().toISOString(),
      media: [
        ...new Map([...imported.media, ...(existing?.media ?? [])].map((m) => [m.id, m])).values(),
      ],
      records: [
        ...new Map(
          [...(existing?.records ?? []), ...imported.records].map((r) => [
            r.id,
            { ...r, userId: toUserId },
          ]),
        ).values(),
      ],
      backfill: [
        ...new Map(
          [...(existing?.backfill ?? []), ...imported.backfill].map((b) => [b.itemId, b]),
        ).values(),
      ],
      confirmations: [
        ...new Map(
          [...(existing?.confirmations ?? []), ...(imported.confirmations ?? [])].map((c) => [
            c.id,
            c,
          ]),
        ).values(),
      ],
      appliedReviewIds: [
        ...new Set([...(existing?.appliedReviewIds ?? []), ...(imported.appliedReviewIds ?? [])]),
      ],
      candidates: [
        ...new Map(
          [...(existing?.candidates ?? []), ...(imported.candidates ?? [])].map((c) => [
            c.itemId,
            c,
          ]),
        ).values(),
      ],
    };
    const sourceView = await this.getView(serverId, fromUserId);
    const targetView = await this.getView(serverId, toUserId);
    await this.writeCorrections(serverId, toUserId, {
      records: { ...sourceView?.corrections?.records, ...targetView?.corrections?.records },
      items: { ...sourceView?.corrections?.items, ...targetView?.corrections?.items },
    });
    this.currentSettings.delete(this.path(serverId, toUserId));
    this.currentSettings.delete(this.path(serverId, fromUserId));
    await this.save(serverId, toUserId, merged);
    await unlink(this.path(serverId, fromUserId));
    return merged;
  }
  private async save(
    serverId: string,
    userId: string,
    value: WatchStatisticsSnapshot,
    settingsOnly = false,
    baseline?: WatchStatisticsSnapshot | null,
  ): Promise<WatchStatisticsSnapshot> {
    const path = this.path(serverId, userId);
    await mkdir(dirname(path), { recursive: true });
    const previous = this.writes.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        // A settings click may arrive while a full scan is running. Apply it to
        // the latest committed data instead of writing an older snapshot over it.
        const latest =
          settingsOnly || baseline !== undefined ? await this.get(serverId, userId) : null;
        const snapshot = settingsOnly && latest ? latest : value;
        if (
          !settingsOnly &&
          latest &&
          baseline &&
          JSON.stringify({
            confirmations: latest.confirmations,
            candidates: latest.candidates,
            backfill: latest.backfill,
          }) !==
            JSON.stringify({
              confirmations: baseline.confirmations,
              candidates: baseline.candidates,
              backfill: baseline.backfill,
            })
        ) {
          const migrated = (snapshot.confirmations ?? []).filter(
            (entry) =>
              entry.source === "initial" &&
              !(baseline.confirmations ?? []).some((old) => old.id === entry.id) &&
              ((latest.candidates ?? []).some(
                (candidate) =>
                  candidate.itemId === entry.itemId &&
                  candidate.status === "pending" &&
                  candidate.evidenceIds.length === 0,
              ) ||
                !(baseline.media ?? []).some((item) => item.id === entry.itemId)) &&
              !(latest.confirmations ?? []).some((old) => old.itemId === entry.itemId),
          );
          snapshot.confirmations = [...(latest.confirmations ?? []), ...migrated];
          snapshot.candidates = [
            ...new Map(
              [...(snapshot.candidates ?? []), ...(latest.candidates ?? [])].map((entry) => [
                entry.itemId,
                entry,
              ]),
            ).values(),
          ];
          snapshot.candidates = snapshot.candidates.filter(
            (entry) => !migrated.some((confirmation) => confirmation.itemId === entry.itemId),
          );
          snapshot.backfill = [
            ...new Map(
              [...(snapshot.backfill ?? []), ...(latest.backfill ?? [])].map((entry) => [
                entry.itemId,
                entry,
              ]),
            ).values(),
          ];
        }
        if (
          !settingsOnly &&
          latest &&
          baseline &&
          (snapshot.confirmations ?? []).some(
            (entry) =>
              entry.source === "initial" &&
              !(latest.confirmations ?? []).some((old) => old.id === entry.id),
          )
        ) {
          try {
            await copyFile(
              path,
              `${path}.historical-first-watch.backup`,
              fsConstants.COPYFILE_EXCL,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        snapshot.settings = this.currentSettings.get(path) ?? snapshot.settings;
        if (!settingsOnly && latest && baseline)
          snapshot.appliedReviewIds = [
            ...new Set([...(snapshot.appliedReviewIds ?? []), ...(latest.appliedReviewIds ?? [])]),
          ];
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot));
        const { rename } = await import("node:fs/promises");
        await rename(temporary, path);
        return snapshot;
      });
    this.writes.set(path, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(path) === next) this.writes.delete(path);
    }
  }
  async settings(serverId: string, userId: string, settings: WatchStatisticsSettings) {
    this.currentSettings.set(this.path(serverId, userId), settings);
    const saved = await this.get(serverId, userId);
    if (saved) {
      saved.settings = settings;
      return this.save(serverId, userId, saved, true);
    }
    return saved;
  }
  async review(serverId: string, userId: string, input: WatchReviewAction) {
    const path = this.path(serverId, userId);
    const previous = this.writes.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const snapshot = await this.get(serverId, userId);
        if (!snapshot) throw new Error("尚无观影统计数据");
        if (input.action === "batch" && snapshot.appliedReviewIds?.includes(input.operationId))
          return snapshot;
        const media = new Map(snapshot.media.map((item) => [item.id, item]));
        let confirmations = snapshot.confirmations ?? [];
        const candidates = snapshot.candidates ?? [];
        if (input.action === "batch") {
          const planned = planBatch(snapshot, input);
          if (planned.preview.token !== input.token) throw new Error("预览已过期，请重新预览");
          confirmations = planned.confirmations;
          snapshot.appliedReviewIds = [...(snapshot.appliedReviewIds ?? []), input.operationId];
        } else if (input.action === "revoke") {
          const index = confirmations.findIndex((item) => item.id === input.confirmationId);
          if (index < 0) throw new Error("观看确认不存在");
          confirmations.splice(index, 1);
        } else {
          for (const id of input.itemIds) {
            const item = media.get(id);
            if (!item || !["Movie", "Episode"].includes(item.type)) throw new Error("作品不存在");
            const candidate = candidates.find(
              (entry) =>
                entry.itemId === id &&
                entry.status !== "ignored" &&
                entry.status !== "accumulating",
            );
            if (input.action === "manual") {
              const count = confirmations.filter((entry) => entry.itemId === id).length;
              if (input.totalCount < count) {
                let remove = count - input.totalCount;
                for (let i = confirmations.length - 1; i >= 0 && remove; i--)
                  if (confirmations[i].itemId === id) {
                    confirmations.splice(i, 1);
                    remove--;
                  }
              }
              for (let i = count; i < input.totalCount; i++)
                confirmations.push({
                  id: randomUUID(),
                  itemId: id,
                  source: "manual",
                  evidenceIds: [],
                  estimatedDurationSec: input.estimate ? item.runtimeSec : undefined,
                });
            } else if (input.action === "confirm" || input.action === "confirmDirect") {
              confirmations.push({
                id: randomUUID(),
                itemId: id,
                source: confirmations.some((entry) => entry.itemId === id)
                  ? "rewatch"
                  : "confirmed",
                confirmedAt: new Date().toISOString(),
                evidenceIds: candidate?.evidenceIds ?? [],
                baselineAt: new Date().toISOString(),
              });
              if (candidate) candidates.splice(candidates.indexOf(candidate), 1);
            } else if (candidate) {
              candidate.status = input.action === "ignore" ? "ignored" : "later";
            }
          }
        }
        snapshot.confirmations = confirmations;
        snapshot.candidates = candidates;
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot));
        const { rename } = await import("node:fs/promises");
        await rename(temporary, path);
        return snapshot;
      });
    this.writes.set(path, next);
    try {
      await next;
      return this.getView(serverId, userId);
    } finally {
      if (this.writes.get(path) === next) this.writes.delete(path);
    }
  }
  async previewReview(
    serverId: string,
    userId: string,
    input: WatchBatchReviewInput,
  ): Promise<WatchBatchReviewPreview> {
    const path = this.path(serverId, userId);
    await this.writes.get(path)?.catch(() => {});
    const snapshot = await this.get(serverId, userId);
    if (!snapshot) throw new Error("尚无观影统计数据");
    return planBatch(snapshot, input).preview;
  }
  async refresh(
    serverId: string,
    auth: Identity,
    fetcher: typeof fetch,
    mode: "full" | "incremental" = "full",
  ): Promise<WatchStatisticsSnapshot> {
    const base = auth.baseUrl.replace(/\/$/, "");
    const reportUserId = itemId(auth.userId);
    if (!/^[0-9a-f]{32}$/.test(reportUserId)) throw new Error("Jellyfin 用户 ID 无效");
    async function request<T>(path: string, body?: unknown): Promise<T> {
      const stage = path.startsWith("user_usage_stats/")
        ? "Playback Reporting 请求"
        : path.endsWith("/Views")
          ? "Jellyfin 媒体库请求"
          : "Jellyfin 媒体请求";
      try {
        const response = await fetcher(`${base}/${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            "X-Emby-Token": auth.token,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`${stage}失败 (${response.status})`);
        return response.json() as Promise<T>;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(stage)) throw error;
        throw new Error(
          `${stage}${error instanceof Error && error.name === "TimeoutError" ? "超时" : "失败，请检查服务连接"}`,
        );
      }
    }
    const previous = await this.get(serverId, auth.userId);
    const fullScan = mode === "full" || !previous || !previous.cursor;
    const views = await request<{ Items: RawItem[] }>(
      `Users/${encodeURIComponent(auth.userId)}/Views`,
    );
    const libraries = new Map(
      (views.Items ?? []).map((item) => [itemId(item.Id), item.Name ?? "未匹配"]),
    );
    const raw: RawItem[] = [];
    const itemLibraries = new Map<string, string>();
    if (fullScan)
      for (const libraryId of libraries.keys())
        for (let offset = 0; ;) {
          const params = new URLSearchParams({
            ParentId: libraryId,
            Recursive: "true",
            EnableUserData: "true",
            EnableImages: "false",
            IncludeItemTypes: "Movie,Series,Season,Episode",
            Fields: "Genres,People,ParentId,ProviderIds",
            StartIndex: String(offset),
            Limit: "500",
          });
          const page = await request<{ Items: RawItem[]; TotalRecordCount?: number }>(
            `Users/${encodeURIComponent(auth.userId)}/Items?${params}`,
          );
          for (const item of page.Items) {
            raw.push(item);
            itemLibraries.set(itemId(item.Id), libraryId);
          }
          offset += page.Items.length;
          if (
            page.Items.length === 0 ||
            offset >= (page.TotalRecordCount ?? (page.Items.length < 500 ? offset : Infinity))
          )
            break;
        }
    const parents = new Map(raw.map((item) => [itemId(item.Id), item]));
    const convertMedia = (item: RawItem): WatchMedia => {
      let cursor: RawItem | undefined = item;
      let libraryId: string | undefined = itemLibraries.get(itemId(item.Id));
      if (!libraryId && item.ParentId && libraries.has(itemId(item.ParentId)))
        libraryId = itemId(item.ParentId);
      for (let i = 0; cursor && i < 8; i++) {
        if (libraries.has(itemId(cursor.Id))) {
          libraryId = itemId(cursor.Id);
          break;
        }
        cursor = cursor.ParentId ? parents.get(itemId(cursor.ParentId)) : undefined;
      }
      return {
        id: itemId(item.Id),
        name: item.Name ?? "",
        type: item.Type ?? "",
        seriesId: item.SeriesId ? itemId(item.SeriesId) : undefined,
        seriesName: item.SeriesName,
        seasonNumber: item.ParentIndexNumber,
        episodeNumber: item.IndexNumber,
        libraryId,
        libraryName: libraryId ? libraries.get(libraryId) : "未匹配",
        runtimeSec: seconds(item.RunTimeTicks),
        year: item.ProductionYear,
        genres: item.Genres ?? [],
        directors:
          item.People?.filter((person) => person.Type === "Director").map(
            (person) => person.Name,
          ) ?? [],
        played: !!item.UserData?.Played,
        playCount: item.UserData?.PlayCount ?? 0,
        lastPlayedAt: item.UserData?.LastPlayedDate,
        positionSec: seconds(item.UserData?.PlaybackPositionTicks),
        providerIds: item.ProviderIds,
      };
    };
    const media: WatchMedia[] = raw.map(convertMedia);
    let activities: RawActivity[];
    try {
      const overlap =
        previous?.cursor && !fullScan
          ? new Date(Date.parse(previous.cursor) - 7 * 86400000)
          : undefined;
      const since = overlap
        ? ` AND DateCreated >= '${overlap.getFullYear()}-${String(overlap.getMonth() + 1).padStart(2, "0")}-${String(overlap.getDate()).padStart(2, "0")} ${String(overlap.getHours()).padStart(2, "0")}:${String(overlap.getMinutes()).padStart(2, "0")}:${String(overlap.getSeconds()).padStart(2, "0")}'`
        : "";
      const query = `SELECT CAST(DateCreated AS TEXT) AS DateCreated, UserId, ItemId, ItemType, ItemName, PlayDuration, ClientName, DeviceName, PlaybackMethod FROM PlaybackActivity WHERE lower(replace(UserId, '-', '')) = '${reportUserId}'${since} ORDER BY DateCreated DESC`;
      const result = await request<{ colums?: string[]; results?: unknown[][]; message?: string }>(
        "user_usage_stats/submit_custom_query",
        { CustomQueryString: query, ReplaceUserId: false },
      );
      if (/^Query executed, no data returned/i.test(result.message ?? "")) activities = [];
      else if (
        !result.colums ||
        !result.results ||
        (result.message && !/^Query executed/i.test(result.message))
      )
        throw new Error("查询结果无效");
      else
        activities = result.results.map(
          (row) =>
            Object.fromEntries(
              result.colums!.map((column, index) => [column, row[index]]),
            ) as RawActivity,
        );
      this.pathLocator.markApiSuccess(serverId, base);
    } catch {
      const info = await request<{ ProgramDataPath?: string }>("System/Info").catch(
        () => ({}) as { ProgramDataPath?: string },
      );
      const databasePath = await this.pathLocator.discover(
        serverId,
        base,
        false,
        info.ProgramDataPath,
      );
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const overlap =
          previous?.cursor && !fullScan
            ? new Date(Date.parse(previous.cursor) - 7 * 86400000)
            : undefined;
        const since = overlap
          ? `${overlap.getFullYear()}-${String(overlap.getMonth() + 1).padStart(2, "0")}-${String(overlap.getDate()).padStart(2, "0")} ${String(overlap.getHours()).padStart(2, "0")}:${String(overlap.getMinutes()).padStart(2, "0")}:${String(overlap.getSeconds()).padStart(2, "0")}`
          : undefined;
        activities = db
          .prepare(
            `SELECT CAST(DateCreated AS TEXT) AS DateCreated, UserId, ItemId, ItemType, ItemName, PlayDuration, ClientName, DeviceName, PlaybackMethod FROM PlaybackActivity WHERE lower(replace(UserId, '-', '')) = ?${since ? " AND DateCreated >= ?" : ""} ORDER BY DateCreated DESC`,
          )
          .all(...(since ? [reportUserId, since] : [reportUserId])) as unknown as RawActivity[];
      } finally {
        db.close();
      }
    }
    const current: WatchRecord[] = activities
      .map((row) => {
        if (
          !row.ItemId ||
          !row.DateCreated ||
          !row.UserId ||
          !Number.isFinite(Number(row.PlayDuration))
        )
          throw new Error("播放记录缺少必需字段");
        const startAt = reportDate(row.DateCreated);
        const sourceKey = `${itemId(row.ItemId)}:${rawDate(row.DateCreated)}:${row.ClientName ?? ""}:${row.DeviceName ?? ""}`;
        return {
          id: `${reportUserId}:${sourceKey}`,
          itemId: itemId(row.ItemId),
          itemName: row.ItemName ?? "",
          itemType: row.ItemType ?? "",
          startAt,
          durationSec: Number(row.PlayDuration),
          clientName: row.ClientName,
          deviceName: row.DeviceName,
          playbackMethod: row.PlaybackMethod,
          userId: row.UserId,
          rawDate: row.DateCreated,
          sourceKey,
        };
      })
      .filter((row) => row.durationSec >= 0);
    const mediaById = new Map((previous?.media ?? []).map((m) => [m.id, m]));
    for (const item of media) mediaById.set(item.id, item);
    if (!fullScan) {
      const priorRecords = new Map((previous?.records ?? []).map((r) => [r.id, r]));
      const changed = current.filter((r) => priorRecords.get(r.id)?.durationSec !== r.durationSec);
      const ids = new Set(changed.map((r) => r.itemId));
      const fetchItems = async (requested: string[]) => {
        const found: RawItem[] = [];
        for (let offset = 0; offset < requested.length; offset += 100) {
          const params = new URLSearchParams({
            Ids: requested.slice(offset, offset + 100).join(","),
            Fields: "Genres,People,ParentId,ProviderIds",
            EnableUserData: "true",
            EnableImages: "false",
            Limit: "100",
          });
          const page = await request<{ Items: RawItem[] }>(
            `Users/${encodeURIComponent(auth.userId)}/Items?${params}`,
          ).catch(() => null);
          found.push(...(page?.Items ?? []));
        }
        return found;
      };
      const changedItems = await fetchItems([...ids]);
      for (const item of changedItems) {
        const converted = convertMedia(item);
        const priorSeries = converted.seriesId ? mediaById.get(converted.seriesId) : undefined;
        if (!converted.libraryId && priorSeries?.libraryId) {
          converted.libraryId = priorSeries.libraryId;
          converted.libraryName = priorSeries.libraryName;
        }
        mediaById.set(converted.id, converted);
      }
      const missingSeries = [
        ...new Set(
          changedItems
            .map((i) => i.SeriesId && itemId(i.SeriesId))
            .filter((id): id is string => !!id && !mediaById.has(id)),
        ),
      ];
      for (const series of await fetchItems(missingSeries))
        mediaById.set(itemId(series.Id), convertMedia(series));
      for (const item of changedItems) {
        const converted = mediaById.get(itemId(item.Id));
        const series = converted?.seriesId ? mediaById.get(converted.seriesId) : undefined;
        if (converted && series?.libraryId && !converted.libraryId) {
          converted.libraryId = series.libraryId;
          converted.libraryName = series.libraryName;
        }
      }
      const affectedSeries = new Set(
        changed.map((r) => mediaById.get(r.itemId)?.seriesId).filter((id): id is string => !!id),
      );
      for (const seriesId of affectedSeries) {
        const params = new URLSearchParams({
          ParentId: seriesId,
          Recursive: "true",
          IncludeItemTypes: "Episode",
          EnableUserData: "true",
          EnableImages: "false",
          Fields: "Genres,People,ParentId,ProviderIds",
          Limit: "500",
        });
        for (let offset = 0; ; offset += 500) {
          params.set("StartIndex", String(offset));
          const page = await request<{ Items: RawItem[]; TotalRecordCount?: number }>(
            `Users/${encodeURIComponent(auth.userId)}/Items?${params}`,
          ).catch(() => null);
          if (!page) break;
          for (const item of page.Items) {
            const converted = convertMedia(item);
            const series = mediaById.get(seriesId);
            if (!converted.libraryId && series?.libraryId) {
              converted.libraryId = series.libraryId;
              converted.libraryName = series.libraryName;
            }
            mediaById.set(itemId(item.Id), converted);
          }
          if (
            page.Items.length < 500 ||
            offset + page.Items.length >= (page.TotalRecordCount ?? Infinity)
          )
            break;
        }
      }
    }
    // A migration may change every Jellyfin ItemId. Match only unambiguous
    // provider identities, then use the matched series plus season/episode.
    const oldMedia = previous?.media ?? [];
    const newMedia = fullScan ? media : [];
    const newByProvider = new Map<string, WatchMedia[]>();
    for (const m of newMedia)
      for (const key of providerKeys(m))
        newByProvider.set(key, [...(newByProvider.get(key) ?? []), m]);
    const remap = new Map<string, string>();
    for (const old of oldMedia.filter((m) => m.type !== "Episode")) {
      const matches = new Set(
        providerKeys(old)
          .flatMap((key) => newByProvider.get(key) ?? [])
          .map((m) => m.id),
      );
      if (matches.size === 1) remap.set(old.id, [...matches][0]);
    }
    for (const old of oldMedia.filter((m) => m.type === "Episode")) {
      const seriesId = old.seriesId && remap.get(old.seriesId);
      if (!seriesId || old.seasonNumber == null || old.episodeNumber == null) continue;
      const matches = newMedia.filter(
        (m) =>
          m.type === "Episode" &&
          m.seriesId === seriesId &&
          m.seasonNumber === old.seasonNumber &&
          m.episodeNumber === old.episodeNumber,
      );
      if (matches.length === 1) remap.set(old.id, matches[0].id);
    }
    if (remap.size) {
      const view = await this.getView(serverId, auth.userId);
      if (view?.corrections) {
        for (const [oldId, newId] of remap) {
          if (view.corrections.items[oldId] && !view.corrections.items[newId])
            view.corrections.items[newId] = view.corrections.items[oldId];
          delete view.corrections.items[oldId];
        }
        await this.writeCorrections(serverId, auth.userId, view.corrections);
      }
    }
    for (const old of fullScan ? oldMedia : []) {
      if (newMedia.some((m) => m.id === old.id)) continue;
      if (remap.has(old.id)) mediaById.delete(old.id);
      else mediaById.set(old.id, old);
    }
    const resolvedMedia = [...mediaById.values()];
    const canonical = new Map<string, string>();
    for (const m of resolvedMedia) {
      let key = mediaKey(m);
      if (m.type === "Episode") {
        const series = m.seriesId ? mediaById.get(m.seriesId) : undefined;
        const seriesKey = series && mediaKey(series);
        key =
          seriesKey && m.seasonNumber != null && m.episodeNumber != null
            ? `${seriesKey}:${m.seasonNumber}:${m.episodeNumber}`
            : undefined;
      }
      if (key) canonical.set(m.id, key);
    }
    const prior = (previous?.records ?? []).map((r) => ({
      ...r,
      itemId: remap.get(r.itemId) ?? r.itemId,
    }));
    const merged = new Map(prior.map((record) => [record.id, record]));
    for (const record of current) {
      const legacyStart = /(?:Z|[+-]\d\d:\d\d)$/i.test(record.rawDate ?? "")
        ? record.startAt
        : new Date(`${(record.rawDate ?? "").replace(" ", "T")}Z`).toISOString();
      const previousMatch = prior.find(
        (old) =>
          old.itemId === record.itemId &&
          old.clientName === record.clientName &&
          old.deviceName === record.deviceName &&
          (old.sourceKey === record.sourceKey ||
            old.startAt === legacyStart ||
            old.startAt === record.startAt),
      );
      if (previousMatch) merged.delete(previousMatch.id);
      const identity = canonical.get(record.itemId);
      if (identity)
        for (const old of merged.values()) {
          if (
            canonical.get(old.itemId) === identity &&
            old.clientName === record.clientName &&
            old.deviceName === record.deviceName &&
            Math.abs(Date.parse(old.startAt) - Date.parse(record.startAt)) < 2000
          ) {
            merged.delete(old.id);
            break;
          }
        }
      merged.set(record.id, record);
    }
    const records = [...merged.values()].sort(
      (a, b) => Date.parse(b.startAt) - Date.parse(a.startAt),
    );
    const playedIds = new Set(
      records.map((record) => canonical.get(record.itemId) ?? record.itemId),
    );
    const priorBackfill = (previous?.backfill ?? []).map((item) => ({
      ...item,
      itemId: remap.get(item.itemId) ?? item.itemId,
      baselineAt: item.baselineAt ?? previous?.refreshedAt,
    }));
    const backfillKeys = new Set<string>();
    const backfill: typeof priorBackfill = [];
    const addBackfill = (item: (typeof priorBackfill)[number]) => {
      const key = canonical.get(item.itemId) ?? item.itemId;
      if (backfillKeys.has(key)) return;
      backfillKeys.add(key);
      backfill.push(item);
    };
    for (const item of priorBackfill) addBackfill(item);
    for (const item of previous ? [] : resolvedMedia)
      if (
        (item.type === "Movie" || item.type === "Episode") &&
        item.played &&
        item.runtimeSec &&
        !playedIds.has(canonical.get(item.id) ?? item.id)
      )
        addBackfill({
          itemId: item.id,
          durationSec: item.runtimeSec,
          baselineRecordIds: [],
          baselineAt: new Date().toISOString(),
        });
    const confirmations: WatchConfirmation[] = (previous?.confirmations ?? []).map((entry) => ({
      ...entry,
      itemId: remap.get(entry.itemId) ?? entry.itemId,
    }));
    const candidates: WatchCandidate[] = (previous?.candidates ?? []).map((entry) => ({
      ...entry,
      itemId: remap.get(entry.itemId) ?? entry.itemId,
    }));
    const knownRecords = new Set(previous?.records.map((entry) => entry.id) ?? []);
    const initial = !previous?.confirmations;
    const initialBaseline = previous?.confirmations?.find(
      (entry) => entry.source === "initial",
    )?.baselineAt;
    const beforeInitialBaseline = (item: WatchMedia) =>
      !!initialBaseline &&
      !!item.lastPlayedAt &&
      Number.isFinite(Date.parse(item.lastPlayedAt)) &&
      Date.parse(item.lastPlayedAt) <= Date.parse(initialBaseline);
    // An incomplete first media scan can discover already-played items later.
    // Only a pre-baseline LastPlayedDate with no later playback evidence proves
    // that their first watch belongs to the original library state.
    const historical = (item: WatchMedia, evidenceIds: string[]) =>
      item.played &&
      beforeInitialBaseline(item) &&
      evidenceIds.length === 0 &&
      !records.some(
        (record) =>
          record.itemId === item.id && Date.parse(record.startAt) > Date.parse(initialBaseline!),
      );
    const historicalCandidates = candidates.filter((candidate) => {
      const item = mediaById.get(candidate.itemId);
      return (
        item &&
        (candidate.status === "pending" || candidate.status === "later") &&
        !confirmations.some((entry) => entry.itemId === candidate.itemId) &&
        historical(item, candidate.evidenceIds)
      );
    });
    if (historicalCandidates.length) {
      for (const candidate of historicalCandidates) {
        confirmations.push({
          id: randomUUID(),
          itemId: candidate.itemId,
          source: "initial",
          evidenceIds: [],
          baselineAt: initialBaseline,
        });
        candidates.splice(candidates.indexOf(candidate), 1);
      }
    }
    for (const item of resolvedMedia) {
      if (item.type !== "Movie" && item.type !== "Episode") continue;
      if (confirmations.some((entry) => entry.itemId === item.id)) continue;
      if (
        (initial && item.played) ||
        (historical(item, []) && !previous?.media.some((entry) => entry.id === item.id))
      )
        confirmations.push({
          id: randomUUID(),
          itemId: item.id,
          source: "initial",
          evidenceIds: records.filter((entry) => entry.itemId === item.id).map((entry) => entry.id),
          baselineAt: initialBaseline ?? previous?.refreshedAt ?? new Date().toISOString(),
        });
      else if (
        item.played &&
        !previous?.media.some((entry) => entry.id === item.id && entry.played) &&
        !candidates.some((entry) => entry.itemId === item.id)
      )
        candidates.push({ itemId: item.id, evidenceIds: [], status: "pending" });
    }
    for (const item of resolvedMedia) {
      if (item.type !== "Movie" && item.type !== "Episode") continue;
      const itemConfirmations = confirmations.filter((entry) => entry.itemId === item.id);
      if (!itemConfirmations.length) {
        const first = candidates.find(
          (entry) => entry.itemId === item.id && entry.status !== "ignored",
        );
        if (first)
          first.evidenceIds = [
            ...new Set([
              ...first.evidenceIds,
              ...records
                .filter(
                  (entry) =>
                    entry.itemId === item.id &&
                    !knownRecords.has(entry.id) &&
                    (!initialBaseline || Date.parse(entry.startAt) > Date.parse(initialBaseline)),
                )
                .map((entry) => entry.id),
            ]),
          ];
        continue;
      }
      const handled = new Set([
        ...itemConfirmations.flatMap((entry) => entry.evidenceIds),
        ...candidates
          .filter((entry) => entry.itemId === item.id && entry.status === "ignored")
          .flatMap((entry) => entry.evidenceIds),
      ]);
      const candidate = candidates.find(
        (entry) => entry.itemId === item.id && entry.status !== "ignored",
      );
      const baselineAt =
        itemConfirmations.at(-1)?.baselineAt ?? itemConfirmations.at(-1)?.confirmedAt;
      const newEvidence = records.filter(
        (entry) =>
          entry.itemId === item.id &&
          entry.durationSec > 0 &&
          (!previous?.settings.excludeShort || entry.durationSec >= 120) &&
          !knownRecords.has(entry.id) &&
          !handled.has(entry.id) &&
          (!baselineAt || Date.parse(entry.startAt) > Date.parse(baselineAt)),
      );
      if (candidate) {
        candidate.evidenceIds = [
          ...new Set([...candidate.evidenceIds, ...newEvidence.map((entry) => entry.id)]),
        ];
        if (
          candidate.status === "accumulating" &&
          records
            .filter((entry) => candidate.evidenceIds.includes(entry.id))
            .reduce((sum, entry) => sum + entry.durationSec, 0) >=
            (previous?.settings.rewatchMinutes ?? 10) * 60
        )
          candidate.status = "pending";
      } else if (newEvidence.length)
        candidates.push({
          itemId: item.id,
          evidenceIds: newEvidence.map((entry) => entry.id),
          status:
            newEvidence.reduce((sum, entry) => sum + entry.durationSec, 0) >=
            (previous?.settings.rewatchMinutes ?? 10) * 60
              ? "pending"
              : "accumulating",
        });
    }
    const snapshot: WatchStatisticsSnapshot = {
      serverId,
      refreshedAt: new Date().toISOString(),
      libraries: [...libraries].map(([id, name]) => ({ id, name })),
      media: resolvedMedia,
      records,
      backfill,
      confirmations,
      candidates,
      appliedReviewIds: previous?.appliedReviewIds,
      settings:
        this.currentSettings.get(this.path(serverId, auth.userId)) ??
        previous?.settings ??
        defaults,
      cursor: new Date().toISOString(),
    };
    return this.save(serverId, auth.userId, snapshot, false, previous);
  }
}
