import { describe, expect, it } from "vitest";
import { markdownBlockEdgeStyle, markdownNodeContainsType } from "./markdown-ast";

it("removes block edge margins while retaining spacing inside lists and quotes", () => {
  const style = { marginTop: 10, marginBottom: 12, marginVertical: 10, height: 1 };
  expect(markdownBlockEdgeStyle(style, [{ type: "body" }])).toEqual({
    marginTop: 0,
    marginBottom: 0,
    marginVertical: 0,
    height: 1,
  });
  expect(markdownBlockEdgeStyle(style, [{ type: "list_item" }, { type: "body" }])).toBe(style);
  expect(markdownBlockEdgeStyle(style, [{ type: "blockquote" }, { type: "body" }])).toBe(style);
});

describe("markdownNodeContainsType", () => {
  it("matches the node itself", () => {
    expect(markdownNodeContainsType({ type: "image", children: [] }, "image")).toBe(true);
  });

  it("matches descendants", () => {
    const paragraph = {
      type: "paragraph",
      children: [
        { type: "text", children: [] },
        {
          type: "link",
          children: [{ type: "image", children: [] }],
        },
      ],
    };

    expect(markdownNodeContainsType(paragraph, "image")).toBe(true);
  });

  it("returns false when the type is absent", () => {
    const paragraph = {
      type: "paragraph",
      children: [
        { type: "text", children: [] },
        { type: "strong", children: [{ type: "text", children: [] }] },
      ],
    };

    expect(markdownNodeContainsType(paragraph, "image")).toBe(false);
  });
});
