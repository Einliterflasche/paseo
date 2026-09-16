import { expect, it } from "vitest";
import { AdmissionGate } from "./admission-gate.js";
import { RestartInProgressError } from "./restart-errors.js";

it("finishes already admitted nested work but never invokes a later mutation", async () => {
  const gate = new AdmissionGate();
  const release = Promise.withResolvers<void>();
  const effects: string[] = [];
  const accepted = gate.run(async () => {
    await release.promise;
    await gate.run(async () => {
      effects.push("accepted");
    });
  });
  const frozen = gate.freeze();
  await expect(
    gate.run(async () => {
      effects.push("rejected");
    }),
  ).rejects.toBeInstanceOf(RestartInProgressError);
  expect(effects).toEqual([]);
  release.resolve();
  await Promise.all([accepted, frozen]);
  expect(effects).toEqual(["accepted"]);
});

it("does not leak admission authority into detached work after its owner finishes", async () => {
  const gate = new AdmissionGate();
  const release = Promise.withResolvers<void>();
  let detached!: Promise<void>;
  const mutate = async () => {};
  const enter = () => gate.run(mutate);
  await gate.run(async () => {
    detached = release.promise.then(enter);
  });
  await gate.freeze();
  const assertion = expect(detached).rejects.toBeInstanceOf(RestartInProgressError);
  release.resolve();
  await assertion;
});

it("permits owner recovery without opening admissions to unrelated callers", async () => {
  const gate = new AdmissionGate();
  await gate.freeze();
  const release = Promise.withResolvers<void>();
  const recovery = gate.restore(async () => {
    await release.promise;
    return "restored";
  });
  await expect(gate.run(async () => "new work")).rejects.toBeInstanceOf(RestartInProgressError);
  release.resolve();
  expect(await recovery).toBe("restored");
  await expect(gate.run(async () => "still frozen")).rejects.toBeInstanceOf(RestartInProgressError);
  gate.open();
  expect(await gate.run(async () => "new work")).toBe("new work");
});
