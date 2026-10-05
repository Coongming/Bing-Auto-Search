const { loadEsmModule } = require("./esm-loader.js");

const {
  sanitizeActivityAttempts,
  getBlockedActivityKeys,
  recordActivityAttempts,
  confirmActivityKeys,
  markUnconfirmedActivityKeys,
} = loadEsmModule("../js/activity-memory.js");

describe("sanitizeActivityAttempts", () => {
  test("drops expand/see-more style keys (en + vi)", () => {
    const attempts = {
      "quiz of the day": 1,
      "see more": 2,
      "xem thêm": 1,
      "mở rộng": 3,
    };
    expect(sanitizeActivityAttempts(attempts)).toEqual({
      "quiz of the day": 1,
    });
  });

  test("returns empty object for nullish input", () => {
    expect(sanitizeActivityAttempts(null)).toEqual({});
    expect(sanitizeActivityAttempts(undefined)).toEqual({});
  });

  test("keeps real activity keys untouched", () => {
    const attempts = { "daily poll": 1, "news quiz": 2 };
    expect(sanitizeActivityAttempts(attempts)).toEqual(attempts);
  });
});

describe("getBlockedActivityKeys", () => {
  test("blocks keys visited this session", () => {
    const blocked = getBlockedActivityKeys(
      { attempts: {} },
      new Set(["a", "b"]),
    );
    expect(blocked.has("a")).toBe(true);
    expect(blocked.has("b")).toBe(true);
  });

  test("blocks keys attempted >= 2 times today", () => {
    const memory = { attempts: { c: 2, d: 1, e: 5 } };
    const blocked = getBlockedActivityKeys(memory, new Set());
    expect(blocked.has("c")).toBe(true);
    expect(blocked.has("e")).toBe(true);
    expect(blocked.has("d")).toBe(false);
  });

  test("tolerates missing memory/session", () => {
    expect(getBlockedActivityKeys(null, null).size).toBe(0);
  });
});

describe("recordActivityAttempts", () => {
  test("increments attempt counts, creating attempts map if needed", () => {
    const memory = {};
    recordActivityAttempts(memory, ["a", "a", "b"]);
    expect(memory.attempts).toEqual({ a: 2, b: 1 });
  });
});

describe("confirmActivityKeys", () => {
  test("marks visited, clears misses, and records attempts", () => {
    const memory = { attempts: {} };
    const visited = new Set();
    const misses = new Map([["a", 1]]);
    confirmActivityKeys(memory, visited, misses, ["a"]);
    expect(visited.has("a")).toBe(true);
    expect(misses.has("a")).toBe(false);
    expect(memory.attempts.a).toBe(1);
  });
});

describe("markUnconfirmedActivityKeys", () => {
  test("first miss is retryable, not yet blocked", () => {
    const visited = new Set();
    const misses = new Map();
    const result = markUnconfirmedActivityKeys(["a"], visited, misses);
    expect(result.retryable).toBe(true);
    expect(result.blocked).toBe(0);
    expect(visited.has("a")).toBe(false);
    expect(misses.get("a")).toBe(1);
  });

  test("reaching maxMisses blocks the key for the session", () => {
    const visited = new Set();
    const misses = new Map([["a", 1]]);
    const result = markUnconfirmedActivityKeys(["a"], visited, misses);
    expect(result.blocked).toBe(1);
    expect(visited.has("a")).toBe(true);
  });

  test("honours a custom maxMisses threshold", () => {
    const visited = new Set();
    const misses = new Map();
    markUnconfirmedActivityKeys(["a"], visited, misses, 1);
    expect(visited.has("a")).toBe(true);
  });
});
