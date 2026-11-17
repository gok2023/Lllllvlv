import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WatchStatisticsStore } from "../../../electron/core/watch-statistics";
import { playbackActivityColumns } from "../../../electron/core/watch-statistics-playback-reporting";

const userId = "a".repeat(32);
const seriesId = "b".repeat(32);
const libraryId = "c".repeat(32);
const episodeIds = ["1", "2", "3", "4"].map((digit) => digit.repeat(32));
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function episode(id: string) {
  return {
    Id: id,
    Type: "Episode",
    Name: "同一集",
    SeriesId: seriesId,
    ParentIndexNumber: 1,
    IndexNumber: 1,
    UserData: { Played: true },
    RunTimeTicks: 60_000_000_000,
  };
}
function series() {
  return { Id: seriesId, Type: "Series", Name: "系列", ProviderIds: { Tmdb: "series-1" } };
}
function history(ids: string[], reportUserId = userId) {
  return {
    colums: [...playbackActivityColumns],
    results: ids.map((id, index) => [
      `2026-11-0${index + 1} 12:00:00`,
      reportUserId,
      id,
      "Episode",
      "同一集",
      1200,
      "client",
      "device",
      "DirectPlay",
    ]),
  };
}
function fetcher(
  items: ReturnType<typeof episode>[],
  records: string[],
  reportUserId = userId,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    let body: unknown;
    if (url.pathname.endsWith("/Views")) body = { Items: [{ Id: libraryId, Name: "库" }] };
    else if (url.pathname.endsWith("/submit_custom_query")) body = history(records, reportUserId);
    else if (url.pathname.endsWith("/Items")) {
      const ids = url.searchParams.get("Ids");
      const parent = url.searchParams.get("ParentId");
      const all = items.length ? [series(), ...items] : [];
      const found = ids
        ? all.filter((item) => ids.split(",").includes(item.Id))
        : parent === seriesId
          ? items
          : all;
      body = { Items: found, TotalRecordCount: found.length };
    } else throw new Error(url.pathname);
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
}

it("keeps episode identity and evidence through repeated rebuilds and an incremental source change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const first = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], [episodeIds[0]]),
  );
  const recordId = first.records[0].id;
  const confirmationId = first.confirmations?.[0]?.id;
  const baselineRecordIds = first.backfill[0]?.baselineRecordIds;
  const baselineAt = first.backfill[0]?.baselineAt;
  expect(first.records[0].durationSec).toBe(1200);
  await store.correctLibrary("server", userId, recordId, libraryId, true);
  const second = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[1])], [episodeIds[0]]),
  );
  expect(second.records[0].id).toBe(recordId);
  expect(second.confirmations?.[0]?.id).toBe(confirmationId);
  expect(second.confirmations?.[0]?.itemId).toBe(episodeIds[1]);
  expect(second.corrections?.items[episodeIds[1]]).toBe(libraryId);
  const third = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[2])], [episodeIds[0]]),
  );
  expect(third.identityLinks?.[episodeIds[0]]).toBe(episodeIds[2]);
  expect(third.identityLinks?.[episodeIds[1]]).toBe(episodeIds[2]);
  const fourth = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[3])], [episodeIds[0], episodeIds[3]]),
    "incremental",
  );
  expect(fourth.records.find((record) => record.id === recordId)?.itemId).toBe(episodeIds[2]);
  expect(fourth.records.find((record) => record.id.includes(episodeIds[3]))?.itemId).toBe(
    episodeIds[2],
  );
  expect(fourth.confirmations?.[0]?.id).toBe(confirmationId);
  expect(fourth.backfill[0]?.baselineRecordIds).toEqual(baselineRecordIds);
  expect(fourth.backfill[0]?.baselineAt).toBe(baselineAt);
  expect(fourth.records.reduce((sum, record) => sum + record.durationSec, 0)).toBe(2400);
  const repeated = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[3])], [episodeIds[0], episodeIds[3]]),
    "incremental",
  );
  expect(repeated.records.map((record) => record.id)).toEqual(
    fourth.records.map((record) => record.id),
  );
  expect(repeated.confirmations?.map((entry) => entry.id)).toEqual(
    fourth.confirmations?.map((entry) => entry.id),
  );
});

