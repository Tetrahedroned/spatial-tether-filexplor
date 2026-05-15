// Python symbol walker — captures functions (def), classes, methods,
// module-level assignments. No reference resolution in v1.
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

function collectClassBody(
  classBody: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  scope: string[],
): void {
  for (let i = 0; i < classBody.namedChildCount; i++) {
    const member = classBody.namedChild(i);
    if (!member) continue;
    if (member.type === "function_definition") {
      const name = fieldName(member);
      if (!name) continue;
      symbols.push({
        name,
        symbol_kind: "method",
        exported: !name.startsWith("_"),       // PEP 8 convention: leading underscore is private
        span: spanOf(member),
        scope_chain: [...scope, name],
        byte_range: byteRangeOf(member),
      });
    }
    // Class-level assignments → const-like
    if (member.type === "expression_statement") {
      const inner = member.namedChild(0);
      if (inner?.type === "assignment") {
        const left = inner.childForFieldName("left");
        if (left?.type === "identifier") {
          symbols.push({
            name: left.text,
            symbol_kind: "const",
            exported: !left.text.startsWith("_"),
            span: spanOf(member),
            scope_chain: [...scope, left.text],
            byte_range: byteRangeOf(member),
          });
        }
      }
    }
  }
}

function handleNode(
  node: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  scope: string[],
): void {
  switch (node.type) {
    case "function_definition": {
      const name = fieldName(node);
      if (!name) return;
      symbols.push({
        name,
        symbol_kind: "function",
        exported: !name.startsWith("_"),
        span: spanOf(node),
        scope_chain: [...scope, name],
        byte_range: byteRangeOf(node),
      });
      return;
    }
    case "class_definition": {
      const name = fieldName(node);
      if (!name) return;
      const chain = [...scope, name];
      symbols.push({
        name,
        symbol_kind: "class",
        exported: !name.startsWith("_"),
        span: spanOf(node),
        scope_chain: chain,
        byte_range: byteRangeOf(node),
      });
      const body = node.childForFieldName("body");
      if (body) collectClassBody(body, symbols, chain);
      return;
    }
    case "expression_statement": {
      // Module-level assignment → const
      const inner = node.namedChild(0);
      if (inner?.type === "assignment") {
        const left = inner.childForFieldName("left");
        if (left?.type === "identifier") {
          symbols.push({
            name: left.text,
            symbol_kind: "const",
            exported: !left.text.startsWith("_"),
            span: spanOf(node),
            scope_chain: [...scope, left.text],
            byte_range: byteRangeOf(node),
          });
        }
      }
      return;
    }
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
