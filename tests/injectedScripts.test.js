/**
 * @jest-environment jsdom
 */

const { loadEsmModule } = require("./esm-loader.js");

const {
  createDashboardActivityScript,
  createEarnActivityScript,
  createSolveActivityScript,
  createClaimReadyScript,
} = loadEsmModule("../js/injected-scripts.js");

// Compile (but never invoke) a script string to assert it is syntactically
// valid JavaScript. new Function() throws on parse errors without running the
// body, so this catches a broken extraction/template without touching the DOM.
function assertCompiles(scriptString) {
  expect(() => new Function(scriptString)).not.toThrow();
}

function activityFixture(heading, cards) {
  document.body.innerHTML = `<main><h2>${heading}</h2><div class="cards">${cards}</div><h2>Your activity</h2></main>`;
  for (const el of document.querySelectorAll("*")) {
    el.getBoundingClientRect = () => ({
      width: 900,
      height: 240,
      top: 45,
      bottom: 285,
      left: 0,
      right: 900,
    });
    el.scrollIntoView = () => {};
  }
  document.querySelector("h2").getBoundingClientRect = () => ({
    width: 200,
    height: 30,
    top: 10,
    bottom: 40,
    left: 0,
    right: 200,
  });
  document.querySelectorAll("h2")[1].getBoundingClientRect = () => ({
    width: 200,
    height: 30,
    top: 300,
    bottom: 330,
    left: 0,
    right: 200,
  });
  for (const [index, card] of [...document.querySelectorAll("a")].entries()) {
    card.getBoundingClientRect = () => ({
      width: 220,
      height: 70,
      top: 60,
      bottom: 130,
      left: 20 + index * 240,
      right: 240 + index * 240,
    });
    card.click = jest.fn();
  }
  document.elementFromPoint = jest.fn((x) =>
    [...document.querySelectorAll("a")].find((card) => {
      const rect = card.getBoundingClientRect();
      return x >= rect.left && x <= rect.right;
    }),
  );
}

describe("createDashboardActivityScript", () => {
  test("a completed sibling never marks an unfinished Daily set card as done", () => {
    activityFixture(
      "Daily set",
      '<a class="daily-card completed" href="https://rewards.bing.com/dset1">+10 Start quiz <svg data-icon="checkmark"></svg></a><a class="daily-card" href="https://rewards.bing.com/dset2">+10 Start poll</a>',
    );
    const result = new Function(
      "return (" + createDashboardActivityScript([], 1, true) + ")",
    )();
    expect(result.openedKeys).toEqual(["https://rewards.bing.com/dset2"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "already done" }),
      ]),
    );
  });

  test("incomplete is not a completed state", () => {
    activityFixture(
      "Daily set",
      '<a class="daily-card incomplete" href="https://rewards.bing.com/dset1">+10 Start quiz</a>',
    );
    const result = new Function(
      "return (" + createDashboardActivityScript([], 1, true) + ")",
    )();
    expect(result.clicked).toHaveLength(1);
  });
  test("produces syntactically valid JS", () => {
    assertCompiles(createDashboardActivityScript(["a", "b"], 1));
  });

  test("embeds visited keys and safety limit", () => {
    const script = createDashboardActivityScript(["daily poll", "news"], 3);
    expect(script).toContain(JSON.stringify(["daily poll", "news"]));
    expect(script).toContain("const safetyLimit = 3;");
  });

  test("defaults safety limit when omitted", () => {
    expect(createDashboardActivityScript([])).toContain(
      "const safetyLimit = 12;",
    );
  });

  test("guards against a non-numeric safety limit", () => {
    expect(createDashboardActivityScript([], "oops")).toContain(
      "const safetyLimit = 12;",
    );
  });

  test("returns a CDP press point for a Daily Set card without synthetic click", () => {
    document.body.innerHTML = `
      <main>
        <h2>Daily set</h2>
        <a class="daily-card" href="https://rewards.bing.com/quiz">+10 Start quiz</a>
        <h2>Your activity</h2>
      </main>`;
    const heading = document.querySelector("h2");
    const card = document.querySelector("a");
    const nextHeading = document.querySelectorAll("h2")[1];
    heading.getBoundingClientRect = () => ({
      width: 200,
      height: 30,
      top: 10,
      bottom: 40,
      left: 0,
      right: 200,
    });
    card.getBoundingClientRect = () => ({
      width: 220,
      height: 70,
      top: 60,
      bottom: 130,
      left: 20,
      right: 240,
    });
    nextHeading.getBoundingClientRect = () => ({
      width: 200,
      height: 30,
      top: 180,
      bottom: 210,
      left: 0,
      right: 200,
    });
    card.scrollIntoView = () => {};
    document.elementFromPoint = jest.fn(() => card);
    card.click = jest.fn();

    const script = createDashboardActivityScript([], 1, true);
    const result = new Function("return (" + script + ")")();

    expect(result.clicked).toHaveLength(1);
    expect(result.pressPoint).toEqual({ x: 130, y: 95 });
    expect(card.click).not.toHaveBeenCalled();
  });
});

