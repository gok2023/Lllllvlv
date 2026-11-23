import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WatchStatisticsStore } from "../../../electron/core/watch-statistics";
import { playbackActivityColumns } from "../../../electron/core/watch-statistics-playback-reporting";

const uid = "a".repeat(32);
const ids = Object.fromEntries(
  ["library", "movie", "series", "episode", "special", "season2", "theater", "replacement"].map(
    (name, index) => [name, String(index + 1).repeat(32)],
  ),
);
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("grows an empty archive through playback, new seasons, remapping and restored playback", async () => {
  vi.stubEnv("TZ", "UTC");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
  const directory = await mkdtemp(join(tmpdir(), "freebo-watch-growth-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const auth = { baseUrl: "http://localhost:12345", userId: uid, token: "synthetic" };
  let reportUserId = uid;
  const media: Array<Record<string, unknown>> = [];
  const events: Array<[string, string, string, number, string?]> = [];
  const fetcher: typeof fetch = (async (input, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe('MediaBrowser Token="synthetic"');
    expect(init?.cache).toBe("no-store");
    const url = new URL(input instanceof Request ? input.url : input.toString());
    let body: unknown;
    if (url.pathname.endsWith("/Views")) body = { Items: [{ Id: ids.library, Name: "动漫库" }] };
    else if (url.pathname.endsWith("/submit_custom_query"))
      body = {
        colums: [...playbackActivityColumns],
        results: events.map(([date, id, type, seconds, device]) => [
          date,
          reportUserId,
          id,
          type,
          "播放",
          seconds,
          "client",
          device || "device",
          "DirectPlay",
        ]),
      };
    else if (url.pathname.endsWith("/Items")) {
      const requested = url.searchParams.get("Ids")?.split(",");
      const parent = url.searchParams.get("ParentId");
      const found = media.filter((item) =>
        requested
          ? requested.includes(String(item.Id))
          : parent
            ? item.ParentId === parent || item.SeriesId === parent
            : true,
      );
      body = { Items: found, TotalRecordCount: found.length };
    } else throw new Error(url.pathname);
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
  const item = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
    Id: id,
    Type: type,
    Name: type,
    RunTimeTicks: 60_000_000_000,
    UserData: { Played: false },
    ParentId: ids.library,
    ...extra,
  });
  const empty = await store.refresh("old", auth, fetcher);
  expect(empty.records).toHaveLength(0);
  media.push(item(ids.movie, "Movie"));
  media.push(item(ids.series, "Series", { ProviderIds: { Tmdb: "show-1" } }));
  media.push(
    item(ids.episode, "Episode", { SeriesId: ids.series, ParentIndexNumber: 1, IndexNumber: 1 }),
  );
  vi.setSystemTime(new Date("2026-11-24T13:00:00Z"));
  const discovered = await store.refresh("old", auth, fetcher, "incremental");
  expect(discovered.media.map((entry) => entry.id)).toContain(ids.episode);
  events.push(["2026-11-20 10:00:00", ids.movie, "Movie", 120]);
  const short = await store.refresh("old", auth, fetcher, "incremental");
  expect(short.records.map((entry) => entry.durationSec)).toEqual([120]);
  expect(short.confirmations?.filter((entry) => entry.itemId === ids.movie)).toHaveLength(0);
  (media[0].UserData as { Played: boolean }).Played = true;
  vi.setSystemTime(new Date("2026-11-25T14:00:00Z"));
  const played = await store.refresh("old", auth, fetcher, "incremental");
  expect(played.records).toHaveLength(1);
  expect(played.confirmations?.some((entry) => entry.itemId === ids.movie)).toBe(true);
  const recordId = played.records[0].id;
  const confirmationId = played.confirmations?.find((entry) => entry.itemId === ids.movie)?.id;
  expect(played.backfill.find((entry) => entry.itemId === ids.movie)?.durationSec).toBe(6000);
  expect(played.backfill.find((entry) => entry.itemId === ids.movie)?.baselineRecordIds).toContain(
    recordId,
  );
  (media[0].UserData as { Played: boolean }).Played = false;
  const unchecked = await store.refresh("old", auth, fetcher);
  expect(unchecked.confirmations?.find((entry) => entry.id === confirmationId)).toBeDefined();
  expect(unchecked.backfill.find((entry) => entry.itemId === ids.movie)?.durationSec).toBe(6000);
  (media[0].UserData as { Played: boolean }).Played = true;
  const rechecked = await store.refresh("old", auth, fetcher);
  expect(rechecked.confirmations?.filter((entry) => entry.itemId === ids.movie)).toHaveLength(1);
  expect(rechecked.backfill.filter((entry) => entry.itemId === ids.movie)).toHaveLength(1);
  media.push(
    item(ids.special, "Episode", { SeriesId: ids.series, ParentIndexNumber: 0, IndexNumber: 1 }),
  );
  media.push(
    item(ids.season2, "Episode", { SeriesId: ids.series, ParentIndexNumber: 2, IndexNumber: 1 }),
  );
  media.push(item(ids.theater, "Movie", { ProviderIds: { Tmdb: "theater-1" } }));
  vi.setSystemTime(new Date("2026-11-26T15:00:00Z"));
  const expanded = await store.refresh("old", auth, fetcher, "incremental");
  expect(expanded.media.map((entry) => entry.id)).toEqual(
    expect.arrayContaining([ids.special, ids.season2, ids.theater]),
  );
  expect(expanded.media.find((entry) => entry.id === ids.special)?.seasonNumber).toBe(0);
  expect(expanded.media.find((entry) => entry.id === ids.season2)?.seasonNumber).toBe(2);
  for (const id of [ids.special, ids.season2, ids.theater])
    expect(expanded.media.find((entry) => entry.id === id)?.libraryName).toBe("动漫库");
  events.push(["2026-11-26 11:00:00", ids.theater, "Movie", 5400]);
  (media.find((entry) => entry.Id === ids.theater)!.UserData as { Played: boolean }).Played = true;
  const threshold = await store.refresh("old", auth, fetcher);
  expect(threshold.backfill.some((entry) => entry.itemId === ids.theater)).toBe(false);
  media[0].Name = "新片名";
  media[0].Genres = ["剧情"];
  media[0].ProviderIds = { Tmdb: "film-1" };
  const enriched = await store.refresh("old", auth, fetcher);
  expect(enriched.media.find((entry) => entry.id === ids.movie)?.name).toBe("新片名");
  expect(enriched.records.some((entry) => entry.id === recordId)).toBe(true);
  media.splice(
    0,
    1,
    item(ids.replacement, "Movie", {
      Name: "新片名",
      ProviderIds: { Tmdb: "film-1" },
      Genres: ["剧情"],
      UserData: { Played: true },
    }),
  );
  const remapped = await store.refresh("old", auth, fetcher);
  expect(remapped.records.find((entry) => entry.id === recordId)?.itemId).toBe(ids.replacement);
  expect(remapped.confirmations?.find((entry) => entry.id === confirmationId)?.itemId).toBe(
    ids.replacement,
  );
  const archive = join(directory, "growth.json");
  await store.exportData("old", uid, archive);
  const newUser = "d".repeat(32);
  const restored = await store.importData("new", newUser, archive);
  expect(restored.records.some((entry) => entry.id === recordId)).toBe(true);
  reportUserId = newUser;
  events.splice(0, events.length, [
    "2026-11-27 10:00:00",
    ids.replacement,
    "Movie",
    700,
    "new-device",
  ]);
  vi.setSystemTime(new Date("2026-11-28T12:00:00Z"));
  const targetAuth = { ...auth, userId: newUser };
  const continued = await store.refresh("new", targetAuth, fetcher);
  const repeated = await store.refresh("new", targetAuth, fetcher, "incremental");
  expect(continued.records).toHaveLength(3);
  expect(repeated.records.map((entry) => entry.id)).toEqual(
    continued.records.map((entry) => entry.id),
  );
  expect(repeated.confirmations?.find((entry) => entry.id === confirmationId)).toBeDefined();
  expect(repeated.records.reduce((sum, entry) => sum + entry.durationSec, 0)).toBe(6220);
  expect(repeated.backfill.find((entry) => entry.itemId === ids.replacement)?.durationSec).toBe(
    6000,
  );
  expect(
    repeated.backfill.find((entry) => entry.itemId === ids.replacement)?.baselineRecordIds,
  ).toContain(recordId);
  expect(repeated.records.find((entry) => entry.deviceName === "new-device")?.durationSec).toBe(
    700,
  );
  expect(repeated.candidates?.some((entry) => entry.itemId === ids.replacement)).toBe(true);
});
