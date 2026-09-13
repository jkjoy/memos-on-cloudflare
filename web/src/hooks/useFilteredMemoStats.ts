import { timestampDate } from "@bufbuild/protobuf/wkt";
import dayjs from "dayjs";
import { countBy } from "lodash-es";
import { useMemo } from "react";
import type { MemoExplorerContext } from "@/components/MemoExplorer";
import { type MemoTimeBasis, useView } from "@/contexts/ViewContext";
import { buildMemoCreatorFilter } from "@/helpers/resource-names";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useMemos } from "@/hooks/useMemoQueries";
import { useUserStats } from "@/hooks/useUserQueries";
import { State } from "@/types/proto/api/v1/common_pb";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import type { StatisticsData } from "@/types/statistics";

export interface FilteredMemoStats {
  statistics: StatisticsData;
  tags: Record<string, number>;
  loading: boolean;
}

export interface UseFilteredMemoStatsOptions {
  userName?: string;
  context?: MemoExplorerContext;
}

const toDateString = (date: Date) => dayjs(date).format("YYYY-MM-DD");

const memoTimestampForBasis = (memo: Memo, basis: MemoTimeBasis): Date | undefined => {
  const ts = basis === "update_time" ? memo.updateTime : memo.createTime;
  return ts ? timestampDate(ts) : undefined;
};

export const useFilteredMemoStats = (options: UseFilteredMemoStatsOptions = {}): FilteredMemoStats => {
  const { userName, context } = options;
  const currentUser = useCurrentUser();
  const { timeBasis } = useView();

  // home/profile: use backend per-user stats (full tag set, not page-limited)
  const { data: userStats, isLoading: isLoadingUserStats } = useUserStats(userName);

  // explore: fetch memos with visibility filter to exclude private content.
  // ListMemos AND's the request filter with the server's auth filter, so private
  // memos are always excluded regardless of backend version.
  // archived: use an archived, current-user-scoped list until a dedicated archived
  // stats endpoint is available. Home/profile use user stats and do not need a list.
  const exploreVisibilityFilter = currentUser != null ? 'visibility in ["PUBLIC", "PROTECTED"]' : 'visibility in ["PUBLIC"]';
  const memoQueryParams =
    context === "explore"
      ? { filter: exploreVisibilityFilter, pageSize: 1000 }
      : context === "archived"
        ? { state: State.ARCHIVED, filter: buildMemoCreatorFilter(currentUser?.name ?? "") }
        : {};
  const memoStatsEnabled = context === "explore" || (context === "archived" && !!currentUser?.name) || (!context && !userName);
  const { data: memosResponse, isLoading: isLoadingMemos } = useMemos(memoQueryParams, { enabled: memoStatsEnabled });

  const data = useMemo(() => {
    const loading = isLoadingUserStats || (memoStatsEnabled && isLoadingMemos);
    let activityStats: Record<string, number> = {};
    let tagCount: Record<string, number> = {};

    if (context === "explore") {
      // Tags and activity stats from visibility-filtered memos (no private content).
      for (const memo of memosResponse?.memos ?? []) {
        for (const tag of memo.tags ?? []) {
          tagCount[tag] = (tagCount[tag] ?? 0) + 1;
        }
      }
      const displayDates = (memosResponse?.memos ?? [])
        .map((memo: Memo) => memoTimestampForBasis(memo, timeBasis))
        .filter((date: Date | undefined): date is Date => date !== undefined)
        .map(toDateString);
      activityStats = countBy(displayDates);
    } else if (userName && userStats) {
      // home/profile: use backend per-user stats.
      //
      // protobuf-es generates repeated fields as non-optional T[], so an old
      // server that doesn't know the new field deserializes it as []. Since
      // memo.updated_ts is initialized to created_ts at row creation, the two
      // arrays are always the same length when there are memos. Length
      // divergence (created non-empty AND updated empty) therefore reliably
      // signals "old server" and is the only case where we fall back.
      const createdArray = userStats.memoCreatedTimestamps ?? [];
      const updatedArray = userStats.memoUpdatedTimestamps ?? [];
      const wantUpdated = timeBasis === "update_time";
      const oldServerFallback = wantUpdated && updatedArray.length === 0 && createdArray.length > 0;
      if (oldServerFallback) {
        console.warn("UserStats.memo_updated_timestamps not present; falling back to memo_created_timestamps");
      }
      const sourceArray = wantUpdated && !oldServerFallback ? updatedArray : createdArray;
      if (sourceArray.length > 0) {
        activityStats = countBy(
          sourceArray
            .map((ts: { seconds?: number | bigint | string } | undefined) => (ts ? timestampDate(ts) : undefined))
            .filter((date: Date | undefined): date is Date => date !== undefined)
            .map(toDateString),
        );
      }
      if (userStats.tagCount) {
        tagCount = userStats.tagCount;
      }
    } else if (memosResponse?.memos) {
      // archived/fallback: compute from cached memos
      const displayDates = memosResponse.memos
        .map((memo: Memo) => memoTimestampForBasis(memo, timeBasis))
        .filter((date: Date | undefined): date is Date => date !== undefined)
        .map(toDateString);
      activityStats = countBy(displayDates);
      for (const memo of memosResponse.memos) {
        for (const tag of memo.tags ?? []) {
          tagCount[tag] = (tagCount[tag] || 0) + 1;
        }
      }
    }

    return { statistics: { activityStats, timeBasis }, tags: tagCount, loading };
  }, [context, userName, userStats, memosResponse, isLoadingUserStats, isLoadingMemos, memoStatsEnabled, timeBasis]);

  return data;
};
