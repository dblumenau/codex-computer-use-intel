import assert from "node:assert/strict";
import test from "node:test";
import { DesktopQueue, ScreenshotStore, performAndObserve } from "../dist/workflow.js";

function geometry() {
  return {
    screenBoundsPoints: { x: 12, y: 34, width: 640, height: 480 },
    imagePixels: { width: 1280, height: 960 },
    imageToScreen: { scaleX: 0.5, scaleY: 0.5, offsetX: 12, offsetY: 34 },
    capturedAt: "2026-09-05T00:00:00.000Z",
  };
}

function fakeClock(start = 0) {
  let current = start;
  const sleeps = [];
  return {
    now: () => current,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
  };
}

test("ScreenshotStore expires old references and invalidates current ones", () => {
  let current = 10_000;
  const store = new ScreenshotStore(() => current, 100);
  const id = store.add(geometry(), 4242);

  assert.equal(store.get(id).appPid, 4242);
  current = 10_100;
  assert.equal(store.get(id).appPid, 4242, "the configured age boundary is still usable");
  current = 10_101;
  assert.throws(() => store.get(id), /missing, expired or invalidated/);

  const fresh = store.add(geometry(), 4242);
  store.invalidate();
  assert.throws(() => store.get(fresh), /missing, expired or invalidated/);
});

test("ScreenshotStore retains only the eight newest references", () => {
  const store = new ScreenshotStore(() => 1_000);
  const ids = Array.from({ length: 9 }, () => store.add(geometry(), 7));

  assert.throws(() => store.get(ids[0]), /missing, expired or invalidated/);
  for (const id of ids.slice(1)) assert.doesNotThrow(() => store.get(id));
});

test("DesktopQueue does not overlap operations", async () => {
  const queue = new DesktopQueue();
  let active = 0;
  let maximumActive = 0;
  let resolveFirstStarted;
  const firstStarted = new Promise(resolve => { resolveFirstStarted = resolve; });
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let secondStarted = false;

  const first = queue.run(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    resolveFirstStarted();
    await firstGate;
    active -= 1;
    return "first";
  });
  const second = queue.run(async () => {
    secondStarted = true;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    active -= 1;
    return "second";
  });

  await firstStarted;
  assert.equal(secondStarted, false);
  assert.equal(active, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(maximumActive, 1);
});

test("DesktopQueue recovers after a rejected operation", async () => {
  const queue = new DesktopQueue();
  const order = [];
  const rejected = queue.run(async () => {
    order.push("rejected");
    throw new Error("operation failed");
  });

  await assert.rejects(rejected, /operation failed/);
  const recovered = queue.run(async () => {
    order.push("recovered");
    return "ok";
  });
  assert.equal(await recovered, "ok");
  assert.deepEqual(order, ["rejected", "recovered"]);
});

test("performAndObserve dispatches once when the postcondition times out", async () => {
  const clock = fakeClock();
  let dispatches = 0;
  const result = await performAndObserve({
    dispatch: async () => { dispatches += 1; },
    observe: async () => ({ state: "after timeout" }),
    matches: async () => false,
    timeoutMs: 40,
    intervalMs: 10,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(dispatches, 1);
  assert.equal(result.action.status, "completed");
  assert.equal(result.verification.status, "timed_out");
  assert.ok(clock.sleeps.length > 0, "polling used the injected clock instead of real waiting");
  assert.deepEqual(result.observation, { state: "after timeout" });
});

test("performAndObserve dispatches once when a postcondition check throws", async () => {
  const clock = fakeClock();
  let dispatches = 0;
  let checks = 0;
  const result = await performAndObserve({
    dispatch: async () => { dispatches += 1; },
    observe: async () => "observed after matcher failure",
    matches: async () => {
      checks += 1;
      if (checks === 1) return false;
      throw new Error("postcondition unavailable");
    },
    timeoutMs: 100,
    intervalMs: 10,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(dispatches, 1);
  assert.equal(result.action.status, "completed");
  assert.equal(result.verification.status, "error");
  assert.match(result.verification.error, /postcondition unavailable/);
  assert.equal(result.observation, "observed after matcher failure");
});

test("performAndObserve dispatches once even when observation fails", async () => {
  let dispatches = 0;
  const result = await performAndObserve({
    dispatch: async () => { dispatches += 1; },
    observe: async () => { throw new Error("screenshot unavailable"); },
  });

  assert.equal(dispatches, 1);
  assert.equal(result.action.status, "completed");
  assert.equal(result.verification.status, "observed");
  assert.match(result.observationError, /screenshot unavailable/);
});

test("performAndObserve skips dispatch when the expected state already holds", async () => {
  let dispatches = 0;
  const result = await performAndObserve({
    dispatch: async () => { dispatches += 1; },
    observe: async () => ({ status: "already ready" }),
    matches: async () => true,
  });

  assert.equal(dispatches, 0);
  assert.equal(result.action.status, "not_run");
  assert.equal(result.verification.status, "already_satisfied");
});

test("performAndObserve reports a false-to-true postcondition as matched", async () => {
  const clock = fakeClock();
  let dispatches = 0;
  const states = [false, true];
  const result = await performAndObserve({
    dispatch: async () => { dispatches += 1; },
    observe: async () => "matched observation",
    matches: async () => states.shift() ?? true,
    timeoutMs: 100,
    intervalMs: 10,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(dispatches, 1);
  assert.equal(result.action.status, "completed");
  assert.equal(result.verification.status, "matched");
  assert.equal(result.observation, "matched observation");
});

test("performAndObserve observes without an expected matcher", async () => {
  let dispatches = 0;
  const result = await performAndObserve({
    dispatch: async () => { dispatches += 1; },
    observe: async () => ({ value: "no expectation" }),
  });

  assert.equal(dispatches, 1);
  assert.equal(result.action.status, "completed");
  assert.equal(result.verification.status, "observed");
  assert.notEqual(result.verification.status, "matched");
});

test("performAndObserve keeps a dispatch failure uncertain", async () => {
  let dispatches = 0;
  const result = await performAndObserve({
    dispatch: async () => {
      dispatches += 1;
      throw new Error("input helper exited after posting");
    },
    observe: async () => "fresh observation",
  });

  assert.equal(dispatches, 1);
  assert.equal(result.action.status, "uncertain");
  assert.notEqual(result.action.status, "not_run");
  assert.equal(result.verification.status, "error");
  assert.match(result.verification.error, /input helper exited after posting/);
  assert.equal(result.observation, "fresh observation");
});
