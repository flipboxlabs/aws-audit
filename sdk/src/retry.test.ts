import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { backoffDelay, RETRY_MAX_DELAY } from "./retry.js";

describe("backoffDelay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [1, 0, 50],
    [1, 0.5, 75],
    [2, 0.5, 150],
    [3, 0.999999, 400],
  ])("after attempt %d with jitter %d waits %dms", (attempt, random, expected) => {
    vi.spyOn(Math, "random").mockReturnValue(random);

    expect(backoffDelay(attempt, 100)).toBe(expected);
  });

  it("caps the delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(backoffDelay(20, 100)).toBe(22_500);
    expect(backoffDelay(40, 100)).toBe(RETRY_MAX_DELAY * 0.75);
  });
});
