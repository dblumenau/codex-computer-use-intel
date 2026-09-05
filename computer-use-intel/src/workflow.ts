import { randomUUID } from "node:crypto";
import type { CaptureGeometry } from "./geometry.js";

/** A screenshot reference is local to one MCP process and one unchanged input epoch. */
export class ScreenshotStore {
  private entries = new Map<string, { geometry: CaptureGeometry; appPid: number; at: number }>();
  constructor(private readonly now = Date.now, private readonly maxAgeMs = 120_000) {}

  add(geometry: CaptureGeometry, appPid: number): string {
    const id = randomUUID();
    this.entries.set(id, { geometry, appPid, at: this.now() });
    while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
    return id;
  }

  get(id: string) {
    const shot = this.entries.get(id);
    if (!shot || this.now() - shot.at > this.maxAgeMs) {
      throw new Error("Screenshot reference is missing, expired or invalidated by an action. Take a fresh screenshot.");
    }
    return shot;
  }

  invalidate(): void { this.entries.clear(); }
}

/** Keep desktop requests in order, including an action's following observation. */
export class DesktopQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export interface Verification {
  status: "observed" | "matched" | "already_satisfied" | "timed_out" | "error";
  elapsedMs: number;
  error?: string;
}

/**
 * Dispatch at most once. A failed observation never replays the input.
 * Dependency injection keeps timeout and partial-failure behavior testable without UI input.
 */
export async function performAndObserve<T>(opts: {
  dispatch: () => Promise<void>;
  observe: () => Promise<T>;
  matches?: () => Promise<boolean>;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  action: { status: "not_run" | "completed" | "uncertain" };
  verification: Verification;
  observation?: T;
  observationError?: string;
}> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const start = now();
  const result: {
    action: { status: "not_run" | "completed" | "uncertain" };
    verification: Verification;
    observation?: T;
    observationError?: string;
  } = { action: { status: "not_run" }, verification: { status: "observed", elapsedMs: 0 } };
  try {
    if (opts.matches && await opts.matches()) {
      result.verification.status = "already_satisfied";
    } else {
      // An input subprocess can fail after posting an event. Never call that "not_run".
      result.action.status = "uncertain";
      await opts.dispatch();
      result.action.status = "completed";
      if (opts.matches) {
        const deadline = now() + (opts.timeoutMs ?? 5000);
        result.verification.status = "timed_out";
        do {
          if (await opts.matches()) { result.verification.status = "matched"; break; }
          const remaining = deadline - now();
          if (remaining <= 0) break;
          await sleep(Math.min(opts.intervalMs ?? 250, remaining));
        } while (now() <= deadline);
      }
    }
  } catch (error) {
    result.verification = { status: "error", elapsedMs: now() - start, error: String(error) };
  }
  try { result.observation = await opts.observe(); }
  catch (error) { result.observationError = String(error); }
  result.verification.elapsedMs = now() - start;
  return result;
}