it("rejects an empty full scan without changing the saved archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const original = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], [episodeIds[0]]),
  );
  await expect(store.refresh("server", auth, fetcher([], []))).rejects.toThrow("扫描为空");
  expect((await store.get("server", userId))?.cursor).toBe(original.cursor);
});

it("keeps the old archive when a rebuilt episode has ambiguous matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const original = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], [episodeIds[0]]),
  );
  const result = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[1]), episode(episodeIds[2])], [episodeIds[0]]),
  );
  expect(result.identityLinks?.[episodeIds[0]]).toBeUndefined();
  expect(result.media.some((item) => item.id === episodeIds[0])).toBe(true);
  expect(result.records[0].id).toBe(original.records[0].id);
  expect(result.confirmations?.[0]?.itemId).toBe(episodeIds[0]);
});

it("rejects a truncated media page before replacing the archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const original = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], [episodeIds[0]]),
  );
  const normal = fetcher([episode(episodeIds[1])], [episodeIds[0]]);
  const broken = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/Items"))
      return { ok: true, json: async () => ({ Items: [], TotalRecordCount: 2 }) } as Response;
    return normal(input, init);
  }) as typeof fetch;
  await expect(store.refresh("server", auth, broken)).rejects.toThrow("分页响应不完整");
  expect((await store.get("server", userId))?.cursor).toBe(original.cursor);
});

it("does not join items when another provider ID contradicts the shared ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const movie = (id: string, imdb: string) =>
    ({
      Id: id,
      Type: "Movie",
      Name: "同名电影",
      UserData: { Played: true },
      ProviderIds: { Tmdb: "shared", Imdb: imdb },
    }) as unknown as ReturnType<typeof episode>;
  await store.refresh("server", auth, fetcher([movie(episodeIds[0], "tt-old")], [episodeIds[0]]));
  const result = await store.refresh(
    "server",
    auth,
    fetcher([movie(episodeIds[1], "tt-new")], [episodeIds[0]]),
  );
  expect(result.identityLinks?.[episodeIds[0]]).toBeUndefined();
  expect(result.media.some((item) => item.id === episodeIds[0])).toBe(true);
  expect(result.media.some((item) => item.id === episodeIds[1])).toBe(true);
});

it("restores another server and user, then preserves evidence through fresh and repeated playback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const sourceAuth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const targetUser = "d".repeat(32);
  const targetAuth = { ...sourceAuth, userId: targetUser };
  const source = await store.refresh(
    "old-server",
    sourceAuth,
    fetcher([episode(episodeIds[0])], [episodeIds[0]]),
  );
  const exportPath = join(directory, "archive.json");
  await store.exportData("old-server", userId, exportPath);
  const imported = await store.importData("new-server", targetUser, exportPath);
  const legacyId = `legacy:old-server:${episodeIds[0]}`;
  expect(imported.records[0].id).toBe(source.records[0].id);
  expect(imported.records[0].itemId).toBe(legacyId);
  const migrated = await store.refresh(
    "new-server",
    targetAuth,
    fetcher([episode(episodeIds[1])], [episodeIds[1]], targetUser),
  );
  expect(migrated.identityLinks?.[legacyId]).toBe(episodeIds[1]);
  expect(migrated.records[0].id).toBe(source.records[0].id);
  expect(migrated.records[0].itemId).toBe(episodeIds[1]);
  expect(migrated.confirmations?.[0]?.id).toBe(source.confirmations?.[0]?.id);
  expect(migrated.confirmations?.[0]?.itemId).toBe(episodeIds[1]);
  expect(migrated.backfill[0]?.baselineRecordIds).toEqual(source.backfill[0]?.baselineRecordIds);
  expect(migrated.backfill[0]?.baselineAt).toBe(source.backfill[0]?.baselineAt);
  const repeated = await store.refresh(
    "new-server",
    targetAuth,
    fetcher([episode(episodeIds[1])], [episodeIds[1]], targetUser),
  );
  expect(repeated.records.map((record) => record.id)).toEqual(
    migrated.records.map((record) => record.id),
  );
  expect(repeated.confirmations?.map((entry) => entry.id)).toEqual(
    migrated.confirmations?.map((entry) => entry.id),
  );
  expect(repeated.records.reduce((sum, record) => sum + record.durationSec, 0)).toBe(1200);
});

