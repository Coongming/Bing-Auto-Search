export const REWARDS_REQUEST_TIMEOUT_MS = 4000;

export function extractRewardsUserStatus(data) {
  for (const status of [
    data?.status?.userStatus,
    data?.dashboard?.userStatus,
  ]) {
    if (
      status &&
      typeof status === "object" &&
      !Array.isArray(status) &&
      status.isRewardsUser !== false
    )
      return status;
  }
  // Log structure only, never the account payload or authentication values.
  const keys =
    Object.keys(data || {})
      .slice(0, 12)
      .join(", ") || "none";
  throw new Error(
    `Rewards response has no usable userStatus (response keys: ${keys}).`,
  );
}

// Bound both the HTTP request and JSON body. A stalled Rewards API must not
// keep the activity engine busy forever after the last card was clicked.
export async function readRewardsUserStatus({
  fetchFn = fetch,
  timeoutMs = REWARDS_REQUEST_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Rewards request timed out after ${timeoutMs}ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchFn(
          "https://rewards.bing.com/api/getuserinfo",
          {
            cache: "no-store",
            credentials: "include",
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return extractRewardsUserStatus(data);
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A retry flag alone is not progress. Allow scrolling through a long page, but
// stop when repeated scans stay at the same position without any interaction.
export function createActivityScanTracker({
  maxIdle = 2,
  maxStalled = 2,
} = {}) {
  let idle = 0;
  let stalled = 0;
  let lastPosition = null;
  return {
    observe(result) {
      const interacted =
        Number(result.attempted) > 0 ||
        Number(result.clicked) > 0 ||
        Number(result.processed) > 0 ||
        Number(result.pointDelta) > 0;
      if (interacted) {
        idle = 0;
        stalled = 0;
        lastPosition = null;
        return { stop: false };
      }
      if (!result.retry) {
        stalled = 0;
        idle++;
        return { stop: idle >= maxIdle, reason: "no runnable cards" };
      }
      idle = 0;
      const position = result.scanPosition;
      if (Number.isFinite(position) && position !== lastPosition) {
        stalled = 0;
      } else {
        stalled++;
      }
      lastPosition = Number.isFinite(position) ? position : null;
      return { stop: stalled >= maxStalled, reason: "scan made no progress" };
    },
  };
}
