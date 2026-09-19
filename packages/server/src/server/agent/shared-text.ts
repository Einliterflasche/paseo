import { z } from "zod";
import { constants as bufferConstants } from "node:buffer";

interface OwnedText {
  readonly text: string;
}

interface TextShape {
  readonly length: number;
  readonly height: number;
  readonly firstUnit: number;
  readonly lastUnit: number;
}

interface TextLeaf extends TextShape {
  readonly kind: "leaf";
  readonly backing: OwnedText;
  readonly start: number;
  readonly end: number;
}

interface TextBranch extends TextShape {
  readonly kind: "branch";
  readonly left: TextNode;
  readonly right: TextNode;
}

export type TextNode = TextLeaf | TextBranch;
export type SharedText = TextNode | null;

// Weak metadata never retains text after its last version owner releases it.
const encodedLengths = new WeakMap<TextNode, number>();

function ownText(text: string): OwnedText {
  // Preserve lone surrogates and detach slices from the provider's cumulative log.
  return Object.freeze({ text: Buffer.from(text, "utf16le").toString("utf16le") });
}

function span(backing: OwnedText, start: number, end: number): TextLeaf {
  return Object.freeze({
    kind: "leaf",
    backing,
    start,
    end,
    length: end - start,
    height: 1,
    firstUnit: backing.text.charCodeAt(start),
    lastUnit: backing.text.charCodeAt(end - 1),
  });
}

function leaf(text: string): SharedText {
  return text.length ? span(ownText(text), 0, text.length) : null;
}

function branch(left: TextNode, right: TextNode): TextBranch {
  return Object.freeze({
    kind: "branch",
    left,
    right,
    length: left.length + right.length,
    height: Math.max(left.height, right.height) + 1,
    firstUnit: left.firstUnit,
    lastUnit: right.lastUnit,
  });
}

function balance(left: TextNode, right: TextNode): TextNode {
  if (left.height > right.height + 1 && left.kind === "branch") {
    if (left.left.height >= left.right.height) {
      return branch(left.left, branch(left.right, right));
    }
    const pivot = left.right;
    if (pivot.kind === "branch") {
      return branch(branch(left.left, pivot.left), branch(pivot.right, right));
    }
  }
  if (right.height > left.height + 1 && right.kind === "branch") {
    if (right.right.height >= right.left.height) {
      return branch(branch(left, right.left), right.right);
    }
    const pivot = right.left;
    if (pivot.kind === "branch") {
      return branch(branch(left, pivot.left), branch(pivot.right, right.right));
    }
  }
  return branch(left, right);
}

function concat(left: SharedText, right: SharedText): SharedText {
  if (!left) return right;
  if (!right) return left;
  if (left.height > right.height + 1 && left.kind === "branch") {
    const joined = concat(left.right, right);
    return joined ? balance(left.left, joined) : left.left;
  }
  if (right.height > left.height + 1 && right.kind === "branch") {
    const joined = concat(left, right.left);
    return joined ? balance(joined, right.right) : right.right;
  }
  return branch(left, right);
}

function slice(node: SharedText, start: number, end: number): SharedText {
  if (!node || start === end) return null;
  if (start === 0 && end === node.length) return node;
  if (node.kind === "leaf") return span(node.backing, node.start + start, node.start + end);
  const boundary = node.left.length;
  if (end <= boundary) return slice(node.left, start, end);
  if (start >= boundary) return slice(node.right, start - boundary, end - boundary);
  return concat(slice(node.left, start, boundary), slice(node.right, 0, end - boundary));
}

/** Longest suffix(previous) equal to a prefix(text), including UTF-16 split boundaries. */
export function suffixPrefixOverlap(previous: string, text: string): number {
  const limit = Math.min(previous.length, text.length);
  if (!limit) return 0;
  const failure = new Int32Array(limit);
  let matched = 0;
  for (let index = 1; index < limit; index++) {
    const unit = text.charCodeAt(index);
    while (matched && text.charCodeAt(matched) !== unit) matched = failure[matched - 1];
    if (text.charCodeAt(matched) === unit) matched++;
    failure[index] = matched;
  }
  matched = 0;
  // No possible overlap begins before this suffix.
  for (let index = previous.length - limit; index < previous.length; index++) {
    const unit = previous.charCodeAt(index);
    while (matched && (matched === limit || text.charCodeAt(matched) !== unit)) {
      matched = failure[matched - 1];
    }
    if (text.charCodeAt(matched) === unit) matched++;
  }
  return matched;
}

