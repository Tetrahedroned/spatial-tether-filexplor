// Rust symbol walker — captures fn, struct, enum, trait, type alias, const,
// and impl-block methods. The `pub` modifier maps to exported=true.
import Parser from "tree-sitter";
import { ExtractedSymbol } from "./fs-symbols-types";

function spanOf(node: Parser.SyntaxNode) {
  return { start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1 };
}
function byteRangeOf(node: Parser.SyntaxNode) {
  return { start: node.startIndex, end: node.endIndex };
}

function fieldName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

// A node is exported if its first child is `visibility_modifier` containing `pub`.
function isPublic(node: Parser.SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type === "visibility_modifier") return true;
  }
  return false;
}

function collectImplBlock(
  impl: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  scope: string[],
): void {
  // impl_item has a `type` field for the type being impl'd
  const typeNode = impl.childForFieldName("type");
  const typeName = typeNode?.text ?? "_";
  const chainBase = [...scope, typeName];

  // Walk the body for function items
  const body = impl.childForFieldName("body");
  const target = body ?? impl;
  for (let i = 0; i < target.namedChildCount; i++) {
    const member = target.namedChild(i);
    if (!member) continue;
    if (member.type === "function_item") {
      const name = fieldName(member);
      if (!name) continue;
      symbols.push({
        name,
        symbol_kind: "method",
        exported: isPublic(member),
        span: spanOf(member),
        scope_chain: [...chainBase, name],
        byte_range: byteRangeOf(member),
      });
    }
  }
}

function handleNode(
  node: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  scope: string[],
): void {
  switch (node.type) {
    case "function_item": {
      const name = fieldName(node);
      if (!name) return;
      symbols.push({
        name,
        symbol_kind: "function",
        exported: isPublic(node),
        span: spanOf(node),
        scope_chain: [...scope, name],
        byte_range: byteRangeOf(node),
      });
      return;
    }
    case "struct_item": {
      const name = fieldName(node);
      if (!name) return;
      symbols.push({
        name,
        symbol_kind: "class",          // closest atom kind
        exported: isPublic(node),
        span: spanOf(node),
        scope_chain: [...scope, name],
        byte_range: byteRangeOf(node),
      });
      return;
    }
    case "enum_item": {
      const name = fieldName(node);
      if (!name) return;
      symbols.push({
        name,
        symbol_kind: "enum",
        exported: isPublic(node),
        span: spanOf(node),
        scope_chain: [...scope, name],
        byte_range: byteRangeOf(node),
      });
      return;
    }
    case "trait_item": {
      const name = fieldName(node);
      if (!name) return;
      symbols.push({
        name,
        symbol_kind: "interface",      // traits are Rust's interface analogue
        exported: isPublic(node),
        span: spanOf(node),
        scope_chain: [...scope, name],
        byte_range: byteRangeOf(node),
      });
      return;
    }
    case "type_item": {
      const name = fieldName(node);
      if (!name) return;
      symbols.push({
        name,
        symbol_kind: "type",
        exported: isPublic(node),
        span: spanOf(node),
        scope_chain: [...scope, name],
        byte_range: byteRangeOf(node),
      });
      return;
    }
    case "const_item":
    case "static_item": {
      const name = fieldName(node);
      if (!name) return;
      symbols.push({
        name,
        symbol_kind: "const",
        exported: isPublic(node),
        span: spanOf(node),
        scope_chain: [...scope, name],
        byte_range: byteRangeOf(node),
      });
      return;
    }
    case "impl_item":
      collectImplBlock(node, symbols, scope);
      return;
    default:
      return;
  }
}

export function walkSymbols(tree: Parser.Tree, _src: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const root = tree.rootNode;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child) handleNode(child, symbols, []);
  }
  return symbols;
}
