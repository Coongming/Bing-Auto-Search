/**
 * Pure helpers for reading Rewards points/counters out of the getuserinfo
 * payload. Extracted from service.js so they can be unit-tested by actually
 * executing them (not string-matching the source).
 */

// Deep-search an object graph for the first numeric value under any of `names`.
export function findFirstNumberByKey(source, names) {
  const targets = new Set(names.map((name) => name.toLowerCase()));
  const stack = [source];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const [key, value] of Object.entries(current)) {
      if (
        targets.has(key.toLowerCase()) &&
        value != null &&
        value !== "" &&
        typeof value !== "object"
      ) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
      }
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return null;
}

export function getCounterValue(arr, key) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const item = arr[0];
  if (item == null) return 0; // guard a literal null first element
  const attr = item.attributes || item;
  const value = Number(attr[key] ?? item[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function sumCounterProgress(counters) {
  if (!counters || typeof counters !== "object") return 0;
  let total = 0;
  for (const value of Object.values(counters)) {
    if (Array.isArray(value)) {
      total += getCounterValue(value, "progress");
    }
  }
  return total;
}

// Build the score snapshot used to detect whether an activity click actually
// earned points. Pure: takes the parsed userStatus object.
export function buildRewardsSnapshot(userStatus) {
  const status = userStatus || {};
  const counters = status?.counters || {};
  const availablePoints = findFirstNumberByKey(status, [
    "availablePoints",
    "redeemablePoints",
    "balance",
    "pointsBalance",
    "pointBalance",
    "availablePoint",
  ]);
  const lifetimePoints = findFirstNumberByKey(status, [
    "lifetimePoints",
    "lifetimePoint",
    "totalPoints",
    "totalPoint",
  ]);
  const counterProgress = sumCounterProgress(counters);
  const score =
    availablePoints ??
    lifetimePoints ??
    (Object.keys(counters).length > 0 ? counterProgress : null);
  return {
    score,
    availablePoints,
    lifetimePoints,
    counterProgress,
    pcProgress: getCounterValue(counters.pcSearch, "progress"),
    mobProgress:
      Array.isArray(counters.mobileSearch) && counters.mobileSearch.length > 0
        ? getCounterValue(counters.mobileSearch, "progress")
        : null,
    mobMax:
      Array.isArray(counters.mobileSearch) && counters.mobileSearch.length > 0
        ? getCounterValue(counters.mobileSearch, "max")
        : null,
  };
}

export function getScoreDelta(before, after) {
  if (!before || !after) return null;
  if (!Number.isFinite(before.score) || !Number.isFinite(after.score))
    return null;
  return after.score - before.score;
}
