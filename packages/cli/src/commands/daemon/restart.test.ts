import { describe, expect, it } from "vitest";
import { daemonRestartCommand } from "./restart.js";
describe("controlled restart CLI", () => {
  it("exposes reason and readiness deadline", () => {
    const command = daemonRestartCommand();
    expect(command.options.some((option) => option.long === "--reason")).toBe(true);
    expect(command.options.some((option) => option.long === "--timeout")).toBe(true);
  });
});
