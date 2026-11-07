export const playbackActivityColumns = [
  "DateCreated",
  "UserId",
  "ItemId",
  "ItemType",
  "ItemName",
  "PlayDuration",
  "ClientName",
  "DeviceName",
  "PlaybackMethod",
] as const;

export type PlaybackActivity = {
  DateCreated: string;
  UserId: string;
  ItemId: string;
  ItemType: string;
  ItemName: string;
  PlayDuration: number | string;
  ClientName?: string;
  DeviceName?: string;
  PlaybackMethod?: string;
};

const selection = `SELECT CAST(DateCreated AS TEXT) AS DateCreated, ${playbackActivityColumns.slice(1).join(", ")} FROM PlaybackActivity WHERE lower(replace(UserId, '-', '')) = `;

export function playbackActivityQuery(userId: string, since?: string): string {
  return `${selection}'${userId}'${since ? ` AND DateCreated >= '${since}'` : ""} ORDER BY DateCreated DESC`;
}

export function playbackActivityLocalQuery(since?: string): string {
  return `${selection}?${since ? " AND DateCreated >= ?" : ""} ORDER BY DateCreated DESC`;
}

export function hasPlaybackActivityColumns(names: ReadonlySet<string>): boolean {
  return playbackActivityColumns.every((name) => names.has(name));
}

const emptyMessage = /^Query executed, no data returned\.<\/br>Number of rows effected : \d+$/;

export function parsePlaybackActivityResponse(value: unknown): PlaybackActivity[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Playback Reporting 响应结构无效");
  const response = value as Record<string, unknown>;
  const { colums, results, message } = response;
  if (message !== undefined && typeof message !== "string")
    throw new Error("Playback Reporting 响应消息无效");
  if (
    typeof message === "string" &&
    emptyMessage.test(message) &&
    Array.isArray(colums) &&
    colums.length === 0 &&
    Array.isArray(results) &&
    results.length === 0
  )
    return [];
  if (message) throw new Error("Playback Reporting 查询失败");
  if (
    !Array.isArray(colums) ||
    !colums.every((column) => typeof column === "string") ||
    new Set(colums).size !== colums.length ||
    !hasPlaybackActivityColumns(new Set(colums)) ||
    !Array.isArray(results)
  )
    throw new Error("Playback Reporting 响应列无效");
  return results.map((row) => {
    if (!Array.isArray(row) || row.length !== colums.length)
      throw new Error("Playback Reporting 响应行无效");
    const activity = Object.fromEntries(
      colums.map((column, index) => [column, row[index]]),
    ) as PlaybackActivity;
    const duration: unknown = activity.PlayDuration;
    if (
      typeof activity.DateCreated !== "string" ||
      !activity.DateCreated ||
      typeof activity.UserId !== "string" ||
      !activity.UserId ||
      typeof activity.ItemId !== "string" ||
      !activity.ItemId ||
      (typeof duration !== "number" && typeof duration !== "string") ||
      duration === "" ||
      !Number.isFinite(Number(duration))
    )
      throw new Error("Playback Reporting 播放记录字段无效");
    return activity;
  });
}
