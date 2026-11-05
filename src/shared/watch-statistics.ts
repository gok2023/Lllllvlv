export interface WatchMedia {
  id: string;
  name: string;
  type: string;
  seriesId?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  libraryId?: string;
  libraryName?: string;
  runtimeSec?: number;
  year?: number;
  genres: string[];
  directors: string[];
  played: boolean;
  playCount: number;
  lastPlayedAt?: string;
  positionSec?: number;
  providerIds?: Record<string, string>;
  sourceId?: string;
}
export interface WatchRecord {
  id: string;
  itemId: string;
  itemName: string;
  itemType: string;
  startAt: string;
  durationSec: number;
  clientName?: string;
  deviceName?: string;
  playbackMethod?: string;
  userId?: string;
  rawDate?: string;
  sourceKey?: string;
}
export interface WatchBackfill {
  itemId: string;
  durationSec: number;
  watchedAt?: string;
}
export interface WatchStatisticsSettings {
  gapMinutes: number;
  includeBackfill: boolean;
  excludeShort: boolean;
}
export interface WatchStatisticsSnapshot {
  serverId: string;
  refreshedAt: string;
  media: WatchMedia[];
  records: WatchRecord[];
  backfill: WatchBackfill[];
  settings: WatchStatisticsSettings;
  cursor?: string;
}
export interface WatchStatisticsImportPreview {
  version: number;
  records: number;
  backfill: number;
  media: number;
  earliestAt?: string;
  latestAt?: string;
  exportedAt?: string;
}
