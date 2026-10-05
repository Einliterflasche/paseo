import type { ViewStyle } from "react-native";

export interface MarkdownAstNodeWithChildren {
  type: string;
  children: MarkdownAstNodeWithChildren[];
}

export function markdownNodeContainsType(node: MarkdownAstNodeWithChildren, type: string): boolean {
  if (node.type === type) {
    return true;
  }

  return node.children.some((child) => markdownNodeContainsType(child, type));
}

/** Block rows own their outer spacing; paragraphs inside lists and quotes keep theirs. */
export function markdownBlockEdgeStyle(
  style: ViewStyle,
  parent: readonly { type: string }[],
): ViewStyle {
  return parent.some((ancestor) => ancestor.type !== "body")
    ? style
    : { ...style, marginVertical: 0, marginTop: 0, marginBottom: 0 };
}
