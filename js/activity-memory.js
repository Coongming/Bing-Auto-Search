/**
 * Pure helpers for the daily "activity memory" — which Rewards cards have been
 * attempted/confirmed today, so the engine avoids re-clicking the same card and
 * knows when to stop retrying. Extracted from service.js for real unit testing.
 * All functions operate on plain objects / Sets / Maps passed by the caller;
 * storage I/O stays in service.js.
 */

// Cards whose visible label matches an "expand/see more" control must never be
// remembered as attempts (they are navigation, not point-earning activities).
const EXPAND_ATTEMPT_PATTERN =
  /(^|\b)(earn more|show more|see more|view all|load more|more activities|expand|kiếm thêm|xem thêm|hiển thị thêm|mở rộng)(\b|$)/i;

export function sanitizeActivityAttempts(attempts) {
  return Object.fromEntries(
    Object.entries(attempts || {}).filter(
      ([key]) => !EXPAND_ATTEMPT_PATTERN.test(key),
    ),
  );
}

// A card is "blocked" for this run if it was already visited this session, or it
// has been attempted >= 2 times across today without success.
export function getBlockedActivityKeys(memory, sessionVisited) {
  const blocked = new Set(sessionVisited || []);
  for (const [key, count] of Object.entries(memory?.attempts || {})) {
    if (Number(count) >= 2) {
      blocked.add(key);
    }
  }
  return blocked;
}

export function recordActivityAttempts(memory, keys) {
  memory.attempts = memory.attempts || {};
  for (const key of keys || []) {
    memory.attempts[key] = (Number(memory.attempts[key]) || 0) + 1;
  }
}

export function confirmActivityKeys(
  memory,
  sessionVisited,
  sessionMisses,
  keys,
) {
  for (const key of keys || []) {
    sessionVisited.add(key);
    sessionMisses.delete(key);
  }
  recordActivityAttempts(memory, keys || []);
}

// A clicked card that did not score is a "miss". After `maxMisses` misses we
// give up on it for this session; otherwise it stays retryable.
export function markUnconfirmedActivityKeys(
  keys,
  sessionVisited,
  sessionMisses,
  maxMisses = 2,
) {
  let retryable = false;
  let blocked = 0;
  for (const key of keys || []) {
    const misses = (Number(sessionMisses.get(key)) || 0) + 1;
    sessionMisses.set(key, misses);
    if (misses >= maxMisses) {
      sessionVisited.add(key);
      blocked++;
    } else {
      retryable = true;
    }
  }
  return { retryable, blocked };
}
