/**
 * @jest-environment jsdom
 */

const { loadEsmModule } = require("./esm-loader.js");

const {
  createDashboardActivityScript,
  createEarnActivityScript,
  createSolveActivityScript,
  createClaimReadyScript,
  createActivityCompletionScript,
} = loadEsmModule("../js/injected-scripts.js");

// Compile (but never invoke) a script string to assert it is syntactically
// valid JavaScript. new Function() throws on parse errors without running the
// body, so this catches a broken extraction/template without touching the DOM.
function assertCompiles(scriptString) {
  expect(() => new Function(scriptString)).not.toThrow();
}

describe("createDashboardActivityScript", () => {
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
  test("produces syntactically valid JS", () => {
    assertCompiles(createEarnActivityScript(["x"], 2));
  });

  test("embeds visited keys and safety limit", () => {
    const script = createEarnActivityScript(["quiz"], 4);
    expect(script).toContain(JSON.stringify(["quiz"]));
    expect(script).toContain("const safetyLimit = 4;");
  });
});

describe("activity card completion boundaries", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main><h2>Daily set</h2><div class="row">
      <a class="daily-card" href="https://www.bing.com/search?q=done">First card 10 Completed <svg data-icon="checkmark"></svg></a>
      <a class="daily-card" href="https://www.bing.com/search?q=next">Second card +10 Start quiz</a>
      </div><h2>Your activity</h2></main>`;
    document.querySelectorAll("h2").forEach((heading, index) => {
      const top = index === 0 ? 10 : 180;
      heading.getBoundingClientRect = () => ({
        width: 200,
        height: 30,
        top,
        bottom: top + 30,
        left: 0,
        right: 200,
      });
    });
    document.querySelectorAll("a").forEach((card, index) => {
      card.getBoundingClientRect = () => ({
        width: 220,
        height: 70,
        top: 60,
        bottom: 130,
        left: index * 240,
        right: index * 240 + 220,
      });
      card.scrollIntoView = () => {};
    });
    document.elementFromPoint = () => document.querySelectorAll("a")[1];
  });

  test("a completed sibling does not prevent clicking the next Daily Set card", () => {
    const result = new Function(
      "return (" + createDashboardActivityScript([], 1, true) + ")",
    )();
    expect(result.clicked).toHaveLength(1);
    expect(result.clicked[0].text).toContain("Second card");
  });

  test("opening a card is not confirmed by the sibling's completion tick", () => {
    const item = {
      key: "https://www.bing.com/search?q=next",
      text: "Second card +10 Start quiz",
    };
    const script = createActivityCompletionScript([item]);
    expect(new Function("return (" + script + ")")().completedKeys).toEqual([]);
    document.querySelectorAll("a")[1].textContent =
      "Second card +10 Start quiz Completed";
    expect(new Function("return (" + script + ")")().completedKeys).toEqual([
      item.key,
    ]);
  });

  test("a Tailwind block class is not interpreted as a locked earn card", () => {
    document.querySelector("h2").textContent = "Keep earning";
    const card = document.querySelectorAll("a")[1];
    card.innerHTML = '<span class="block">Second card +10 Start quiz</span>';
    card.click = jest.fn();
    const result = new Function(
      "return (" + createEarnActivityScript([], 1) + ")",
    )();
    expect(result.clicked).toHaveLength(1);
    expect(result.clicked[0].text).toContain("Second card");
  });

  test("button-only cards cannot inherit completion from their shared row", () => {
    document.body.innerHTML =
      "<main><div><button>First card Completed</button><button>Second card</button></div></main>";
    const item = { key: "Second card|60|240", text: "Second card" };
    const script = createActivityCompletionScript([item]);
    expect(new Function("return (" + script + ")")().completedKeys).toEqual([]);
    document.querySelectorAll("button")[1].textContent += " Completed";
    expect(new Function("return (" + script + ")")().completedKeys).toEqual([
      item.key,
    ]);
  });

  test("different cards sharing a URL still have separate completion states", () => {
    document.querySelectorAll("a")[0].href =
      document.querySelectorAll("a")[1].href;
    const item = {
      key: "https://www.bing.com/search?q=next",
      text: "Second card +10 Start quiz",
    };
    const script = createActivityCompletionScript([item]);
    expect(new Function("return (" + script + ")")().completedKeys).toEqual([]);
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
