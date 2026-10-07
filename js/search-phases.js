export async function runSearchPhases(
  searches,
  expectedSessionId,
  tabId,
  deps,
) {
  const {
    isSessionStillActive,
    log,
    searchFn,
    simulateFn,
    clearFn,
    setConfig,
    getConfig,
    delayFn,
    shortestDelay,
    detachFn,
    readSearchCountersFn,
  } = deps;

  let searchPhasesSuccessful = true;

  const readCounters = async (stage) => {
    if (!readSearchCountersFn) return null;
    try {
      const snapshot = await readSearchCountersFn();
      if (!snapshot) throw new Error("Account counters unavailable.");
      const value = (n) => (Number.isFinite(n) ? n : "unknown");
      log(
        `[MOBILE_POINTS] ${stage}: PC=${value(snapshot.pcProgress)}/${value(snapshot.pcMax)}, mobile=${value(snapshot.mobProgress)}/${value(snapshot.mobMax)}, counters=${(snapshot.counterNames || []).join(",") || "none"}.`,
        "update",
      );
      return snapshot;
    } catch (error) {
      log(
        `[MOBILE_POINTS] ${stage}: cannot read Rewards counters: ${error.message}`,
        "warning",
      );
      return null;
    }
  };

  // Helper to update runtime state in-memory + persist to storage once
  const updatePhase = async (phase, extra = {}) => {
    const cfg = getConfig();
    cfg.runtime.currentPhase = phase;
    Object.assign(cfg.runtime, extra);
    await setConfig(cfg);
  };

  try {
    if (searches.desk > 0 && isSessionStillActive(expectedSessionId)) {
      log(`[SEARCH] - Starting desktop searches...`, "update");
      const desktopOk = await searchFn(
        searches.desk,
        searches.min,
        searches.max,
      );

      if (!desktopOk) {
        searchPhasesSuccessful = false;
        log(`[SEARCH] - Desktop searches did not complete cleanly.`, "warning");
      } else {
        log(`[SEARCH] - Desktop searches completed.`, "success");
      }
    }

    let mobilePhaseStarted = false;
    try {
      if (searches.mob > 0 && isSessionStillActive(expectedSessionId)) {
        if (!searchPhasesSuccessful) {
          log(
            `[SEARCH] - Desktop phase did not complete cleanly; continuing requested mobile searches.`,
            "warning",
          );
        }

        mobilePhaseStarted = true;
        await updatePhase("mobile_pre_clear", { mobile: 1 });

        if (getConfig()?.control?.clear) {
          log(
            `[SEARCH] - Refreshing Bing cache before mobile simulation; keeping Microsoft login.`,
            "update",
          );
          const cleared = await clearFn(true, false);
          if (!cleared)
            throw new Error(
              "Failed to clear browsing data before mobile simulation.",
            );
          await delayFn(shortestDelay, true);
        }

        await updatePhase("mobile_simulation");

        const simulated = await simulateFn(tabId);
        if (!simulated) {
          try {
            await detachFn?.(tabId, false);
          } catch (e) {}
          throw new Error("Mobile simulation failed.");
        }

        log(`[SEARCH] - Simulating mobile environment...`, "update");
        await delayFn(shortestDelay, true);

        const mobileBefore = await readCounters("Before mobile searches");
        if (!isSessionStillActive(expectedSessionId)) return false;
        await updatePhase("mobile_search");

        const mobileOk = await searchFn(
          searches.mob,
          searches.min,
          searches.max,
        );
        if (!mobileOk) {
          searchPhasesSuccessful = false;
          log(
            `[SEARCH] - Mobile searches did not complete cleanly.`,
            "warning",
          );
        } else {
          log(`[SEARCH] - Requested mobile searches submitted.`, "success");
        }

        if (isSessionStillActive(expectedSessionId) && readSearchCountersFn) {
          const mobileAfter = await readCounters("After mobile searches");
          if (!isSessionStillActive(expectedSessionId)) return false;
          const delta = (key) =>
            Number.isFinite(mobileBefore?.[key]) &&
            Number.isFinite(mobileAfter?.[key])
              ? mobileAfter[key] - mobileBefore[key]
              : null;
          const mobileDelta = delta("mobProgress");
          const pcDelta = delta("pcProgress");
          log(
            `[MOBILE_POINTS] Counter change during mobile: mobile=${mobileDelta ?? "unknown"}, PC=${pcDelta ?? "unknown"}. Submitted searches do not confirm mobile points.`,
            mobileDelta > 0 ? "success" : "warning",
          );
        }

        if (getConfig()?.control?.clear && getConfig()?.runtime?.running) {
          log(
            `[SEARCH] - Clearing Bing cache after mobile searches...`,
            "update",
          );
          const cleared = await clearFn(true, false);
          if (!cleared)
            throw new Error(
              "Failed to clear browsing data after mobile searches.",
            );
          await delayFn(shortestDelay, true);
        }

        await updatePhase("post_mobile", { mobile: 0 });
      } else if (searches.mob > 0 && !isSessionStillActive(expectedSessionId)) {
        log(
          `[SEARCH] - Skipping mobile searches because the session is no longer active.`,
          "warning",
        );
      }
    } catch (searchError) {
      searchPhasesSuccessful = false;
      log(
        `[SEARCH] - Error during mobile searches: ${searchError.message}`,
        "error",
      );
    } finally {
      if (mobilePhaseStarted) {
        try {
          await detachFn?.(tabId, false);
        } catch (e) {}
        const cfg = getConfig();
        const currentSessionId = cfg.runtime.currentSession?.id;
        if (
          cfg.runtime.mobile &&
          (!currentSessionId || currentSessionId === expectedSessionId)
        ) {
          cfg.runtime.mobile = 0;
          // SAFETY: getConfig() returns the same object reference the coordinator
          // already mutated (running=0 etc.), so this write won't re-enable running.
          await setConfig(cfg);
        }
      }
    }
  } catch (err) {
    searchPhasesSuccessful = false;
    log(`[SEARCH_PHASES] - Error: ${err.message}`, "error");
  }

  return searchPhasesSuccessful;
}

