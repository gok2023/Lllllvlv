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
  /** Records already known when this estimate was created are covered by it. */
  baselineRecordIds?: string[];
  baselineAt?: string;
}
export interface WatchConfirmation {
  id: string;
  itemId: string;
  source: "initial" | "confirmed" | "rewatch" | "manual";
  confirmedAt?: string;
  evidenceIds: string[];
  estimatedDurationSec?: number;
  baselineAt?: string;
}
export interface WatchCandidate {
  itemId: string;
  evidenceIds: string[];
  status: "accumulating" | "pending" | "later" | "ignored";
}
export type WatchReviewAction =
  | { action: "confirm" | "ignore" | "later"; itemIds: string[] }
  | { action: "confirmDirect"; itemIds: string[] }
  | { action: "manual"; itemIds: string[]; totalCount: number; estimate: boolean }
  | { action: "revoke"; confirmationId: string }
  | (WatchBatchReviewInput & { token: string; operationId: string });
export interface WatchBatchReviewInput {
  action: "batch";
  itemIds: string[];
  mode: "set" | "increase" | "decrease" | "estimate";
  totalCount?: number;
  estimate?: boolean;
  estimated?: boolean;
}
export interface WatchBatchReviewPreview {
  token: string;
  itemCount: number;
  changedCount: number;
  countBefore: number;
  countAfter: number;
  countDelta: number;
  estimateBeforeSec: number;
  estimateAfterSec: number;
  estimateDeltaSec: number;
  actualDurationDeltaSec: 0;
  items: {
    itemId: string;
    beforeCount: number;
    afterCount: number;
    estimateDeltaSec: number;
    estimateBeforeSec: number;
    estimateAfterSec: number;
    estimatedBeforeCount: number;
    estimatedAfterCount: number;
    estimateUnavailable: boolean;
    changed: boolean;
  }[];
}
export interface WatchStatisticsSettings {
  gapMinutes: number;
  includeBackfill: boolean;
  excludeShort: boolean;
  rewatchMinutes?: number;
}
export interface WatchStatisticsSnapshot {
  serverId: string;
  refreshedAt: string;
  media: WatchMedia[];
  records: WatchRecord[];
  backfill: WatchBackfill[];
  settings: WatchStatisticsSettings;
  cursor?: string;
  libraries?: { id: string; name: string }[];
  corrections?: { records: Record<string, string>; items: Record<string, string> };
  confirmations?: WatchConfirmation[];
  candidates?: WatchCandidate[];
  appliedReviewIds?: string[];
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
