// Go symbol walker — captures functions, methods (functions with a receiver),
// type declarations (struct/interface/alias), and constants. Exported flag
// follows Go's convention: capitalized identifiers are exported.
import Parser from "tree-sitter";
import { ExtractedSymbol } from "./fs-symbols-types";
import { SymbolKind } from "./fs-manifest";

function spanOf(node: Parser.SyntaxNode) {
  return { start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1 };
}
function byteRangeOf(node: Parser.SyntaxNode) {
  return { start: node.startIndex, end: node.endIndex };
}

function isExportedGo(name: string): boolean {
  // Go: identifiers starting with an uppercase ASCII letter are exported.
  return /^[A-Z]/.test(name);
}

function fieldName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

// type_declaration wraps one or more type_spec children: type T struct {…},
// type I interface {…}, type Alias = X. We pull each spec out as its own
// symbol whose kind reflects the underlying type expression.
function collectTypeSpecs(
  typeDecl: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  scope: string[],
): void {
  for (let i = 0; i < typeDecl.namedChildCount; i++) {
    const spec = typeDecl.namedChild(i);
    if (!spec) continue;
    if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
    const name = fieldName(spec);
    if (!name) continue;

    // Determine kind by inspecting the type expression
    const typeNode = spec.childForFieldName("type");
    let kind: SymbolKind = "type";
    if (typeNode) {
      if (typeNode.type === "struct_type")    kind = "class";       // closest mapping
      else if (typeNode.type === "interface_type") kind = "interface";
    }

    symbols.push({
      name,
      symbol_kind: kind,
      exported: isExportedGo(name),
      span: spanOf(spec),
      scope_chain: [...scope, name],
      byte_range: byteRangeOf(spec),
    });
  }
}

function collectConstSpecs(
  constDecl: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  scope: string[],
): void {
  for (let i = 0; i < constDecl.namedChildCount; i++) {
    const spec = constDecl.namedChild(i);
    if (!spec || spec.type !== "const_spec") continue;
    // const_spec can declare multiple names: `const a, b = 1, 2`
    for (let j = 0; j < spec.namedChildCount; j++) {
      const id = spec.namedChild(j);
      if (id?.type !== "identifier") continue;
      symbols.push({
        name: id.text,
        symbol_kind: "const",
        exported: isExportedGo(id.text),
        span: spanOf(spec),
        scope_chain: [...scope, id.text],
        byte_range: byteRangeOf(spec),
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
    case "function_declaration": {
      const name = fieldName(node);
      if (!name) return;
      symbols.push({
        name,
        symbol_kind: "function",
        exported: isExportedGo(name),
        span: spanOf(node),
        scope_chain: [...scope, name],
        byte_range: byteRangeOf(node),
      });
      return;
    }
    case "method_declaration": {
      // Methods have a receiver — we synthesize a scope chain like
      // ["ReceiverType", "MethodName"] so the atom ID disambiguates.
      const name = fieldName(node);
      if (!name) return;
      const recv = node.childForFieldName("receiver");
      let receiverType = "_";
      if (recv) {
        // receiver: parameter_list → parameter_declaration → type
        const paramDecl = recv.namedChild(0);
        const typeNode = paramDecl?.childForFieldName("type");
        if (typeNode) {
          const t = typeNode.type === "pointer_type"
            ? typeNode.namedChild(0)?.text
            : typeNode.text;
          if (t) receiverType = t;
        }
      }
      symbols.push({
        name,
        symbol_kind: "method",
        exported: isExportedGo(name),
        span: spanOf(node),
        scope_chain: [...scope, receiverType, name],
        byte_range: byteRangeOf(node),
      });
      return;
    }
    case "type_declaration":
      collectTypeSpecs(node, symbols, scope);
      return;
    case "const_declaration":
      collectConstSpecs(node, symbols, scope);
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
