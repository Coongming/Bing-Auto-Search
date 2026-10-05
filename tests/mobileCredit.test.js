const { loadEsmModule } = require("./esm-loader.js");
const { createMobileCreditGuard } = loadEsmModule("../js/mobile-credit.js");

function fixture(snapshots) {
  const readSnapshot = jest.fn();
  for (const snapshot of snapshots)
    readSnapshot.mockResolvedValueOnce(snapshot);
  const report = jest.fn();
  const delay = jest.fn(async () => {});
  const guard = createMobileCreditGuard({
    readSnapshot,
    report,
    delay,
    isActive: () => true,
  });
  return { guard, readSnapshot, report, delay };
}
const counter = (progress) => ({ mobProgress: progress, mobMax: 60 });

test("three submitted searches without mobile points stop the phase even if total points changed", async () => {
  const f = fixture([
    counter(0),
    { ...counter(0), score: 110 },
    counter(0),
    counter(0),
  ]);
  expect(await f.guard.start()).toBe(true);
  expect(await f.guard.check(1)).toEqual({ ok: true, complete: false });
  expect(await f.guard.check(3)).toEqual({ ok: false, complete: false });
  expect(f.readSnapshot).toHaveBeenCalledTimes(4);
  expect(f.report).toHaveBeenLastCalledWith(
    expect.stringContaining("no new points"),
    "warning",
  );
});

test("delayed mobile credit is confirmed after polling", async () => {
  const f = fixture([counter(0), counter(0), counter(9)]);
  await f.guard.start();
  expect(await f.guard.check(3)).toEqual({ ok: true, complete: false });
  expect(f.delay).toHaveBeenCalledTimes(1);
  expect(f.report).toHaveBeenLastCalledWith(
    expect.stringContaining("+9 points"),
    "success",
  );
});

test("daily mobile cap ends the phase successfully", async () => {
  const f = fixture([counter(57), counter(60)]);
  await f.guard.start();
  expect(await f.guard.check(1, true)).toEqual({ ok: true, complete: true });
});

test("an already completed counter skips additional mobile searches", async () => {
  const f = fixture([counter(60)]);
  expect(await f.guard.start()).toBe(true);
  expect(f.guard.isComplete()).toBe(true);
  expect(f.readSnapshot).toHaveBeenCalledTimes(1);
});

test("stopping the run cancels polling before another counter read", async () => {
  const readSnapshot = jest.fn().mockResolvedValue(counter(0));
  let active = true;
  const guard = createMobileCreditGuard({
    readSnapshot,
    delay: async () => {
      active = false;
    },
    report: jest.fn(),
    isActive: () => active,
  });
  await guard.start();
  expect(await guard.check(3)).toEqual({ ok: false, complete: false });
  expect(readSnapshot).toHaveBeenCalledTimes(2);
});

test("an unavailable mobile counter cannot start a mobile run", async () => {
  const f = fixture([{ mobProgress: null, mobMax: null }]);
  expect(await f.guard.start()).toBe(false);
});

test("loss of counter access after a batch reports unconfirmed points", async () => {
  const f = fixture([counter(0), null, null, null]);
  await f.guard.start();
  expect((await f.guard.check(3)).ok).toBe(false);
  expect(f.report).toHaveBeenLastCalledWith(
    expect.stringContaining("counter unavailable"),
    "warning",
  );
});
