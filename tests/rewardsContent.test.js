const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(
  path.join(__dirname, "../js/content.js"),
  "utf8",
);
// Only counters and structure from the user's response; no account identifiers.
const countersPayload = require("./fixtures/rewards-counters.json");

function fixture(
  origin = "https://rewards.bing.com",
  pathname = "/dashboard",
  pageText = "",
) {
  let listener;
  const userStatus = { counters: { mobileSearch: [{ progress: 3, max: 60 }] } };
  const fetch = jest.fn(async () => ({
    ok: true,
    url: `${origin}/api/getuserinfo`,
    json: async () => ({ status: { userStatus } }),
  }));
  vm.runInNewContext(source, {
    chrome: {
      runtime: {
        onMessage: {
          addListener: (fn) => {
            listener = fn;
          },
        },
      },
    },
    fetch,
    location: { origin, pathname },
    document: {
      querySelector: () => ({ textContent: pageText }),
      body: { textContent: pageText },
    },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return {
    fetch,
    userStatus,
    request: (action = "readRewardsStatus") =>
      new Promise((resolve) => listener({ action }, {}, resolve)),
  };
}

test("reads account status with first-party credentials on Rewards", async () => {
  const f = fixture();
  expect(await f.request()).toEqual({
    success: true,
    userStatus: f.userStatus,
  });
  expect(f.fetch).toHaveBeenCalledWith(
    "/api/getuserinfo",
    expect.objectContaining({ credentials: "include", cache: "no-store" }),
  );
});

test("reads the API JSON document without making another fetch request", async () => {
  const f = fixture(
    "https://rewards.bing.com",
    "/api/getuserinfo",
    JSON.stringify(countersPayload),
  );
  const result = await f.request("readRewardsDocument");
  expect(result.success).toBe(true);
  expect(result.userStatus.counters.pcSearch[0].pointProgress).toBe(90);
  expect(result.userStatus.counters.mobileSearch[0].pointProgress).toBe(60);
  expect(f.fetch).not.toHaveBeenCalled();
});

test("an empty code-9 document remains an error, not zero points or proof of logout", async () => {
  const f = fixture(
    "https://rewards.bing.com",
    "/api/getuserinfo",
    '{"code":9,"error":"","data":{}}',
  );
  const result = await f.request("readRewardsDocument");
  expect(result.success).toBe(false);
  expect(result.message).toContain("API code 9");
  expect(result.message).not.toMatch(/sign in|logged out/i);
  expect(result.userStatus).toBeUndefined();
  expect(f.fetch).not.toHaveBeenCalled();
});

test("refuses document reads outside the exact API page", async () => {
  const f = fixture(
    "https://rewards.bing.com",
    "/dashboard",
    JSON.stringify(countersPayload),
  );
  expect((await f.request("readRewardsDocument")).success).toBe(false);
  expect(f.fetch).not.toHaveBeenCalled();
});

test("a rendered HTML error cannot be mistaken for API JSON", async () => {
  const f = fixture(
    "https://rewards.bing.com",
    "/api/getuserinfo",
    "Sign in to Microsoft",
  );
  expect((await f.request("readRewardsDocument")).message).toContain(
    "valid JSON",
  );
});

test("the fetch parser also accepts the dashboard branch in the user's payload", async () => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce({
    ok: true,
    url: "https://rewards.bing.com/api/getuserinfo",
    json: async () => countersPayload,
  });
  expect(
    (await f.request()).userStatus.counters.mobileSearch[0].attributes.max,
  ).toBe("60");
});

test("refuses to read account status from Bing search or another origin", async () => {
  const f = fixture("https://www.bing.com");
  expect((await f.request()).success).toBe(false);
  expect(f.fetch).not.toHaveBeenCalled();
});

test("reports login redirects and malformed account payloads as errors", async () => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce({ ok: true, url: "https://login.live.com/" });
  expect((await f.request()).message).toMatch(/redirected to login/);
  f.fetch.mockResolvedValueOnce({
    ok: true,
    url: "https://rewards.bing.com/api/getuserinfo",
    json: async () => ({ status: { userStatus: {} } }),
  });
  expect((await f.request()).success).toBe(false);
});
