import { describe, expect, it } from "vitest";
import {
  decodeTextNodes,
  readText,
  suffixPrefixOverlap,
  textJsonBytes,
  validateTextNodes,
  reviseText,
  TextSnapshotWriter,
  type SharedText,
} from "./shared-text.js";

function extendStrings(prefixes: string[], alphabet: string[]): string[] {
  return prefixes.flatMap((prefix) => alphabet.map((unit) => prefix + unit));
}

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
    const decoded = decodeTextNodes(JSON.parse(JSON.stringify(writer.nodes)), writer.backings);
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
    const characters = writer.backings.reduce((sum, entry) => sum + entry.length, 0);
    expect(characters).toBe(10_000);
    const decoded = decodeTextNodes(writer.nodes, writer.backings);
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
    expect(decodeTextNodes(writer.nodes, writer.backings).length).toBe(writer.nodes.length);
    const characters = writer.backings.reduce((sum, entry) => sum + entry.length, 0);
    expect(characters).toBeLessThan(suffix.length * 3);
  });

  it("retains one owned backing across advancing edits instead of copying each suffix", () => {
    const original = "a".repeat(65_536);
    let text = original;
    let version = reviseText(null, "", text);
    const writer = new TextSnapshotWriter();
    const roots = [writer.add(version)];
    for (let index = 0; index < 300; index++) {
      const next = text.slice(0, index) + "b" + text.slice(index + 1);
      version = reviseText(version, text, next);
      roots.push(writer.add(version));
      text = next;
    }
    expect(writer.backings.reduce((sum, backing) => sum + backing.length, 0)).toBe(
      original.length + 300,
    );
    const decoded = decodeTextNodes(writer.nodes, writer.backings);
    expect(readText(decoded[roots[0]!])).toBe(original);
    expect(readText(decoded[roots[300]!])).toBe(text);
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
    const decoded = decodeTextNodes(writer.nodes, writer.backings);
    expect(roots.map((root) => readText(root === null ? null : decoded[root]))).toEqual(expected);
  });

  it("reuses rolling action windows beyond the producers' 200-action window", () => {
    let text = "";
    let version: SharedText = null;
    const writer = new TextSnapshotWriter();
    const lines: string[] = [];
    const expected: string[] = [];
    const roots: Array<number | null> = [];
    for (let index = 0; index < 600; index++) {
      lines.push(`action-${index}: ${"repeated content".repeat(20)}\r\n`);
      const next = lines.slice(-200).join("");
      version = reviseText(version, text, next);
      roots.push(writer.add(version));
      expected.push(next);
      text = next;
    }
    const decoded = decodeTextNodes(writer.nodes, writer.backings);
    expect(roots.map((root) => readText(root === null ? null : decoded[root]))).toEqual(expected);
    expect(writer.backings.reduce((sum, backing) => sum + backing.length, 0)).toBe(
      lines.join("").length,
    );
  });

  it("matches a brute-force rolling overlap oracle including lone surrogates", () => {
    const values = [""];
    let frontier = [""];
    for (let length = 1; length <= 4; length++) {
      frontier = extendStrings(frontier, ["a", "b", "\n", "\ud800", "\udfff"]);
      values.push(...frontier);
    }
    for (const previous of values) {
      for (const next of values) {
        let expected = Math.min(previous.length, next.length);
        while (
          expected > 0 &&
          previous.slice(previous.length - expected) !== next.slice(0, expected)
        )
          expected--;
        expect(suffixPrefixOverlap(previous, next)).toBe(expected);
      }
    }
    const repeated = `${"identical line\n".repeat(200)}late difference`;
    expect(suffixPrefixOverlap(`older ${repeated}`, `${repeated} appended`)).toBe(repeated.length);
  });

  it("sizes JSON escapes and surrogate pairs across every possible leaf boundary", () => {
    const values = [""];
    let frontier = [""];
    for (let length = 1; length <= 3; length++) {
      frontier = extendStrings(frontier, [
        "a",
        '"',
        "\\",
        "\n",
        "\ud800",
        "\udfff",
        "\u07ff",
        "\u0800",
      ]);
      values.push(...frontier);
    }
    for (const text of values) {
      const expected = Buffer.byteLength(JSON.stringify(text)) - 2;
      for (let split = 0; split <= text.length; split++) {
        const prefix = text.slice(0, split);
        const first = reviseText(null, "", prefix);
        const version = reviseText(first, prefix, text);
        expect(textJsonBytes(version)).toBe(expected);
        expect(textJsonBytes(version, expected)).toBe(expected);
        expect(textJsonBytes(version, expected - 1)).toBe(null);
      }
    }
  });

  it("sizes previously uncached split surrogates at an exact response budget", () => {
    const version = reviseText(reviseText(null, "", "\ud800"), "\ud800", "\ud800\udfff");
    expect(textJsonBytes(version, 4)).toBe(4);
    const different = reviseText(reviseText(null, "", "\ud800"), "\ud800", "\ud800\udfff");
    expect(textJsonBytes(different, 3)).toBe(null);
    expect(textJsonBytes(different, 4)).toBe(4);
  });

  it("validates range graphs structurally and keeps version 2 decoding explicit", () => {
    expect(() => validateTextNodes([[0, 0, 4]], ["text"])).not.toThrow();
    expect(readText(decodeTextNodes([[0, 1, 3]], ["text"])[0])).toBe("ex");
    expect(readText(decodeTextNodes(["old", " format", [0, 1]])[2])).toBe("old format");
    expect(() => validateTextNodes([[0, 0, 1]])).toThrow("version 3");
    expect(() => validateTextNodes(["inline"], ["text"])).toThrow("Version 3");
    for (const range of [
      [0, 2, 2],
      [0, -1, 1],
      [0, 0, 5],
      [1, 0, 1],
      [0, 0.5, 1],
    ]) {
      expect(() => validateTextNodes([[range[0], range[1], range[2]]], ["text"])).toThrow(
        "backing range",
      );
    }
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
