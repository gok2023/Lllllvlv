import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WatchStatisticsStore } from "../../../electron/core/watch-statistics";
import { playbackActivityColumns } from "../../../electron/core/watch-statistics-playback-reporting";

const id = (digit: string) => digit.repeat(32);

it("backfills a newly marked movie and episode once, then keeps them through rename, replacement and playback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-manual-played-"));
  try {
    const store = new WatchStatisticsStore(directory);
    const userId = id("a");
    const libraryId = id("b");
    const movieId = id("1");
    const replacementId = id("2");
    const seriesId = id("3");
    const episodeId = id("4");
    const oldEpisodeId = id("5");
    const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
    const media: Array<Record<string, any>> = [];
    const events: Array<[string, string, number]> = [];
    const fetcher: typeof fetch = (async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      let body: unknown;
      if (url.pathname.endsWith("/Views")) body = { Items: [{ Id: libraryId, Name: "库" }] };
      else if (url.pathname.endsWith("/submit_custom_query"))
        body = {
          colums: [...playbackActivityColumns],
          results: events.map(([date, itemId, duration]) => [
            date,
            userId,
            itemId,
            "Movie",
            "片",
            duration,
            "client",
            "device",
            "DirectPlay",
          ]),
        };
      else if (url.pathname.endsWith("/Items")) {
        const ids = url.searchParams.get("Ids")?.split(",");
        const found = media.filter((item) => !ids || ids.includes(item.Id));
        body = { Items: found, TotalRecordCount: found.length };
      } else throw new Error(url.pathname);
      return { ok: true, json: async () => body } as Response;
    }) as typeof fetch;
    await store.refresh("server", auth, fetcher);
    media.push({
      Id: movieId,
      Type: "Movie",
      Name: "原名",
      ParentId: libraryId,
      RunTimeTicks: 60_000_000_000,
      ProviderIds: { Tmdb: "movie-1" },
      UserData: { Played: true },
    });
    media.push({
      Id: seriesId,
      Type: "Series",
      Name: "剧",
      ParentId: libraryId,
      ProviderIds: { Tmdb: "series-1" },
      UserData: { Played: false },
    });
    media.push({
      Id: episodeId,
      Type: "Episode",
      Name: "第一集",
      SeriesId: seriesId,
      ParentId: seriesId,
      ParentIndexNumber: 1,
      IndexNumber: 1,
      RunTimeTicks: 36_000_000_000,
      UserData: { Played: false },
    });
    media.push({
      Id: oldEpisodeId,
      Type: "Episode",
      Name: "旧集",
      SeriesId: seriesId,
      ParentId: seriesId,
      ParentIndexNumber: 1,
      IndexNumber: 2,
      RunTimeTicks: 36_000_000_000,
      UserData: { Played: true },
    });
    media[0].UserData.Played = false;
    const cancelled = await store.refresh("server", auth, fetcher);
    expect(cancelled.confirmations?.some((entry) => entry.itemId === movieId)).toBe(false);
    const oldEpisodeConfirmation = cancelled.confirmations?.find(
      (entry) => entry.itemId === oldEpisodeId,
    )?.id;
    expect(oldEpisodeConfirmation).toBeDefined();
    media[0].UserData.Played = true;
    media[2].UserData.Played = true;
    const first = await store.refresh("server", auth, fetcher);
    expect(first.confirmations?.map((entry) => entry.itemId)).toEqual(
      expect.arrayContaining([movieId, episodeId]),
    );
    expect(first.backfill.map((entry) => [entry.itemId, entry.durationSec])).toEqual(
      expect.arrayContaining([
        [movieId, 6000],
        [episodeId, 3600],
      ]),
    );
    const firstIds = first.confirmations?.map((entry) => entry.id);
    expect(first.confirmations?.find((entry) => entry.itemId === oldEpisodeId)?.id).toBe(
      oldEpisodeConfirmation,
    );
    const incremental = await store.refresh("server", auth, fetcher, "incremental");
    expect(incremental.confirmations?.map((entry) => entry.id)).toEqual(firstIds);
    const repeated = await store.refresh("server", auth, fetcher);
    expect(repeated.confirmations?.map((entry) => entry.id)).toEqual(firstIds);
    const incrementalAgain = await store.refresh("server", auth, fetcher, "incremental");
    expect(incrementalAgain.confirmations?.map((entry) => entry.id)).toEqual(firstIds);
    media[0].Name = "新名";
    const renamed = await store.refresh("server", auth, fetcher);
    expect(renamed.media.find((entry) => entry.id === movieId)?.name).toBe("新名");
    media[0].Id = replacementId;
    events.push(["2026-11-23 12:00:00", replacementId, 700]);
    const continued = await store.refresh("server", auth, fetcher);
    expect(continued.records.find((entry) => entry.itemId === replacementId)?.durationSec).toBe(
      700,
    );
    expect(continued.confirmations?.some((entry) => entry.itemId === replacementId)).toBe(true);
    expect(continued.backfill.find((entry) => entry.itemId === replacementId)?.durationSec).toBe(
      6000,
    );
    expect(continued.confirmations?.length).toBe(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("finds existing and new played movies hidden by Jellyfin's default box-set collapse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-box-set-"));
  try {
    const store = new WatchStatisticsStore(directory);
    const userId = id("a");
    const libraryId = id("b");
    const existingId = id("1");
    const newId = id("2");
    const auth = { baseUrl: "http://localhost:12345", userId, token: "synthetic" };
    let includeNew = false;
    let existingPlayed = false;
    const fetcher: typeof fetch = (async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      let body: unknown;
      if (url.pathname.endsWith("/Views")) body = { Items: [{ Id: libraryId, Name: "库" }] };
      else if (url.pathname.endsWith("/submit_custom_query"))
        body = { colums: [...playbackActivityColumns], results: [] };
      else if (url.pathname.endsWith("/Items")) {
        const movie = (movieId: string, played: boolean) => ({
          Id: movieId, Type: "Movie", Name: movieId, ParentId: libraryId,
          RunTimeTicks: 60_000_000_000, UserData: { Played: played },
        });
        const items = [movie(existingId, existingPlayed), ...(includeNew ? [movie(newId, true)] : [])];
        const visible = url.searchParams.get("CollapseBoxSetItems") === "false" ? items : [];
        body = { Items: visible, TotalRecordCount: visible.length };
      } else throw new Error(url.pathname);
      return { ok: true, json: async () => body } as Response;
    }) as typeof fetch;
    const initial = await store.refresh("server", auth, fetcher);
    expect(initial.media.map((item) => item.id)).toContain(existingId);
    existingPlayed = true;
    includeNew = true;
    const refreshed = await store.refresh("server", auth, fetcher);
    expect(refreshed.media.filter((item) => [existingId, newId].includes(item.id)).map((item) => item.played))
      .toEqual([true, true]);
    expect(refreshed.confirmations?.map((entry) => entry.itemId)).toEqual(
      expect.arrayContaining([existingId, newId]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
