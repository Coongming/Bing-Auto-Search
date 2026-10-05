export const STARTUP_RETRY_ALARM = "startup_rewards_retry";
const STATE_KEY = "pendingRewardsStartup";

// Persist the retry so MV3 worker suspension cannot lose the startup attempt.
export function createStartupRetry({
  storage,
  alarms,
  getMode,
  run,
  log,
  now = Date.now,
}) {
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  async function clear() {
    await alarms.clear(STARTUP_RETRY_ALARM);
    await storage.remove(STATE_KEY);
  }
  async function attempt() {
    const state = (await storage.get(STATE_KEY))?.[STATE_KEY];
    if (!state) return;
    if (getMode() !== "m2" || state.expiresAt <= now()) {
      await clear();
      return;
    }
    const attemptNumber = state.attempt + 1;
    // Persist before calling run: a worker restart must not repeat a started run.
    await storage.set({ [STATE_KEY]: { ...state, attempt: attemptNumber } });
    let result;
    try {
      result = await run();
    } catch (error) {
      log(`[STARTUP] Attempt failed: ${error.message}`, "warning");
      result = { retryable: true };
    }
    if (!result?.retryable || getMode() !== "m2") {
      await clear();
    } else if (attemptNumber >= 4) {
      log(
        "[STARTUP] Rewards is still unavailable after 4 attempts. Sign in and run manually.",
        "warning",
      );
      await clear();
    } else {
      await alarms.create(STARTUP_RETRY_ALARM, { when: now() + 60000 });
      log(
        `[STARTUP] Retry ${attemptNumber + 1}/4 queued in 60 seconds.`,
        "warning",
      );
    }
  }
  return {
    start: () =>
      serialize(async () => {
        await clear();
        await storage.set({
          [STATE_KEY]: { attempt: 0, expiresAt: now() + 5 * 60000 },
        });
        await attempt();
      }),
    retry: () => serialize(attempt),
    resume: () =>
      serialize(async () => {
        const state = (await storage.get(STATE_KEY))?.[STATE_KEY];
        if (!state) return;
        if (
          getMode() !== "m2" ||
          state.expiresAt <= now() ||
          state.attempt >= 4
        ) {
          await clear();
        } else if (!(await alarms.get(STARTUP_RETRY_ALARM))) {
          await alarms.create(STARTUP_RETRY_ALARM, { when: now() + 60000 });
        }
      }),
    cancel: () => serialize(clear),
  };
}
