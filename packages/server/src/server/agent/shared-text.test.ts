import { describe, expect, it } from "vitest";
import {
  decodeTextNodes,
  readText,
  reviseText,
  TextSnapshotWriter,
  type SharedText,
} from "./shared-text.js";

describe("shared text versions", () => {
  it("preserves immutable versions through edits, shrinking, clearing and UTF-16 boundaries", () => {
    const values = [
      "",
      "alpha🙂\ud800beta\udfff",
      "alpha🙂\ud800BETTER\udfff",
      "first alpha🙂\ud800BETTER\udfff",
      "first a",
      "",
      "new",
      "new",
    ];
    const versions: SharedText[] = [];
    let previous: SharedText = null;
    let text = "";
    for (const next of values) {
      previous = reviseText(previous, text, next);
      versions.push(previous);
      text = next;
    }
    expect(versions.map(readText)).toEqual(values);
    expect(versions.at(-1)).toBe(versions.at(-2));
    const writer = new TextSnapshotWriter();
    const roots = versions.map((node) => writer.add(node));
    const decoded = decodeTextNodes(JSON.parse(JSON.stringify(writer.nodes)));
    expect(roots.map((root) => readText(root === null ? null : decoded[root]))).toEqual(values);
  });

  it("keeps long append histories balanced and stores each appended chunk once", () => {
    let version: SharedText = null;
    let text = "";
    const writer = new TextSnapshotWriter();
    const roots: Array<number | null> = [];
    for (let index = 0; index < 10_000; index++) {
      const next = text + String.fromCharCode(65 + (index % 26));
      version = reviseText(version, text, next);
      roots.push(writer.add(version));
      text = next;
    }
    expect(readText(version)).toBe(text);
    expect(version?.height).toBeLessThan(30);
    const characters = writer.nodes.reduce(
      (sum, entry) => sum + (typeof entry === "string" ? entry.length : 0),
      0,
    );
    expect(characters).toBe(10_000);
    const decoded = decodeTextNodes(writer.nodes);
    for (const index of [0, 1, 99, 999, 9999]) {
      const root = roots[index];
      expect(readText(root === null ? null : decoded[root])).toBe(text.slice(0, index + 1));
    }
  });

  it("shares a large suffix when status text changes at the beginning", () => {
    const suffix = "unchanged🙂".repeat(10_000);
    let text = `running: ${suffix}`;
    let version = reviseText(null, "", text);
    const writer = new TextSnapshotWriter();
    writer.add(version);
    for (let index = 0; index < 200; index++) {
      const next = `status-${index}: ${suffix}`;
      version = reviseText(version, text, next);
      writer.add(version);
      text = next;
    }
    expect(readText(version)).toBe(text);
    expect(decodeTextNodes(writer.nodes).length).toBe(writer.nodes.length);
    const characters = writer.nodes.reduce(
      (sum, entry) => sum + (typeof entry === "string" ? entry.length : 0),
      0,
    );
    expect(characters).toBeLessThan(suffix.length * 3);
  });

  it("round trips deterministic edits throughout a growing document", () => {
    let seed = 17;
    function nextInt() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    }
    let version: SharedText = null;
    let text = "";
    const writer = new TextSnapshotWriter();
    const expected: string[] = [];
    const roots: Array<number | null> = [];
    for (let index = 0; index < 500; index++) {
      const start = nextInt() % (text.length + 1);
      const removed = nextInt() % (text.length - start + 1);
      const inserted = `${index}\ud800🙂`;
      const next = text.slice(0, start) + inserted + text.slice(start + removed);
      version = reviseText(version, text, next);
      expect(readText(version)).toBe(next);
      roots.push(writer.add(version));
      expected.push(next);
      text = next;
    }
    const decoded = decodeTextNodes(writer.nodes);
    expect(roots.map((root) => readText(root === null ? null : decoded[root]))).toEqual(expected);
  });

  it("rejects cyclic, forward, unbalanced and runtime-impossible text graphs", () => {
    expect(() => decodeTextNodes([[0, 0]])).toThrow("earlier nodes");
    expect(() => decodeTextNodes(["a", [0, 2]])).toThrow("earlier nodes");
    expect(() => decodeTextNodes(["a", [0, 0], [1, 0], [2, 0]])).toThrow("balanced");
    const writer = new TextSnapshotWriter();
    writer.nodes.push("x");
    for (let index = 0; index < 40; index++) writer.nodes.push([index, index]);
    expect(() => decodeTextNodes(writer.nodes)).toThrow("runtime string limit");
  });
});
