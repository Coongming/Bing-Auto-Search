const { loadEsmModule } = require("./esm-loader.js");
const { createStartupRetry, STARTUP_RETRY_ALARM } = loadEsmModule(
  "../js/startup-retry.js",
);

function fixture() {
  const data = {};
  const storage = {
    get: jest.fn(async (key) => ({ [key]: data[key] })),
    set: jest.fn(async (values) => Object.assign(data, values)),
    remove: jest.fn(async (key) => {
      delete data[key];
    }),
  };
  const alarms = {
    clear: jest.fn(async () => {}),
    create: jest.fn(async () => {}),
    get: jest.fn(async () => null),
  };
  const run = jest.fn(async () => ({ retryable: true }));
  let mode = "m2";
  const options = {
    storage,
    alarms,
    run,
    getMode: () => mode,
    log: jest.fn(),
    now: () => 1000,
  };
  return {
    data,
    storage,
    alarms,
    run,
    options,
    controller: createStartupRetry(options),
    changeMode: (value) => {
      mode = value;
    },
  };
}

test("startup retries missing counters and stops scheduling once a run starts", async () => {
  const f = fixture();
  await f.controller.start();
  expect(f.alarms.create).toHaveBeenCalledWith(STARTUP_RETRY_ALARM, {
    when: 61000,
  });
  f.run.mockResolvedValueOnce({ started: true, retryable: false });
  await f.controller.retry();
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.data.pendingRewardsStartup).toBeUndefined();
  await f.controller.retry();
  expect(f.run).toHaveBeenCalledTimes(2);
});

test("four failures stop retrying rather than starting a recurring schedule", async () => {
  const f = fixture();
  await f.controller.start();
  for (let i = 0; i < 4; i++) await f.controller.retry();
  expect(f.run).toHaveBeenCalledTimes(4);
  expect(f.alarms.create).toHaveBeenCalledTimes(3);
  expect(f.data.pendingRewardsStartup).toBeUndefined();
});

test("a worker restart resumes the persisted retry", async () => {
  const f = fixture();
  await f.controller.start();
  const restarted = createStartupRetry(f.options);
  await restarted.resume();
  await restarted.retry();
  expect(f.run).toHaveBeenCalledTimes(2);
});

test("changing schedule mode cancels pending startup work", async () => {
  const f = fixture();
  await f.controller.start();
  f.changeMode("m1");
  await f.controller.retry();
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.data.pendingRewardsStartup).toBeUndefined();
});

test("unexpected read errors still get a bounded retry", async () => {
  const f = fixture();
  f.run.mockRejectedValueOnce(new Error("Page closed"));
  await f.controller.start();
  expect(f.alarms.create).toHaveBeenCalledTimes(1);
});

test("an expired startup retry cannot start a later run", async () => {
  const f = fixture();
  await f.controller.start();
  f.data.pendingRewardsStartup.expiresAt = 999;
  await f.controller.retry();
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.data.pendingRewardsStartup).toBeUndefined();
});

test("cancelling removes pending work before another startup alarm", async () => {
  const f = fixture();
  await f.controller.start();
  await f.controller.cancel();
  await f.controller.retry();
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.data.pendingRewardsStartup).toBeUndefined();
});