/** Immutable versions share ordinary edits and rolling windows over owned chunks. */
export function reviseText(previous: SharedText, previousText: string, text: string): SharedText {
  if (text === previousText) return previous;
  if (!previous) return leaf(text);
  if (text.startsWith(previousText)) return concat(previous, leaf(text.slice(previousText.length)));
  if (previousText.startsWith(text)) return slice(previous, 0, text.length);
  const limit = Math.min(previousText.length, text.length);
  let prefix = 0;
  while (prefix < limit && previousText.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    previousText.charCodeAt(previousText.length - suffix - 1) ===
      text.charCodeAt(text.length - suffix - 1)
  ) {
    suffix++;
  }
  if (prefix + suffix < limit) {
    const overlap = suffixPrefixOverlap(previousText, text);
    if (overlap > prefix + suffix) {
      return concat(
        slice(previous, previousText.length - overlap, previousText.length),
        leaf(text.slice(overlap)),
      );
    }
  }
  const leading = slice(previous, 0, prefix);
  const inserted = leaf(text.slice(prefix, text.length - suffix));
  const trailing = slice(previous, previousText.length - suffix, previousText.length);
  return concat(concat(leading, inserted), trailing);
}

/** Expanded historical strings are transient; never memoize them on a version. */
export function readText(root: SharedText): string {
  if (!root) return "";
  const pending = [root];
  const chunks: string[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.kind === "leaf") chunks.push(node.backing.text.slice(node.start, node.end));
    else pending.push(node.right, node.left);
  }
  return chunks.join("");
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function spanJsonBytes(node: TextLeaf, maximum: number): number | null {
  let bytes = 0;
  for (let index = node.start; index < node.end; index++) {
    const unit = node.backing.text.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 8 ||
      unit === 9 ||
      unit === 10 ||
      unit === 12 ||
      unit === 13
    )
      bytes += 2;
    else if (unit < 0x20) bytes += 6;
    else if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (
      isHighSurrogate(unit) &&
      index + 1 < node.end &&
      isLowSurrogate(node.backing.text.charCodeAt(index + 1))
    ) {
      bytes += 4;
      index++;
    } else if (isHighSurrogate(unit) || isLowSurrogate(unit)) bytes += 6;
    else bytes += 3;
    if (bytes > maximum) return null;
  }
  return bytes;
}

/** JSON string content bytes, excluding quotes. Null means the supplied budget is exceeded. */
export function textJsonBytes(root: SharedText, maximum = Infinity): number | null {
  if (!root) return maximum < 0 ? null : 0;
  if (root.length > maximum) return null;
  const cached = encodedLengths.get(root);
  if (cached !== undefined) return cached > maximum ? null : cached;
  let bytes: number | null;
  if (root.kind === "leaf") bytes = spanJsonBytes(root, maximum);
  else {
    // Each isolated surrogate is escaped as six bytes; together they encode as four.
    const correction =
      isHighSurrogate(root.left.lastUnit) && isLowSurrogate(root.right.firstUnit) ? 8 : 0;
    const left = textJsonBytes(root.left, maximum + correction);
    if (left === null) return null;
    const right = textJsonBytes(root.right, maximum - left + correction);
    if (right === null) return null;
    bytes = left + right - correction;
  }
  if (bytes !== null) encodedLengths.set(root, bytes);
  return bytes;
}

// COMPAT(checkpoint-text-v2): added in fork 2026-09-19; retain while v2 checkpoints are supported.
export const TextNodeSnapshotSchema = z.union([
  z.string().min(1),
  z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
]);
export type TextNodeSnapshot = z.infer<typeof TextNodeSnapshotSchema>;

