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

it("provider callbacks cannot inherit an in-flight command's authority", async () => {
  const gate = new AdmissionGate();
  const release = Promise.withResolvers<void>();
  let providerCallback!: () => Promise<string>;
  const newWork = async () => "new work";
  const admitNewWork = () => gate.run(newWork);
  const accepted = gate.run(async () => {
    providerCallback = () => gate.outside(admitNewWork);
    await release.promise;
  });
  const frozen = gate.freeze();
  await expect(providerCallback()).rejects.toBeInstanceOf(RestartInProgressError);
  release.resolve();
  await Promise.all([accepted, frozen]);
  gate.open();
  expect(await providerCallback()).toBe("new work");
});
