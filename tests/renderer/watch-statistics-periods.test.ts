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
