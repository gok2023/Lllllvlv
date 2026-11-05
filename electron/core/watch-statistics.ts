import { readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WatchStatisticsPathLocator } from "./watch-statistics-path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  WatchStatisticsSnapshot,
  WatchStatisticsSettings,
  WatchMedia,
  WatchRecord,
  WatchStatisticsImportPreview,
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
  includeBackfill: false,
  excludeShort: false,
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
});
const settingsSchema = z.object({
  gapMinutes: z.number().finite().nonnegative(),
  includeBackfill: z.boolean(),
  excludeShort: z.boolean(),
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
});

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
    const snapshot = await this.get(serverId, userId);
    if (!snapshot) throw new Error("尚无可导出的观影统计数据");
    await writeFile(
      path,
      JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), snapshot }),
    );
  }
  private async readImport(path: string) {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("导入文件格式无效");
    const archive = parsed as { version?: unknown; exportedAt?: unknown; snapshot?: unknown };
    if (archive.version !== 1 || !archive.snapshot || typeof archive.snapshot !== "object")
      throw new Error("不支持的统计文件版本");
    const result = snapshotSchema.safeParse(archive.snapshot);
    if (!result.success)
      throw new Error(`统计文件内容无效：${result.error.issues[0]?.path.join(".") ?? "未知字段"}`);
    const snapshot = result.data as WatchStatisticsSnapshot;
    return {
      snapshot,
      exportedAt: typeof archive.exportedAt === "string" ? archive.exportedAt : undefined,
    };
  }
  async previewImport(path: string): Promise<WatchStatisticsImportPreview> {
    const { snapshot, exportedAt } = await this.readImport(path);
    const dates = snapshot.records.map((r) => r.startAt).sort();
    return {
      version: 1,
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
    };
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
  ): Promise<WatchStatisticsSnapshot> {
    const path = this.path(serverId, userId);
    await mkdir(dirname(path), { recursive: true });
    const previous = this.writes.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        // A settings click may arrive while a full scan is running. Apply it to
        // the latest committed data instead of writing an older snapshot over it.
        const latest = settingsOnly ? await this.get(serverId, userId) : null;
        const snapshot = settingsOnly && latest ? latest : value;
        snapshot.settings = this.currentSettings.get(path) ?? snapshot.settings;
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
        for (let offset = 0; ; offset += 500) {
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
          if (
            page.Items.length < 500 ||
            offset + page.Items.length >= (page.TotalRecordCount ?? Infinity)
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
    for (const old of fullScan ? oldMedia : []) {
      if (newMedia.some((m) => m.id === old.id)) continue;
      if (remap.has(old.id)) mediaById.delete(old.id);
      else mediaById.set(old.id, { ...old, libraryId: undefined, libraryName: "未匹配" });
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
    }));
    const backfillKeys = new Set<string>();
    const backfill: typeof priorBackfill = [];
    const addBackfill = (item: (typeof priorBackfill)[number]) => {
      const key = canonical.get(item.itemId) ?? item.itemId;
      if (playedIds.has(key) || backfillKeys.has(key)) return;
      backfillKeys.add(key);
      backfill.push(item);
    };
    for (const item of priorBackfill) addBackfill(item);
    for (const item of resolvedMedia)
      if ((item.type === "Movie" || item.type === "Episode") && item.played && item.runtimeSec)
        addBackfill({
          itemId: item.id,
          durationSec: item.runtimeSec,
          watchedAt: item.lastPlayedAt,
        });
    const snapshot = {
      serverId,
      refreshedAt: new Date().toISOString(),
      libraries: [...libraries].map(([id, name]) => ({ id, name })),
      media: resolvedMedia,
      records,
      backfill,
      settings:
        this.currentSettings.get(this.path(serverId, auth.userId)) ??
        previous?.settings ??
        defaults,
      cursor: new Date().toISOString(),
    };
    await this.save(serverId, auth.userId, snapshot);
    return snapshot;
  }
}
