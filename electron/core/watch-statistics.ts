import { jellyfinAuthorization } from "./jellyfin-authorization";
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  unlink,
  rename,
  readdir,
  access,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WatchStatisticsPathLocator } from "./watch-statistics-path";
import {
  parsePlaybackActivityResponse,
  playbackActivityLocalQuery,
  playbackActivityQuery,
  type PlaybackActivity,
} from "./watch-statistics-playback-reporting";
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
const defaults: WatchStatisticsSettings = {
  gapMinutes: 15,
  includeBackfill: true,
  excludeShort: false,
  rewatchMinutes: 10,
};
const seconds = (ticks?: number) => (ticks && ticks > 0 ? ticks / 10_000_000 : undefined);
const itemId = (value: string) => value.replace(/-/g, "").toLowerCase();
const reportDate = (value: string) => {
  // Playback Reporting stores DateTime.Now without an offset. JavaScript interprets
  // it in the Freebo client's local timezone, including for remote servers.
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
const providerCompatible = (left: WatchMedia, right: WatchMedia) => {
  const ids = (media: WatchMedia) =>
    new Map(
      Object.entries(media.providerIds ?? {})
        .filter(([key, value]) => /^(tmdb|imdb|tvdb)$/i.test(key) && value)
        .map(([key, value]) => [key.toLowerCase(), value.toLowerCase()]),
    );
  const a = ids(left);
  const b = ids(right);
  return [...a].every(([key, value]) => !b.has(key) || b.get(key) === value);
};
const eligibleArchiveMedia = (media: WatchMedia, serverId: string) =>
  !media.sourceId || media.sourceId === serverId || media.id.startsWith("legacy:");
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
  catalogRefreshedAt: optionalText,
  media: z.array(mediaSchema),
  records: z.array(recordSchema),
  backfill: z.array(backfillSchema),
  settings: settingsSchema,
  cursor: optionalText,
  libraries: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  confirmations: z.array(confirmationSchema).optional(),
  candidates: z.array(candidateSchema).optional(),
  appliedReviewIds: z.array(z.string()).optional(),
  revokedConfirmationIds: z.array(z.string()).optional(),
  identityLinks: z.record(z.string(), z.string()).optional(),
  identityConflicts: z
    .array(z.object({ fromItemId: z.string(), toItemId: z.string(), reason: z.string() }))
    .optional(),
  corrections: z
    .object({ records: z.record(z.string(), z.string()), items: z.record(z.string(), z.string()) })
    .optional(),
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
    const legacyEstimate = snapshot.backfill.find(
      (entry) => entry.itemId === id && entry.durationSec > 0,
    );
    const beforeEstimate =
      (legacyEstimate?.durationSec ?? 0) +
      existing.reduce((sum, entry) => sum + (entry.estimatedDurationSec ?? 0), 0);
    const estimatedBeforeCount =
      Number(Boolean(legacyEstimate)) +
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
    const estimateAfterSec =
      (legacyEstimate?.durationSec ?? 0) +
      after.reduce((sum, entry) => sum + (entry.estimatedDurationSec ?? 0), 0);
    const estimatedAfterCount =
      Number(Boolean(legacyEstimate)) +
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

export const watchLinkSafeErrors = new Set([
  "尚无观影统计数据",
  "作品关联无效",
  "目标作品必须属于当前服务",
  "作品外部身份矛盾，不能关联",
  "作品已有不同关联",
  "作品关联形成循环",
  "作品媒体库修正冲突",
  "两部作品已有相互冲突的观影资产，请先人工核对",
  "无法读取观影档案，作品关联未保存",
  "无法备份观影档案，作品关联未保存",
  "无法写入观影档案，作品关联未保存",
]);

export class WatchStatisticsStore {
  private writes = new Map<string, Promise<WatchStatisticsSnapshot>>();
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
    if (snapshot.corrections) return snapshot;
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
      if (!result.success) throw new Error("观影修正文件损坏");
      corrections = result.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    const path = this.path(serverId, userId);
    const prior = this.writes.get(path) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(async () => {
        const snapshot = await this.getView(serverId, userId);
        if (!snapshot) throw new Error("尚无观影统计数据");
        const record = snapshot.records.find((entry) => entry.id === recordId);
        if (!record) throw new Error("播放记录不存在");
        if (libraryId !== null && !snapshot.libraries?.some((entry) => entry.id === libraryId))
          throw new Error("媒体库不存在，请重新同步");
        await this.dailyBackup(path, snapshot);
        const corrections = snapshot.corrections!;
        const key = itemId(record.itemId);
        if (libraryId === null) {
          delete corrections.records[recordId];
          if (remember) delete corrections.items[key];
        } else {
          corrections.records[recordId] = libraryId;
          if (remember) corrections.items[key] = libraryId;
        }
        await this.atomicWrite(
          this.path(serverId, userId),
          JSON.stringify({ ...snapshot, corrections }),
        );
        return { ...snapshot, corrections };
      });
    this.writes.set(path, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(path) === next) this.writes.delete(path);
    }
  }
  async get(serverId: string, userId: string): Promise<WatchStatisticsSnapshot | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path(serverId, userId), "utf8"));
      const result = snapshotSchema.safeParse(parsed);
      if (!result.success)
        throw new Error(`观影档案损坏：${result.error.issues[0]?.path.join(".")}`);
      return result.data as WatchStatisticsSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async atomicWrite(path: string, data: string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data);
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  private async dailyBackup(path: string, snapshot: WatchStatisticsSnapshot | null) {
    if (!snapshot) return;
    const backup = `${path}.${new Date().toISOString().slice(0, 10)}.auto.backup`;
    try {
      await access(backup);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.atomicWrite(backup, JSON.stringify(snapshot));
    const files = (await readdir(dirname(path)))
      .filter(
        (name) =>
          name.startsWith(`${path.split(/[\\/]/).at(-1)}.`) && name.endsWith(".auto.backup"),
      )
      .sort()
      .reverse();
    for (const stale of files.slice(5)) await unlink(join(dirname(path), stale)).catch(() => {});
  }
  async exportData(serverId: string, userId: string, path: string): Promise<void> {
    await this.writes.get(this.path(serverId, userId))?.catch(() => {});
    const snapshot = await this.getView(serverId, userId);
    if (!snapshot) throw new Error("尚无可导出的观影统计数据");
    const payload = JSON.stringify(snapshot);
    await this.atomicWrite(
      path,
      JSON.stringify({
        version: 3,
        exportedAt: new Date().toISOString(),
        snapshot,
        sha256: createHash("sha256").update(payload).digest("hex"),
      }),
    );
  }
  private async readImport(path: string) {
    const bytes = await readFile(path);
    const fileDigest = createHash("sha256").update(bytes).digest("hex");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("导入文件格式无效");
    const input = parsed as {
      version?: unknown;
      exportedAt?: unknown;
      snapshot?: unknown;
      serverId?: unknown;
    };
    const archive =
      input.version === undefined && typeof input.serverId === "string"
        ? { version: 2, snapshot: input, exportedAt: undefined }
        : input;
    if (
      ![1, 2, 3].includes(archive.version as number) ||
      !archive.snapshot ||
      typeof archive.snapshot !== "object"
    )
      throw new Error("不支持的统计文件版本");
    if (
      archive.version === 3 &&
      (typeof (parsed as { sha256?: unknown }).sha256 !== "string" ||
        createHash("sha256").update(JSON.stringify(archive.snapshot)).digest("hex") !==
          (parsed as { sha256: string }).sha256)
    )
      throw new Error("统计文件完整性校验失败");
    const result = snapshotSchema.safeParse(archive.snapshot);
    if (!result.success)
      throw new Error(`统计文件内容无效：${result.error.issues[0]?.path.join(".") ?? "未知字段"}`);
    const snapshot = result.data as WatchStatisticsSnapshot;
    if (snapshot.candidates) {
      const candidates = new Map<
        string,
        NonNullable<WatchStatisticsSnapshot["candidates"]>[number]
      >();
      for (const entry of snapshot.candidates) {
        const key = `${entry.itemId}:${entry.status === "ignored" ? "ignored" : "active"}`;
        const existing = candidates.get(key);
        if (existing && entry.status === "ignored")
          existing.evidenceIds = [...new Set([...existing.evidenceIds, ...entry.evidenceIds])];
        else if (existing) throw new Error("统计文件candidate含重复身份");
        else candidates.set(key, { ...entry, evidenceIds: [...entry.evidenceIds] });
      }
      snapshot.candidates = [...candidates.values()];
    }
    for (const [kind, ids] of [
      ["media", snapshot.media.map((entry) => entry.id)],
      ["record", snapshot.records.map((entry) => entry.id)],
      ["backfill", snapshot.backfill.map((entry) => entry.itemId)],
      ["confirmation", (snapshot.confirmations ?? []).map((entry) => entry.id)],
      [
        "candidate",
        (snapshot.candidates ?? []).map(
          (entry) => `${entry.itemId}:${entry.status === "ignored" ? "ignored" : "active"}`,
        ),
      ],
    ] as const)
      if (new Set(ids).size !== ids.length) throw new Error(`统计文件${kind}含重复身份`);
    const corrections = z
      .object({
        records: z.record(z.string(), z.string()),
        items: z.record(z.string(), z.string()),
      })
      .safeParse((archive.snapshot as WatchStatisticsSnapshot).corrections);
    if (corrections.success) snapshot.corrections = corrections.data;
    else if (archive.version === 3 || "corrections" in archive.snapshot)
      throw new Error("统计文件修正数据无效");
    return {
      snapshot,
      fileDigest,
      version: Number(archive.version),
      exportedAt: typeof archive.exportedAt === "string" ? archive.exportedAt : undefined,
    };
  }
  async previewImport(
    path: string,
    serverId?: string,
    userId?: string,
  ): Promise<WatchStatisticsImportPreview> {
    const { snapshot, exportedAt, version } = await this.readImport(path);
    const dates = snapshot.records.map((r) => r.startAt).sort();
    const current = serverId && userId ? await this.getView(serverId, userId) : null;
    const normalized =
      serverId && userId
        ? this.normalizeImport(snapshot, serverId, userId, current, "merge")
        : snapshot;
    const conflicts = current ? this.mergeConflicts(current, normalized).length : 0;
    const existingRecords = new Set(current?.records.map((record) => record.id) ?? []);
    const targetLibraries = new Set(current?.libraries?.map((library) => library.id) ?? []);
    const correctionValues = [
      ...Object.values(normalized.corrections?.records ?? {}),
      ...Object.values(normalized.corrections?.items ?? {}),
    ];
    const linked = Object.keys(normalized.identityLinks ?? {}).length;
    return {
      version,
      records: snapshot.records.length,
      backfill: snapshot.backfill.length,
      media: snapshot.media.length,
      earliestAt: dates[0],
      latestAt: dates.at(-1),
      exportedAt,
      confirmations: snapshot.confirmations?.length ?? 0,
      candidates: snapshot.candidates?.length ?? 0,
      corrections:
        Object.keys(snapshot.corrections?.records ?? {}).length +
        Object.keys(snapshot.corrections?.items ?? {}).length,
      identityLinks: Object.keys(snapshot.identityLinks ?? {}).length,
      conflicts,
      missingLibraryCorrections: current
        ? correctionValues.filter((id) => !targetLibraries.has(id)).length
        : 0,
      added: normalized.records.filter((record) => !existingRecords.has(record.id)).length,
      duplicates: normalized.records.filter((record) => existingRecords.has(record.id)).length,
      linked,
      unlinked: normalized.media.filter(
        (media) => media.id.startsWith("legacy:") && !normalized.identityLinks?.[media.id],
      ).length,
    };
  }
  private mergeConflicts(current: WatchStatisticsSnapshot, incoming: WatchStatisticsSnapshot) {
    const conflicts: string[] = [];
    const check = <T extends { id: string }>(kind: string, a: T[], b: T[]) => {
      const known = new Map(a.map((entry) => [entry.id, entry]));
      for (const entry of b) {
        const prior = known.get(entry.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(entry))
          conflicts.push(`${kind}:${entry.id}`);
      }
    };
    check("record", current.records, incoming.records);
    check("media", current.media, incoming.media);
    check("confirmation", current.confirmations ?? [], incoming.confirmations ?? []);
    const keyed = <T>(kind: string, a: T[], b: T[], key: (value: T) => string) => {
      const known = new Map(a.map((value) => [key(value), value]));
      for (const value of b) {
        const prior = known.get(key(value));
        if (prior && JSON.stringify(prior) !== JSON.stringify(value))
          conflicts.push(`${kind}:${key(value)}`);
      }
    };
    keyed("backfill", current.backfill, incoming.backfill, (value) => value.itemId);
    const candidates = new Map(
      (current.candidates ?? []).map((value) => [
        `${value.itemId}:${value.status === "ignored" ? "ignored" : "active"}`,
        value,
      ]),
    );
    for (const value of incoming.candidates ?? []) {
      const key = `${value.itemId}:${value.status === "ignored" ? "ignored" : "active"}`;
      if (candidates.get(key)?.status !== undefined && candidates.get(key)?.status !== value.status)
        conflicts.push(`candidate:${key}`);
      for (const other of current.candidates ?? [])
        if (
          other.itemId === value.itemId &&
          (other.status === "ignored") !== (value.status === "ignored") &&
          value.evidenceIds.some((id) => other.evidenceIds.includes(id))
        )
          conflicts.push(`candidate-evidence:${value.itemId}`);
    }
    if (JSON.stringify(current.settings) !== JSON.stringify(incoming.settings))
      conflicts.push("settings");
    for (const [key, value] of Object.entries(incoming.identityLinks ?? {}))
      if (current.identityLinks?.[key] && current.identityLinks[key] !== value)
        conflicts.push(`identity:${key}`);
    for (const confirmation of incoming.confirmations ?? [])
      if (
        confirmation.source === "initial" &&
        (current.confirmations ?? []).some(
          (other) =>
            other.source === "initial" &&
            other.itemId === confirmation.itemId &&
            other.id !== confirmation.id,
        )
      )
        conflicts.push(`initial:${confirmation.itemId}`);
    for (const id of incoming.confirmations?.map((entry) => entry.id) ?? [])
      if (current.revokedConfirmationIds?.includes(id)) conflicts.push(`revoked:${id}`);
    for (const id of current.confirmations?.map((entry) => entry.id) ?? [])
      if (incoming.revokedConfirmationIds?.includes(id)) conflicts.push(`revoked:${id}`);
    for (const kind of ["records", "items"] as const)
      for (const [key, value] of Object.entries(incoming.corrections?.[kind] ?? {}))
        if (current.corrections?.[kind][key] && current.corrections[kind][key] !== value)
          conflicts.push(`correction:${kind}:${key}`);
    return conflicts;
  }
  private normalizeImport(
    snapshot: WatchStatisticsSnapshot,
    serverId: string,
    userId: string,
    current: WatchStatisticsSnapshot | null,
    mode: "replace" | "merge",
  ): WatchStatisticsSnapshot {
    const crossServer = snapshot.serverId !== serverId;
    const mapId = (id: string) =>
      crossServer && !id.startsWith("legacy:") ? `legacy:${snapshot.serverId}:${id}` : id;
    const normalized: WatchStatisticsSnapshot = {
      ...snapshot,
      serverId,
      cursor: undefined,
      media: snapshot.media.map((media) => ({
        ...media,
        id: mapId(media.id),
        seriesId: media.seriesId ? mapId(media.seriesId) : undefined,
        sourceId: media.sourceId ?? snapshot.serverId,
      })),
      records: snapshot.records.map((record) => ({
        ...record,
        itemId: mapId(record.itemId),
        userId,
      })),
      backfill: snapshot.backfill.map((entry) => ({ ...entry, itemId: mapId(entry.itemId) })),
      confirmations: snapshot.confirmations?.map((entry) => ({
        ...entry,
        itemId: mapId(entry.itemId),
      })),
      candidates: snapshot.candidates?.map((entry) => ({ ...entry, itemId: mapId(entry.itemId) })),
      corrections: snapshot.corrections && {
        records: snapshot.corrections.records,
        items: Object.fromEntries(
          Object.entries(snapshot.corrections.items).map(([id, library]) => [mapId(id), library]),
        ),
      },
      identityLinks:
        snapshot.identityLinks &&
        Object.fromEntries(
          Object.entries(snapshot.identityLinks).map(([from, to]) => [mapId(from), mapId(to)]),
        ),
      identityConflicts: snapshot.identityConflicts?.map((entry) => ({
        ...entry,
        fromItemId: mapId(entry.fromItemId),
        toItemId: mapId(entry.toItemId),
      })),
      refreshedAt: new Date().toISOString(),
    };
    if (mode === "merge" && current && crossServer) {
      const links = new Map<string, string>();
      for (const old of normalized.media.filter((item) => item.type !== "Episode")) {
        const keys = providerKeys(old);
        if (!keys.length) continue;
        const matches = current.media.filter(
          (candidate) =>
            candidate.sourceId === serverId &&
            candidate.type === old.type &&
            keys.some((key) => providerKeys(candidate).includes(key)) &&
            providerCompatible(old, candidate),
        );
        if (matches.length === 1) links.set(old.id, matches[0].id);
      }
      const parentTargets = new Map<string, number>();
      for (const target of links.values())
        parentTargets.set(target, (parentTargets.get(target) ?? 0) + 1);
      for (const [source, target] of links)
        if ((parentTargets.get(target) ?? 0) > 1) links.delete(source);
      for (const old of normalized.media) {
        if (
          old.type !== "Episode" ||
          links.has(old.id) ||
          !old.seriesId ||
          old.seasonNumber === undefined ||
          old.episodeNumber === undefined
        )
          continue;
        const mappedSeries = links.get(old.seriesId);
        if (!mappedSeries) continue;
        const matches = current.media.filter(
          (candidate) =>
            candidate.type === "Episode" &&
            candidate.sourceId === serverId &&
            candidate.seriesId === mappedSeries &&
            candidate.seasonNumber === old.seasonNumber &&
            candidate.episodeNumber === old.episodeNumber &&
            providerCompatible(old, candidate),
        );
        if (matches.length === 1) links.set(old.id, matches[0].id);
      }
      const targets = new Map<string, number>();
      for (const target of links.values()) targets.set(target, (targets.get(target) ?? 0) + 1);
      for (const [source, target] of links)
        if ((targets.get(target) ?? 0) > 1) links.delete(source);
      const linked = (id: string) => links.get(id) ?? id;
      normalized.records = normalized.records.map((record) => ({
        ...record,
        itemId: linked(record.itemId),
      }));
      normalized.backfill = normalized.backfill.map((entry) => ({
        ...entry,
        itemId: linked(entry.itemId),
      }));
      normalized.confirmations = normalized.confirmations?.map((entry) => ({
        ...entry,
        itemId: linked(entry.itemId),
      }));
      normalized.candidates = normalized.candidates?.map((entry) => ({
        ...entry,
        itemId: linked(entry.itemId),
      }));
      normalized.corrections = normalized.corrections && {
        ...normalized.corrections,
        items: Object.fromEntries(
          Object.entries(normalized.corrections.items).map(([id, library]) => [
            linked(id),
            library,
          ]),
        ),
      };
      normalized.identityLinks = { ...normalized.identityLinks, ...Object.fromEntries(links) };
    }
    return normalized;
  }
  async importData(
    serverId: string,
    userId: string,
    path: string,
    mode: "replace" | "merge" = "replace",
    expected?: { fileDigest: string; targetDigest: string },
  ): Promise<WatchStatisticsSnapshot> {
    const destination = this.path(serverId, userId);
    await mkdir(dirname(destination), { recursive: true });
    const previous = this.writes.get(destination) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const current = await this.getView(serverId, userId);
        if (
          expected &&
          createHash("sha256").update(JSON.stringify(current)).digest("hex") !==
            expected.targetDigest
        )
          throw new Error("当前观影档案在预览后发生变化，请重新预览");
        const { snapshot, fileDigest } = await this.readImport(path);
        if (expected && fileDigest !== expected.fileDigest)
          throw new Error("导入文件在预览后发生变化，请重新选择并预览");
        const normalized = this.normalizeImport(snapshot, serverId, userId, current, mode);
        if (mode === "merge" && current) {
          const conflicts = this.mergeConflicts(current, normalized);
          if (conflicts.length)
            throw new Error(`合并冲突 (${conflicts.length})：${conflicts.slice(0, 3).join(", ")}`);
        }
        const imported =
          mode === "merge" && current ? this.mergeSnapshots(current, normalized) : normalized;
        const oldBytes = current ? await readFile(destination) : null;
        if (current) {
          const backup = `${destination}.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}.backup`;
          await this.atomicWrite(backup, JSON.stringify(current));
        }
        try {
          await this.atomicWrite(destination, JSON.stringify(imported));
        } catch (error) {
          if (oldBytes) await this.atomicWrite(destination, oldBytes.toString("utf8"));
          else await unlink(destination).catch(() => {});
          throw error;
        }
        this.currentSettings.delete(destination);
        const files = (await readdir(dirname(destination)))
          .filter(
            (name) =>
              name.startsWith(`${serverId}-${itemId(userId)}.json.`) &&
              name.endsWith(".backup") &&
              !name.endsWith(".auto.backup") &&
              !name.endsWith(".historical-first-watch.backup"),
          )
          .sort()
          .reverse();
        for (const stale of files.slice(5))
          await unlink(join(dirname(destination), stale)).catch(() => {});
        return imported;
      });
    this.writes.set(destination, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(destination) === next) this.writes.delete(destination);
    }
  }
  private mergeSnapshots(
    current: WatchStatisticsSnapshot,
    incoming: WatchStatisticsSnapshot,
  ): WatchStatisticsSnapshot {
    const union = <T>(left: T[], right: T[], key: (value: T) => string) => [
      ...new Map([...left, ...right].map((value) => [key(value), value])).values(),
    ];
    const revokedConfirmationIds = [
      ...new Set([
        ...(current.revokedConfirmationIds ?? []),
        ...(incoming.revokedConfirmationIds ?? []),
      ]),
    ];
    return {
      ...current,
      cursor: undefined,
      refreshedAt: new Date().toISOString(),
      media: union(incoming.media, current.media, (value) => value.id),
      records: union(incoming.records, current.records, (value) => value.id),
      backfill: union(incoming.backfill, current.backfill, (value) => value.itemId),
      confirmations: union(
        incoming.confirmations ?? [],
        current.confirmations ?? [],
        (value) => value.id,
      ).filter((value) => !revokedConfirmationIds.includes(value.id)),
      candidates: union(
        incoming.candidates ?? [],
        current.candidates ?? [],
        (value) => `${value.itemId}:${value.status === "ignored" ? "ignored" : "active"}`,
      ).map((value) => ({
        ...value,
        evidenceIds: [
          ...new Set([
            ...((incoming.candidates ?? []).find(
              (candidate) => candidate.itemId === value.itemId && candidate.status === value.status,
            )?.evidenceIds ?? []),
            ...((current.candidates ?? []).find(
              (candidate) => candidate.itemId === value.itemId && candidate.status === value.status,
            )?.evidenceIds ?? []),
          ]),
        ],
      })),
      revokedConfirmationIds,
      appliedReviewIds: [
        ...new Set([...(current.appliedReviewIds ?? []), ...(incoming.appliedReviewIds ?? [])]),
      ],
      corrections: {
        records: { ...incoming.corrections?.records, ...current.corrections?.records },
        items: { ...incoming.corrections?.items, ...current.corrections?.items },
      },
      identityLinks: { ...incoming.identityLinks, ...current.identityLinks },
      identityConflicts: [
        ...new Map(
          [...(current.identityConflicts ?? []), ...(incoming.identityConflicts ?? [])].map(
            (entry) => [`${entry.fromItemId}:${entry.toItemId}:${entry.reason}`, entry],
          ),
        ).values(),
      ],
    };
  }
  async linkWatchMedia(serverId: string, userId: string, fromItemId: string, toItemId: string) {
    const path = this.path(serverId, userId);
    const previous = this.writes.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const snapshot = await this.getView(serverId, userId).catch(() => {
          throw new Error("无法读取观影档案，作品关联未保存");
        });
        if (!snapshot) throw new Error("尚无观影统计数据");
        const from = snapshot.media.find((media) => media.id === fromItemId);
        const to = snapshot.media.find((media) => media.id === toItemId);
        if (!from || !to || from.id === to.id || from.type !== to.type)
          throw new Error("作品关联无效");
        if (to.id.startsWith("legacy:") || (to.sourceId && to.sourceId !== serverId))
          throw new Error("目标作品必须属于当前服务");
        if (
          snapshot.identityLinks?.[fromItemId] === toItemId &&
          !snapshot.records.some((entry) => entry.itemId === fromItemId) &&
          !snapshot.backfill.some((entry) => entry.itemId === fromItemId) &&
          !(snapshot.confirmations ?? []).some((entry) => entry.itemId === fromItemId) &&
          !(snapshot.candidates ?? []).some((entry) => entry.itemId === fromItemId) &&
          !snapshot.corrections?.items[fromItemId]
        ) return snapshot;
        if (!providerCompatible(from, to)) throw new Error("作品外部身份矛盾，不能关联");
        if (snapshot.identityLinks?.[fromItemId] && snapshot.identityLinks[fromItemId] !== toItemId)
          throw new Error("作品已有不同关联");
        let cursor: string | undefined = toItemId;
        const seen = new Set<string>();
        while (cursor) {
          if (cursor === fromItemId || seen.has(cursor)) throw new Error("作品关联形成循环");
          seen.add(cursor);
          cursor = snapshot.identityLinks?.[cursor];
        }
        const priorLibrary = snapshot.corrections?.items[fromItemId];
        const targetLibrary = snapshot.corrections?.items[toItemId];
        if (priorLibrary && targetLibrary && priorLibrary !== targetLibrary)
          throw new Error("作品媒体库修正冲突");
        if (
          (snapshot.backfill.some((entry) => entry.itemId === fromItemId) &&
            snapshot.backfill.some((entry) => entry.itemId === toItemId)) ||
          ((snapshot.confirmations ?? []).some(
            (entry) => entry.itemId === fromItemId && entry.source === "initial",
          ) &&
            (snapshot.confirmations ?? []).some(
              (entry) => entry.itemId === toItemId && entry.source === "initial",
            )) ||
          ((snapshot.candidates ?? []).some((entry) => entry.itemId === fromItemId) &&
            (snapshot.candidates ?? []).some((entry) => entry.itemId === toItemId))
        )
          throw new Error("两部作品已有相互冲突的观影资产，请先人工核对");
        await this.dailyBackup(path, snapshot).catch(() => {
          throw new Error("无法备份观影档案，作品关联未保存");
        });
        snapshot.identityLinks = { ...snapshot.identityLinks, [fromItemId]: toItemId };
        for (const [alias, target] of Object.entries(snapshot.identityLinks))
          if (target === fromItemId) snapshot.identityLinks[alias] = toItemId;
        snapshot.identityConflicts = snapshot.identityConflicts?.filter(
          (entry) => entry.fromItemId !== fromItemId && entry.toItemId !== fromItemId,
        );
        snapshot.records = snapshot.records.map((record) =>
          record.itemId === fromItemId ? { ...record, itemId: toItemId } : record,
        );
        snapshot.backfill = snapshot.backfill.map((entry) =>
          entry.itemId === fromItemId ? { ...entry, itemId: toItemId } : entry,
        );
        snapshot.confirmations = snapshot.confirmations?.map((entry) =>
          entry.itemId === fromItemId ? { ...entry, itemId: toItemId } : entry,
        );
        snapshot.candidates = snapshot.candidates?.map((entry) =>
          entry.itemId === fromItemId ? { ...entry, itemId: toItemId } : entry,
        );
        if (snapshot.corrections?.items[fromItemId]) {
          snapshot.corrections.items[toItemId] = snapshot.corrections.items[fromItemId];
          delete snapshot.corrections.items[fromItemId];
        }
        snapshot.refreshedAt = new Date().toISOString();
        await this.atomicWrite(path, JSON.stringify(snapshot)).catch(() => {
          throw new Error("无法写入观影档案，作品关联未保存");
        });
        return snapshot;
      });
    this.writes.set(path, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(path) === next) this.writes.delete(path);
    }
  }
  async bindImported(
    serverId: string,
    fromUserId: string,
    toUserId: string,
  ): Promise<WatchStatisticsSnapshot | null> {
    if (itemId(fromUserId) === itemId(toUserId)) return null;
    const source = await this.get(serverId, fromUserId);
    if (!source) return null;
    const archive = `${this.path(serverId, fromUserId)}.${randomUUID()}.bind.tmp`;
    try {
      await this.exportData(serverId, fromUserId, archive);
      const merged = await this.importData(serverId, toUserId, archive, "merge");
      await unlink(this.path(serverId, fromUserId));
      this.currentSettings.delete(this.path(serverId, toUserId));
      this.currentSettings.delete(this.path(serverId, fromUserId));
      return merged;
    } finally {
      await unlink(archive).catch(() => {});
    }
  }
  private async save(
    serverId: string,
    userId: string,
    value: WatchStatisticsSnapshot,
    settingsOnly = false,
    baseline?: WatchStatisticsSnapshot | null,
    allowNoop = false,
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
        if (
          !settingsOnly &&
          baseline !== undefined &&
          JSON.stringify(latest) !== JSON.stringify(baseline)
        )
          throw new Error("观影档案已更新，请重新同步");
        const snapshot = settingsOnly && latest ? latest : value;
        if (
          allowNoop &&
          latest &&
          latest.cursor &&
          Date.now() - Date.parse(latest.cursor) < 60 * 60 * 1000
        ) {
          const stable = (item: WatchStatisticsSnapshot) => {
            const {
              refreshedAt: _refreshedAt,
              cursor: _cursor,
              catalogRefreshedAt: _catalogRefreshedAt,
              ...data
            } = item;
            return JSON.stringify(
              Object.fromEntries(
                Object.entries({
                  ...data,
                  corrections: data.corrections ?? { records: {}, items: {} },
                }).sort(([left], [right]) => left.localeCompare(right)),
              ),
            );
          };
          if (stable(latest) === stable(snapshot)) return latest;
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
        await this.dailyBackup(
          path,
          latest?.corrections ? latest : await this.getView(serverId, userId),
        );
        await this.atomicWrite(path, JSON.stringify(snapshot));
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
        await this.dailyBackup(path, await this.getView(serverId, userId));
        if (input.action === "batch" && snapshot.appliedReviewIds?.includes(input.operationId))
          return snapshot;
        const media = new Map(snapshot.media.map((item) => [item.id, item]));
        let confirmations = snapshot.confirmations ?? [];
        const candidates = snapshot.candidates ?? [];
        if (input.action === "batch") {
          const planned = planBatch(snapshot, input);
          if (planned.preview.token !== input.token) throw new Error("预览已过期，请重新预览");
          confirmations = planned.confirmations;
          for (const item of planned.preview.items) {
            if (item.afterCount !== 0) continue;
            const active = candidates.find(
              (entry) => entry.itemId === item.itemId && entry.status !== "ignored",
            );
            const ignored = candidates.find(
              (entry) => entry.itemId === item.itemId && entry.status === "ignored",
            );
            if (active && ignored) {
              ignored.evidenceIds = [...new Set([...ignored.evidenceIds, ...active.evidenceIds])];
              candidates.splice(candidates.indexOf(active), 1);
            } else if (active) active.status = "ignored";
            else if (!ignored)
              candidates.push({ itemId: item.itemId, evidenceIds: [], status: "ignored" });
          }
          snapshot.appliedReviewIds = [...(snapshot.appliedReviewIds ?? []), input.operationId];
        } else if (input.action === "revoke") {
          const index = confirmations.findIndex((item) => item.id === input.confirmationId);
          if (index < 0) throw new Error("观看确认不存在");
          const [revoked] = confirmations.splice(index, 1);
          if (
            !confirmations.some((entry) => entry.itemId === revoked.itemId) &&
            !candidates.some((entry) => entry.itemId === revoked.itemId)
          )
            candidates.push({ itemId: revoked.itemId, evidenceIds: [], status: "ignored" });
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
              if (input.totalCount === 0 && !candidates.some((entry) => entry.itemId === id))
                candidates.push({ itemId: id, evidenceIds: [], status: "ignored" });
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
              if (input.action === "ignore") {
                const ignored = candidates.find(
                  (entry) => entry.itemId === id && entry.status === "ignored",
                );
                if (ignored) {
                  ignored.evidenceIds = [
                    ...new Set([...ignored.evidenceIds, ...candidate.evidenceIds]),
                  ];
                  candidates.splice(candidates.indexOf(candidate), 1);
                } else candidate.status = "ignored";
              } else candidate.status = "later";
            }
          }
        }
        snapshot.confirmations = confirmations;
        const remaining = new Set(confirmations.map((entry) => entry.id));
        snapshot.revokedConfirmationIds = [
          ...new Set([
            ...(snapshot.revokedConfirmationIds ?? []),
            ...((await this.get(serverId, userId))?.confirmations ?? [])
              .filter((entry) => !remaining.has(entry.id))
              .map((entry) => entry.id),
          ]),
        ];
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
          cache: "no-store",
          headers: {
            Authorization: jellyfinAuthorization(auth.token),
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
    const cursorTime = previous?.cursor ? Date.parse(previous.cursor) : NaN;
    const fullScan =
      mode === "full" || !previous || !Number.isFinite(cursorTime) || cursorTime > Date.now();
    const views = await request<{ Items: RawItem[] }>(
      `Users/${encodeURIComponent(auth.userId)}/Views`,
    );
    if (!Array.isArray(views?.Items) || (previous?.libraries?.length && !views.Items.length))
      throw new Error("Jellyfin 媒体库目录为空或不完整，同步未保存");
    if (
      views.Items.some(
        (item) =>
          typeof item?.Id !== "string" ||
          !item.Id ||
          (item.Name !== undefined && typeof item.Name !== "string"),
      )
    )
      throw new Error("Jellyfin 媒体库目录字段无效，同步未保存");
    const libraries = new Map(
      (views.Items ?? []).map((item) => [itemId(item.Id), item.Name ?? "未匹配"]),
    );
    const priorLibraries = new Set((previous?.libraries ?? []).map((item) => item.id));
    const librariesChanged =
      priorLibraries.size !== libraries.size ||
      [...libraries.keys()].some((id) => !priorLibraries.has(id));
    const lastCatalogAt = previous?.catalogRefreshedAt ?? previous?.refreshedAt;
    const catalogScan =
      fullScan ||
      librariesChanged ||
      !lastCatalogAt ||
      !Number.isFinite(Date.parse(lastCatalogAt)) ||
      Date.now() - Date.parse(lastCatalogAt) >= 24 * 60 * 60 * 1000;
    const raw: RawItem[] = [];
    const itemLibraries = new Map<string, string>();
    if (catalogScan)
      for (const libraryId of libraries.keys())
        for (let offset = 0; ;) {
          const params = new URLSearchParams({
            ParentId: libraryId,
            Recursive: "true",
            CollapseBoxSetItems: "false",
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
          if (
            !Array.isArray(page?.Items) ||
            (page.TotalRecordCount != null &&
              (!Number.isSafeInteger(page.TotalRecordCount) ||
                page.TotalRecordCount < 0 ||
                (page.Items.length === 0 && offset < page.TotalRecordCount)))
          )
            throw new Error("Jellyfin 媒体分页响应不完整，同步未保存");
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
        sourceId: serverId,
      };
    };
    const media: WatchMedia[] = raw.map(convertMedia);
    if (catalogScan && previous?.media.length && !media.length)
      throw new Error("Jellyfin 媒体扫描为空，同步未保存");
    let activities: PlaybackActivity[];
    try {
      const overlap =
        previous?.cursor && !fullScan
          ? new Date(Date.parse(previous.cursor) - 7 * 86400000)
          : undefined;
      const since = overlap
        ? `${overlap.getFullYear()}-${String(overlap.getMonth() + 1).padStart(2, "0")}-${String(overlap.getDate()).padStart(2, "0")} ${String(overlap.getHours()).padStart(2, "0")}:${String(overlap.getMinutes()).padStart(2, "0")}:${String(overlap.getSeconds()).padStart(2, "0")}`
        : undefined;
      const result = await request<unknown>("user_usage_stats/submit_custom_query", {
        CustomQueryString: playbackActivityQuery(reportUserId, since),
        ReplaceUserId: false,
      });
      activities = parsePlaybackActivityResponse(result);
      this.pathLocator.markApiSuccess(serverId, base);
    } catch (httpError) {
      try {
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
            .prepare(playbackActivityLocalQuery(since))
            .all(
              ...(since ? [reportUserId, since] : [reportUserId]),
            ) as unknown as PlaybackActivity[];
        } finally {
          db.close();
        }
      } catch (fallbackError) {
        const reason =
          httpError instanceof Error ? httpError.message : "Playback Reporting 接口失败";
        const safeReason =
          /^(Playback Reporting (?:请求失败 \(\d{3}\)|请求超时|请求失败，请检查服务连接|响应结构无效|响应消息无效|查询失败|响应列无效|响应行无效|播放记录字段无效))$/.test(
            reason,
          )
            ? reason
            : "Playback Reporting 接口失败";
        const fallbackReason = fallbackError instanceof Error ? fallbackError.message : "";
        const safeFallbackReason = [
          "Playback Reporting 接口不可用；远程服务器不能读取本机数据库",
          "本机数据库自动定位目前仅支持 Windows",
          "无法核实当前端口对应的本机 Jellyfin 进程，请手动选择 Playback Reporting 数据库或检查服务连接",
          "无法自动定位 Playback Reporting 数据库，请手动选择数据库文件",
        ].includes(fallbackReason)
          ? fallbackReason
          : "本机数据库回退失败";
        throw new Error(`${safeReason}；${safeFallbackReason}`);
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
        if (itemId(row.UserId) !== reportUserId)
          throw new Error("播放记录用户与当前 Jellyfin 用户不符");
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
    if (!catalogScan) {
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
          try {
            const page = await request<{ Items: RawItem[] }>(
              `Users/${encodeURIComponent(auth.userId)}/Items?${params}`,
            );
            if (!Array.isArray(page?.Items)) throw new Error("Jellyfin 媒体响应缺少 Items");
            found.push(...page.Items);
          } catch (error) {
            if (requested.length === 1 && error instanceof Error && /\(404\)$/.test(error.message))
              continue;
            throw error;
          }
        }
        return found;
      };
      const changedItems = await fetchItems([...ids]);
      for (const item of changedItems) {
        const converted = convertMedia(item);
        const prior = mediaById.get(converted.id);
        if (!converted.libraryId && prior?.libraryId) {
          converted.libraryId = prior.libraryId;
          converted.libraryName = prior.libraryName;
        }
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
        for (let offset = 0; ;) {
          params.set("StartIndex", String(offset));
          const page = await request<{ Items: RawItem[]; TotalRecordCount?: number }>(
            `Users/${encodeURIComponent(auth.userId)}/Items?${params}`,
          );
          if (
            !Array.isArray(page?.Items) ||
            (page.TotalRecordCount != null &&
              (!Number.isSafeInteger(page.TotalRecordCount) ||
                page.TotalRecordCount < 0 ||
                (page.Items.length === 0 && offset < page.TotalRecordCount)))
          )
            throw new Error("Jellyfin 剧集分页响应不完整，同步未保存");
          for (const item of page.Items) {
            const converted = convertMedia(item);
            const series = mediaById.get(seriesId);
            if (!converted.libraryId && series?.libraryId) {
              converted.libraryId = series.libraryId;
              converted.libraryName = series.libraryName;
            }
            mediaById.set(itemId(item.Id), converted);
          }
          offset += page.Items.length;
          if (
            page.Items.length === 0 ||
            offset >= (page.TotalRecordCount ?? (page.Items.length < 500 ? offset : Infinity))
          )
            break;
        }
      }
    }
    // A migration may change every Jellyfin ItemId. Match only unambiguous
    // provider identities, then use the matched series plus season/episode.
    const oldMedia = previous?.media ?? [];
    const oldMediaIds = new Set(oldMedia.map((item) => item.id));
    const newMedia = catalogScan
      ? media
      : [...mediaById.values()].filter((m) => !oldMediaIds.has(m.id));
    const newMediaIds = new Set(newMedia.map((item) => item.id));
    const newByProvider = new Map<string, WatchMedia[]>();
    const newById = new Map(newMedia.map((item) => [item.id, item]));
    const episodeKey = (
      seriesId: string | undefined,
      season: number | undefined,
      episode: number | undefined,
    ) => `${seriesId ?? ""}:${season ?? ""}:${episode ?? ""}`;
    const newEpisodes = new Map<string, WatchMedia[]>();
    for (const m of newMedia)
      for (const key of providerKeys(m))
        newByProvider.set(key, [...(newByProvider.get(key) ?? []), m]);
    for (const m of newMedia.filter((item) => item.type === "Episode")) {
      const key = episodeKey(m.seriesId, m.seasonNumber, m.episodeNumber);
      newEpisodes.set(key, [...(newEpisodes.get(key) ?? []), m]);
    }
    const remap = new Map<string, string>();
    const priorCorrections = (await this.getView(serverId, auth.userId))?.corrections;
    const identityConflicts: NonNullable<WatchStatisticsSnapshot["identityConflicts"]> = [
      ...(previous?.identityConflicts ?? []),
    ];
    const conflict = (fromItemId: string, toItemId: string, reason: string) =>
      identityConflicts.push({ fromItemId, toItemId, reason });
    const historicalIds = new Set([
      ...(previous?.records ?? []).map((entry) => entry.itemId),
      ...(previous?.backfill ?? []).map((entry) => entry.itemId),
      ...(previous?.confirmations ?? []).map((entry) => entry.itemId),
    ]);
    const pruneRemap = () => {
      const sourcesByTarget = new Map<string, string[]>();
      for (const [from, to] of remap)
        sourcesByTarget.set(to, [...(sourcesByTarget.get(to) ?? []), from]);
      for (const [to, sources] of sourcesByTarget)
        if (sources.length > 1)
          for (const from of sources) {
            conflict(from, to, "多个旧作品匹配同一目标");
            remap.delete(from);
          }
      for (const [from, to] of remap) {
        const entries = previous;
        const has = (ids: string[]) => ids.includes(from) && ids.includes(to);
        const reason = has((entries?.backfill ?? []).map((entry) => entry.itemId))
          ? "双方已有独立历史估算"
          : has(
                (entries?.confirmations ?? [])
                  .filter((entry) => entry.source === "initial")
                  .map((entry) => entry.itemId),
              )
            ? "双方已有独立首次观看确认"
            : has((entries?.candidates ?? []).map((entry) => entry.itemId))
              ? "双方已有独立待处理证据"
              : priorCorrections?.items[from] &&
                  priorCorrections.items[to] &&
                  priorCorrections.items[from] !== priorCorrections.items[to]
                ? "双方媒体库修正矛盾"
                : undefined;
        if (reason) {
          conflict(from, to, reason);
          remap.delete(from);
        }
      }
    };
    for (const old of oldMedia) {
      const updated = newById.get(old.id);
      if (
        updated &&
        old.type === updated.type &&
        !providerCompatible(old, updated) &&
        historicalIds.has(old.id)
      )
        conflict(
          old.id,
          old.id,
          `同一 ItemId 的外部身份改变，需核对旧 ${old.type} ${providerKeys(old).join(",")}；新 ${updated.type} ${providerKeys(updated).join(",")}`,
        );
    }
    for (const old of oldMedia.filter(
      (m) => m.type !== "Episode" && catalogScan && eligibleArchiveMedia(m, serverId),
    )) {
      const matches = new Set(
        providerKeys(old)
          .flatMap((key) => newByProvider.get(key) ?? [])
          .filter((candidate) => providerCompatible(old, candidate))
          .map((m) => m.id),
      );
      if (matches.size > 1 && !matches.has(old.id))
        for (const to of matches) conflict(old.id, to, "旧作品匹配多个候选");
      const related = new Set(providerKeys(old).flatMap((key) => newByProvider.get(key) ?? []));
      for (const candidate of related)
        if (
          candidate.type === old.type &&
          candidate.id !== old.id &&
          providerKeys(old).some((key) => providerKeys(candidate).includes(key)) &&
          !providerCompatible(old, candidate)
        )
          conflict(old.id, candidate.id, "外部身份部分相同但存在矛盾");
      if (matches.size === 1 && !newMediaIds.has(old.id)) remap.set(old.id, [...matches][0]);
    }
    pruneRemap();
    for (const old of oldMedia.filter(
      (m) => m.type === "Episode" && catalogScan && eligibleArchiveMedia(m, serverId),
    )) {
      const seriesId =
        old.seriesId &&
        (remap.get(old.seriesId) ?? (newMediaIds.has(old.seriesId) ? old.seriesId : undefined));
      if (!seriesId || old.seasonNumber == null || old.episodeNumber == null) continue;
      const episodeCandidates =
        newEpisodes.get(episodeKey(seriesId, old.seasonNumber, old.episodeNumber)) ?? [];
      const matches = episodeCandidates.filter(
        (m) =>
          m.type === "Episode" &&
          m.seriesId === seriesId &&
          m.seasonNumber === old.seasonNumber &&
          m.episodeNumber === old.episodeNumber &&
          providerCompatible(old, m),
      );
      for (const candidate of episodeCandidates)
        if (
          candidate.type === "Episode" &&
          candidate.seriesId === seriesId &&
          candidate.seasonNumber === old.seasonNumber &&
          candidate.episodeNumber === old.episodeNumber &&
          !providerCompatible(old, candidate)
        )
          conflict(old.id, candidate.id, "季集号相同但外部身份矛盾");
      if (matches.length === 1 && matches[0].id !== old.id) remap.set(old.id, matches[0].id);
    }
    if (!catalogScan) {
      for (const item of newMedia.filter((m) => m.type !== "Episode")) {
        const matches = new Set(
          providerKeys(item)
            .flatMap((key) =>
              oldMedia.filter(
                (old) =>
                  eligibleArchiveMedia(old, serverId) &&
                  providerCompatible(old, item) &&
                  providerKeys(old).includes(key),
              ),
            )
            .map((old) => old.id),
        );
        if (matches.size === 1) remap.set(item.id, [...matches][0]);
      }
      for (const item of newMedia.filter((m) => m.type === "Episode")) {
        const seriesId = item.seriesId && (remap.get(item.seriesId) ?? item.seriesId);
        if (!seriesId || item.seasonNumber == null || item.episodeNumber == null) continue;
        const matches = oldMedia.filter(
          (old) =>
            eligibleArchiveMedia(old, serverId) &&
            old.type === "Episode" &&
            old.seriesId === seriesId &&
            old.seasonNumber === item.seasonNumber &&
            old.episodeNumber === item.episodeNumber &&
            providerCompatible(old, item),
        );
        if (matches.length === 1) remap.set(item.id, matches[0].id);
      }
    }
    // When the old library entry still exists, use it as the stable logical
    // item for exactly one duplicate with the same provider identity.
    for (const old of oldMedia.filter((m) => m.type !== "Episode" && newMediaIds.has(m.id))) {
      const matches = new Set(
        providerKeys(old)
          .flatMap((key) => newByProvider.get(key) ?? [])
          .filter((candidate) => providerCompatible(old, candidate))
          .map((m) => m.id),
      );
      if (matches.size !== 2 || !matches.has(old.id)) continue;
      const duplicateId = [...matches].find((id) => id !== old.id)!;
      if (!oldMedia.some((m) => m.id === duplicateId)) remap.set(duplicateId, old.id);
    }
    for (const old of oldMedia.filter((m) => m.type === "Episode" && newMediaIds.has(m.id))) {
      const duplicateSeries = [...remap].find(([, target]) => target === old.seriesId)?.[0];
      if (!duplicateSeries || old.seasonNumber == null || old.episodeNumber == null) continue;
      const matches = newMedia.filter(
        (m) =>
          m.type === "Episode" &&
          m.seriesId === duplicateSeries &&
          m.seasonNumber === old.seasonNumber &&
          m.episodeNumber === old.episodeNumber &&
          providerCompatible(old, m),
      );
      if (matches.length === 1 && !oldMedia.some((m) => m.id === matches[0].id))
        remap.set(matches[0].id, old.id);
    }
    pruneRemap();
    // A name can suggest a manual review, but never establishes identity.
    const nameKey = (name: string) =>
      name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    const newByName = new Map<string, WatchMedia[]>();
    for (const item of newMedia) {
      const name = nameKey(item.name);
      if (!name) continue;
      const key = `${item.type}:${name}`;
      const group = newByName.get(key) ?? [];
      group.push(item);
      newByName.set(key, group);
    }
    const oldSeriesNames = new Map(
      oldMedia
        .filter((item) => item.type === "Series")
        .map((item) => [item.id, nameKey(item.name)]),
    );
    const newSeriesNames = new Map(
      newMedia
        .filter((item) => item.type === "Series")
        .map((item) => [item.id, nameKey(item.name)]),
    );
    for (const old of oldMedia) {
      if (!historicalIds.has(old.id) || newMediaIds.has(old.id) || !nameKey(old.name)) continue;
      for (const item of newByName.get(`${old.type}:${nameKey(old.name)}`) ?? []) {
        if (remap.has(old.id) || item.id === old.id) continue;
        const priorKeys = providerKeys(old),
          currentKeys = providerKeys(item);
        if (priorKeys.length && currentKeys.length) continue;
        if (old.type === "Episode") {
          const oldSeries = nameKey(old.seriesName || "") || oldSeriesNames.get(old.seriesId || "");
          const newSeries =
            nameKey(item.seriesName || "") || newSeriesNames.get(item.seriesId || "");
          if (oldSeries && newSeries && oldSeries !== newSeries) continue;
          if (
            old.seasonNumber != null &&
            item.seasonNumber != null &&
            old.seasonNumber !== item.seasonNumber
          )
            continue;
          if (
            old.episodeNumber != null &&
            item.episodeNumber != null &&
            old.episodeNumber !== item.episodeNumber
          )
            continue;
        }
        conflict(old.id, item.id, "同名作品缺少可靠身份，请人工核对");
      }
    }
    // Keep prior source ItemIds as aliases across repeated library rebuilds.
    // The archive itself is scoped by server and user; never infer aliases from titles.
    const identityLinks = { ...(previous?.identityLinks ?? {}) };
    for (const [from, to] of remap) {
      if (identityLinks[to]) delete identityLinks[to];
      for (const [alias, target] of Object.entries(identityLinks))
        if (target === from) identityLinks[alias] = to;
      identityLinks[from] = to;
    }
    const resolveItemId = (id: string) => {
      const seen = new Set<string>();
      while (identityLinks[id] && !seen.has(id)) {
        seen.add(id);
        id = identityLinks[id];
      }
      return id;
    };
    const corrections = priorCorrections && {
      records: { ...priorCorrections.records },
      items: { ...priorCorrections.items },
    };
    if (corrections)
      for (const [from, to] of Object.entries(identityLinks)) {
        if (corrections.items[from] && !corrections.items[to])
          corrections.items[to] = corrections.items[from];
        delete corrections.items[from];
      }
    for (const old of catalogScan ? oldMedia : []) {
      if (newMediaIds.has(old.id)) continue;
      if (remap.has(old.id)) mediaById.delete(old.id);
      else mediaById.set(old.id, old);
    }
    for (const [from, to] of remap)
      if (oldMediaIds.has(to) && newMediaIds.has(from)) {
        const retained = mediaById.get(to);
        const duplicate = mediaById.get(from);
        if (retained && duplicate) {
          retained.played = retained.played || duplicate.played;
          mediaById.delete(from);
        }
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
      if (key) canonical.set(m.id, `${m.sourceId ?? serverId}:${key}`);
    }
    const prior = (previous?.records ?? []).map((r) => ({
      ...r,
      itemId: resolveItemId(r.itemId),
    }));
    const priorMediaById = new Map((previous?.media ?? []).map((item) => [item.id, item]));
    const priorSource = new Map(
      (previous?.records ?? []).map((record) => [
        record.id,
        priorMediaById.get(record.itemId)?.sourceId ?? serverId,
      ]),
    );
    const merged = new Map(prior.map((record) => [record.id, record]));
    const eventBuckets = new Map<string, WatchRecord[]>();
    const eventKey = (client: string | undefined, device: string | undefined, date: string) =>
      `${client ?? ""}\u0000${device ?? ""}\u0000${date}`;
    for (const record of prior)
      for (const date of new Set(
        [record.rawDate, record.startAt].filter((value): value is string => !!value),
      )) {
        const key = eventKey(record.clientName, record.deviceName, date);
        eventBuckets.set(key, [...(eventBuckets.get(key) ?? []), record]);
      }
    const incomingIds = new Set(current.map((record) => record.id));
    const incomingEvidence = (record: WatchRecord) =>
      `${resolveItemId(record.itemId)}:${record.rawDate ?? ""}:${record.durationSec}:${record.clientName ?? ""}:${record.deviceName ?? ""}`;
    const incomingEvidenceCounts = new Map<string, number>();
    for (const record of current) {
      const key = incomingEvidence(record);
      incomingEvidenceCounts.set(key, (incomingEvidenceCounts.get(key) ?? 0) + 1);
    }
    if (incomingIds.size !== current.length)
      throw new Error("Playback Reporting 返回重复播放事件身份，同步未保存，请核对插件数据");
    for (const incoming of current) {
      const sameId = merged.get(incoming.id);
      if (
        sameId &&
        priorSource.get(sameId.id) !== serverId &&
        (sameId.rawDate !== incoming.rawDate || sameId.durationSec !== incoming.durationSec)
      )
        throw new Error("跨服务播放记录身份冲突，请先人工核对档案");
      if (
        sameId &&
        priorSource.get(sameId.id) !== serverId &&
        sameId.itemId !== resolveItemId(incoming.itemId) &&
        (!canonical.get(sameId.itemId) ||
          canonical.get(sameId.itemId) !== canonical.get(incoming.itemId) ||
          !mediaById.get(sameId.itemId) ||
          !mediaById.get(incoming.itemId) ||
          !providerCompatible(mediaById.get(sameId.itemId)!, mediaById.get(incoming.itemId)!))
      )
        throw new Error("跨服务播放记录 ID 指向不同作品，同步未保存，请先人工核对档案");
      const record = {
        ...incoming,
        itemId: sameId?.itemId ?? resolveItemId(incoming.itemId),
      };
      // A source event ID is stronger evidence than a nearby timestamp. Never
      // consume an old event that also appears independently in this response.
      let matched = sameId;
      if (!matched && incomingEvidenceCounts.get(incomingEvidence(record)) === 1) {
        const identity = canonical.get(record.itemId);
        const legacyStart = /(?:Z|[+-]\d\d:\d\d)$/i.test(record.rawDate ?? "")
          ? record.startAt
          : new Date(`${(record.rawDate ?? "").replace(" ", "T")}Z`).toISOString();
        const possible = new Map<string, WatchRecord>();
        for (const date of new Set(
          [record.rawDate, record.startAt, legacyStart].filter((value): value is string => !!value),
        ))
          for (const old of eventBuckets.get(
            eventKey(record.clientName, record.deviceName, date),
          ) ?? [])
            possible.set(old.id, old);
        const candidates = [...possible.values()].filter((old) => {
          if (!merged.has(old.id)) return false;
          if (
            incomingIds.has(old.id) ||
            old.clientName !== record.clientName ||
            old.deviceName !== record.deviceName
          )
            return false;
          if (
            old.itemId !== record.itemId &&
            (!identity ||
              canonical.get(old.itemId) !== identity ||
              (mediaById.get(old.itemId) &&
                mediaById.get(record.itemId) &&
                !providerCompatible(mediaById.get(old.itemId)!, mediaById.get(record.itemId)!)))
          )
            return false;
          return (
            old.sourceKey === record.sourceKey ||
            (old.rawDate === record.rawDate && old.durationSec === record.durationSec) ||
            (!old.rawDate &&
              !old.sourceKey &&
              old.durationSec === record.durationSec &&
              (old.startAt === record.startAt || old.startAt === legacyStart))
          );
        });
        if (candidates.length === 1) matched = candidates[0];
        else if (candidates.length > 1)
          console.warn("观影统计播放记录关联有歧义，保留原记录", { candidates: candidates.length });
      }
      if (matched && matched.id !== record.id) merged.delete(matched.id);
      merged.set(matched?.id ?? record.id, {
        ...record,
        id: matched?.id ?? record.id,
        startAt: matched?.startAt ?? record.startAt,
      });
    }
    const records = [...merged.values()].sort(
      (a, b) => Date.parse(b.startAt) - Date.parse(a.startAt),
    );
    const priorBackfill = (previous?.backfill ?? []).map((item) => ({
      ...item,
      itemId: resolveItemId(item.itemId),
      baselineAt: item.baselineAt ?? previous?.refreshedAt,
    }));
    const backfillKeys = new Set<string>();
    const backfill: typeof priorBackfill = [];
    const addBackfill = (item: (typeof priorBackfill)[number]) => {
      const key = item.itemId;
      if (backfillKeys.has(key)) throw new Error("估算基线身份冲突，请先人工核对档案");
      backfillKeys.add(key);
      backfill.push(item);
    };
    for (const item of priorBackfill) addBackfill(item);
    const confirmations: WatchConfirmation[] = (previous?.confirmations ?? []).map((entry) => ({
      ...entry,
      itemId: resolveItemId(entry.itemId),
    }));
    const candidates: WatchCandidate[] = (previous?.candidates ?? []).map((entry) => ({
      ...entry,
      itemId: resolveItemId(entry.itemId),
    }));
    const previousRecords = new Map(previous?.records.map((entry) => [entry.id, entry]) ?? []);
    const isNewEvidence = (entry: WatchRecord) => {
      const old = previousRecords.get(entry.id);
      return (
        !old ||
        ((old.durationSec <= 0 || (previous?.settings.excludeShort && old.durationSec < 120)) &&
          entry.durationSec > old.durationSec)
      );
    };
    const baselineNow = new Date().toISOString();
    for (const item of resolvedMedia) {
      if (item.type !== "Movie" && item.type !== "Episode") continue;
      if (confirmations.some((entry) => entry.itemId === item.id)) continue;
      if (!item.played) continue;
      // The old transition path alone created an empty pending first candidate.
      // A reviewed or evidence-bearing candidate has no reliable provenance.
      const existingCandidate = candidates.find((entry) => entry.itemId === item.id);
      if (existingCandidate) {
        if (existingCandidate.status !== "pending" || existingCandidate.evidenceIds.length)
          continue;
        candidates.splice(candidates.indexOf(existingCandidate), 1);
      }
      const itemRecords = records.filter(
        (entry) => entry.itemId === item.id && entry.durationSec > 0,
      );
      confirmations.push({
        id: randomUUID(),
        itemId: item.id,
        source: "initial",
        evidenceIds: itemRecords.map((entry) => entry.id),
        baselineAt: baselineNow,
      });
      // A complete recorded watch already accounts for the first viewing.
      // Short playback is separate evidence and does not erase the older watch
      // represented by Played; retain its minutes alongside one full estimate.
      const recordedSeconds = itemRecords.reduce((sum, entry) => sum + entry.durationSec, 0);
      if (
        item.runtimeSec &&
        recordedSeconds < item.runtimeSec * 0.9 &&
        !backfillKeys.has(canonical.get(item.id) ?? item.id)
      )
        addBackfill({
          itemId: item.id,
          durationSec: item.runtimeSec,
          baselineRecordIds: itemRecords.map((entry) => entry.id),
          baselineAt: baselineNow,
        });
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
                .filter((entry) => entry.itemId === item.id && isNewEvidence(entry))
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
          isNewEvidence(entry) &&
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
      catalogRefreshedAt: catalogScan ? new Date().toISOString() : lastCatalogAt,
      libraries: [...libraries].map(([id, name]) => ({ id, name })),
      media: resolvedMedia,
      records,
      identityConflicts: [
        ...new Map(
          identityConflicts
            .filter(
              (entry) =>
                entry.fromItemId === entry.toItemId ||
                resolveItemId(entry.fromItemId) !== resolveItemId(entry.toItemId),
            )
            .map((entry) => [`${entry.fromItemId}:${entry.toItemId}:${entry.reason}`, entry]),
        ).values(),
      ],
      backfill,
      confirmations,
      candidates,
      appliedReviewIds: previous?.appliedReviewIds,
      revokedConfirmationIds: previous?.revokedConfirmationIds,
      identityLinks,
      corrections,
      settings:
        this.currentSettings.get(this.path(serverId, auth.userId)) ??
        previous?.settings ??
        defaults,
      cursor: new Date().toISOString(),
    };
    const valid = snapshotSchema.safeParse(snapshot);
    if (!valid.success)
      throw new Error(`同步数据无效，档案未保存：${valid.error.issues[0]?.path.join(".")}`);
    return this.save(serverId, auth.userId, snapshot, false, previous, !catalogScan);
  }
}