export async function handlePostSearchTasks(
  searches,
  expectedSessionId,
  tabId,
  searchPhasesSuccessful,
  deps,
) {
  const {
    isSessionStillActive,
    log,
    attachFn,
    detachFn,
    clearFn,
    clickFn,
    waitFn,
    delayFn,
    createTabFn,
    removeTabFn,
    updateTabFn,
    activityFn,
    shortestDelay,
    mediumDelay,
    rewards,
    bing,
    getConfig,
    hasActivityQuotaFn,
  } = deps;
  // When no quota function is supplied, default to "quota available" so callers
  // that don't care about the daily activity cap keep their previous behaviour.
  const activityQuotaAvailable =
    typeof hasActivityQuotaFn !== "function" || hasActivityQuotaFn();

  if (!isSessionStillActive(expectedSessionId)) {
    log(
      `[POST_SEARCH] - Session no longer active before post-search tasks.`,
      "warning",
    );
    return {
      searchTabClosed: false,
      runSuccessful: false,
      searchSuccessful: false,
    };
  }

  if (
    !searchPhasesSuccessful &&
    isSessionStillActive(expectedSessionId) &&
    getConfig()?.control?.act
  ) {
    log(
      `[POST_SEARCH] - Searches finished with warnings; continuing automated activities.`,
      "warning",
    );
  }

  if (!getConfig()?.runtime?.running) {
    log(
      `[POST_SEARCH] - Run stopped before cleanup/activity phase.`,
      "warning",
    );
    return {
      searchTabClosed: false,
      runSuccessful: false,
      searchSuccessful: false,
    };
  }

  let activitySuccessful = true;

  if (tabId) {
    await detachFn(tabId, false).catch(() => {});
  }
  await delayFn(shortestDelay, false);

  const shouldRunPostSearchClear =
    isSessionStillActive(expectedSessionId) &&
    getConfig()?.control?.clear &&
    !getConfig()?.control?.act &&
    Number(searches?.mob || 0) <= 0;
  const shouldSkipPostSearchClear =
    isSessionStillActive(expectedSessionId) &&
    getConfig()?.control?.clear &&
    !shouldRunPostSearchClear;

  if (shouldRunPostSearchClear && tabId) {
    try {
      await attachFn(tabId);
      await delayFn(shortestDelay, true);
      await updateTabFn(tabId, { url: bing, active: true });
      await waitFn(tabId);
      await delayFn(shortestDelay, true);
      await clearFn();
      await delayFn(shortestDelay, true);
      await clickFn();
      await delayFn(shortestDelay, true);
      await detachFn(tabId, false);
      log(`[POST_SEARCH] - Browsing data cleared after searches.`, "success");
    } catch (clearError) {
      log(
        `[POST_SEARCH] - Error clearing browsing data: ${clearError.message}`,
        "warning",
      );
      await detachFn(tabId, false).catch(() => {});
    }
  } else if (shouldSkipPostSearchClear) {
    const skipMessage = getConfig()?.control?.act
      ? `[POST_SEARCH] - Skipping post-search clear to preserve Rewards session before returning to Rewards.`
      : `[POST_SEARCH] - Skipping post-search clear because mobile phase already cleared browsing data.`;
    log(skipMessage, "update");
  }

  if (tabId) {
    try {
      await removeTabFn(tabId);
      log(`[POST_SEARCH] - Closed search tab early: ${tabId}`, "update");
      tabId = null;
    } catch (err) {
      log(
        `[POST_SEARCH] - Failed to close search tab early: ${err.message}`,
        "warning",
      );
    }
  }

  let activityQuotaExceeded = false;

  if (isSessionStillActive(expectedSessionId) && getConfig()?.control?.act) {
    if (!activityQuotaAvailable) {
      activityQuotaExceeded = true;
      log(
        `[POST_SEARCH] - Skipping activities; daily activity run quota already reached.`,
        "update",
      );
    } else {
      try {
        log(`[POST_SEARCH] - Creating a clean tab for activities...`, "update");
        const activityTab = await createTabFn({
          url: rewards + "dashboard",
          active: true,
        });
        const activityTabId = Number(activityTab.id);

        log(
          `[POST_SEARCH] - Activity started for tab ${activityTabId}.`,
          "update",
        );
        const activityWarmupDelay =
          Number(searches?.mob || 0) > 0
            ? mediumDelay || shortestDelay
            : shortestDelay;
        await delayFn(activityWarmupDelay, true);
        const activityOk = await activityFn(activityTabId, true);
        if (!activityOk) {
          activitySuccessful = false;
          log(
            `[POST_SEARCH] - Activity engine finished without clicking any cards.`,
            "warning",
          );
        } else {
          log(
            `[POST_SEARCH] - Activity completed for tab ${activityTabId}.`,
            "success",
          );
        }

        try {
          await removeTabFn(activityTabId);
          log(
            `[POST_SEARCH] - Closed activity tab with ID: ${activityTabId}`,
            "update",
          );
        } catch (err) {
          log(
            `[POST_SEARCH] - Failed to close activity tab: ${err.message}`,
            "warning",
          );
        }
      } catch (activityError) {
        activitySuccessful = false;
        log(
          `[POST_SEARCH] - Error during activities: ${activityError.message}`,
          "error",
        );
      }
    }
  }

  const sessionStillActive =
    isSessionStillActive(expectedSessionId) && !!getConfig()?.runtime?.running;
  const activitiesEnabled =
    !!getConfig()?.control?.act && !activityQuotaExceeded;
  const searchSuccessful = searchPhasesSuccessful && sessionStillActive;
  const runSuccessful =
    searchSuccessful && (!activitiesEnabled || activitySuccessful);

  if (!runSuccessful && sessionStillActive) {
    if (!searchPhasesSuccessful) {
      log(
        `[POST_SEARCH] - Run not successful because search phases did not complete cleanly.`,
        "warning",
      );
    } else if (activitiesEnabled && !activitySuccessful) {
      log(
        `[POST_SEARCH] - Searches completed but activities did not finish cleanly.`,
        "warning",
      );
    }
  }

  return { searchTabClosed: tabId === null, runSuccessful, searchSuccessful };
}

