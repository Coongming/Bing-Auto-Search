// Read Rewards in its own first-party tab. Never navigate or close a user's tab.
export function createRewardsReader({
  tabs,
  waitForTab,
  sendMessage,
  log = () => {},
}) {
  const origin = "https://rewards.bing.com";
  let probeTabId = null;
  let useDocumentRead = false;
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  const isRewardsTab = (tab) => {
    try {
      return new URL(tab?.url).origin === origin;
    } catch {
      return false;
    }
  };

  async function getTab(id) {
    if (!id) return null;
    try {
      return await tabs.get(Number(id));
    } catch {
      return null;
    }
  }

  async function readTab(tab, action, requireApiPage = false) {
    if (tab.status !== "complete" && !(await waitForTab(tab.id))) {
      throw new Error("Rewards page did not finish loading.");
    }
    tab = await getTab(tab.id);
    if (!isRewardsTab(tab)) {
      throw new Error(
        "Rewards redirected to login; sign in to Microsoft first.",
      );
    }
    if (requireApiPage && new URL(tab.url).pathname !== "/api/getuserinfo") {
      throw new Error("Rewards API redirected to a different page.");
    }
    const response = await sendMessage(tab.id, { action });
    if (!response?.success || !response.userStatus) {
      throw new Error(
        response?.message || "Rewards page did not return account status.",
      );
    }
    return response.userStatus;
  }

  async function readApiDocument() {
    // A new navigation every time ensures a fresh counter, not a cached DOM.
    // Never navigate the user's Rewards/activity tab or the search tab.
    const tab = await tabs.create({
      url: `${origin}/api/getuserinfo`,
      active: false,
    });
    try {
      const status = await readTab(tab, "readRewardsDocument", true);
      log("[REWARDS] Read counters from a newly opened API page.", "update");
      return status;
    } finally {
      try {
        await tabs.remove(tab.id);
      } catch {
        /* already closed */
      }
    }
  }

  async function read(preferredTabId = null) {
    return serialize(async () => {
      if (useDocumentRead) return readApiDocument();
      let tab = await getTab(preferredTabId);
      if (!isRewardsTab(tab)) {
        tab = await getTab(probeTabId);
        if (!tab) {
          tab = await tabs.create({
            url: `${origin}/dashboard`,
            active: false,
          });
          probeTabId = tab.id;
        }
      }
      try {
        return await readTab(tab, "readRewardsStatus");
      } catch (error) {
        // HTTP/auth failures are not a reason to retry through another route.
        // This fallback addresses the observed fetch transport failure only.
        if (
          !/Failed to fetch|NetworkError|Network request failed|fetch aborted/i.test(
            error.message,
          )
        )
          throw error;
        log(
          `[REWARDS] Fetch transport failed; trying the API page: ${error.message}`,
          "warning",
        );
        const status = await readApiDocument();
        useDocumentRead = true;
        return status;
      }
    });
  }

  async function release() {
    return serialize(async () => {
      const id = probeTabId;
      probeTabId = null;
      if (id) {
        try {
          await tabs.remove(id);
        } catch {
          /* already closed */
        }
      }
    });
  }
  return { read, release };
}
