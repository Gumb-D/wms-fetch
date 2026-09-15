import { expect, test, vi } from "vitest";
import { runRefresh } from "../../apps/scheduler/src/refresh.js";

test("failed refresh preserves last good snapshot and releases lock", async () => {
  const release = vi.fn();
  const publish = vi.fn();
  await expect(
    runRefresh({
      acquireLock: async () => ({ release }),
      extract: async () => {
        throw new Error("WMS unavailable");
      },
      build: vi.fn(),
      publish,
    }),
  ).rejects.toThrow("WMS unavailable");
  expect(publish).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});
