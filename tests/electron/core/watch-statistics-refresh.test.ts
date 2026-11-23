import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  vi.unstubAllEnvs();
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

it("keeps a legacy event ID when only its exact start time survives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  await store.refresh("server", auth, fetcher([episode(episodeIds[0])], [episodeIds[0]]));
  const path = join(directory, "watch-statistics", `server-${userId}.json`);
  const snapshot = JSON.parse(await readFile(path, "utf8"));
  snapshot.records[0].id = "legacy-event";
  delete snapshot.records[0].rawDate;
  delete snapshot.records[0].sourceKey;
  await writeFile(path, JSON.stringify(snapshot));
  const updated = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], [episodeIds[0]]),
  );
  expect(updated.records).toHaveLength(1);
  expect(updated.records[0].id).toBe("legacy-event");
});

it("keeps independent events one second apart and their original time interpretation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const base = fetcher([episode(episodeIds[0])], [episodeIds[0]]);
  let dates = ["2026-11-01 12:00:00"];
  const withEvents: typeof fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!url.pathname.endsWith("/submit_custom_query")) return base(input, init);
    return {
      ok: true,
      json: async () => ({
        colums: [...playbackActivityColumns],
        results: dates.map((date) => [
          date,
          userId,
          episodeIds[0],
          "Episode",
          "同一集",
          1200,
          "client",
          "device",
          "DirectPlay",
        ]),
      }),
    } as Response;
  }) as typeof fetch;
  vi.stubEnv("TZ", "UTC");
  const first = await store.refresh("server", auth, withEvents);
  dates = ["2026-11-01 12:00:00", "2026-11-01 12:00:01"];
  vi.stubEnv("TZ", "Asia/Shanghai");
  const second = await store.refresh("server", auth, withEvents, "incremental");
  const repeated = await store.refresh("server", auth, withEvents, "incremental");
  expect(second.records).toHaveLength(2);
  expect(repeated.records.map((record) => record.id)).toEqual(
    second.records.map((record) => record.id),
  );
  expect(repeated.records.find((record) => record.id === first.records[0].id)?.startAt).toBe(
    first.records[0].startAt,
  );
});
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
  seriesItems: ReturnType<typeof series>[] = [series()],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe('MediaBrowser Token="synthetic"');
    expect(headers.has("X-Emby-Token")).toBe(false);
    expect(headers.has("X-MediaBrowser-Token")).toBe(false);
    const url = new URL(input instanceof Request ? input.url : input.toString());
    let body: unknown;
    if (url.pathname.endsWith("/Views")) body = { Items: [{ Id: libraryId, Name: "库" }] };
    else if (url.pathname.endsWith("/submit_custom_query")) body = history(records, reportUserId);
    else if (url.pathname.endsWith("/Items")) {
      const ids = url.searchParams.get("Ids");
      const parent = url.searchParams.get("ParentId");
      const all = items.length ? [...seriesItems, ...items] : [];
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

it("rejects malformed media and another user's report without changing archive bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  await store.refresh("server", auth, fetcher([episode(episodeIds[0])], [episodeIds[0]]));
  const path = join(directory, "watch-statistics", `server-${userId}.json`);
  const before = await readFile(path);
  const malformed = { ...episode(episodeIds[0]), Genres: [17] } as unknown as ReturnType<
    typeof episode
  >;
  await expect(
    store.refresh("server", auth, fetcher([malformed], [episodeIds[0]])),
  ).rejects.toThrow("同步数据无效");
  expect(await readFile(path)).toEqual(before);
  await expect(
    store.refresh(
      "server",
      auth,
      fetcher([episode(episodeIds[0])], [episodeIds[0]], "d".repeat(32)),
    ),
  ).rejects.toThrow("播放记录用户与当前 Jellyfin 用户不符");
  expect(await readFile(path)).toEqual(before);
});