it("does not overwrite a restored work when the new server reuses its raw ItemId", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const movie = (provider: string) =>
    ({
      Id: episodeIds[0],
      Type: "Movie",
      Name: "同名电影",
      UserData: { Played: true },
      ProviderIds: { Tmdb: provider },
    }) as unknown as ReturnType<typeof episode>;
  await store.refresh("old-server", auth, fetcher([movie("old")], [episodeIds[0]]));
  const exportPath = join(directory, "archive.json");
  await store.exportData("old-server", userId, exportPath);
  await store.importData("new-server", userId, exportPath);
  const result = await store.refresh("new-server", auth, fetcher([movie("new")], []));
  expect(
    result.media.find((item) => item.id === `legacy:old-server:${episodeIds[0]}`)?.providerIds
      ?.Tmdb,
  ).toBe("old");
  expect(result.media.find((item) => item.id === episodeIds[0])?.providerIds?.Tmdb).toBe("new");
  expect(
    result.confirmations?.some((entry) => entry.itemId === `legacy:old-server:${episodeIds[0]}`),
  ).toBe(true);
});

it("applies a reviewed legacy link immediately when provider IDs are unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  await store.refresh("old-server", auth, fetcher([episode(episodeIds[0])], [episodeIds[0]]));
  const exportPath = join(directory, "archive.json");
  await store.exportData("old-server", userId, exportPath);
  await store.importData("new-server", userId, exportPath);
  const fresh = episode(episodeIds[1]);
  fresh.IndexNumber = 2;
  fresh.UserData.Played = false;
  await store.refresh("new-server", auth, fetcher([fresh], []));
  const legacyId = `legacy:old-server:${episodeIds[0]}`;
  const linked = await store.linkWatchMedia("new-server", userId, legacyId, episodeIds[1]);
  expect(linked.records[0].itemId).toBe(episodeIds[1]);
  expect(linked.confirmations?.[0]?.itemId).toBe(episodeIds[1]);
  expect(linked.backfill[0]?.itemId).toBe(episodeIds[1]);
  expect(linked.identityLinks?.[legacyId]).toBe(episodeIds[1]);
});

it("does not equate same-title movies from different years without provider identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const movie = (id: string, year: number) =>
    ({
      Id: id,
      Type: "Movie",
      Name: "同名电影",
      ProductionYear: year,
      UserData: { Played: true },
    }) as unknown as ReturnType<typeof episode>;
  await store.refresh("server", auth, fetcher([movie(episodeIds[0], 1990)], [episodeIds[0]]));
  const result = await store.refresh(
    "server",
    auth,
    fetcher([movie(episodeIds[1], 2020)], [episodeIds[0]]),
  );
  expect(result.identityLinks?.[episodeIds[0]]).toBeUndefined();
  expect(result.media.some((item) => item.id === episodeIds[0] && item.year === 1990)).toBe(true);
  expect(result.media.some((item) => item.id === episodeIds[1] && item.year === 2020)).toBe(true);
});

