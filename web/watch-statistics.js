(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const api = (() => {
    let nextId = 0;
    const pending = new Map();
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || event.data?.channel !== "watch-statistics") return;
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
    focus: null,
    seriesMode: "all",
    seriesPage: 1,
    activityPage: 1,
    recordType: "all",
    recordSearch: "",
    gap: 15,
    excludeShort: false,
    includeBackfill: false,
    calendarYear: null,
    directorMetric: "duration",
    genresExpanded: false,
  };
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
    else if (state.period === "d90") start.setDate(start.getDate() - 89);
    else return [null, end];
    return [start, end];
  };
  const mediaMap = () => new Map((state.snapshot?.media || []).map((m) => [String(m.id), m]));
  const rawRecords = () =>
    (state.snapshot?.records || [])
      .map((r) => {
        const start = new Date(r.startAt),
          seconds = valid(r.durationSec),
          m = mediaMapCache.get(String(r.itemId));
        return {
          ...r,
          start,
          seconds,
          media: m,
          name: r.itemName || m?.name || "未知作品",
          type: m?.type || r.itemType,
          library: m?.libraryName || "未匹配",
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
    if (!state.includeBackfill || state.period !== "all") return [];
    if (state.focus?.type === "day" || state.focus?.type === "device") return [];
    const recorded = new Set(rawRecords().map((r) => String(r.itemId)));
    const seen = new Set();
    return (state.snapshot?.backfill || [])
      .filter((b) => {
        const id = String(b.itemId);
        if (recorded.has(id) || seen.has(id) || !valid(b.durationSec)) return false;
        seen.add(id);
        return true;
      })
      .map((b) => {
        const m = mediaMapCache.get(String(b.itemId));
        return {
          itemId: b.itemId,
          name: m?.name || "未知作品",
          type: m?.type,
          seriesId: m?.seriesId,
          library: m?.libraryName || "未匹配",
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
  function renderOverview(records, combined, parts, activities) {
    const actual = parts.total,
      backfill = combined
        .filter((r) => r.source === "estimate")
        .reduce((n, r) => n + r.clippedSeconds, 0);
    animate("totalHours", (actual + backfill) / 3600, "小时", 1);
    animate(
      "moviesCount",
      new Set(combined.filter((r) => r.type === "Movie").map((r) => r.itemId)).size,
      "部",
    );
    animate(
      "episodesCount",
      new Set(combined.filter((r) => r.type === "Episode").map((r) => r.itemId)).size,
      "集",
    );
    animate("activeDays", [...parts.daily.values()].filter(Boolean).length, "天");
    $("timeFoot").textContent = `实际 ${hours(actual)} · 历史补录估算 ${hours(backfill)}`;
    $("daysFoot").textContent = `${records.length} 次播放 · ${activities.length} 次观影活动`;
    $("sessionFoot").textContent =
      `最长活动实际播放 ${duration(Math.max(0, ...activities.map((g) => g.total)))} · 活动时间跨度按记录起点和时长估算，间隔不计入播放。`;
    $("rangeHint").textContent = {
      year: `统计时间：${now().getFullYear()} 年`,
      d90: "统计时间：近 90 天",
      d30: "统计时间：近 30 天",
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
          total: 0,
          watched: 0,
        });
    }
    for (const ep of episodes) {
      const s = series.get(ep.seriesId) || {
        id: ep.seriesId,
        name: ep.seriesName || "未知剧集",
        library: ep.libraryName || "未匹配",
        total: 0,
        watched: 0,
      };
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
      const cells = Array.from(
        { length: Math.min(s.total, 150) },
        (_, i) => `<i class="${i < s.watched ? "done" : i === s.watched ? "current" : ""}"></i>`,
      ).join("");
      row.innerHTML = `<div class="series-top"><span class="series-name">${esc(s.name)}</span><span class="series-num">${s.watched} / ${s.total} 集</span></div><div class="series-cells">${cells}</div><div class="series-bottom"><span>${esc(s.library)} · ${last.has(s.id) ? "最近观看 " + dayKey(last.get(s.id)) : "暂无播放记录"}</span><span>${s.watched === s.total ? "已看完" : "还有 " + (s.total - s.watched) + " 集未观看"}</span></div>`;
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
        libs = [...new Set(g.records.map((r) => r.library))],
        tr = document.createElement("tr");
      tr.dataset.activityKey = g.records
        .map((r) => String(r.id))
        .sort()
        .join("|");
      const details = g.records
        .map(
          (r, i) =>
            `<div>${i + 1}. <strong>${esc(dateLabel(r.start))}</strong>　${esc(r.name)}　${duration(r.seconds)}${r.clippedSeconds < r.seconds ? `（当前范围计入 ${duration(r.clippedSeconds)}）` : ``}<div>客户端：${esc(r.clientName || "未知")} · 设备：${esc(r.deviceName || "未知")} · ${esc(r.playbackMethod || "")}</div></div>`,
        )
        .join("<hr>");
      tr.innerHTML = `<td><div class="primary">${dayKey(new Date(g.start))}</div><div class="secondary">${esc(dateLabel(new Date(g.start)).slice(11))}—${esc(dateLabel(new Date(g.end)).slice(11))}${dayKey(new Date(g.start)) !== dayKey(new Date(g.end)) ? "（跨日）" : ""} · 结束时间估算</div></td><td><div class="primary">${esc(names[0])}${names.length > 1 ? ` 等 ${names.length} 部作品` : ""}</div><div class="secondary">${g.records.length} 次播放</div><details><summary>查看每次播放</summary><div class="detail">${details}</div></details></td><td><span class="row-tag">${esc(libs.join("、"))}</span></td><td><span class="num">${duration(g.total)}</span></td><td>${g.records.length > 1 ? "合并记录" : "单次播放"}<div class="secondary">活动跨度 ${duration((g.end - g.start) / 1000)}（估算）</div></td>`;
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
  function render() {
    if (!state.snapshot) return;
    const expandedRows = new Set(
      [...document.querySelectorAll("#activityRows tr")]
        .filter((row) => row.querySelector("details[open]"))
        .map((row) => row.dataset.activityKey),
    );
    mediaMapCache = mediaMap();
    const records = selectedRecords(),
      combined = [...records, ...selectedBackfill()],
      combinedTotal = combined.reduce((n, r) => n + r.clippedSeconds, 0),
      parts = slices(records),
      activities = groups(records);
    document
      .querySelectorAll("[data-period]")
      .forEach((b) => b.classList.toggle("active", b.dataset.period === state.period));
    $("backfillHint").textContent =
      state.period !== "all"
        ? "历史补录估算仅计入“全部”时间范围。"
        : state.includeBackfill && !selectedBackfill().length
          ? "暂无可用历史补录。"
          : "";
    renderOverview(records, combined, parts, activities);
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
  function applySnapshot(result, restoreSettings) {
    state.snapshot = result;
    if (restoreSettings) {
      state.gap = num(result.settings?.gapMinutes) || 15;
      state.excludeShort = !!result.settings?.excludeShort;
      state.includeBackfill = !!result.settings?.includeBackfill;
      $("gapSelect").value = String(state.gap);
      $("excludeShort").checked = state.excludeShort;
      $("includeBackfill").checked = state.includeBackfill;
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
        includeBackfill: state.includeBackfill,
      });
    } catch (error) {
      $("refreshStatus").textContent = `设置保存失败：${error?.message || String(error)}`;
    }
  }
  $("periodBtns").onclick = (e) => {
    const b = e.target.closest("[data-period]");
    if (b) {
      state.period = b.dataset.period;
      state.calendarYear = null;
      state.focus = null;
      state.activityPage = 1;
      render();
    }
  };
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
    save();
  };
  $("excludeShort").onchange = (e) => {
    state.excludeShort = e.target.checked;
    state.activityPage = 1;
    render();
    save();
  };
  $("includeBackfill").onchange = (e) => {
    state.includeBackfill = e.target.checked;
    if (state.includeBackfill && state.period !== "all") {
      state.period = "all";
      state.focus = null;
      state.calendarYear = null;
    }
    render();
    save();
  };
  $("recordType").onchange = (e) => {
    state.recordType = e.target.value;
    state.activityPage = 1;
    render();
  };
  $("recordSearch").oninput = (e) => {
    state.recordSearch = e.target.value.trim().toLocaleLowerCase();
    state.activityPage = 1;
    render();
  };
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
  load();
  api
    .getWatchStatisticsStatus()
    .then(showSyncStatus)
    .catch(() => {});
  void updatePathFallback();
})();
