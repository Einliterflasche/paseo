import { z } from "zod";
import { constants as bufferConstants } from "node:buffer";

interface TextLeaf {
  readonly kind: "leaf";
  readonly text: string;
  readonly length: number;
  readonly height: number;
}

interface TextBranch {
  readonly kind: "branch";
  readonly left: TextNode;
  readonly right: TextNode;
  readonly length: number;
  readonly height: number;
}

export type TextNode = TextLeaf | TextBranch;
export type SharedText = TextNode | null;

// Copy code units, including lone surrogates. A V8 sliced string can otherwise
// keep the entire incoming cumulative log alive for one tiny inserted fragment.
function leaf(text: string): SharedText {
  if (!text.length) return null;
  const copy = Buffer.from(text, "utf16le").toString("utf16le");
  return { kind: "leaf", text: copy, length: copy.length, height: 1 };
}

function branch(left: TextNode, right: TextNode): TextBranch {
  return {
    kind: "branch",
    left,
    right,
    length: left.length + right.length,
    height: Math.max(left.height, right.height) + 1,
  };
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
  if (node.kind === "leaf") return leaf(node.text.slice(start, end));
  const boundary = node.left.length;
  if (end <= boundary) return slice(node.left, start, end);
  if (start >= boundary) return slice(node.right, start - boundary, end - boundary);
  return concat(slice(node.left, start, boundary), slice(node.right, 0, end - boundary));
}

/** Immutable versions share unchanged prefixes AND suffixes, including tool-status edits. */
export function reviseText(previous: SharedText, previousText: string, text: string): SharedText {
  if (text === previousText) return previous;
  if (!previous) return leaf(text);
  let prefix = 0;
  if (text.startsWith(previousText)) {
    prefix = previousText.length;
  } else {
    const end = Math.min(previousText.length, text.length);
    while (prefix < end && previousText.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
  }
  let suffix = 0;
  const end = Math.min(previousText.length, text.length) - prefix;
  while (
    suffix < end &&
    previousText.charCodeAt(previousText.length - suffix - 1) ===
      text.charCodeAt(text.length - suffix - 1)
  ) {
    suffix++;
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
    if (node.kind === "leaf") chunks.push(node.text);
    else pending.push(node.right, node.left);
  }
  return chunks.join("");
}

export const TextNodeSnapshotSchema = z.union([
  z.string().min(1),
  z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
]);
export type TextNodeSnapshot = z.infer<typeof TextNodeSnapshotSchema>;

/** Child indices always precede their parent: decoding cannot recurse or form cycles. */
export function decodeTextNodes(encoded: readonly TextNodeSnapshot[]): TextNode[] {
  const nodes: TextNode[] = [];
  for (const entry of encoded) {
    if (typeof entry === "string") {
      const node = leaf(entry);
      if (!node) throw new Error("Shared text leaf must not be empty");
      nodes.push(node);
      continue;
    }
    const left = nodes[entry[0]];
    const right = nodes[entry[1]];
    if (!left || !right) throw new Error("Shared text references must point to earlier nodes");
    if (Math.abs(left.height - right.height) > 1) {
      throw new Error("Shared text tree must be balanced");
    }
    if (left.length + right.length > bufferConstants.MAX_STRING_LENGTH) {
      throw new Error("Shared text length exceeds the runtime string limit");
    }
    nodes.push(branch(left, right));
  }
  return nodes;
}

export class TextSnapshotWriter {
  readonly nodes: TextNodeSnapshot[] = [];
  private readonly indices = new Map<TextNode, number>();

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
        this.indices.set(node, this.nodes.length);
        this.nodes.push(node.text);
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
