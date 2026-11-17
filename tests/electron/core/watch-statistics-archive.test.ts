import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { WatchStatisticsStore } from "../../../electron/core/watch-statistics";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("exports a checked archive, rejects corruption and preserves the current snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-archive-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const serverId = "server";
  const userId = "0123456789abcdef0123456789abcdef";
  const snapshotPath = join(directory, "watch-statistics", `${serverId}-${userId}.json`);
  const snapshot = {
    serverId,
    refreshedAt: "2026-11-16T00:00:00.000Z",
    media: [],
    records: [],
    backfill: [],
    settings: { gapMinutes: 15, includeBackfill: true, excludeShort: false },
    corrections: { records: { one: "library" }, items: {} },
    confirmations: [],
    revokedConfirmationIds: ["removed"],
  };
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(directory, "watch-statistics")));
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  const archivePath = join(directory, "archive.json");
  await store.exportData(serverId, userId, archivePath);
  const archive = JSON.parse(await readFile(archivePath, "utf8"));
  expect(archive.version).toBe(3);
  expect(archive.snapshot.corrections.records.one).toBe("library");
  expect(archive.snapshot.revokedConfirmationIds).toEqual(["removed"]);
  const rawBackup = join(directory, "previous.backup");
  await writeFile(rawBackup, JSON.stringify(snapshot));
  expect((await store.previewImport(rawBackup)).version).toBe(2);
  await store.importData(serverId, userId, rawBackup);
  expect((await store.get(serverId, userId))?.corrections?.records.one).toBe("library");
  const beforeCorruption = JSON.parse(await readFile(snapshotPath, "utf8"));
  archive.snapshot.records.push({ id: "corrupt" });
  await writeFile(archivePath, JSON.stringify(archive));
  await expect(store.previewImport(archivePath)).rejects.toThrow("完整性");
  await expect(store.importData(serverId, userId, archivePath)).rejects.toThrow("完整性");
  expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toEqual(beforeCorruption);
});

it("restores the prior snapshot when the replacement write fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-archive-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const userId = "0123456789abcdef0123456789abcdef";
  const snapshot = {
    serverId: "same",
    refreshedAt: "2026-11-16T00:00:00.000Z",
    media: [],
    records: [],
    backfill: [],
    settings: { gapMinutes: 15, includeBackfill: true, excludeShort: false },
  };
  const archivePath = join(directory, "archive.json");
  await writeFile(archivePath, JSON.stringify({ version: 2, snapshot }));
  await store.importData("same", userId, archivePath);
  const before = await store.get("same", userId);
  const spy = vi
    .spyOn(
      store as unknown as { atomicWrite: (path: string, data: string) => Promise<void> },
      "atomicWrite",
    )
    .mockRejectedValueOnce(new Error("injected write failure"));
  await expect(store.importData("same", userId, archivePath)).rejects.toThrow(
    "injected write failure",
  );
  spy.mockRestore();
  expect(await store.get("same", userId)).toEqual(before);
});

it("does not accept a string version that bypasses the v3 checksum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-archive-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const archivePath = join(directory, "archive.json");
  await writeFile(archivePath, JSON.stringify({ version: "3", snapshot: {} }));
  await expect(store.previewImport(archivePath)).rejects.toThrow("版本");
});

it("restores a foreign server with isolated media IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-archive-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const archivePath = join(directory, "old.json");
  const snapshot = {
    serverId: "old",
    refreshedAt: "2026-11-16T00:00:00.000Z",
    media: [
      {
        id: "movie",
        name: "Film",
        type: "Movie",
        genres: [],
        directors: [],
        played: true,
        playCount: 1,
      },
    ],
    records: [],
    backfill: [],
    settings: { gapMinutes: 15, includeBackfill: true, excludeShort: false },
    confirmations: [{ id: "confirmation", itemId: "movie", source: "initial", evidenceIds: [] }],
  };
  await writeFile(archivePath, JSON.stringify({ version: 2, snapshot }));
  const restored = await store.importData("new", "0123456789abcdef0123456789abcdef", archivePath);
  expect(restored.media[0].id).toBe("legacy:old:movie");
  expect(restored.media[0].sourceId).toBe("old");
  expect(restored.confirmations?.[0].itemId).toBe("legacy:old:movie");
});