describe("createEarnActivityScript", () => {
  test("does not mistake Today's points / Points breakdown for an earning activity", () => {
    activityFixture(
      "Keep earning",
      '<a class="earn-card" href="https://rewards.bing.com/earn#points-breakdown">Today\'s points 117 Points breakdown</a><a class="earn-card" href="https://rewards.bing.com/quote">Quote of the day +5</a>',
    );
    const result = new Function(
      "return (" + createEarnActivityScript([], 1, true) + ")",
    )();
    expect(result.clicked).toHaveLength(1);
    expect(result.clicked[0].text).toContain("Quote of the day");
    expect(
      result.skipped.some((item) => item.reason === "points summary"),
    ).toBe(true);
  });
  test("defers the selected Keep earning card to CDP without clicking it during the scan", () => {
    activityFixture(
      "Keep earning",
      '<a class="earn-card" href="https://rewards.bing.com/offer1">+10 Start quiz</a>',
    );
    const card = document.querySelector("a");
    const result = new Function(
      "return (" + createEarnActivityScript([], 1, true) + ")",
    )();
    expect(result.clicked).toHaveLength(1);
    expect(result.pressPoint).toEqual({ x: 130, y: 95 });
    expect(card.click).not.toHaveBeenCalled();
  });
  test("a completed sibling does not block an unfinished Keep earning card", () => {
    activityFixture(
      "Keep earning",
      '<a class="earn-card completed" href="https://rewards.bing.com/offer1">+10 Start quiz <svg data-icon="checkmark"></svg></a><a class="earn-card block incomplete" href="https://rewards.bing.com/offer2">+10 Start poll</a>',
    );
    const result = new Function(
      "return (" + createEarnActivityScript([], 1) + ")",
    )();
    expect(result.openedKeys).toEqual(["https://rewards.bing.com/offer2"]);
  });
  test("produces syntactically valid JS", () => {
    assertCompiles(createEarnActivityScript(["x"], 2));
  });

  test("embeds visited keys and safety limit", () => {
    const script = createEarnActivityScript(["quiz"], 4);
    expect(script).toContain(JSON.stringify(["quiz"]));
    expect(script).toContain("const safetyLimit = 4;");
  });
});

describe("createSolveActivityScript", () => {
  test("produces syntactically valid JS", () => {
    assertCompiles(createSolveActivityScript());
  });

  test("returns an immediately-invoked function expression string", () => {
    const script = createSolveActivityScript();
    expect(script).toContain("(function()");
    expect(script).toContain("})()");
  });
});

describe("createClaimReadyScript", () => {
  test("produces syntactically valid JS", () => {
    assertCompiles(createClaimReadyScript());
  });

  test("matches the ready-to-claim card and returns a click result shape", () => {
    const script = createClaimReadyScript();
    expect(script).toMatch(/ready to claim/i);
    expect(script).toContain("clicked:");
    expect(script).toContain("count:");
  });

  test("evaluates to a no-op result when there is no claim UI (jsdom)", () => {
    // Run the IIFE against an empty jsdom document: no card, no crash.
    const script = createClaimReadyScript();
    // Parenthesise to avoid ASI (the script body starts with a newline).
    const result = new Function("return (" + script + ")")();
    expect(result).toMatchObject({ clicked: false });
  });

  test("clicks the ready-to-claim card and reads the pending count", () => {
    // Mirrors the real dashboard card: a button labelled "Ready to claim" with
    // the pending count and a "Claim" affordance.
    document.body.innerHTML = `
      <button aria-expanded="false">
        <p>Ready to claim</p>
        <p>6</p>
        <p>Claim</p>
      </button>`;
    const btn = document.querySelector("button");
    // jsdom has no layout, so fake a visible box and capture the click.
    btn.getBoundingClientRect = () => ({
      width: 120,
      height: 40,
      top: 0,
      bottom: 40,
      left: 0,
      right: 120,
    });
    btn.scrollIntoView = () => {};
    let clicked = false;
    btn.click = () => {
      clicked = true;
    };

    const script = createClaimReadyScript();
    const result = new Function("return (" + script + ")")();

    expect(clicked).toBe(true);
    expect(result).toMatchObject({ clicked: true, count: 6 });
  });

  test('clicks a standalone "Claim points" confirm button', () => {
    // The confirm control that appears after opening the card (real text).
    document.body.innerHTML = `<button><span>Claim points</span></button>`;
    const btn = document.querySelector("button");
    btn.getBoundingClientRect = () => ({
      width: 140,
      height: 40,
      top: 0,
      bottom: 40,
      left: 0,
      right: 140,
    });
    btn.scrollIntoView = () => {};
    let clicked = false;
    btn.click = () => {
      clicked = true;
    };

    const script = createClaimReadyScript();
    const result = new Function("return (" + script + ")")();

    expect(clicked).toBe(true);
    expect(result).toMatchObject({ clicked: true });
  });

  test("finds a React Aria claim control in a dialog and defers to CDP", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div data-react-aria-pressable tabindex="0"><span>Claim points</span></div>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    const control = document.querySelector("[data-react-aria-pressable]");
    dialog.getBoundingClientRect = () => ({
      width: 300,
      height: 200,
      top: 0,
      bottom: 200,
      left: 0,
      right: 300,
    });
    control.getBoundingClientRect = () => ({
      width: 140,
      height: 40,
      top: 50,
      bottom: 90,
      left: 30,
      right: 170,
    });
    control.scrollIntoView = () => {};
    control.click = jest.fn();

    const script = createClaimReadyScript(true);
    const result = new Function("return (" + script + ")")();

    expect(result).toMatchObject({
      clicked: true,
      stage: "confirm",
      pressPoint: { x: 100, y: 70 },
    });
    expect(control.click).not.toHaveBeenCalled();
  });
});