export async function cleanupAfterRun(tabId, expectedSessionId, deps) {
  const {
    removeTabFn,
    stopCurrentSession,
    setConfig,
    createAlarm,
    log,
    getConfig,
    clearBadgeFn,
    runSucceeded = false,
    getScheduleAlarmDelayMs,
    isScheduledModeActive,
  } = deps;

  if (tabId) {
    try {
      await removeTabFn(tabId).catch(() => {});
    } catch (e) {}
  }

  try {
    await clearBadgeFn?.();
  } catch (e) {}

  const config = getConfig();
  const sessionType =
    config?.runtime?.currentSession?.type ?? deps.endedSessionType;
  const isCurrentSession = deps.isActiveSession(expectedSessionId);
  const noConflictingRun = !config?.runtime?.currentSession || isCurrentSession;

  if (isCurrentSession) {
    await stopCurrentSession("normal_finish");
  }

  if (isCurrentSession || !config?.runtime?.currentSession) {
    config.runtime.rsaTab = null;
    config.runtime.mobile = 0;
    config.runtime.act = 0;
    config.runtime.currentPhase = null;
    await setConfig(config);
  }

  const shouldRearmSchedule =
    noConflictingRun &&
    (isCurrentSession || deps.endedSessionType) &&
    typeof getScheduleAlarmDelayMs === "function" &&
    typeof isScheduledModeActive === "function" &&
    isScheduledModeActive();

  if (
    shouldRearmSchedule &&
    (sessionType === "schedule" || sessionType === "search")
  ) {
    const scheduleMode = config?.schedule?.mode;
    let delayMs = getScheduleAlarmDelayMs(scheduleMode);
    if (!runSucceeded && delayMs) {
      // Backoff: double the delay on failure (cap at 30 minutes)
      delayMs = Math.min(delayMs * 2, 30 * 60 * 1000);
      log(
        `[CLEANUP] - Run failed; re-arming schedule with backoff delay (${Math.round(delayMs / 1000)}s).`,
        "warning",
      );
    }
    if (delayMs) {
      await createAlarm("schedule", { when: Date.now() + delayMs });
      if (runSucceeded) {
        log(`[CLEANUP] - Scheduled next run.`, "update");
      }
    }
  }
}
