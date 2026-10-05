const { loadEsmModule } = require("./esm-loader.js");
const { createRewardsReader } = loadEsmModule("../js/rewards-client.js", {
  URL,
});

function fixture() {
  const tabMap = new Map();
  let nextTabId = 10;
  const tabs = {
    create: jest.fn(async ({ url }) => {
      const tab = {
        id: nextTabId++,
        url,
        status: "complete",
      };
      tabMap.set(tab.id, tab);
      return tab;
    }),
    get: jest.fn(async (id) => {
      if (!tabMap.has(id)) throw new Error("Closed tab");
      return tabMap.get(id);
    }),
    remove: jest.fn(async (id) => tabMap.delete(id)),
    update: jest.fn(),
  };
  const sendMessage = jest.fn(async () => ({
    success: true,
    userStatus: { counters: { mobileSearch: [{ progress: 3, max: 60 }] } },
  }));
  return {
    tabs,
    tabMap,
    sendMessage,
    reader: createRewardsReader({
      tabs,
      sendMessage,
      waitForTab: async () => true,
    }),
  };
}

test("concurrent reads share one owned Rewards tab and cleanup closes only that tab", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.reader.read(), f.reader.read()]);
  expect(first).toEqual(second);
  expect(f.tabs.create).toHaveBeenCalledTimes(1);
  expect(f.tabs.create).toHaveBeenCalledWith({
    url: "https://rewards.bing.com/dashboard",
    active: false,
  });
  expect(f.sendMessage).toHaveBeenCalledWith(10, {
    action: "readRewardsStatus",
  });
  await f.reader.release();
  expect(f.tabs.remove).toHaveBeenCalledWith(10);
});

test("a failed fetch falls back to a temporary JSON page and subsequent reads navigate anew", async () => {
  const f = fixture();
  f.sendMessage.mockResolvedValueOnce({
    success: false,
    message: "Failed to fetch",
  });
  await expect(f.reader.read()).resolves.toHaveProperty("counters");
  expect(f.tabs.create).toHaveBeenLastCalledWith({
    url: "https://rewards.bing.com/api/getuserinfo",
    active: false,
  });
  expect(f.sendMessage).toHaveBeenLastCalledWith(11, {
    action: "readRewardsDocument",
  });
  expect(f.tabs.remove).toHaveBeenCalledWith(11);

  await f.reader.read();
  expect(f.sendMessage).toHaveBeenLastCalledWith(12, {
    action: "readRewardsDocument",
  });
  expect(f.tabs.remove).toHaveBeenCalledWith(12);
  expect(
    f.sendMessage.mock.calls.filter(
      ([, message]) => message.action === "readRewardsStatus",
    ),
  ).toHaveLength(1);
  await f.reader.release();
  expect(f.tabs.remove).toHaveBeenLastCalledWith(10);
  expect(f.tabMap.size).toBe(0);
});

test("fallback leaves the provided activity tab intact", async () => {
  const f = fixture();
  f.tabMap.set(42, {
    id: 42,
    url: "https://rewards.bing.com/dashboard",
    status: "complete",
  });
  f.sendMessage.mockResolvedValueOnce({
    success: false,
    message: "Failed to fetch",
  });
  await f.reader.read(42);
  await f.reader.release();
  expect(f.tabMap.has(42)).toBe(true);
  expect(f.tabs.remove).not.toHaveBeenCalledWith(42);
  expect(f.tabs.update).not.toHaveBeenCalled();
});

test("fallback JSON errors cannot turn an unknown counter into a successful read", async () => {
  const f = fixture();
  f.sendMessage.mockResolvedValueOnce({
    success: false,
    message: "Failed to fetch",
  });
  f.sendMessage.mockResolvedValueOnce({
    success: false,
    message: "Rewards returned no usable counters (API code 9).",
  });
  await expect(f.reader.read()).rejects.toThrow("API code 9");
  expect(f.tabs.remove).toHaveBeenCalledWith(11);
  await f.reader.release();
  expect(f.tabMap.size).toBe(0);
});

test("an API-page redirect is rejected before reading its document", async () => {
  const f = fixture();
  f.sendMessage.mockResolvedValueOnce({
    success: false,
    message: "Failed to fetch",
  });
  const create = f.tabs.create.getMockImplementation();
  f.tabs.create.mockImplementation(async (opts) => {
    const tab = await create(opts);
    if (opts.url.includes("/api/getuserinfo"))
      tab.url = "https://rewards.bing.com/signin";
    return tab;
  });
  await expect(f.reader.read()).rejects.toThrow("different page");
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.tabs.remove).toHaveBeenCalledWith(11);
});

test("an HTTP or account error is not retried through document navigation", async () => {
  const f = fixture();
  f.sendMessage.mockResolvedValueOnce({
    success: false,
    message: "Rewards API HTTP 401",
  });
  await expect(f.reader.read()).rejects.toThrow("HTTP 401");
  expect(f.tabs.create).toHaveBeenCalledTimes(1);
});

test("activity reads use the supplied Rewards tab without navigating or closing it", async () => {
  const f = fixture();
  f.tabMap.set(42, {
    id: 42,
    url: "https://rewards.bing.com/earn",
    status: "complete",
  });
  await f.reader.read(42);
  await f.reader.release();
  expect(f.tabs.create).not.toHaveBeenCalled();
  expect(f.tabs.remove).not.toHaveBeenCalled();
  expect(f.sendMessage).toHaveBeenCalledWith(42, {
    action: "readRewardsStatus",
  });
});

test("a login redirect never receives the status message", async () => {
  const f = fixture();
  f.tabs.create.mockImplementationOnce(async () => {
    f.tabMap.set(10, {
      id: 10,
      url: "https://login.live.com/",
      status: "complete",
    });
    return f.tabMap.get(10);
  });
  await expect(f.reader.read()).rejects.toThrow("redirected to login");
  expect(f.sendMessage).not.toHaveBeenCalled();
});

test("account API errors propagate and do not poison the next read", async () => {
  const f = fixture();
  f.sendMessage.mockResolvedValueOnce({
    success: false,
    message: "Rewards API HTTP 503",
  });
  await expect(f.reader.read()).rejects.toThrow("HTTP 503");
  await expect(f.reader.read()).resolves.toHaveProperty("counters");
});

test("closing the owned probe causes the next read to recreate it", async () => {
  const f = fixture();
  await f.reader.read();
  f.tabMap.delete(10);
  await f.reader.read();
  expect(f.tabs.create).toHaveBeenCalledTimes(2);
});
