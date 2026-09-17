import { expect, it } from "vitest";
import { createDeferredCleanup } from "./deferred-cleanup";

it("keeps resources alive across effect replay and disposes after the real unmount", () => {
  const queued: Array<() => void> = [];
  let disposals = 0;
  const attach = createDeferredCleanup(
    () => {
      disposals += 1;
    },
    (task) => queued.push(task),
  );
  const firstCleanup = attach();
  firstCleanup();
  const finalCleanup = attach();
  for (const task of queued.splice(0)) task();
  expect(disposals).toBe(0);
  finalCleanup();
  expect(disposals).toBe(0);
  for (const task of queued.splice(0)) task();
  expect(disposals).toBe(1);
});