it("preserves the archive when the sync commit fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  await store.refresh("server", auth, fetcher([episode(episodeIds[0])], [episodeIds[0]]));
  const path = join(directory, "watch-statistics", `server-${userId}.json`);
  const before = await readFile(path);
  const write = vi
    .spyOn(
      store as unknown as { atomicWrite: (path: string, data: string) => Promise<void> },
      "atomicWrite",
    )
    .mockRejectedValueOnce(new Error("synthetic commit failure"));
  await expect(
    store.refresh("server", auth, fetcher([episode(episodeIds[1])], [episodeIds[0]])),
  ).rejects.toThrow("synthetic commit failure");
  write.mockRestore();
  expect(await readFile(path)).toEqual(before);
  expect((await store.get("server", userId))?.media.some((item) => item.id === episodeIds[0])).toBe(
    true,
  );
});

it("bounds automatic catalog scans even when reporting is empty and discovers Played-only media", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  let items = [] as ReturnType<typeof episode>[];
  const requests: string[] = [];
  const tracked = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push(url.pathname);
    return fetcher(items, [])(input, init);
  }) as typeof fetch;
  const first = await store.refresh("server", auth, tracked, "incremental");
  expect(first.cursor).toBeDefined();
  expect(first.catalogRefreshedAt).toBeDefined();
  expect(requests.filter((path) => path.endsWith("/Items"))).toHaveLength(1);
  requests.length = 0;
  items = [episode(episodeIds[0])];
  const second = await store.refresh("server", auth, tracked, "incremental");
  expect(second.media).toHaveLength(0);
  expect(requests.filter((path) => path.endsWith("/Items"))).toHaveLength(0);
  vi.setSystemTime(new Date("2026-11-21T12:00:01Z"));
  requests.length = 0;
  const third = await store.refresh("server", auth, tracked, "incremental");
  expect(requests.filter((path) => path.endsWith("/Items"))).toHaveLength(1);
  expect(third.media.some((item) => item.id === episodeIds[0])).toBe(true);
  expect(third.confirmations?.some((item) => item.itemId === episodeIds[0])).toBe(true);
});

it("skips unchanged incremental commits but persists new evidence", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const path = join(directory, "watch-statistics", `server-${userId}.json`);
  await store.refresh("server", auth, fetcher([episode(episodeIds[0])], [episodeIds[0]]));
  const before = await readFile(path);
  const write = vi.spyOn(
    store as unknown as { atomicWrite: (path: string, data: string) => Promise<void> },
    "atomicWrite",
  );
  const unchanged = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], [episodeIds[0]]),
    "incremental",
  );
  expect(write).not.toHaveBeenCalled();
  expect(await readFile(path)).toEqual(before);
  expect(unchanged.cursor).toBeDefined();
  const added = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], [episodeIds[0], episodeIds[0]]),
    "incremental",
  );
  expect(write.mock.calls.filter(([target]) => target === path)).toHaveLength(1);
  expect(added.records).toHaveLength(2);
  expect(await readFile(path)).not.toEqual(before);
  vi.setSystemTime(new Date("2026-11-20T13:00:01Z"));
  await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], [episodeIds[0], episodeIds[0]]),
    "incremental",
  );
  expect(write.mock.calls.filter(([target]) => target === path)).toHaveLength(2);
  expect((await store.get("server", userId))?.cursor).toBe("2026-11-20T13:00:01.000Z");
  vi.setSystemTime(new Date("2026-11-20T12:30:00Z"));
  let catalogRequests = 0;
  const base = fetcher([episode(episodeIds[0])], [episodeIds[0], episodeIds[0]]);
  const measured: typeof fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/Items") && url.searchParams.has("ParentId")) catalogRequests++;
    return base(input, init);
  }) as typeof fetch;
  const recovered = await store.refresh("server", auth, measured, "incremental");
  expect(catalogRequests).toBeGreaterThan(0);
  expect(recovered.cursor).toBe("2026-11-20T12:30:00.000Z");
});