it("merges repeated archives once and rejects conflicting backfill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-archive-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const userId = "0123456789abcdef0123456789abcdef";
  const archivePath = join(directory, "archive.json");
  const snapshot = {
    serverId: "same",
    refreshedAt: "2026-11-16T00:00:00.000Z",
    media: [],
    records: [],
    backfill: [{ itemId: "one", durationSec: 300 }],
    settings: { gapMinutes: 15, includeBackfill: true, excludeShort: false },
    confirmations: [],
    revokedConfirmationIds: ["revoked"],
  };
  await writeFile(archivePath, JSON.stringify({ version: 2, snapshot }));
  await store.importData("same", userId, archivePath);
  const repeated = await store.importData("same", userId, archivePath, "merge");
  expect(repeated.backfill).toHaveLength(1);
  expect(repeated.revokedConfirmationIds).toEqual(["revoked"]);
  snapshot.backfill[0].durationSec = 600;
  await writeFile(archivePath, JSON.stringify({ version: 2, snapshot }));
  await expect(store.importData("same", userId, archivePath, "merge")).rejects.toThrow("合并冲突");
  expect((await store.get("same", userId))?.backfill[0].durationSec).toBe(300);
});

it("rejects corrupt local data instead of treating it as a first run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-archive-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const userId = "0123456789abcdef0123456789abcdef";
  const folder = join(directory, "watch-statistics");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(folder));
  await writeFile(join(folder, `same-${userId}.json`), "{broken");
  await expect(store.get("same", userId)).rejects.toThrow();
});

it("links restored history to a current item immediately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-archive-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const userId = "0123456789abcdef0123456789abcdef";
  const folder = join(directory, "watch-statistics");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(folder));
  const media = (id: string, sourceId: string) => ({
    id,
    sourceId,
    name: "Film",
    type: "Movie",
    genres: [],
    directors: [],
    played: true,
    playCount: 1,
  });
  await writeFile(
    join(folder, `new-${userId}.json`),
    JSON.stringify({
      serverId: "new",
      refreshedAt: "2026-11-16T00:00:00.000Z",
      media: [media("legacy:old:movie", "old"), media("newmovie", "new")],
      records: [],
      backfill: [{ itemId: "legacy:old:movie", durationSec: 300 }],
      confirmations: [
        { id: "once", itemId: "legacy:old:movie", source: "initial", evidenceIds: [] },
      ],
      settings: { gapMinutes: 15, includeBackfill: true, excludeShort: false },
    }),
  );
  const linked = await store.linkWatchMedia("new", userId, "legacy:old:movie", "newmovie");
  expect(linked.confirmations?.[0].itemId).toBe("newmovie");
  expect(linked.backfill[0].itemId).toBe("newmovie");
  expect(linked.identityLinks?.["legacy:old:movie"]).toBe("newmovie");
});

it("merges a foreign archive with one unique match and independent items on both sides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-archive-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const userId = "0123456789abcdef0123456789abcdef";
  const media = (id: string, tmdb: string) => ({
    id,
    name: id,
    type: "Movie",
    genres: [],
    directors: [],
    played: false,
    playCount: 0,
    providerIds: { Tmdb: tmdb },
  });
  const base = {
    refreshedAt: "2026-11-16T00:00:00.000Z",
    records: [],
    backfill: [],
    settings: { gapMinutes: 15, includeBackfill: true, excludeShort: false },
  };
  const targetPath = join(directory, "target.json");
  const sourcePath = join(directory, "source.json");
  await writeFile(
    targetPath,
    JSON.stringify({
      version: 2,
      snapshot: {
        ...base,
        serverId: "target",
        media: [media("shared-new", "1"), media("target-only", "3")],
      },
    }),
  );
  await writeFile(
    sourcePath,
    JSON.stringify({
      version: 2,
      snapshot: {
        ...base,
        serverId: "source",
        media: [media("shared-old", "1"), media("source-only", "2")],
      },
    }),
  );
  await store.importData("target", userId, targetPath);
  const preview = await store.previewImport(sourcePath, "target", userId);
  expect(preview.conflicts).toBe(0);
  expect(preview.linked).toBe(1);
  expect(preview.unlinked).toBe(1);
  const merged = await store.importData("target", userId, sourcePath, "merge");
  expect(merged.identityLinks?.["legacy:source:shared-old"]).toBe("shared-new");
  expect(merged.media.map((item) => item.id)).toEqual(
    expect.arrayContaining([
      "shared-new",
      "target-only",
      "legacy:source:shared-old",
      "legacy:source:source-only",
    ]),
  );
  const repeated = await store.importData("target", userId, sourcePath, "merge");
  expect(repeated.media).toHaveLength(4);
});

