(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const api = (() => {
    let nextId = 0;
    const pending = new Map();
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || event.data?.channel !== "watch-statistics") return;
      if (event.data.event === "visual-theme") {
        if (event.data.theme !== "elysium" && event.data.theme !== "original") return;
        document.documentElement.dataset.visualTheme = event.data.theme;
        const allowed = {
          contentTint: "--elysium-content",
          controlTint: "--elysium-control",
          foreground: "--elysium-foreground",
          mutedForeground: "--elysium-muted",
        };
        for (const [key, variable] of Object.entries(allowed)) {
          const value = event.data.colors?.[key];
          if (
            event.data.theme === "elysium" &&
            typeof value === "string" &&
            /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)
          )
            document.documentElement.style.setProperty(variable, value);
          else document.documentElement.style.removeProperty(variable);
        }
        return;
      }
      if (event.data.event === "updated") {
        if (event.data.snapshot) applySnapshot(event.data.snapshot, !state.snapshot);
        return;
      }
      if (event.data.event === "status") {
        showSyncStatus(event.data.status || {});
        return;
      }
      if (event.data.event === "recheck") {
        Promise.all([api.getWatchStatistics(), api.getWatchStatisticsStatus()])
          .then(([snapshot, status]) => {
            if (snapshot) applySnapshot(snapshot, !state.snapshot);
            showSyncStatus(status);
          })
          .catch((error) => {
            $("refreshStatus").textContent = `读取统计状态失败：${error?.message || String(error)}`;
          });
        return;
      }
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      clearTimeout(request.timeout);
      if (event.data.error) request.reject(new Error(event.data.error));
      else request.resolve(event.data.result);
    });
    const call = (method, ...args) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        if (window.parent === window) {
          reject(new Error("请在应用内打开统计页面"));
          return;
        }
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error("统计接口响应超时"));
        }, 60000);
        pending.set(id, { resolve, reject, timeout });
        window.parent.postMessage({ channel: "watch-statistics", id, method, args }, "*");
      });
    return {
      getWatchStatistics: () => call("getWatchStatistics"),
      correctWatchLibrary: (input) => call("correctWatchLibrary", input),
      reviewWatchStatistics: (input) => call("reviewWatchStatistics", input),
      previewWatchStatisticsReview: (input) => call("previewWatchStatisticsReview", input),
      refreshWatchStatistics: () => call("refreshWatchStatistics"),
      getWatchStatisticsStatus: () => call("getWatchStatisticsStatus"),
      getWatchStatisticsPathStatus: () => call("getWatchStatisticsPathStatus"),
      autoDiscoverWatchStatisticsPath: () => call("autoDiscoverWatchStatisticsPath"),
      chooseWatchStatisticsPath: () => call("chooseWatchStatisticsPath"),
      saveWatchStatisticsSettings: (settings) => call("saveWatchStatisticsSettings", settings),
      exportWatchStatistics: () => call("exportWatchStatistics"),
      previewWatchStatisticsImport: () => call("previewWatchStatisticsImport"),
      importWatchStatistics: () => call("importWatchStatistics", "replace"),
    };
  })();
  const state = {
    snapshot: null,
    period: "year",
    customDays: 7,
    focus: null,
    seriesMode: "all",
    seriesPage: 1,
    activityPage: 1,
    recordType: "all",
    recordSearch: "",
    gap: 15,
    excludeShort: false,
    rewatchMinutes: 10,
    calendarYear: null,
    directorMetric: "duration",
    genresExpanded: false,
    breakdown: null,
    breakdownPage: { Movie: 1, Episode: 1 },
    breakdownSearch: { Movie: "", Episode: "" },
    watchVisit: { Movie: "all", Episode: "all" },
    watchSeries: null,
    watchSeason: null,
    watchItem: null,
    watchBatch: false,
    watchSelection: new Set(),
    watchOperation: "set",
    watchTarget: 2,
    watchEstimate: false,
    watchPreview: null,
    watchPreviewVersion: 0,
    watchPreviewFilter: "changed",
    watchPreviewPage: 1,
    watchStatus: "",
    candidatePage: 1,
    candidateType: "all",
    candidateVisit: "all",
    candidateSearch: "",
    candidateSelection: new Set(),
  };
  function invalidateWatchPreview() {
    state.watchPreview = null;
    state.watchPreviewVersion++;
    state.watchPreviewPage = 1;
  }
  function watchPreviewSignature(snapshot, ids) {
    const media = new Map((snapshot?.media || []).map((item) => [item.id, item]));
    return JSON.stringify(
      ids.map((id) => ({
        id,
        runtimeSec: media.get(id)?.runtimeSec,
        confirmations: (snapshot?.confirmations || []).filter((entry) => entry.itemId === id),
        backfill: (snapshot?.backfill || []).filter((entry) => entry.itemId === id),
      })),
    );
  }
  const motion = new Map();
  function showSyncStatus(status) {
    updateRefreshStatus(status);
    $("activityStatus").textContent = status.error
      ? `自动同步失败：${status.error}。已有统计仍可查看。`
      : status.syncing
        ? "正在同步播放记录……"
        : status.playing
          ? "检测到播放活动，结束后将自动同步。"
          : "";
    if (status.error) void updatePathFallback();
  }
  async function updatePathFallback() {
    try {
      const status = await api.getWatchStatisticsPathStatus();
      $("pathFallback").hidden = !status?.needsManualPath;
      if (status?.needsManualPath) {
        $("pathFallbackText").textContent = status.path
          ? `Playback Reporting 数据库不可用：${status.path}`
          : "Playback Reporting 数据库未能自动定位。";
      }
    } catch {
      $("pathFallback").hidden = true;
    }
  }
  let manualRefresh = false;
  let refreshPoll = null;
  function updateRefreshStatus(status) {
    if (!manualRefresh) return;
    if (status.syncing) return;
    manualRefresh = false;
    clearInterval(refreshPoll);
    refreshPoll = null;
    $("refreshBtn").disabled = false;
    $("refreshBtn").textContent = "重新同步";
    if (status.error) {
      $("refreshStatus").textContent = `刷新失败：${status.error}。已有统计数据仍可查看。`;
      void updatePathFallback();
    } else {
      api
        .getWatchStatistics()
        .then((snapshot) => {
          if (snapshot) applySnapshot(snapshot, !state.snapshot);
          $("refreshStatus").textContent = "刷新完成，统计数据已更新。";
        })
        .catch((error) => {
          $("refreshStatus").textContent = `读取刷新结果失败：${error?.message || String(error)}`;
        });
    }
  }
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const valid = (value) =>
    Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const dayKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dateLabel = (d) =>
    `${dayKey(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const duration = (s) => {
    const m = Math.round(s / 60);
    if (m < 1) return `${Math.round(s)} 秒`;
    const h = Math.floor(m / 60);
    return h ? `${h} 小时${m % 60 ? ` ${m % 60} 分钟` : ""}` : `${m} 分钟`;
  };
  const hours = (s) => `${(s / 3600).toFixed(1)} 小时`;
  const share = (n, total) => (total ? Math.round((n / total) * 100) : 0);
  const nameKey = (value) =>
    String(value ?? "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase();
  function normalizeNames(values, kind) {
    const aliases = new Map();
    for (const entry of window.FreeboStatisticsNames?.[kind] || []) {
      for (const name of [entry.canonical, ...(entry.aliases || [])]) {
        aliases.set(nameKey(name), entry.canonical);
      }
    }
    const unique = new Map();
    for (const value of Array.isArray(values) ? values : []) {
      const original = String(value ?? "").trim();
      if (!original) continue;
      const canonical = aliases.get(nameKey(original)) || original;
      unique.set(nameKey(canonical), canonical);
    }
    return [...unique.values()];
  }
  const now = () => new Date();
  const bounds = () => {
    const end = now(),
      start = new Date(end);
    start.setHours(0, 0, 0, 0);
    if (state.period === "year") start.setMonth(0, 1);
    else if (state.period === "d30") start.setDate(start.getDate() - 29);
    else if (state.period === "d7") start.setDate(start.getDate() - 6);
    else if (state.period === "custom") start.setDate(start.getDate() - state.customDays + 1);
    else return [null, end];
    return [start, end];
  };
  const mediaMap = () => new Map((state.snapshot?.media || []).map((m) => [String(m.id), m]));
  const normalizedId = (value) =>
    String(value || "")
      .replace(/-/g, "")
      .toLowerCase();
  function effectiveLibrary(record, media) {
    const correction = state.snapshot?.corrections || {};
    const id = correction.records?.[record.id] || correction.items?.[normalizedId(record.itemId)];
    return (
      (id && state.snapshot?.libraries?.find((entry) => entry.id === id)?.name) ||
      media?.libraryName ||
      "未匹配"
    );
  }
  const rawRecords = () =>
    (state.snapshot?.records || [])
      .map((r) => {
        const start = new Date(r.startAt),
          seconds = valid(r.durationSec),
          m =
            mediaMapCache.get(String(r.itemId)) ||
            (["Movie", "Episode"].includes(r.itemType)
              ? { id: String(r.itemId), type: r.itemType, name: r.itemName || "未知作品" }
              : null);
        return {
          ...r,
          start,
          seconds,
          media: m,
          name: r.itemName || m?.name || "未知作品",
          type: m?.type || r.itemType,
          library: effectiveLibrary(r, m),
          genres: normalizeNames(m?.genres, "genres"),
          directors: normalizeNames(m?.directors, "directors"),
          year: num(m?.year),
          seriesId: m?.seriesId || (m?.type === "Series" ? m.id : null),
        };
      })
      .filter(
        (r) =>
          Number.isFinite(+r.start) && r.seconds > 0 && (!state.excludeShort || r.seconds >= 120),
      );
  let mediaMapCache = new Map();
  function selectedRecords() {
    const [lo, hi] = bounds();
    const focusDay = state.focus?.type === "day" ? new Date(state.focus.value + "T00:00:00") : null;
    const focusEnd = focusDay
      ? new Date(focusDay.getFullYear(), focusDay.getMonth(), focusDay.getDate() + 1)
      : null;
    return rawRecords()
      .map((r) => {
        const start = Math.max(+r.start, lo ? +lo : -Infinity, focusDay ? +focusDay : -Infinity),
          end = Math.min(+r.start + r.seconds * 1000, +hi, focusEnd ? +focusEnd : Infinity);
        return end > start
          ? {
              ...r,
              clippedStart: new Date(start),
              clippedEnd: new Date(end),
              clippedSeconds: (end - start) / 1000,
            }
          : null;
      })
      .filter(Boolean)
      .filter(fitsFocus);
  }
  function selectedBackfill() {
    if (state.period !== "all") return [];
    if (state.focus?.type === "day" || state.focus?.type === "device") return [];
    const seen = new Set();
    return [
      ...(state.snapshot?.backfill || []),
      ...(state.snapshot?.confirmations || [])
        .filter((c) => c.estimatedDurationSec)
        .map((c) => ({ itemId: c.itemId, durationSec: c.estimatedDurationSec, id: c.id })),
    ]
      .filter((b) => {
        const id = String(b.itemId);
        if (seen.has(b.id || id) || !valid(b.durationSec)) return false;
        seen.add(b.id || id);
        return true;
      })
      .map((b) => {
        const m = mediaMapCache.get(String(b.itemId));
        return {
          itemId: b.itemId,
          name: m?.name || "未知作品",
          type: m?.type,
          seriesId: m?.seriesId,
          library: effectiveLibrary({ itemId: b.itemId }, m),
          genres: normalizeNames(m?.genres, "genres"),
          directors: normalizeNames(m?.directors, "directors"),
          year: num(m?.year),
          clippedSeconds: valid(b.durationSec),
          source: "estimate",
        };
      })
      .filter(fitsFocus);
  }
  function fitsFocus(r) {
    const f = state.focus;
    if (!f) return true;
    if (f.type === "day")
      return (
        +r.clippedStart <
          +new Date(
            new Date(f.value + "T00:00:00").setDate(new Date(f.value + "T00:00:00").getDate() + 1),
          ) && +r.clippedEnd > +new Date(f.value + "T00:00:00")
      );
    if (f.type === "library") return r.library === f.value;
    if (f.type === "genre") return r.genres.includes(f.value);
    if (f.type === "director") return r.directors.includes(f.value);
    if (f.type === "decade") return Math.floor(r.year / 10) * 10 === f.value;
    if (f.type === "series") return r.seriesId === f.value;
    if (f.type === "work") return String(r.itemId) === f.value;
    if (f.type === "device") return (r.deviceName || "未知设备") === f.value;
    return true;
  }
  function slices(records) {
    const daily = new Map(),
      hourly = Array(24).fill(0),
      weekday = Array(7).fill(0);
    let total = 0;
    for (const r of records) {
      let t = new Date(r.clippedStart),
        end = r.clippedEnd;
      total += r.clippedSeconds;
      while (t < end) {
        const next = new Date(t);
        next.setMinutes(0, 0, 0);
        next.setHours(next.getHours() + 1);
        const stop = new Date(Math.min(+next, +end)),
          sec = (stop - t) / 1000;
        daily.set(dayKey(t), (daily.get(dayKey(t)) || 0) + sec);
        hourly[t.getHours()] += sec;
        weekday[(t.getDay() + 6) % 7] += sec;
        t = stop;
      }
    }
    return { daily, hourly, weekday, total };
  }
  function groups(records) {
    const ordered = [...records].sort((a, b) => a.start - b.start),
      out = [];
    for (const r of ordered) {
      const end = +r.start + r.seconds * 1000,
        last = out.at(-1);
      if (last && last.userId === r.userId && +r.start - last.end <= state.gap * 60000) {
        last.records.push(r);
        last.end = Math.max(last.end, end);
        last.total += r.clippedSeconds;
      } else
        out.push({ userId: r.userId, start: +r.start, end, total: r.clippedSeconds, records: [r] });
    }
    return out.reverse();
  }
  function animate(id, target, unit, decimals = 0) {
    const el = $(id),
      prior = motion.get(id);
    if (prior?.frame) cancelAnimationFrame(prior.frame);
    const from = prior?.value ?? 0,
      item = { value: from, frame: 0 };
    motion.set(id, item);
    const paint = (n) => {
      el.textContent = "";
      el.append(document.createTextNode(decimals ? n.toFixed(decimals) : String(Math.round(n))));
      const span = document.createElement("span");
      span.textContent = unit;
      el.append(span);
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      item.value = target;
      paint(target);
      return;
    }
    const started = performance.now();
    const step = (time) => {
      const p = Math.min(1, (time - started) / 820);
      item.value = from + (target - from) * (1 - (1 - p) ** 4);
      paint(item.value);
      if (p < 1) item.frame = requestAnimationFrame(step);
      else item.frame = 0;
    };
    item.frame = requestAnimationFrame(step);
  }
  function setFocus(type, value, label) {
    if (state.focus?.type === type && state.focus.value === value) state.focus = null;
    else state.focus = { type, value, label };
    state.activityPage = 1;
    render();
  }
  function bar(parent, entries, total, onClick) {
    const el = $(parent);
    el.replaceChildren();
    if (!entries.length) {
      el.innerHTML = '<div class="muted-box">暂无数据</div>';
      return;
    }
    const max = entries[0][1];
    for (const [name, value] of entries) {
      const row = document.createElement("div");
      row.className = "link-row bar-row";
      row.tabIndex = 0;
      row.role = "button";
      if (state.focus?.value === name) row.classList.add("is-picked");
      row.innerHTML = `<div class="bar-meta"><strong>${esc(name)}</strong><small>${hours(value)} · ${share(value, total)}%</small></div><div class="bar-track"><div class="bar-fill" style="width:${(value / max) * 100}%"></div></div>`;
      row.onclick = () => onClick(name);
      row.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      };
      el.append(row);
    }
  }
  function aggregate(records, fn, multi = false) {
    const map = new Map();
    for (const r of records) {
      const keys = multi ? fn(r) : [fn(r)];
      for (const key of keys) {
        if (key === undefined || key === null || key === "") continue;
        map.set(key, (map.get(key) || 0) + r.clippedSeconds);
      }
    }
    return [...map].sort((a, b) => b[1] - a[1]);
  }
  function pageControls(container, page, pages, change) {
    const nav = document.createElement("div");
    nav.className = "review-paging";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "上一页";
    prev.disabled = page <= 1;
    prev.onclick = () => change(page - 1);
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "下一页";
    next.disabled = page >= pages;
    next.onclick = () => change(page + 1);
    const label = document.createElement("span");
    label.textContent = `${page} / ${pages} 页`;
    nav.append(prev, label, next);
    container.append(nav);
  }
  function emptyWatch() {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "暂无匹配的已确认作品";
    return p;
  }
  function watchRow(parent, title, detail, open, id, rerender) {
    const row = document.createElement("div");
    row.className = "link-row watch-row";
    if (id && state.watchBatch) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = state.watchSelection.has(id);
      box.setAttribute("aria-label", `选择 ${title}`);
      box.onchange = () => {
        if (box.checked) state.watchSelection.add(id);
        else state.watchSelection.delete(id);
        invalidateWatchPreview();
        rerender();
      };
      row.append(box);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "watch-row-button";
    const name = document.createElement("strong");
    name.textContent = title;
    const meta = document.createElement("span");
    meta.textContent = detail;
    const arrow = document.createElement("span");
    arrow.className = "watch-arrow";
    arrow.textContent = "›";
    button.append(name, meta, arrow);
    button.onclick = open;
    row.append(button);
    parent.append(row);
  }
  function addSelectScope(parent, visible, label, all, rerender) {
    const tools = document.createElement("div");
    tools.className = "review-tools";
    for (const [text, ids] of [
      [label, all],
      ["取消选择", all],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.onclick = () => {
        for (const id of ids) {
          if (text === "取消选择") state.watchSelection.delete(id);
          else state.watchSelection.add(id);
        }
        invalidateWatchPreview();
        rerender();
      };
      tools.append(button);
    }
    const selected = document.createElement("span");
    selected.className = "hint";
    selected.textContent = `已选 ${state.watchSelection.size} 项`;
    tools.append(selected);
    parent.append(tools);
  }
  function renderWatchSeries(body, all, counts, rerender) {
    const episodes = all.filter(
      (m) =>
        (m.seriesId || m.seriesName || m.id) === state.watchSeries &&
        (state.period === "all" || counts.has(m.id)),
    );
    const title = episodes[0]?.seriesName || mediaMapCache.get(state.watchSeries)?.name || "电视剧";
    const back = document.createElement("button");
    back.className = "watch-back";
    back.textContent = `‹ 返回电视剧 · ${title}`;
    back.onclick = () => {
      state.watchSeries = null;
      state.watchSeason = null;
      rerender();
    };
    body.append(back);
    const seasons = new Map();
    for (const media of episodes) {
      const key = media.seasonNumber ?? "?";
      if (!seasons.has(key)) seasons.set(key, []);
      seasons.get(key).push(media);
    }
    if (state.watchBatch)
      addSelectScope(
        body,
        episodes.map((m) => m.id),
        "选择整部剧",
        episodes.map((m) => m.id),
        rerender,
      );
    for (const [season, items] of [...seasons].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const row = document.createElement("div");
      row.className = "watch-season";
      if (state.watchBatch) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = items.every((m) => state.watchSelection.has(m.id));
        box.indeterminate = !box.checked && items.some((m) => state.watchSelection.has(m.id));
        box.setAttribute("aria-label", `选择第 ${season} 季`);
        box.onchange = () => {
          for (const m of items) {
            if (box.checked) state.watchSelection.add(m.id);
            else state.watchSelection.delete(m.id);
          }
          invalidateWatchPreview();
          rerender();
        };
        row.append(box);
      }
      const button = document.createElement("button");
      button.className = "watch-row-button";
      button.textContent =
        state.period === "all"
          ? `第 ${season} 季 · ${items.length} 集 · ${items.reduce((n, m) => n + (counts.get(m.id) || 0), 0)} 集次 ${state.watchSeason === season ? "⌄" : "›"}`
          : `第 ${season} 季 · 播放过 ${items.filter((m) => counts.has(m.id)).length} 集 ${state.watchSeason === season ? "⌄" : "›"}`;
      button.onclick = () => {
        state.watchSeason = state.watchSeason === season ? null : season;
        rerender();
      };
      row.append(button);
      body.append(row);
      if (state.watchSeason === season) {
        const sorted = items.sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
        const pages = Math.max(1, Math.ceil(sorted.length / 20));
        state.breakdownPage.Episode = Math.min(state.breakdownPage.Episode, pages);
        for (const item of sorted.slice(
          (state.breakdownPage.Episode - 1) * 20,
          state.breakdownPage.Episode * 20,
        ))
          watchRow(
            body,
            `S${String(item.seasonNumber ?? 0).padStart(2, "0")}E${String(item.episodeNumber ?? 0).padStart(2, "0")} ${item.name}`,
            state.period === "all" ? `${counts.get(item.id)} 刷` : "期间有实播",
            () => {
              state.watchItem = { type: "Episode", id: item.id };
              rerender();
            },
            item.id,
            rerender,
          );
        pageControls(body, state.breakdownPage.Episode, pages, (page) => {
          state.breakdownPage.Episode = page;
          rerender();
        });
      }
    }
    if (state.watchBatch) renderBatchTools(body, counts, rerender);
  }
  function renderWatchEditor(body, id, counts, rerender) {
    const media = mediaMapCache.get(id);
    const back = document.createElement("button");
    back.className = "watch-back";
    back.textContent = "‹ 返回列表";
    back.onclick = () => {
      state.watchItem = null;
      rerender();
    };
    body.append(back);
    const heading = document.createElement("h3");
    heading.textContent = media?.name || id;
    body.append(heading);
    const entries = (state.snapshot?.confirmations || [])
      .filter((c) => c.itemId === id)
      .sort((a, b) => String(b.confirmedAt || "").localeCompare(String(a.confirmedAt || "")));
    const current = document.createElement("p");
    current.className = "hint";
    current.textContent = `当前已确认 ${entries.length} 次`;
    body.append(current);
    const history = document.createElement("div");
    history.className = "watch-history";
    const oldEstimate = (state.snapshot?.backfill || []).find(
      (backfill) => backfill.itemId === id && backfill.durationSec > 0,
    );
    if (oldEstimate) {
      const row = document.createElement("div");
      row.className = "watch-history-row";
      row.textContent = `旧历史补录估算 ${duration(oldEstimate.durationSec)} · 与确认记录无明确关联`;
      history.append(row);
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "watch-history-row";
      const label = document.createElement("span");
      label.textContent = `${entry.confirmedAt ? dayKey(new Date(entry.confirmedAt)) : "日期未知"} · ${entry.source === "manual" ? "历史补记" : entry.source === "initial" ? "历史初始化" : "观看确认"}${entry.estimatedDurationSec ? ` · 历史估算 ${duration(entry.estimatedDurationSec)}` : ""}`;
      const revoke = document.createElement("button");
      revoke.textContent = "撤销";
      revoke.onclick = () => {
        if (window.confirm("撤销这次确认及其关联历史估算？"))
          void review({ action: "revoke", confirmationId: entry.id });
      };
      row.append(label, revoke);
      history.append(row);
    }
    body.append(history);
    state.watchSelection.clear();
    state.watchSelection.add(id);
    renderBatchTools(body, counts, rerender);
  }
  function renderBatchTools(body, counts, rerender) {
    const ids = [...state.watchSelection];
    const panel = document.createElement("div");
    panel.className = "watch-editor";
    const title = document.createElement("strong");
    title.textContent = `修正与补记 · 已选 ${ids.length} ${state.breakdown === "Movie" ? "部" : "集"}`;
    const controls = document.createElement("div");
    controls.className = "review-tools";
    const mode = document.createElement("select");
    mode.className = "select";
    for (const [value, label] of [
      ["set", "设置累计总次数"],
      ["increase", "增加一次观看"],
      ["decrease", "减少一次观看"],
      ["estimate", "仅修改历史估算"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      mode.append(option);
    }
    mode.value = state.watchOperation;
    mode.onchange = () => {
      state.watchOperation = mode.value;
      invalidateWatchPreview();
      rerender();
    };
    const target = document.createElement("input");
    target.type = "number";
    target.min = "0";
    target.max = "100";
    target.value = String(state.watchTarget);
    target.setAttribute("aria-label", "目标累计次数");
    target.hidden = state.watchOperation !== "set";
    target.onchange = () => {
      state.watchTarget = num(target.value);
      invalidateWatchPreview();
      while (panel.children.length > 2) panel.lastChild.remove();
    };
    const estimate = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.watchEstimate;
    box.onchange = () => {
      state.watchEstimate = box.checked;
      invalidateWatchPreview();
      rerender();
    };
    estimate.append(
      box,
      document.createTextNode(
        state.watchOperation === "estimate"
          ? "补充历史估算（取消则清除）"
          : state.watchOperation === "decrease"
            ? "优先撤销带历史估算的确认"
            : state.watchOperation === "set"
              ? "新增时补估算；减少时优先撤销估算"
              : "新增确认时补充片长估算",
      ),
    );
    const preview = document.createElement("button");
    preview.type = "button";
    preview.textContent = "预览修改";
    preview.disabled = !ids.length;
    preview.onclick = async () => {
      const version = ++state.watchPreviewVersion;
      state.watchPreview = null;
      preview.disabled = true;
      preview.textContent = "正在预览…";
      try {
        const input = {
          action: "batch",
          itemIds: ids,
          mode: state.watchOperation,
          ...(state.watchOperation === "set" ? { totalCount: state.watchTarget } : {}),
          ...(state.watchOperation === "estimate"
            ? { estimated: state.watchEstimate }
            : { estimate: state.watchEstimate }),
        };
        const result = await api.previewWatchStatisticsReview(input);
        if (version !== state.watchPreviewVersion) {
          state.watchStatus = "观看确认已更新，请重新预览";
          render();
          return;
        }
        state.watchPreview = {
          input,
          result,
          operationId: globalThis.crypto.randomUUID
            ? globalThis.crypto.randomUUID()
            : `10000000-1000-4000-8000-${[...globalThis.crypto.getRandomValues(new Uint8Array(6))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        };
        state.watchPreviewFilter = "changed";
        state.watchPreviewPage = 1;
        state.watchStatus = "";
        rerender();
      } catch (error) {
        if (version === state.watchPreviewVersion) {
          state.watchPreview = null;
          state.watchStatus = `预览失败：${error?.message || String(error)}`;
          rerender();
        }
      } finally {
        preview.disabled = false;
        preview.textContent = "预览修改";
      }
    };
    controls.append(mode, target, estimate, preview);
    panel.append(title, controls);
    if (state.watchPreview && ids.join("|") === state.watchPreview.input.itemIds.join("|")) {
      const currentPreview = state.watchPreview;
      const result = currentPreview.result;
      const info = document.createElement("p");
      info.className = "hint";
      info.textContent = `${result.itemCount} 项，${result.changedCount} 项变化 · 次数 ${result.countBefore} → ${result.countAfter}（${result.countDelta >= 0 ? "+" : ""}${result.countDelta}） · 历史估算 ${duration(result.estimateBeforeSec)} → ${duration(result.estimateAfterSec)}（${result.estimateDeltaSec >= 0 ? "+" : "-"}${duration(Math.abs(result.estimateDeltaSec))}） · 实际播放时长不变`;
      panel.append(info);
      const filter = document.createElement("select");
      filter.className = "select";
      filter.setAttribute("aria-label", "预览明细筛选");
      for (const [value, label] of [
        ["all", "全部"],
        ["changed", "有变化"],
        ["unchanged", "无变化"],
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        filter.append(option);
      }
      filter.value = state.watchPreviewFilter;
      filter.onchange = () => {
        state.watchPreviewFilter = filter.value;
        state.watchPreviewPage = 1;
        rerender();
      };
      panel.append(filter);
      const details = document.createElement("div");
      details.className = "watch-history";
      const filtered = result.items.filter(
        (item) =>
          state.watchPreviewFilter === "all" ||
          item.changed === (state.watchPreviewFilter === "changed"),
      );
      filtered.sort(
        (a, b) => Number(b.changed) - Number(a.changed) || a.itemId.localeCompare(b.itemId),
      );
      const pages = Math.max(1, Math.ceil(filtered.length / 20));
      state.watchPreviewPage = Math.min(state.watchPreviewPage, pages);
      for (const item of filtered.slice(
        (state.watchPreviewPage - 1) * 20,
        state.watchPreviewPage * 20,
      )) {
        const media = mediaMapCache.get(item.itemId);
        const row = document.createElement("div");
        row.className = "watch-history-row";
        const label = document.createElement("span");
        const title =
          media?.type === "Episode"
            ? `${media.seriesName || "电视剧"} · S${String(media.seasonNumber ?? "?").padStart(2, "0")}E${String(media.episodeNumber ?? "?").padStart(2, "0")} ${media.name}`
            : media?.name || item.itemId;
        const countDelta = item.afterCount - item.beforeCount;
        const estimateDelta = item.estimateDeltaSec;
        label.textContent = `${item.changed ? "有变化" : "无变化"} · ${title} · 次数 ${item.beforeCount} → ${item.afterCount}（${countDelta >= 0 ? "+" : ""}${countDelta}） · 历史估算 ${duration(item.estimateBeforeSec)} → ${duration(item.estimateAfterSec)}（${estimateDelta >= 0 ? "+" : "-"}${duration(Math.abs(estimateDelta))}，${item.estimatedBeforeCount} → ${item.estimatedAfterCount} 次） · 实播时长不变${item.estimateUnavailable ? " · 缺片长，无法估算" : ""}`;
        row.append(label);
        details.append(row);
      }
      if (!filtered.length) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "暂无符合条件的项目";
        details.append(empty);
      }
      panel.append(details);
      pageControls(panel, state.watchPreviewPage, pages, (page) => {
        state.watchPreviewPage = page;
        rerender();
      });
      const apply = document.createElement("button");
      apply.textContent = "确认应用";
      apply.disabled = !result.changedCount;
      apply.onclick = async () => {
        if (state.watchPreview !== currentPreview) return;
        apply.disabled = true;
        try {
          await review({
            ...currentPreview.input,
            token: result.token,
            operationId: currentPreview.operationId,
          });
        } finally {
          apply.disabled = false;
        }
      };
      panel.append(apply);
    }
    body.append(panel);
  }
  function showWatchError(parent, error) {
    const message = document.createElement("p");
    message.className = "hint";
    message.role = "status";
    message.textContent = error?.message || String(error);
    parent.append(message);
  }
  function renderBreakdown(type, bodyId, counts, buckets) {
    const body = $(bodyId);
    let summary = body.querySelector(":scope > .breakdown-summary");
    if (!summary) {
      summary = document.createElement("p");
      summary.className = "hint breakdown-summary";
      body.append(summary);
    }
    let status = body.querySelector(":scope > .breakdown-status");
    if (!status) {
      status = document.createElement("p");
      status.className = "hint breakdown-status";
      status.role = "status";
      body.append(status);
    }
    let toolbar = body.querySelector(":scope > .breakdown-toolbar");
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.className = "review-tools breakdown-toolbar";
      body.append(toolbar);
    }
    let results = body.querySelector(":scope > .breakdown-results");
    if (!results) {
      results = document.createElement("div");
      results.className = "breakdown-results";
      body.append(results);
    }
    results.replaceChildren();
    const unit = type === "Movie" ? "部" : "集";
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    summary.textContent =
      state.period === "all"
        ? `累计 ${total} ${unit}次 · 不同作品 ${counts.size} ${unit} · ${
            [...buckets]
              .sort((a, b) => a[0] - b[0])
              .map(([n, c]) => `${n} 刷 ${c} ${unit}`)
              .join(" · ") || "暂无确认"
          }`
        : `播放过的不同${type === "Movie" ? "电影" : "单集"} ${counts.size} ${unit} · 实播记录不代表完整观看或刷次`;
    status.textContent = state.watchStatus;
    status.hidden = !state.watchStatus;
    const rerender = () => renderBreakdown(type, bodyId, counts, buckets);
    let search = toolbar.querySelector(".record-search");
    if (!search) {
      search = document.createElement("input");
      search.type = "search";
      search.className = "record-search";
      search.placeholder = "搜索作品";
      search.value = state.breakdownSearch[type];
      search.addEventListener("compositionstart", () => {
        search.isComposing = true;
      });
      search.addEventListener("compositionend", () => {
        search.isComposing = false;
        search.commitSearch();
      });
      toolbar.append(search);
    }
    const updateSearch = () => {
      state.breakdownSearch[type] = search.value;
      state.breakdownPage[type] = 1;
      rerender();
    };
    search.commitSearch = updateSearch;
    search.oninput = (event) => {
      if (search.isComposing || event.isComposing) return;
      updateSearch();
    };
    let visit = toolbar.querySelector(".breakdown-visit");
    if (!visit) {
      visit = document.createElement("select");
      visit.className = "select breakdown-visit";
      visit.setAttribute("aria-label", "按刷次筛选");
      for (const [value, label] of [
        ["all", "全部刷次"],
        ["1", "一刷"],
        ["2", "二刷"],
        ["3", "三刷"],
        ["4", "四刷及以上"],
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        visit.append(option);
      }
      toolbar.append(visit);
    }
    visit.value = state.watchVisit[type];
    visit.hidden = state.period !== "all";
    visit.onchange = () => {
      state.watchVisit[type] = visit.value;
      state.breakdownPage[type] = 1;
      rerender();
    };
    let batch = toolbar.querySelector(".breakdown-batch");
    if (!batch) {
      batch = document.createElement("button");
      batch.type = "button";
      batch.className = "breakdown-batch";
      toolbar.append(batch);
    }
    batch.textContent = state.watchBatch ? "退出批量管理" : "批量管理";
    batch.onclick = () => {
      state.watchBatch = !state.watchBatch;
      state.watchSelection.clear();
      invalidateWatchPreview();
      rerender();
    };
    const all = [...mediaMapCache.values()].filter((m) => m.type === type);
    const fits = (n) =>
      state.period !== "all" ||
      state.watchVisit[type] === "all" ||
      (state.watchVisit[type] === "4" ? n >= 4 : n === Number(state.watchVisit[type]));
    const matched = all.filter(
      (m) =>
        (counts.get(m.id) || 0) > 0 &&
        fits(counts.get(m.id) || 0) &&
        `${m.seriesName || ""} ${m.name}`
          .toLocaleLowerCase()
          .includes(state.breakdownSearch[type].trim().toLocaleLowerCase()),
    );
    if (state.watchItem && state.watchItem.type === type) {
      renderWatchEditor(results, state.watchItem.id, counts, rerender);
      return;
    }
    if (type === "Episode" && state.watchSeries) {
      renderWatchSeries(results, all, counts, rerender);
      return;
    }
    if (type === "Movie") {
      const sorted = matched.sort(
        (a, b) => counts.get(b.id) - counts.get(a.id) || a.name.localeCompare(b.name),
      );
      const pages = Math.max(1, Math.ceil(sorted.length / 20));
      state.breakdownPage[type] = Math.min(state.breakdownPage[type], pages);
      const visible = sorted.slice(
        (state.breakdownPage[type] - 1) * 20,
        state.breakdownPage[type] * 20,
      );
      if (state.watchBatch)
        addSelectScope(
          results,
          visible.map((m) => m.id),
          "全选当前筛选结果",
          sorted.map((m) => m.id),
          rerender,
        );
      for (const media of visible)
        watchRow(
          results,
          media.name,
          state.period === "all" ? `${counts.get(media.id)} 刷` : "期间有实播",
          () => {
            state.watchItem = { type, id: media.id };
            rerender();
          },
          media.id,
          rerender,
        );
      if (!visible.length) results.append(emptyWatch());
      pageControls(results, state.breakdownPage[type], pages, (page) => {
        state.breakdownPage[type] = page;
        rerender();
      });
    } else {
      const series = new Map();
      for (const media of matched) {
        const id = media.seriesId || media.seriesName || media.id;
        const group = series.get(id) || { id, name: media.seriesName || media.name, episodes: [] };
        group.episodes.push(media);
        series.set(id, group);
      }
      const sorted = [...series.values()].sort(
        (a, b) =>
          b.episodes.reduce((n, m) => n + (counts.get(m.id) || 0), 0) -
            a.episodes.reduce((n, m) => n + (counts.get(m.id) || 0), 0) ||
          a.name.localeCompare(b.name),
      );
      const pages = Math.max(1, Math.ceil(sorted.length / 20));
      state.breakdownPage[type] = Math.min(state.breakdownPage[type], pages);
      for (const group of sorted.slice(
        (state.breakdownPage[type] - 1) * 20,
        state.breakdownPage[type] * 20,
      ))
        watchRow(
          results,
          group.name,
          state.period === "all"
            ? `已看 ${group.episodes.length} 集 · 累计 ${group.episodes.reduce((n, m) => n + (counts.get(m.id) || 0), 0)} 集次`
            : `播放过 ${group.episodes.length} 集`,
          () => {
            state.watchSeries = group.id;
            state.watchSeason = null;
            rerender();
          },
        );
      if (!sorted.length) results.append(emptyWatch());
      pageControls(results, state.breakdownPage[type], pages, (page) => {
        state.breakdownPage[type] = page;
        rerender();
      });
    }
    if (state.watchBatch) renderBatchTools(results, counts, rerender);
  }
  function renderOverview(records, combined, parts, activities) {
    const actual = combined
        .filter((r) => r.source !== "estimate")
        .reduce((sum, r) => sum + r.clippedSeconds, 0),
      backfill = combined
        .filter((r) => r.source === "estimate")
        .reduce((n, r) => n + r.clippedSeconds, 0);
    animate("totalHours", (actual + backfill) / 3600, "小时", 1);
    const counts = { Movie: new Map(), Episode: new Map() };
    if (state.period === "all") {
      for (const confirmation of state.snapshot.confirmations || []) {
        const media = mediaMapCache.get(confirmation.itemId);
        if (counts[media?.type])
          counts[media.type].set(media.id, (counts[media.type].get(media.id) || 0) + 1);
      }
    } else {
      for (const record of records) {
        const media = record.media;
        if (counts[media?.type]) {
          if (!mediaMapCache.has(media.id)) mediaMapCache.set(media.id, media);
          counts[media.type].set(media.id, 1);
        }
      }
    }
    for (const [type, target, body] of [
      ["Movie", "moviesCount", "movieBreakdownBody"],
      ["Episode", "episodesCount", "episodeBreakdownBody"],
    ]) {
      const values = [...counts[type].values()];
      animate(
        target,
        state.period === "all" ? values.reduce((sum, n) => sum + n, 0) : counts[type].size,
        state.period === "all"
          ? type === "Movie"
            ? "部次"
            : "集次"
          : type === "Movie"
            ? "部"
            : "集",
      );
      const buckets = new Map();
      for (const n of values) buckets.set(n, (buckets.get(n) || 0) + 1);
      renderBreakdown(type, body, counts[type], buckets);
    }
    animate("activeDays", [...parts.daily.values()].filter(Boolean).length, "天");
    $("timeFoot").textContent = `实际 ${hours(actual)} · 历史补录估算 ${hours(backfill)}`;
    $("daysFoot").textContent = `${records.length} 次播放 · ${activities.length} 次观影活动`;
    $("sessionFoot").textContent =
      `最长活动实际播放 ${duration(Math.max(0, ...activities.map((g) => g.total)))} · 活动时间跨度按记录起点和时长估算，间隔不计入播放。`;
    $("rangeHint").textContent = {
      year: `统计时间：${now().getFullYear()} 年`,
      d30: "统计时间：近 30 天",
      d7: "统计时间：近 7 天",
      custom: `统计时间：近 ${state.customDays} 天`,
      all: "统计时间：全部记录",
    }[state.period];
  }
  function renderCalendar(parts) {
    const [rangeStart] = bounds();
    const years = new Set([now().getFullYear()]);
    if (rangeStart)
      for (let y = rangeStart.getFullYear(); y <= now().getFullYear(); y++) years.add(y);
    if (state.period === "all") {
      for (const record of rawRecords()) {
        for (
          let year = record.start.getFullYear();
          year <= new Date(+record.start + record.seconds * 1000).getFullYear();
          year++
        )
          years.add(year);
      }
    }
    const choices = [...years].sort((a, b) => b - a);
    if (!choices.includes(state.calendarYear)) state.calendarYear = choices[0];
    const selector = $("calendarYear");
    selector.replaceChildren();
    for (const choice of choices) {
      const option = document.createElement("option");
      option.value = String(choice);
      option.textContent = `${choice} 年`;
      selector.append(option);
    }
    selector.value = String(state.calendarYear);
    const year = state.calendarYear,
      grid = $("calendarGrid"),
      months = $("monthNames");
    grid.replaceChildren();
    months.replaceChildren();
    const first = new Date(year, 0, 1),
      monday = new Date(first);
    monday.setDate(1 - ((first.getDay() + 6) % 7));
    const weeks = Math.ceil((+new Date(year + 1, 0, 1) - monday) / 604800000);
    let previous = -1;
    for (let w = 0; w < weeks; w++) {
      const label = document.createElement("span");
      label.className = "months-label";
      const week = document.createElement("div");
      week.className = "calendar-week";
      for (let d = 0; d < 7; d++) {
        const date = new Date(monday);
        date.setDate(date.getDate() + w * 7 + d);
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "cal-day";
        if (date.getFullYear() !== year) {
          cell.classList.add("empty");
          cell.disabled = true;
        } else {
          if (d === 0 && date.getMonth() !== previous) {
            label.textContent = `${date.getMonth() + 1} 月`;
            previous = date.getMonth();
          }
          const sec = parts.daily.get(dayKey(date)) || 0,
            h = sec / 3600,
            level = h >= 4.5 ? 4 : h >= 3 ? 3 : h >= 1.5 ? 2 : h > 0 ? 1 : 0;
          if (level) cell.classList.add(`level${level}`);
          cell.classList.add("active");
          cell.title = `${dayKey(date)}：${duration(sec)}`;
          cell.setAttribute("aria-label", cell.title);
          cell.onclick = () => setFocus("day", dayKey(date), dayKey(date));
        }
        week.append(cell);
      }
      months.append(label);
      grid.append(week);
    }
    $("calendarFoot").textContent =
      `${year} 年有 ${[...parts.daily.keys()].filter((k) => k.startsWith(year + "-")).length} 个观影日；跨午夜按记录起点与播放时长估算分配。`;
  }
  function renderHabits(parts) {
    const max = Math.max(1, ...parts.hourly),
      peak = parts.hourly.indexOf(Math.max(...parts.hourly));
    $("peakHour").textContent = `最多：${peak} 时—${(peak + 1) % 24} 时`;
    $("hourChart").innerHTML = parts.hourly
      .map(
        (n, i) =>
          `<div class="hour-bar-wrap" title="${i} 时：${duration(n)}"><div class="hour-bar" style="height:${Math.max(2, (n / max) * 100)}%"></div></div>`,
      )
      .join("");
    const wd = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
      top = Math.max(1, ...parts.weekday);
    $("weekendShare").textContent =
      `周末占 ${share(parts.weekday[5] + parts.weekday[6], parts.total)}%`;
    $("weekdayChart").innerHTML = parts.weekday
      .map(
        (n, i) =>
          `<div class="weekday-cell"><span>${wd[i]}</span><b>${hours(n)}</b><div class="mini"><i style="width:${(n / top) * 100}%"></i></div></div>`,
      )
      .join("");
  }
  function renderSeries() {
    const all = state.snapshot?.media || [],
      episodes = all.filter((m) => m.type === "Episode" && m.seriesId),
      series = new Map(),
      last = new Map();
    for (const m of all) {
      if (m.type === "Series")
        series.set(m.id, {
          id: m.id,
          name: m.name,
          library: m.libraryName || "未匹配",
          episodes: [],
          total: 0,
          watched: 0,
        });
    }
    for (const ep of episodes) {
      const s = series.get(ep.seriesId) || {
        id: ep.seriesId,
        name: ep.seriesName || "未知剧集",
        library: ep.libraryName || "未匹配",
        episodes: [],
        total: 0,
        watched: 0,
      };
      s.episodes.push(ep);
      s.total++;
      if (ep.played) s.watched++;
      series.set(s.id, s);
    }
    for (const m of all) {
      if (m.lastPlayedAt) {
        const d = new Date(m.lastPlayedAt),
          id = m.type === "Series" ? m.id : m.seriesId;
        if (id && Number.isFinite(+d) && (!last.has(id) || d > last.get(id))) last.set(id, d);
      }
    }
    for (const r of rawRecords()) {
      if (r.seriesId && (!last.has(r.seriesId) || r.start > last.get(r.seriesId)))
        last.set(r.seriesId, r.start);
    }
    const cutoff = now();
    cutoff.setDate(cutoff.getDate() - 90);
    const priority = (s) =>
      s.watched < s.total ? (last.get(s.id) >= cutoff ? 0 : 2) : last.has(s.id) ? 1 : 3;
    const items = [...series.values()]
      .filter((s) => s.total > 0)
      .filter(
        (s) =>
          state.seriesMode === "all" ||
          (state.seriesMode === "watching" ? s.watched < s.total : s.watched === s.total),
      )
      .sort((a, b) => priority(a) - priority(b) || +(last.get(b.id) || 0) - +(last.get(a.id) || 0));
    const pages = Math.max(1, Math.ceil(items.length / 5));
    state.seriesPage = Math.min(state.seriesPage, pages);
    const visible = items.slice((state.seriesPage - 1) * 5, state.seriesPage * 5),
      el = $("seriesList");
    el.replaceChildren();
    for (const s of visible) {
      const row = document.createElement("div");
      row.className = "series-row";
      row.tabIndex = 0;
      row.role = "button";
      const ordered = s.episodes.sort(
        (a, b) =>
          (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
          (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0),
      );
      const current = ordered.findIndex((ep) => !ep.played);
      const cells = ordered
        .map((ep, i) => `<i class="${ep.played ? "done" : i === current ? "current" : ""}"></i>`)
        .join("");
      row.innerHTML = `<div class="series-top"><span class="series-name">${esc(s.name)}</span><span class="series-num">${s.watched} / ${s.total} 集</span></div><div class="series-cells" style="--series-columns:${Math.min(s.total, 50)}">${cells}</div><div class="series-bottom"><span>${esc(s.library)} · ${last.has(s.id) ? "最近观看 " + dayKey(last.get(s.id)) : "暂无播放记录"}</span><span>${s.watched === s.total ? "已看完" : "还有 " + (s.total - s.watched) + " 集未观看"}</span></div>`;
      row.onclick = () => setFocus("series", s.id, s.name);
      row.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      };
      el.append(row);
    }
    if (!visible.length) el.innerHTML = '<div class="muted-box">暂无剧集</div>';
    $("seriesPageInfo").textContent = `${state.seriesPage} / ${pages} 页`;
    $("seriesPrev").disabled = state.seriesPage === 1;
    $("seriesNext").disabled = state.seriesPage === pages;
    $("seriesHint").textContent =
      `共 ${items.length} 部 · 每页 5 部；进度来自 Jellyfin 当前观看状态。`;
    document
      .querySelectorAll("[data-series]")
      .forEach((b) => b.classList.toggle("active", b.dataset.series === state.seriesMode));
  }
  function renderDistributions(records, combined, total) {
    bar(
      "libraryChart",
      aggregate(combined, (r) => r.library),
      total,
      (n) => setFocus("library", n, n),
    );
    bar(
      "decadeChart",
      aggregate(combined, (r) => (r.year ? `${Math.floor(r.year / 10) * 10} 年代` : null)),
      total,
      (n) => setFocus("decade", Number(n.slice(0, 4)), n),
    );
    const genres = aggregate(combined, (r) => r.genres, true);
    bar("genreChart", state.genresExpanded ? genres : genres.slice(0, 12), total, (n) =>
      setFocus("genre", n, n),
    );
    const genreToggle = $("genreToggle");
    genreToggle.hidden = genres.length <= 12;
    genreToggle.textContent = state.genresExpanded ? "收起" : `展开全部 ${genres.length} 类`;
    genreToggle.setAttribute("aria-expanded", String(state.genresExpanded));
    const works = new Map();
    for (const record of combined) {
      const id = String(record.itemId);
      const entry = works.get(id) || { id, title: record.name, seconds: 0 };
      entry.seconds += record.clippedSeconds;
      works.set(id, entry);
    }
    const topWorks = [...works.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 8);
    const workChart = $("workChart");
    workChart.replaceChildren();
    for (const work of topWorks) {
      const row = document.createElement("div");
      row.className = "link-row bar-row";
      row.role = "button";
      row.tabIndex = 0;
      if (state.focus?.type === "work" && state.focus.value === work.id)
        row.classList.add("is-picked");
      row.innerHTML = `<div class="bar-meta"><strong>${esc(work.title)}</strong><small>${hours(work.seconds)} · ${share(work.seconds, total)}%</small></div><div class="bar-track"><div class="bar-fill" style="width:${(work.seconds / topWorks[0].seconds) * 100}%"></div></div>`;
      row.onclick = () => setFocus("work", work.id, work.title);
      row.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          row.click();
        }
      };
      workChart.append(row);
    }
    if (!topWorks.length) workChart.innerHTML = '<div class="muted-box">暂无数据</div>';
    bar(
      "deviceChart",
      aggregate(records, (r) => r.deviceName || "未知设备").slice(0, 8),
      records.reduce((n, r) => n + r.clippedSeconds, 0),
      (n) => setFocus("device", n, n),
    );
    const played = (state.snapshot?.media || []).filter(
      (m) => (m.type === "Movie" || m.type === "Episode") && m.played,
    );
    $("playedCount").textContent =
      `Jellyfin 当前已观看：${played.filter((m) => m.type === "Movie").length} 部电影 · ${played.filter((m) => m.type === "Episode").length} 集剧集（与播放次数分开统计）`;
    const directorTotals = new Map();
    for (const record of combined) {
      if (record.type !== "Movie" && record.type !== "Episode") continue;
      for (const name of record.directors) {
        const entry = directorTotals.get(name) || { seconds: 0, mediaIds: new Set() };
        entry.seconds += record.clippedSeconds;
        entry.mediaIds.add(`${record.type}:${String(record.itemId)}`);
        directorTotals.set(name, entry);
      }
    }
    const metric = state.directorMetric;
    const directors = [...directorTotals]
        .sort(
          (a, b) =>
            (metric === "count"
              ? b[1].mediaIds.size - a[1].mediaIds.size
              : b[1].seconds - a[1].seconds) ||
            b[1].seconds - a[1].seconds ||
            a[0].localeCompare(b[0]),
        )
        .slice(0, 5),
      el = $("directorChart");
    document.querySelectorAll("[data-director-metric]").forEach((button) => {
      const active = button.dataset.directorMetric === metric;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    el.replaceChildren();
    for (const [i, [name, entry]] of directors.entries()) {
      const row = document.createElement("div");
      row.className = "rank-row";
      row.tabIndex = 0;
      row.role = "button";
      if (state.focus?.type === "director" && state.focus.value === name)
        row.classList.add("is-picked");
      row.innerHTML = `<span><span class="rank-index">${String(i + 1).padStart(2, "0")}</span><span class="rank-name">${esc(name)}</span></span><span class="rank-time">${metric === "count" ? `${entry.mediaIds.size} 项` : hours(entry.seconds)}</span>`;
      row.onclick = () => setFocus("director", name, name);
      row.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      };
      el.append(row);
    }
    if (!directors.length) el.innerHTML = '<div class="muted-box">暂无数据</div>';
  }
  function renderActivities(records, activities) {
    const matches = activities.filter(
      (g) =>
        (state.recordType === "all" ||
          g.records.some(
            (r) =>
              r.type === state.recordType &&
              (!state.recordSearch || r.name.toLocaleLowerCase().includes(state.recordSearch)),
          )) &&
        (!state.recordSearch ||
          g.records.some((r) => r.name.toLocaleLowerCase().includes(state.recordSearch))),
    );
    const pages = Math.max(1, Math.ceil(matches.length / 12));
    state.activityPage = Math.min(state.activityPage, pages);
    const visible = matches.slice((state.activityPage - 1) * 12, state.activityPage * 12),
      el = $("activityRows");
    el.replaceChildren();
    for (const g of visible) {
      const names = [...new Set(g.records.map((r) => r.name))],
        tr = document.createElement("tr");
      tr.dataset.activityKey = g.records
        .map((r) => String(r.id))
        .sort()
        .join("|");
      const details = g.records
        .map(
          (r, i) =>
            `<div>${i + 1}. <strong>${esc(dateLabel(r.start))}</strong>　${esc(r.name)}　${duration(r.seconds)}${r.clippedSeconds < r.seconds ? `（当前范围计入 ${duration(r.clippedSeconds)}）` : ``}<div>客户端：${esc(r.clientName || "未知")} · 设备：${esc(r.deviceName || "未知")} · ${esc(r.playbackMethod || "")} · <button type="button" class="library-edit" data-record-id="${esc(r.id)}">${esc(r.library)} · 修改媒体库</button></div></div>`,
        )
        .join("<hr>");
      tr.innerHTML = `<td><div class="primary">${dayKey(new Date(g.start))}</div><div class="secondary">${esc(dateLabel(new Date(g.start)).slice(11))}—${esc(dateLabel(new Date(g.end)).slice(11))}${dayKey(new Date(g.start)) !== dayKey(new Date(g.end)) ? "（跨日）" : ""} · 结束时间估算</div></td><td><div class="primary">${esc(names[0])}${names.length > 1 ? ` 等 ${names.length} 部作品` : ""}</div><div class="secondary">${g.records.length} 次播放</div><details><summary>查看每次播放</summary><div class="detail">${details}</div></details></td><td>${g.records.map((r) => `<button type="button" class="row-tag library-edit" data-record-id="${esc(r.id)}" title="${esc(r.name)} · ${esc(dateLabel(r.start))}">${esc(r.library)}</button>`).join(" ")}</td><td><span class="num">${duration(g.total)}</span></td><td>${g.records.length > 1 ? "合并记录" : "单次播放"}<div class="secondary">活动跨度 ${duration((g.end - g.start) / 1000)}（估算）</div></td>`;
      el.append(tr);
    }
    if (!visible.length)
      el.innerHTML = '<tr><td colspan="5" class="muted-box">暂无播放记录</td></tr>';
    $("activitySummary").textContent =
      `当前范围 ${records.length} 次播放 · ${activities.length} 次活动 · 符合条件 ${matches.length} 次`;
    $("activityPageInfo").textContent = `${state.activityPage} / ${pages} 页`;
    $("activityPrev").disabled = state.activityPage === 1;
    $("activityNext").disabled = state.activityPage === pages;
    const filter = $("activeFilter");
    filter.replaceChildren();
    filter.style.display = state.focus ? "inline-block" : "none";
    if (state.focus) {
      const button = document.createElement("button");
      button.className = "filter-tag";
      button.textContent = `筛选：${state.focus.label} ×`;
      button.onclick = () => {
        state.focus = null;
        render();
      };
      filter.append(button);
    }
  }
  let editingRecord = null;
  $("activityRows").onclick = (event) => {
    const button = event.target.closest(".library-edit");
    if (!button) return;
    const record = rawRecords().find((entry) => entry.id === button.dataset.recordId);
    if (!record) return;
    editingRecord = record;
    $("libraryContext").textContent =
      `${record.name} · ${dateLabel(record.start)} · 当前：${record.library}`;
    const select = $("librarySelect");
    select.replaceChildren();
    for (const library of state.snapshot?.libraries || []) {
      const option = document.createElement("option");
      option.value = library.id;
      option.textContent = library.name;
      select.append(option);
    }
    const corrections = state.snapshot?.corrections || {};
    const preferred =
      corrections.records?.[record.id] ||
      corrections.items?.[normalizedId(record.itemId)] ||
      record.media?.libraryId;
    select.value = [...select.options].some((option) => option.value === preferred)
      ? preferred
      : select.options[0]?.value || "";
    $("libraryRemember").checked = false;
    $("libraryError").textContent = select.options.length ? "" : "尚无媒体库目录，请先重新同步。";
    $("librarySave").disabled = !select.options.length;
    $("libraryReset").disabled = !corrections.records?.[record.id];
    $("libraryRemember").onchange = () => {
      $("libraryReset").disabled =
        !corrections.records?.[record.id] &&
        !($("libraryRemember").checked && corrections.items?.[normalizedId(record.itemId)]);
    };
    $("libraryDialog").showModal();
  };
  $("libraryCancel").onclick = () => $("libraryDialog").close();
  async function submitLibrary(libraryId) {
    if (!editingRecord) return;
    const remember = $("libraryRemember").checked;
    $("librarySave").disabled = true;
    $("libraryReset").disabled = true;
    try {
      const result = await api.correctWatchLibrary({
        recordId: editingRecord.id,
        libraryId,
        remember,
      });
      applySnapshot(result, false);
      $("libraryDialog").close();
    } catch (error) {
      $("libraryError").textContent = error?.message || String(error);
    } finally {
      $("librarySave").disabled = false;
      $("libraryReset").disabled = false;
    }
  }
  $("librarySave").onclick = () => void submitLibrary($("librarySelect").value);
  $("libraryReset").onclick = () => void submitLibrary(null);
  function render() {
    if (!state.snapshot) return;
    const expandedRows = new Set(
      [...document.querySelectorAll("#activityRows tr")]
        .filter((row) => row.querySelector("details[open]"))
        .map((row) => row.dataset.activityKey),
    );
    mediaMapCache = mediaMap();
    const records = selectedRecords(),
      effectiveRecords =
        state.period === "all"
          ? records.filter(
              (r) =>
                !(state.snapshot?.backfill || []).some(
                  (b) =>
                    b.itemId === r.itemId &&
                    b.baselineAt &&
                    new Date(r.startAt) <= new Date(b.baselineAt) &&
                    !(b.baselineRecordIds || []).includes(r.id),
                ),
            )
          : records,
      combined = [...effectiveRecords, ...selectedBackfill()],
      combinedTotal = combined.reduce((n, r) => n + r.clippedSeconds, 0),
      parts = slices(records),
      activities = groups(records);
    document
      .querySelectorAll("[data-period]")
      .forEach((b) => b.classList.toggle("active", b.dataset.period === state.period));
    $("customDays")
      .closest(".custom-period")
      .classList.toggle("active", state.period === "custom");
    $("backfillHint").textContent =
      state.period !== "all"
        ? "历史补录估算仅计入“全部”时间范围。"
        : !selectedBackfill().length
          ? "暂无可用历史补录。"
          : "";
    renderOverview(records, combined, parts, activities);
    renderReview();
    renderCalendar(parts);
    renderHabits(parts);
    renderSeries();
    renderDistributions(records, combined, combinedTotal);
    renderActivities(records, activities);
    for (const row of $("activityRows").children) {
      if (expandedRows.has(row.dataset.activityKey)) {
        const detail = row.querySelector("details");
        if (detail) detail.open = true;
      }
    }
  }
  function renderReview() {
    const media = (state.snapshot.media || []).filter(
      (m) => m.type === "Movie" || m.type === "Episode",
    );
    const pending = (state.snapshot.candidates || []).filter(
      (c) => c.status === "pending" || c.status === "later",
    );
    const pendingIds = new Set(pending.map((c) => c.itemId));
    for (const id of state.candidateSelection)
      if (!pendingIds.has(id)) state.candidateSelection.delete(id);
    $("candidateCount").textContent = String(pending.length);
    const mediaById = new Map(media.map((m) => [m.id, m]));
    const confirmationCount = new Map();
    for (const entry of state.snapshot.confirmations || [])
      confirmationCount.set(entry.itemId, (confirmationCount.get(entry.itemId) || 0) + 1);
    const matches = pending.filter((c) => {
      const item = mediaById.get(c.itemId),
        n = confirmationCount.get(c.itemId) || 0;
      return (
        (state.candidateType === "all" || item?.type === state.candidateType) &&
        (state.candidateVisit === "all" || (state.candidateVisit === "first" ? n === 0 : n > 0)) &&
        `${item?.seriesName || ""} ${item?.name || c.itemId}`
          .toLocaleLowerCase()
          .includes(state.candidateSearch.trim().toLocaleLowerCase())
      );
    });
    const pages = Math.max(1, Math.ceil(matches.length / 20));
    state.candidatePage = Math.min(state.candidatePage, pages);
    const visible = matches.slice((state.candidatePage - 1) * 20, state.candidatePage * 20);
    const list = $("candidateList");
    list.replaceChildren();
    if (!visible.length) list.textContent = "暂无匹配的待确认观看";
    for (const candidate of visible) {
      const item = mediaById.get(candidate.itemId);
      const evidence = (state.snapshot.records || []).filter((r) =>
        candidate.evidenceIds.includes(r.id),
      );
      const count = confirmationCount.get(candidate.itemId) || 0;
      const row = document.createElement("div");
      row.className = "link-row review-entry";
      const label = document.createElement("label"),
        checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.candidateSelection.has(candidate.itemId);
      checkbox.onchange = () => {
        if (checkbox.checked) state.candidateSelection.add(candidate.itemId);
        else state.candidateSelection.delete(candidate.itemId);
        updateCandidateSelection(visible);
      };
      label.append(
        checkbox,
        document.createTextNode(
          ` ${item?.seriesName ? item.seriesName + " · " : ""}${item?.name || candidate.itemId} · ${count ? "重温" : "首次"} · 已确认 ${count} 次 · 本轮 ${duration(evidence.reduce((n, r) => n + valid(r.durationSec), 0))} · 可能第 ${count + 1} 次 · ${evidence.length ? dayKey(new Date(evidence.at(-1).startAt)) : "Jellyfin 已观看状态"}`,
        ),
      );
      row.append(label);
      for (const [action, text] of [
        ["confirm", "确认完成"],
        ["later", "稍后"],
        ["ignore", "忽略本次"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.onclick = () => void review({ action, itemIds: [candidate.itemId] });
        row.append(button);
      }
      list.append(row);
    }
    $("candidatePageInfo").textContent =
      `${state.candidatePage} / ${pages} 页 · ${matches.length} 项`;
    $("candidatePrev").disabled = state.candidatePage <= 1;
    $("candidateNext").disabled = state.candidatePage >= pages;
    updateCandidateSelection(visible);
  }
  function updateCandidateSelection(visible) {
    const box = $("candidateSelectPage");
    box.checked =
      visible.length > 0 && visible.every((c) => state.candidateSelection.has(c.itemId));
    box.indeterminate = !box.checked && visible.some((c) => state.candidateSelection.has(c.itemId));
    $("candidateSelection").textContent = `本页已选 ${state.candidateSelection.size} 项`;
    $("candidateBatch").disabled = !state.candidateSelection.size;
  }
  async function review(input) {
    if (input.itemIds && !input.itemIds.length) return;
    try {
      const result = await api.reviewWatchStatistics(input);
      invalidateWatchPreview();
      state.watchStatus = "修改已保存";
      if (result) applySnapshot(result, false);
      return true;
    } catch (error) {
      showWatchError($("breakdownContent"), error);
      return false;
    }
  }
  function setBreakdown(type) {
    state.breakdown = state.breakdown === type ? null : type;
    state.watchItem = null;
    state.watchSeries = null;
    state.watchSeason = null;
    state.watchBatch = false;
    state.watchSelection.clear();
    invalidateWatchPreview();
    $("breakdownShell").classList.toggle("open", !!state.breakdown);
    $("breakdownShell").inert = !state.breakdown;
    $("breakdownShell").setAttribute("aria-hidden", String(!state.breakdown));
    $("movieBreakdown").hidden = state.breakdown !== "Movie";
    $("episodeBreakdown").hidden = state.breakdown !== "Episode";
    for (const [kind, id] of [
      ["Movie", "moviesCount"],
      ["Episode", "episodesCount"],
    ])
      $(id).setAttribute("aria-expanded", String(state.breakdown === kind));
  }
  $("breakdownShell").inert = true;
  $("breakdownShell").setAttribute("aria-hidden", "true");
  $("moviesCount").closest(".kpi").onclick = () => setBreakdown("Movie");
  $("episodesCount").closest(".kpi").onclick = () => setBreakdown("Episode");
  for (const [id, kind] of [
    ["moviesCount", "Movie"],
    ["episodesCount", "Episode"],
  ]) {
    $(id).role = "button";
    $(id).tabIndex = 0;
    $(id).setAttribute("aria-controls", "breakdownShell");
    $(id).setAttribute("aria-expanded", "false");
    $(id).onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setBreakdown(kind);
      }
    };
  }
  for (const [id, key] of [
    ["candidateType", "candidateType"],
    ["candidateVisit", "candidateVisit"],
  ]) {
    $(id).onchange = () => {
      state[key] = $(id).value;
      state.candidatePage = 1;
      state.candidateSelection.clear();
      renderReview();
    };
  }
  const candidateSearch = $("candidateSearch");
  const updateCandidateSearch = () => {
    state.candidateSearch = candidateSearch.value;
    state.candidatePage = 1;
    state.candidateSelection.clear();
    renderReview();
  };
  candidateSearch.addEventListener("compositionstart", () => {
    candidateSearch.isComposing = true;
  });
  candidateSearch.oninput = (event) => {
    if (!candidateSearch.isComposing && !event.isComposing) updateCandidateSearch();
  };
  candidateSearch.addEventListener("compositionend", () => {
    candidateSearch.isComposing = false;
    updateCandidateSearch();
  });
  $("candidatePrev").onclick = () => {
    state.candidatePage--;
    state.candidateSelection.clear();
    renderReview();
  };
  $("candidateNext").onclick = () => {
    state.candidatePage++;
    state.candidateSelection.clear();
    renderReview();
  };
  $("candidateSelectPage").onchange = () => {
    const select = $("candidateSelectPage").checked;
    for (const row of $("candidateList").children) {
      const checkbox = row.querySelector("input[type=checkbox]");
      if (checkbox) {
        checkbox.checked = select;
        checkbox.dispatchEvent(new Event("change"));
      }
    }
  };
  $("candidateBatch").onclick = () =>
    void review({ action: "confirm", itemIds: [...state.candidateSelection] });
  function applySnapshot(result, restoreSettings) {
    const ids = state.watchPreview?.input.itemIds || [...state.watchSelection];
    if (
      !state.snapshot ||
      !ids.length ||
      watchPreviewSignature(state.snapshot, ids) !== watchPreviewSignature(result, ids)
    )
      invalidateWatchPreview();
    state.snapshot = result;
    if (restoreSettings) {
      state.gap = num(result.settings?.gapMinutes) || 15;
      state.excludeShort = !!result.settings?.excludeShort;
      state.rewatchMinutes = num(result.settings?.rewatchMinutes) || 10;
      $("rewatchMinutes").value = String(state.rewatchMinutes);
      $("gapSelect").value = String(state.gap);
      $("excludeShort").checked = state.excludeShort;
    }
    render();
    $("refreshStatus").textContent =
      `上次更新：${result.refreshedAt ? dateLabel(new Date(result.refreshedAt)) : "尚未同步"}`;
  }
  async function load(refresh = false) {
    const button = $("refreshBtn");
    if (refresh) {
      if (manualRefresh) return;
      button.disabled = true;
      button.textContent = "正在同步……";
    }
    $("refreshStatus").textContent = refresh
      ? "正在刷新 Jellyfin 数据……"
      : "正在读取本地统计数据……";
    try {
      if (!api) throw new Error("统计接口不可用，请在应用内打开此页面");
      if (refresh) {
        await api.refreshWatchStatistics();
        manualRefresh = true;
        $("refreshStatus").textContent = "完整同步正在后台进行，完成后自动更新统计。";
        refreshPoll = setInterval(() => {
          api
            .getWatchStatisticsStatus()
            .then(updateRefreshStatus)
            .catch((error) => {
              $("refreshStatus").textContent =
                `查询同步状态失败：${error?.message || String(error)}`;
            });
        }, 3000);
        updateRefreshStatus(await api.getWatchStatisticsStatus());
        return;
      }
      const result = await api.getWatchStatistics();
      if (!result) {
        $("refreshStatus").textContent = "暂无统计数据，点击“重新同步”从 Jellyfin 读取。";
        return;
      }
      applySnapshot(result, !state.snapshot);
      $("refreshStatus").textContent =
        `${refresh ? "刷新完成" : "数据已读取"} · 最近刷新：${result.refreshedAt ? dateLabel(new Date(result.refreshedAt)) : "尚未刷新"}`;
    } catch (error) {
      $("refreshStatus").textContent =
        `刷新失败：${error?.message || String(error)}${state.snapshot ? "。已有统计数据仍可查看。" : "。"}`;
    } finally {
      if (!manualRefresh) {
        button.disabled = false;
        button.textContent = "重新同步";
      }
    }
  }
  async function save() {
    try {
      await api.saveWatchStatisticsSettings({
        gapMinutes: state.gap,
        excludeShort: state.excludeShort,
        includeBackfill: true,
        rewatchMinutes: state.rewatchMinutes,
      });
    } catch (error) {
      $("refreshStatus").textContent = `设置保存失败：${error?.message || String(error)}`;
    }
  }
  $("periodBtns").onclick = (e) => {
    const b = e.target.closest("[data-period]");
    if (b) {
      if (b.dataset.period === "custom") {
        const input = $("customDays");
        if (
          !/^[1-9]\d*$/.test(input.value) ||
          !Number.isSafeInteger(Number(input.value)) ||
          Number(input.value) > 100000
        ) {
          input.setCustomValidity("请输入 1–100000 的整数天数");
          input.reportValidity();
          return;
        }
        input.setCustomValidity("");
        state.customDays = Number(input.value);
      }
      state.period = b.dataset.period;
      state.watchItem = null;
      state.watchSeries = null;
      state.watchSeason = null;
      state.watchSelection.clear();
      state.watchBatch = false;
      invalidateWatchPreview();
      state.calendarYear = null;
      state.focus = null;
      state.activityPage = 1;
      render();
    }
  };
  $("customDays").onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("periodBtns").querySelector('[data-period="custom"]').click();
    }
  };
  $("customDays").oninput = (event) => event.target.setCustomValidity("");
  $("calendarYear").onchange = (event) => {
    state.calendarYear = Number(event.target.value);
    renderCalendar(slices(selectedRecords()));
  };
  $("refreshBtn").onclick = () => load(true);
  $("pathDetectBtn").onclick = async () => {
    try {
      const status = await api.autoDiscoverWatchStatisticsPath();
      await updatePathFallback();
      if (status?.path && !status.needsManualPath)
        $("refreshStatus").textContent = "数据库已定位，请重新同步。";
    } catch (error) {
      $("pathFallbackText").textContent = `自动检测失败：${error?.message || String(error)}`;
    }
  };
  $("pathChooseBtn").onclick = async () => {
    try {
      const status = await api.chooseWatchStatisticsPath();
      await updatePathFallback();
      if (status?.path && !status.needsManualPath)
        $("refreshStatus").textContent = "数据库位置已保存，请重新同步。";
    } catch (error) {
      $("pathFallbackText").textContent = `选择数据库失败：${error?.message || String(error)}`;
    }
  };
  $("exportBtn").onclick = async () => {
    try {
      const path = await api.exportWatchStatistics();
      if (path) $("refreshStatus").textContent = `数据已导出：${path}`;
    } catch (error) {
      $("refreshStatus").textContent = `导出失败：${error?.message || String(error)}`;
    }
  };
  $("importBtn").onclick = async () => {
    try {
      const preview = await api.previewWatchStatisticsImport();
      if (!preview) return;
      const count = (value) => num(value?.length ?? value);
      const range =
        preview.earliestAt && preview.latestAt
          ? `${dayKey(new Date(preview.earliestAt))} 至 ${dayKey(new Date(preview.latestAt))}`
          : "无可确定的播放日期";
      $("importPreviewText").textContent =
        `播放记录 ${count(preview.records)} 条 · 历史补录 ${count(preview.backfill)} 条 · 作品 ${count(preview.media)} 项 · 时间范围 ${range}。导入会替换当前统计数据，程序会先备份原数据。`;
      $("importDialog").showModal();
    } catch (error) {
      $("refreshStatus").textContent = `读取导入文件失败：${error?.message || String(error)}`;
    }
  };
  $("importConfirm").onclick = async () => {
    const button = $("importConfirm");
    button.disabled = true;
    try {
      const result = await api.importWatchStatistics();
      if (result) applySnapshot(result, true);
      $("importDialog").close();
      $("refreshStatus").textContent = "导入完成，已更新观影统计。";
    } catch (error) {
      $("refreshStatus").textContent =
        `导入失败：${error?.message || String(error)}。原有统计仍可查看。`;
      $("importDialog").close();
    } finally {
      button.disabled = false;
    }
  };
  $("printBtn").onclick = () => window.print();
  $("gapSelect").onchange = (e) => {
    state.gap = num(e.target.value) || 15;
    state.activityPage = 1;
    render();
    void save();
  };
  $("rewatchMinutes").onchange = (e) => {
    state.rewatchMinutes = Math.max(1, Math.min(240, num(e.target.value) || 10));
    e.target.value = String(state.rewatchMinutes);
    void save();
  };
  $("excludeShort").onchange = (e) => {
    state.excludeShort = e.target.checked;
    state.activityPage = 1;
    render();
    void save();
  };
  $("recordType").onchange = (e) => {
    state.recordType = e.target.value;
    state.activityPage = 1;
    render();
  };
  const recordSearch = $("recordSearch");
  const updateRecordSearch = () => {
    state.recordSearch = recordSearch.value.trim().toLocaleLowerCase();
    state.activityPage = 1;
    render();
  };
  recordSearch.addEventListener("compositionstart", () => {
    recordSearch.isComposing = true;
  });
  recordSearch.oninput = (event) => {
    if (!recordSearch.isComposing && !event.isComposing) updateRecordSearch();
  };
  recordSearch.addEventListener("compositionend", () => {
    recordSearch.isComposing = false;
    updateRecordSearch();
  });
  $("seriesTabs").onclick = (e) => {
    const b = e.target.closest("[data-series]");
    if (b) {
      state.seriesMode = b.dataset.series;
      state.seriesPage = 1;
      renderSeries();
    }
  };
  $("directorMetric").onclick = (event) => {
    const button = event.target.closest("[data-director-metric]");
    if (!button || !["duration", "count"].includes(button.dataset.directorMetric)) return;
    state.directorMetric = button.dataset.directorMetric;
    render();
  };
  $("genreToggle").onclick = () => {
    state.genresExpanded = !state.genresExpanded;
    render();
  };
  $("seriesPrev").onclick = () => {
    state.seriesPage--;
    renderSeries();
  };
  $("seriesNext").onclick = () => {
    state.seriesPage++;
    renderSeries();
  };
  $("activityPrev").onclick = () => {
    state.activityPage--;
    renderActivities(selectedRecords(), groups(selectedRecords()));
  };
  $("activityNext").onclick = () => {
    state.activityPage++;
    renderActivities(selectedRecords(), groups(selectedRecords()));
  };
  void load();
  api
    .getWatchStatisticsStatus()
    .then(showSyncStatus)
    .catch(() => {});
  void updatePathFallback();
})();