it("retains a revoked confirmation through sync and archive recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const first = await store.refresh("server", auth, fetcher([episode(episodeIds[0])], []));
  const oldArchive = join(directory, "before-revoke.json");
  await store.exportData("server", userId, oldArchive);
  const confirmationId = first.confirmations![0].id;
  await store.review("server", userId, { action: "revoke", confirmationId });
  const refreshed = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], []),
    "incremental",
  );
  expect(refreshed.confirmations).toHaveLength(0);
  expect(refreshed.revokedConfirmationIds).toContain(confirmationId);
  const archive = join(directory, "after-revoke.json");
  await store.exportData("server", userId, archive);
  const restored = await store.importData("server", userId, archive, "replace");
  expect(restored.revokedConfirmationIds).toContain(confirmationId);
  await expect(store.importData("server", userId, oldArchive, "merge")).rejects.toThrow("合并冲突");
});

it("recognizes an existing zero-duration report when it later gains viewing time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const item = episode(episodeIds[0]);
  await store.refresh("server", auth, fetcher([item], []));
  vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
  let duration = 0;
  const reporting = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/submit_custom_query")) {
      const response = history([item.Id, item.Id]);
      response.results[0][5] = 0 as never;
      response.results[1][5] = duration as never;
      return { ok: true, json: async () => response } as Response;
    }
    return fetcher([item], [])(input, init);
  }) as typeof fetch;
  const zero = await store.refresh("server", auth, reporting, "incremental");
  expect(zero.candidates?.filter((entry) => entry.status !== "ignored")).toHaveLength(0);
  duration = 1200;
  const updated = await store.refresh("server", auth, reporting, "incremental");
  expect(updated.candidates?.filter((entry) => entry.status === "pending")).toHaveLength(1);
  const repeated = await store.refresh("server", auth, reporting, "incremental");
  expect(repeated.candidates).toEqual(updated.candidates);
});

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
  const returned = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], [episodeIds[0]]),
  );
  expect(returned.records.find((entry) => entry.id === recordId)?.itemId).toBe(episodeIds[0]);
  expect(returned.identityLinks?.[episodeIds[0]]).toBeUndefined();
  expect(returned.identityLinks?.[episodeIds[2]]).toBe(episodeIds[0]);
  expect(returned.identityLinks?.[episodeIds[3]]).toBe(episodeIds[0]);
});

it("keeps conflicting standalone library rules when a provider match suggests remapping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const movie = (id: string) =>
    ({
      Id: id,
      Type: "Movie",
      Name: "同一电影",
      UserData: { Played: false },
      ProviderIds: { Tmdb: "same" },
      RunTimeTicks: 60_000_000_000,
    }) as unknown as ReturnType<typeof episode>;
  await store.refresh(
    "server",
    auth,
    fetcher([movie(episodeIds[0]), movie(episodeIds[1])], [episodeIds[0]]),
  );
  await writeFile(
    join(directory, "watch-statistics", `server-${userId}.json.corrections.json`),
    JSON.stringify({
      records: {},
      items: { [episodeIds[0]]: "old-library", [episodeIds[1]]: "new-library" },
    }),
  );
  const result = await store.refresh(
    "server",
    auth,
    fetcher([movie(episodeIds[1])], [episodeIds[0]]),
  );
  expect(result.identityLinks?.[episodeIds[0]]).toBeUndefined();
  expect(result.identityConflicts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        fromItemId: episodeIds[0],
        toItemId: episodeIds[1],
        reason: "双方媒体库修正矛盾",
      }),
    ]),
  );
  expect(result.records[0].itemId).toBe(episodeIds[0]);
  expect(result.corrections?.items).toMatchObject({
    [episodeIds[0]]: "old-library",
    [episodeIds[1]]: "new-library",
  });
});