it("keeps season zero specials separate from a numbered-season episode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const special = episode(episodeIds[0]);
  special.ParentIndexNumber = 0;
  await store.refresh("server", auth, fetcher([special], [episodeIds[0]]));
  const regular = episode(episodeIds[1]);
  regular.ParentIndexNumber = 1;
  const result = await store.refresh("server", auth, fetcher([regular], [episodeIds[0]]));
  expect(result.identityLinks?.[episodeIds[0]]).toBeUndefined();
  expect(result.confirmations?.some((entry) => entry.itemId === episodeIds[0])).toBe(true);
  expect(result.media.find((item) => item.id === episodeIds[0])?.seasonNumber).toBe(0);
  expect(result.media.find((item) => item.id === episodeIds[1])?.seasonNumber).toBe(1);
});

it("does not collapse a different server playback one second away", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  await store.refresh("old-server", auth, fetcher([episode(episodeIds[0])], [episodeIds[0]]));
  const exportPath = join(directory, "archive.json");
  await store.exportData("old-server", userId, exportPath);
  await store.importData("new-server", userId, exportPath);
  const normal = fetcher([episode(episodeIds[1])], [episodeIds[1]]);
  const shifted = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await normal(input, init);
    if (!new URL(String(input)).pathname.endsWith("/submit_custom_query")) return response;
    const body = (await response.json()) as ReturnType<typeof history>;
    body.results[0][0] = "2026-11-01 12:00:01";
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
  const result = await store.refresh("new-server", auth, shifted);
  expect(result.records).toHaveLength(2);
  expect(result.records.reduce((sum, record) => sum + record.durationSec, 0)).toBe(2400);
});

it("keeps two distinct baselines when both old works match one new provider identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const movie = (id: string) =>
    ({
      Id: id,
      Type: "Movie",
      Name: "重复条目",
      UserData: { Played: true },
      RunTimeTicks: 60_000_000_000,
      ProviderIds: { Tmdb: "shared" },
    }) as unknown as ReturnType<typeof episode>;
  const first = await store.refresh(
    "server",
    auth,
    fetcher([movie(episodeIds[0]), movie(episodeIds[1])], [episodeIds[0], episodeIds[1]]),
  );
  expect(first.backfill).toHaveLength(2);
  const result = await store.refresh("server", auth, fetcher([movie(episodeIds[2])], []));
  expect(result.identityLinks?.[episodeIds[0]]).toBeUndefined();
  expect(result.identityLinks?.[episodeIds[1]]).toBeUndefined();
  expect(result.backfill.map((entry) => entry.itemId).sort()).toEqual(
    [episodeIds[0], episodeIds[1], episodeIds[2]].sort(),
  );
  expect(result.confirmations?.filter((entry) => entry.itemId === episodeIds[0])).toHaveLength(1);
  expect(result.confirmations?.filter((entry) => entry.itemId === episodeIds[1])).toHaveLength(1);
});

it("does not let an in-flight refresh replace a later imported archive", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  await store.refresh("target", auth, fetcher([episode(episodeIds[0])], [episodeIds[0]]));
  await store.refresh("origin", auth, fetcher([episode(episodeIds[1])], [episodeIds[1]]));
  const exportPath = join(directory, "archive.json");
  await store.exportData("origin", userId, exportPath);
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const normal = fetcher([episode(episodeIds[0])], [episodeIds[0]]);
  const slow = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/submit_custom_query")) {
      started();
      await blocked;
    }
    return normal(input, init);
  }) as typeof fetch;
  const refreshing = store.refresh("target", auth, slow);
  await entered;
  const imported = await store.importData("target", userId, exportPath);
  release();
  await expect(refreshing).rejects.toThrow("档案已更新");
  const saved = await store.get("target", userId);
  expect(saved?.records.map((record) => record.id)).toEqual(
    imported.records.map((record) => record.id),
  );
  expect(saved?.confirmations?.map((entry) => entry.id)).toEqual(
    imported.confirmations?.map((entry) => entry.id),
  );
});
