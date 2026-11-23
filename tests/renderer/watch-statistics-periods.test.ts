import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve("web/watch-statistics.js"), "utf8");

function block(start: string, next: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(next, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Web statistics function missing: ${start}`);
  return source.slice(from, to);
}

function page(period: string, customDays = 3) {
  class FixedDate extends Date {
    constructor(...args: Array<number | string | Date>) {
      if (args.length === 0) super(2026, 10, 16, 12);
      else if (args[0] instanceof Date) super(args[0].getTime());
      else if (typeof args[0] === "string") super(Date.parse(args[0]));
      else if (args.length === 1) super(args[0] as number);
      else
        super(
          args[0] as number,
          (args[1] as number) ?? 0,
          args[2] as number,
          args[3] as number,
          args[4] as number,
          args[5] as number,
          args[6] as number,
        );
    }
  }
  const state = {
    period,
    customDays,
    focus: null,
    excludeShort: false,
    snapshot: {
      media: [{ id: "film", type: "Movie", name: "Film", genres: [], directors: [] }],
      records: [
        {
          id: "old",
          itemId: "film",
          itemType: "Movie",
          startAt: "2026-10-01T10:00:00.000Z",
          durationSec: 600,
        },
        {
          id: "boundary",
          itemId: "film",
          itemType: "Movie",
          startAt: new Date(2026, 10, 9, 23, 50).toISOString(),
          durationSec: 1200,
        },
        {
          id: "recent",
          itemId: "film",
          itemType: "Movie",
          startAt: "2026-11-15T10:00:00.000Z",
          durationSec: 600,
        },
        {
          id: "future",
          itemId: "film",
          itemType: "Movie",
          startAt: "2026-11-17T10:00:00.000Z",
          durationSec: 600,
        },
      ],
      backfill: [{ itemId: "film", durationSec: 3600 }],
      confirmations: [
        { id: "confirm", itemId: "film" },
        { id: "repeat", itemId: "film" },
      ],
    },
  };
  const values: Record<string, number> = {};
  const elements = new Map<string, { textContent: string }>();
  const context = {
    state,
    Date: FixedDate,
    Map,
    Set,
    Math,
    Number,
    String,
    window: { FreeboStatisticsNames: {} },
    nameKey: (value: string) => value,
    num: (value: unknown) => Number(value) || 0,
    valid: (value: unknown) => Math.max(0, Number(value) || 0),
    animate: (key: string, value: number) => {
      values[key] = value;
    },
    renderBreakdown: () => {},
    hours: (value: number) => String(value),
    duration: (value: number) => String(value),
    $: (key: string) => {
      if (!elements.has(key)) elements.set(key, { textContent: "" });
      return elements.get(key);
    },
  };
  const code = [
    block("  function normalizeNames", "  const now = ()"),
    block("  const now = ()", "  function group"),
    block("  function renderOverview", "  function renderCalendar"),
    "mediaMapCache = mediaMap(); return { bounds, selectedRecords, selectedBackfill, renderOverview };",
  ].join("\n");
  const api = runInNewContext(`(() => { ${code} })()`, context) as {
    bounds: () => [Date | null, Date];
    selectedRecords: () => Array<{ id: string; clippedSeconds: number }>;
    selectedBackfill: () => Array<{ clippedSeconds: number }>;
    renderOverview: (
      records: unknown[],
      combined: unknown[],
      parts: unknown,
      activities: unknown[],
    ) => void;
  };
  return { state, values, elements, ...api };
}

describe("web statistics periods", () => {
  it("reconciles cross-midnight activities, habits, corrections and distributions", () => {
    const previousZone = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const state = {
        gap: 15,
        snapshot: {
          libraries: [
            { id: "corrected", name: "修正库" },
            { id: "rule", name: "作品库" },
          ],
          corrections: { records: { a: "corrected" }, items: { film: "rule" } },
        },
      };
      const code = [
        'const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;',
        block("  const mediaMap =", "  const rawRecords ="),
        block("  function slices", "  function animate"),
        block("  function aggregate", "  function pageControls"),
        block("    const directorTotals = new Map();", "    const metric = state.directorMetric;"),
        "return { effectiveLibrary, slices, groups, aggregate, directorTotals };",
      ].join("\n");
      const records = [
        {
          id: "a",
          itemId: "film",
          type: "Movie",
          name: "甲",
          year: 1999,
          genres: ["剧情"],
          directors: ["王"],
          deviceName: "电视",
          userId: "u",
          start: new Date("2026-11-16T23:50:00Z"),
          seconds: 1200,
          clippedStart: new Date("2026-11-16T23:50:00Z"),
          clippedEnd: new Date("2026-11-17T00:10:00Z"),
          clippedSeconds: 1200,
        },
        {
          id: "b",
          itemId: "film",
          type: "Movie",
          name: "甲",
          year: 1999,
          genres: ["剧情"],
          directors: ["王"],
          deviceName: "电视",
          userId: "u",
          start: new Date("2026-11-17T00:20:00Z"),
          seconds: 600,
          clippedStart: new Date("2026-11-17T00:20:00Z"),
          clippedEnd: new Date("2026-11-17T00:30:00Z"),
          clippedSeconds: 600,
        },
        {
          id: "c",
          itemId: "episode",
          type: "Episode",
          name: "乙",
          year: 2020,
          genres: ["动画"],
          directors: ["李"],
          deviceName: "电脑",
          userId: "u",
          start: new Date("2026-11-17T01:00:00Z"),
          seconds: 600,
          clippedStart: new Date("2026-11-17T01:00:00Z"),
          clippedEnd: new Date("2026-11-17T01:10:00Z"),
          clippedSeconds: 600,
        },
      ];
      const result = runInNewContext(`(() => { ${code} })()`, {
        state,
        combined: records,
        Date,
        Map,
        Set,
        Array,
        Math,
        String,
      }) as any;
      const parts = result.slices(records);
      expect([parts.daily.get("2026-11-16"), parts.daily.get("2026-11-17")]).toEqual([600, 1800]);
      expect([parts.hourly[23], parts.hourly[0], parts.hourly[1]]).toEqual([600, 1200, 600]);
      expect([parts.weekday[0], parts.weekday[1]]).toEqual([600, 1800]);
      expect(result.groups(records).map((group: { total: number }) => group.total)).toEqual([
        600, 1800,
      ]);
      expect([...result.aggregate(records, (r: (typeof records)[number]) => r.deviceName)]).toEqual(
        [
          ["电视", 1800],
          ["电脑", 600],
        ],
      );
      expect(result.effectiveLibrary(records[0], { libraryName: "原库" })).toBe("修正库");
      expect(result.effectiveLibrary(records[1], { libraryName: "原库" })).toBe("作品库");
      expect(result.effectiveLibrary(records[2], { libraryName: "原库" })).toBe("原库");
      expect([
        ...result.aggregate(
          records,
          (r: (typeof records)[number]) => `${Math.floor(r.year / 10) * 10} 年代`,
        ),
      ]).toEqual([
        ["1990 年代", 1800],
        ["2020 年代", 600],
      ]);
      expect([
        ...result.aggregate(records, (r: (typeof records)[number]) => r.genres, true),
      ]).toEqual([
        ["剧情", 1800],
        ["动画", 600],
      ]);
      expect(result.directorTotals.get("王").seconds).toBe(1800);
      expect(result.directorTotals.get("王").mediaIds.size).toBe(1);
    } finally {
      if (previousZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousZone;
    }
  });

  it("allocates repeated and skipped DST hours without losing playback time", () => {
    const previousZone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const slices = runInNewContext(
        `(() => { const dayKey = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"); ${block("  function slices", "  function groups")} return slices; })()`,
        { Date, Map, Array, Math },
      ) as (records: Array<{ clippedStart: Date; clippedEnd: Date; clippedSeconds: number }>) => {
        daily: Map<string, number>;
        hourly: number[];
        weekday: number[];
        total: number;
      };
      const segment = (start: string, end: string) => ({
        clippedStart: new Date(start),
        clippedEnd: new Date(end),
        clippedSeconds: (Date.parse(end) - Date.parse(start)) / 1000,
      });
      const fall = slices([segment("2026-11-01T05:30:00Z", "2026-11-01T07:30:00Z")]);
      expect(fall.hourly[1]).toBe(5400);
      expect(fall.hourly[2]).toBe(1800);
      expect(fall.daily.get("2026-11-01")).toBe(7200);
      const spring = slices([segment("2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z")]);
      expect(spring.hourly[1]).toBe(1800);
      expect(spring.hourly[2]).toBe(0);
      expect(spring.hourly[3]).toBe(1800);
      expect(spring.daily.get("2026-03-08")).toBe(3600);
    } finally {
      if (previousZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousZone;
    }
  });

  it.each([
    ["all", ["old", "boundary", "recent"], 1],
    ["year", ["old", "boundary", "recent"], 0],
    ["d30", ["boundary", "recent"], 0],
    ["d7", ["boundary", "recent"], 0],
    ["custom", ["recent"], 0],
  ])("uses actual page functions for %s", (period, ids, estimates) => {
    const app = page(period as string);
    const records = app.selectedRecords();
    expect(records.map((record) => record.id)).toEqual(ids);
    expect(app.selectedBackfill()).toHaveLength(estimates as number);
    const combined = [...records, ...app.selectedBackfill()];
    app.renderOverview(records, combined, { daily: new Map() }, []);
    expect(app.values.moviesCount).toBe(period === "all" ? 2 : 1);
    expect(app.values.totalHours).toBeCloseTo(
      combined.reduce((sum, item) => sum + item.clippedSeconds, 0) / 3600,
    );
  });

  it("clips playback at the recent range and current time", () => {
    const app = page("d7");
    const boundary = app.selectedRecords().find((record) => record.id === "boundary");
    expect(boundary?.clippedSeconds).toBeGreaterThan(0);
    expect(boundary?.clippedSeconds).toBeLessThan(1200);
    expect(app.selectedRecords().some((record) => record.id === "future")).toBe(false);
  });
});