it("roundtrips all user assets in v2 and v3 archives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-archive-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const userId = "0123456789abcdef0123456789abcdef";
  const folder = join(directory, "watch-statistics");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(folder));
  const snapshot = {
    serverId: "same",
    refreshedAt: "2026-11-16T00:00:00.000Z",
    media: [],
    records: [],
    backfill: [{ itemId: "old", durationSec: 100, baselineRecordIds: ["r"] }],
    settings: { gapMinutes: 22, includeBackfill: false, excludeShort: true, rewatchMinutes: 30 },
    cursor: "2026-11-16T00:00:00.000Z",
    libraries: [{ id: "lib", name: "Movies" }],
    confirmations: [
      { id: "c", itemId: "old", source: "manual", evidenceIds: ["r"], estimatedDurationSec: 50 },
    ],
    candidates: [{ itemId: "next", evidenceIds: [], status: "later" }],
    appliedReviewIds: ["op"],
    revokedConfirmationIds: ["removed"],
    corrections: { records: { r: "lib" }, items: { old: "lib" } },
    identityLinks: { old: "next" },
  };
  await writeFile(join(folder, `same-${userId}.json`), JSON.stringify(snapshot));
  const archivePath = join(directory, "complete.json");
  await store.exportData("same", userId, archivePath);
  const restored = await store.importData("same", userId, archivePath);
  expect(restored.backfill).toEqual(snapshot.backfill);
  expect(restored.confirmations).toEqual(snapshot.confirmations);
  expect(restored.candidates).toEqual(snapshot.candidates);
  expect(restored.appliedReviewIds).toEqual(snapshot.appliedReviewIds);
  expect(restored.revokedConfirmationIds).toEqual(snapshot.revokedConfirmationIds);
  expect(restored.corrections).toEqual(snapshot.corrections);
  expect(restored.identityLinks).toEqual(snapshot.identityLinks);
  expect(restored.settings).toEqual(snapshot.settings);
  expect(restored.libraries).toEqual(snapshot.libraries);
  const v2Path = join(directory, "complete-v2.json");
  await writeFile(v2Path, JSON.stringify({ version: 2, snapshot }));
  expect((await store.previewImport(v2Path)).version).toBe(2);
  const restoredV2 = await store.importData("same", userId, v2Path);
  for (const key of [
    "backfill",
    "confirmations",
    "candidates",
    "appliedReviewIds",
    "revokedConfirmationIds",
    "corrections",
    "identityLinks",
    "settings",
    "libraries",
  ] as const)
    expect(restoredV2[key]).toEqual(snapshot[key]);
});

it("links a foreign episode through a uniquely matched series and season number", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freebo-archive-"));
  directories.push(directory);
  const store = new WatchStatisticsStore(directory);
  const userId = "0123456789abcdef0123456789abcdef";
  const archivePath = join(directory, "source.json");
  const media = (id: string, type: string, extra = {}) => ({
    id,
    name: id,
    type,
    genres: [],
    directors: [],
    played: false,
    playCount: 0,
    ...extra,
  });
  const base = {
    refreshedAt: "2026-11-16T00:00:00.000Z",
    records: [],
    backfill: [],
    settings: { gapMinutes: 15, includeBackfill: true, excludeShort: false },
  };
  await writeFile(
    archivePath,
    JSON.stringify({
      version: 2,
      snapshot: {
        ...base,
        serverId: "target",
        media: [
          media("series-new", "Series", { providerIds: { Tmdb: "10" } }),
          media("episode-new", "Episode", {
            seriesId: "series-new",
            seasonNumber: 1,
            episodeNumber: 2,
          }),
        ],
      },
    }),
  );
  await store.importData("target", userId, archivePath);
  await writeFile(
    archivePath,
    JSON.stringify({
      version: 2,
      snapshot: {
        ...base,
        serverId: "source",
        media: [
          media("series-old", "Series", { providerIds: { tmdb: "10" } }),
          media("episode-old", "Episode", {
            seriesId: "series-old",
            seasonNumber: 1,
            episodeNumber: 2,
          }),
        ],
      },
    }),
  );
  expect((await store.previewImport(archivePath, "target", userId)).linked).toBe(2);
  const merged = await store.importData("target", userId, archivePath, "merge");
  expect(merged.identityLinks?.["legacy:source:episode-old"]).toBe("episode-new");
});
