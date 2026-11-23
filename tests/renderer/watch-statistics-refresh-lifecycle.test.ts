import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

const source = readFileSync(resolve("web/watch-statistics.js"), "utf8");
const start = source.indexOf("  async function load(refresh = false) {");
const end = source.indexOf("  async function save() {", start);
if (start < 0 || end < 0) throw new Error("Statistics refresh handler missing");
const loadSource = source.slice(start, end);

function harness(refreshWatchStatistics: () => Promise<void>) {
  const elements = new Map<string, { disabled: boolean; textContent: string }>();
  const $ = (id: string) => {
    if (!elements.has(id)) elements.set(id, { disabled: false, textContent: "" });
    return elements.get(id)!;
  };
  const applySnapshot = vi.fn();
  const api = {
    refreshWatchStatistics,
    getWatchStatistics: vi.fn(async () => ({ refreshedAt: "2026-11-23T12:00:00Z" })),
  };
  const load = runInNewContext(`${loadSource}\nload`, {
    $,
    api,
    state: { snapshot: null },
    applySnapshot,
    dateLabel: () => "today",
  }) as (refresh?: boolean) => Promise<void>;
  return { $, api, applySnapshot, load };
}

it("keeps manual refresh busy until full sync resolves, then reads the committed archive", async () => {
  let complete!: () => void;
  const { $, api, applySnapshot, load } = harness(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const operation = load(true);
  expect($("refreshBtn").disabled).toBe(true);
  expect(api.getWatchStatistics).not.toHaveBeenCalled();
  complete();
  await operation;
  expect(api.getWatchStatistics).toHaveBeenCalledOnce();
  expect(applySnapshot).toHaveBeenCalledOnce();
  expect($("refreshBtn").disabled).toBe(false);
  expect($("refreshStatus").textContent).toContain("刷新完成");
});

it("shows the full sync failure and leaves the prior archive available", async () => {
  const { $, api, load } = harness(async () => {
    throw new Error("Jellyfin 媒体请求失败");
  });
  await load(true);
  expect(api.getWatchStatistics).not.toHaveBeenCalled();
  expect($("refreshStatus").textContent).toContain("Jellyfin 媒体请求失败");
  expect($("refreshBtn").disabled).toBe(false);
});

it("does not report refresh success when the current user has no readable archive", async () => {
  const { $, api, applySnapshot, load } = harness(async () => {});
  api.getWatchStatistics.mockResolvedValueOnce(null as never);
  await load(true);
  expect(applySnapshot).not.toHaveBeenCalled();
  expect($("refreshStatus").textContent).toContain("暂无可读取的观影统计数据");
  expect($("refreshStatus").textContent).not.toContain("刷新完成");
  expect($("refreshBtn").disabled).toBe(false);
});