interface SnapshotShape {
  readonly length: number;
  readonly height: number;
}

interface TextSnapshotVisitor<T extends SnapshotShape> {
  leaf(text: string, start: number, end: number, backingIndex: number): T;
  branch(left: T, right: T): T;
}

/** Validate the graph without expanding any text or making owned backing copies. */
function visitTextNodes<T extends SnapshotShape>(
  encoded: readonly TextNodeSnapshot[],
  backings: readonly string[] | undefined,
  visitor: TextSnapshotVisitor<T>,
): T[] {
  const nodes: T[] = [];
  for (const entry of encoded) {
    if (typeof entry === "string") {
      if (backings !== undefined)
        throw new Error("Version 3 text leaves must reference owned backings");
      if (!entry.length) throw new Error("Shared text leaf must not be empty");
      nodes.push(visitor.leaf(entry, 0, entry.length, nodes.length));
    } else if (entry.length === 3) {
      if (backings === undefined) throw new Error("Shared text ranges require version 3 backings");
      const [index, start, end] = entry;
      const text = backings[index];
      if (
        !Number.isInteger(index) ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        text === undefined ||
        start < 0 ||
        end <= start ||
        end > text.length
      ) {
        throw new Error("Invalid shared text backing range");
      }
      nodes.push(visitor.leaf(text, start, end, index));
    } else {
      const [leftIndex, rightIndex] = entry;
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      if (!Number.isInteger(leftIndex) || !Number.isInteger(rightIndex) || !left || !right) {
        throw new Error("Shared text references must point to earlier nodes");
      }
      if (Math.abs(left.height - right.height) > 1)
        throw new Error("Shared text tree must be balanced");
      if (left.length + right.length > bufferConstants.MAX_STRING_LENGTH)
        throw new Error("Shared text length exceeds the runtime string limit");
      nodes.push(visitor.branch(left, right));
    }
  }
  return nodes;
}

export function validateTextNodes(
  encoded: readonly TextNodeSnapshot[],
  backings?: readonly string[],
): void {
  visitTextNodes(encoded, backings, {
    leaf: (_text, start, end) => ({ length: end - start, height: 1 }),
    branch: (left, right) => ({
      length: left.length + right.length,
      height: Math.max(left.height, right.height) + 1,
    }),
  });
}

/** Child indices precede parents; decoded versions cannot recurse or form cycles. */
export function decodeTextNodes(
  encoded: readonly TextNodeSnapshot[],
  backings?: readonly string[],
): TextNode[] {
  const owned = new Map<number, OwnedText>();
  return visitTextNodes<TextNode>(encoded, backings, {
    leaf: (text, start, end, index) => {
      let backing = owned.get(index);
      if (!backing) {
        backing = ownText(text);
        owned.set(index, backing);
      }
      return span(backing, start, end);
    },
    branch,
  });
}

export class TextSnapshotWriter {
  readonly nodes: TextNodeSnapshot[] = [];
  readonly backings: string[] = [];
  private readonly indices = new Map<TextNode, number>();
  private readonly backingIndices = new Map<OwnedText, number>();

  add(root: SharedText): number | null {
    if (!root) return null;
    const pending = [root];
    while (pending.length) {
      const node = pending[pending.length - 1];
      if (this.indices.has(node)) {
        pending.pop();
        continue;
      }
      if (node.kind === "leaf") {
        let index = this.backingIndices.get(node.backing);
        if (index === undefined) {
          index = this.backings.length;
          this.backings.push(node.backing.text);
          this.backingIndices.set(node.backing, index);
        }
        this.indices.set(node, this.nodes.length);
        this.nodes.push([index, node.start, node.end]);
        pending.pop();
        continue;
      }
      const left = this.indices.get(node.left);
      const right = this.indices.get(node.right);
      if (left === undefined) pending.push(node.left);
      else if (right === undefined) pending.push(node.right);
      else {
        this.indices.set(node, this.nodes.length);
        this.nodes.push([left, right]);
        pending.pop();
      }
    }
    return this.indices.get(root)!;
  }
}