it("does not merge two independent candidate histories through an automatic provider remap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const movie = (id: string) =>
    ({
      Id: id,
      Type: "Movie",
      Name: "同一电影",
      UserData: { Played: false },
      ProviderIds: { Tmdb: "same" },
    }) as unknown as ReturnType<typeof episode>;
  await store.refresh(
    "server",
    auth,
    fetcher([movie(episodeIds[0]), movie(episodeIds[1])], [episodeIds[0]]),
  );
  const path = join(directory, "watch-statistics", `server-${userId}.json`);
  const snapshot = await store.get("server", userId);
  expect(snapshot).not.toBeNull();
  await writeFile(
    path,
    JSON.stringify({
      ...snapshot,
      candidates: [
        { itemId: episodeIds[0], evidenceIds: [snapshot!.records[0].id], status: "later" },
        { itemId: episodeIds[1], evidenceIds: [], status: "ignored" },
      ],
    }),
  );
  const result = await store.refresh(
    "server",
    auth,
    fetcher([movie(episodeIds[1])], [episodeIds[0]]),
  );
  expect(result.identityLinks?.[episodeIds[0]]).toBeUndefined();
  expect(result.identityConflicts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        fromItemId: episodeIds[0],
        toItemId: episodeIds[1],
        reason: "双方已有独立待处理证据",
      }),
    ]),
  );
  expect(result.candidates?.map((entry) => entry.itemId).sort()).toEqual(
    [episodeIds[0], episodeIds[1]].sort(),
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

it("does not remap an episode when its parent series has two provider matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const original = await store.refresh(
    "server",
    auth,
    fetcher([episode(episodeIds[0])], [episodeIds[0]]),
  );
  const nextSeries = [
    { ...series(), Id: "d".repeat(32) },
    { ...series(), Id: "e".repeat(32) },
  ];
  const nextEpisodes = [
    { ...episode(episodeIds[1]), SeriesId: nextSeries[0].Id },
    { ...episode(episodeIds[2]), SeriesId: nextSeries[1].Id },
  ];
  const result = await store.refresh(
    "server",
    auth,
    fetcher(nextEpisodes, [episodeIds[0]], userId, nextSeries),
  );
  expect(result.identityLinks?.[seriesId]).toBeUndefined();
  expect(result.identityLinks?.[episodeIds[0]]).toBeUndefined();
  expect(result.records.find((entry) => entry.id === original.records[0].id)?.itemId).toBe(
    episodeIds[0],
  );
  expect(result.confirmations?.[0]?.itemId).toBe(episodeIds[0]);
  expect(result.backfill[0]?.itemId).toBe(episodeIds[0]);
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
    const url = new URL(input instanceof Request ? input.url : input.toString());
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
  expect(result.identityConflicts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        fromItemId: episodeIds[0],
        toItemId: episodeIds[1],
        reason: "同名作品缺少可靠身份，请人工核对",
      }),
    ]),
  );
  const repeated = await store.refresh(
    "server",
    auth,
    fetcher([movie(episodeIds[1], 2020)], [episodeIds[0]]),
  );
  expect(
    repeated.identityConflicts?.filter(
      (entry) =>
        entry.fromItemId === episodeIds[0] &&
        entry.toItemId === episodeIds[1] &&
        entry.reason === "同名作品缺少可靠身份，请人工核对",
    ),
  ).toHaveLength(1);
});

it("keeps season zero specials separate from a numbered-season episode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-refresh-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
  const special = { ...episode(episodeIds[0]), ProviderIds: { Tvdb: "same-episode" } };
  special.ParentIndexNumber = 0;
  await store.refresh("server", auth, fetcher([special], [episodeIds[0]]));
  const regular = { ...episode(episodeIds[1]), ProviderIds: { Tvdb: "same-episode" } };
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
    if (
      !new URL(input instanceof Request ? input.url : input.toString()).pathname.endsWith(
        "/submit_custom_query",
      )
    )
      return response;
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
    if (
      new URL(input instanceof Request ? input.url : input.toString()).pathname.endsWith(
        "/submit_custom_query",
      )
    ) {
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
