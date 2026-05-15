// ---------------------------------------------------------------------------
// TypeScript / JavaScript / TSX / JSX / MJS / CJS — symbol + reference walker.
//
// Used by fs-symbols.ts dispatcher. Two operations:
//   - walkSymbols(tree, src)        → ExtractedSymbol[]   (Phase 2a)
//   - walkReferences(tree, src, …)  → ReferenceMap        (Phase 2b)
//
// Reference resolution order (per blueprint):
//   1. Local scope    — params + local declarations (drop)
//   2. File symbols   — top-level decls in this file
//   3. Imported names — names imported from other files in the project
// ---------------------------------------------------------------------------
import Parser from "tree-sitter";
import { ExtractedSymbol, ReferenceMap, ImportedNameMap } from "./fs-symbols-types";
import { SymbolKind } from "./fs-manifest";

// ── Symbol walker (Phase 2a) ───────────────────────────────────────────────

function nodeName(node: Parser.SyntaxNode): string | null {
  const n = node.childForFieldName("name");
  if (n) return n.text;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && (c.type === "identifier" || c.type === "type_identifier" || c.type === "property_identifier")) {
      return c.text;
    }
  }
  return null;
}

function spanOf(node: Parser.SyntaxNode) {
  return {
    start_line: node.startPosition.row + 1,
    end_line:   node.endPosition.row + 1,
  };
}

function byteRangeOf(node: Parser.SyntaxNode) {
  return { start: node.startIndex, end: node.endIndex };
}

function declarationKind(nodeType: string): SymbolKind | null {
  switch (nodeType) {
    case "function_declaration":
    case "function":
    case "generator_function_declaration":
      return "function";
    case "class_declaration":
    case "abstract_class_declaration":
      return "class";
    case "type_alias_declaration":
      return "type";
    case "interface_declaration":
      return "interface";
    case "enum_declaration":
      return "enum";
    default:
      return null;
  }
}

function collectClassMembers(
  classBody: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  scope: string[],
): void {
  for (let i = 0; i < classBody.namedChildCount; i++) {
    const member = classBody.namedChild(i);
    if (!member) continue;
    if (member.type === "method_definition") {
      const nameNode = member.childForFieldName("name");
      const name = nameNode?.text;
      if (!name) continue;
      symbols.push({
        name,
        symbol_kind: "method",
        exported: false,
        span: spanOf(member),
        scope_chain: [...scope, name],
        byte_range: byteRangeOf(member),
      });
    }
  }
}

function handleNode(
  node: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  scope: string[],
  exportedHint: boolean,
): void {
  if (node.type === "export_statement") {
    const inner = node.childForFieldName("declaration");
    if (inner) {
      handleNode(inner, symbols, scope, true);
      return;
    }
    // Re-export forms: `export { X, Y as Z } from "...";` and `export * from "...";`
    // Bug 2 — without this branch, barrel-files (vite/src/node/index.ts pattern)
    // produce zero symbols even though they re-export ~50 names. Emit one
    // ExtractedSymbol per re-exported local name so consumers see the surface;
    // the symbol_kind defaults to "var" (we don't yet know the imported file's
    // declaration kind), exported=true.
    const sourceNode = node.childForFieldName("source");
    if (sourceNode) {
      // Look for an export_clause among the children
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        if (c.type === "export_clause") {
          for (let j = 0; j < c.namedChildCount; j++) {
            const spec = c.namedChild(j);
            if (!spec || spec.type !== "export_specifier") continue;
            const nameNode = spec.childForFieldName("name");
            const aliasNode = spec.childForFieldName("alias");
            const localName = aliasNode?.text ?? nameNode?.text;
            if (!localName) continue;
            symbols.push({
              name: localName,
              symbol_kind: "var",
              exported: true,
              span: spanOf(spec),
              scope_chain: [...scope, localName],
              byte_range: byteRangeOf(spec),
            });
          }
          return;
        }
      }
      // `export * from "..."` — no clause, no per-name surface. Emit a single
      // wildcard symbol so consumers can see the re-export edge exists.
      symbols.push({
        name: "*",
        symbol_kind: "var",
        exported: true,
        span: spanOf(node),
        scope_chain: [...scope, "*"],
        byte_range: byteRangeOf(node),
      });
      return;
    }
    // Inline export of a non-declaration child (rare)
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && c.type !== "export_clause" && c.type !== "string") {
        handleNode(c, symbols, scope, true);
      }
    }
    return;
  }

  const kind = declarationKind(node.type);
  if (kind) {
    const name = nodeName(node);
    if (!name) return;
    const chain = [...scope, name];
    symbols.push({
      name,
      symbol_kind: kind,
      exported: exportedHint,
      span: spanOf(node),
      scope_chain: chain,
      byte_range: byteRangeOf(node),
    });
    if (kind === "class") {
      const body = node.childForFieldName("body");
      if (body) collectClassMembers(body, symbols, chain);
    }
    return;
  }

  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const isConst = node.type === "lexical_declaration" && node.firstChild?.text === "const";
    const symbolKind: SymbolKind = isConst ? "const" : "var";
    for (let i = 0; i < node.namedChildCount; i++) {
      const declarator = node.namedChild(i);
      if (!declarator || declarator.type !== "variable_declarator") continue;
      const nameNode = declarator.childForFieldName("name");
      if (!nameNode || nameNode.type !== "identifier") continue;
      symbols.push({
        name: nameNode.text,
        symbol_kind: symbolKind,
        exported: exportedHint,
        span: spanOf(node),
        scope_chain: [...scope, nameNode.text],
        byte_range: byteRangeOf(declarator),
      });
    }
    return;
  }
}

export function walkSymbols(tree: Parser.Tree, _src: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const root = tree.rootNode;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child) handleNode(child, symbols, [], false);
  }
  return symbols;
}

// ── Imported-name extractor (Phase 2b) ─────────────────────────────────────
// Extracts the named imports from a TS/JS file. The result maps each
// imported local name → the source file's rel_path. The dispatcher walks
// from there to find the actual symbol atom in the imported file.

export interface ImportNameRef {
  local_name: string;        // the name as it appears in this file
  source_path: string;       // raw import path string ("./auth", "@/lib/x")
  imported_name: string;     // the original name (handles `import { X as Y }`)
}

export function walkImportedNames(tree: Parser.Tree, _src: string): ImportNameRef[] {
  const out: ImportNameRef[] = [];
  const root = tree.rootNode;

  const stripQuotes = (s: string) => s.replace(/^['"`]|['"`]$/g, "");

  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt) continue;

    // ── ES `import X from "..."` ─────────────────────────────────────────
    if (stmt.type === "import_statement") {
      const sourceNode = stmt.childForFieldName("source");
      if (!sourceNode) continue;
      const sourcePath = stripQuotes(sourceNode.text);
      if (!sourcePath) continue;

      let clause: Parser.SyntaxNode | null = null;
      for (let j = 0; j < stmt.namedChildCount; j++) {
        const c = stmt.namedChild(j);
        if (c?.type === "import_clause") { clause = c; break; }
      }
      if (!clause) continue;

      for (let j = 0; j < clause.namedChildCount; j++) {
        const spec = clause.namedChild(j);
        if (!spec) continue;

        if (spec.type === "named_imports") {
          for (let k = 0; k < spec.namedChildCount; k++) {
            const imp = spec.namedChild(k);
            if (imp?.type !== "import_specifier") continue;
            const nameNode  = imp.childForFieldName("name");
            const aliasNode = imp.childForFieldName("alias");
            const imported  = nameNode?.text;
            if (!imported) continue;
            out.push({
              local_name:    aliasNode?.text ?? imported,
              source_path:   sourcePath,
              imported_name: imported,
            });
          }
        } else if (spec.type === "namespace_import") {
          const idNode = spec.childForFieldName("name") ?? spec.namedChild(0);
          const local  = idNode?.text;
          if (local) out.push({ local_name: local, source_path: sourcePath, imported_name: "*" });
        } else if (spec.type === "identifier") {
          out.push({ local_name: spec.text, source_path: sourcePath, imported_name: "default" });
        }
      }
      continue;
    }

    // ── ES `export { X, Y as Z } from "..."` and `export * from "..."` ───
    // Bug 2 — re-exports are imports too. Without this, barrel files have
    // no edges in Pass 5 and downstream consumers can't resolve through them.
    if (stmt.type === "export_statement") {
      const sourceNode = stmt.childForFieldName("source");
      if (!sourceNode) continue;
      const sourcePath = stripQuotes(sourceNode.text);
      if (!sourcePath) continue;

      let clause: Parser.SyntaxNode | null = null;
      for (let j = 0; j < stmt.namedChildCount; j++) {
        const c = stmt.namedChild(j);
        if (c?.type === "export_clause") { clause = c; break; }
      }
      if (clause) {
        for (let j = 0; j < clause.namedChildCount; j++) {
          const spec = clause.namedChild(j);
          if (!spec || spec.type !== "export_specifier") continue;
          const nameNode  = spec.childForFieldName("name");
          const aliasNode = spec.childForFieldName("alias");
          const imported  = nameNode?.text;
          if (!imported) continue;
          out.push({
            local_name:    aliasNode?.text ?? imported,
            source_path:   sourcePath,
            imported_name: imported,
          });
        }
      } else {
        // `export * from "..."` — record the wildcard re-export edge.
        out.push({ local_name: "*", source_path: sourcePath, imported_name: "*" });
      }
      continue;
    }

    // ── CJS `const { X, Y } = require("...")` and `const x = require("...")` ──
    // Bug 3 — without this, every CJS project's call graph is silently empty.
    if (stmt.type === "lexical_declaration" || stmt.type === "variable_declaration") {
      for (let d = 0; d < stmt.namedChildCount; d++) {
        const declarator = stmt.namedChild(d);
        if (!declarator || declarator.type !== "variable_declarator") continue;
        const value = declarator.childForFieldName("value");
        if (!value) continue;
        const reqInfo = unwrapRequireCall(value);
        if (!reqInfo) continue;
        const { sourcePath, memberName } = reqInfo;

        const namePat = declarator.childForFieldName("name");
        if (!namePat) continue;
        if (namePat.type === "identifier") {
          // const x = require("m") — single name, full module
          out.push({
            local_name:    namePat.text,
            source_path:   sourcePath,
            imported_name: memberName ?? "default",
          });
        } else if (namePat.type === "object_pattern") {
          // const { a, b: c } = require("m")
          for (let k = 0; k < namePat.namedChildCount; k++) {
            const prop = namePat.namedChild(k);
            if (!prop) continue;
            // shorthand_property_identifier_pattern — `{ a }`
            if (prop.type === "shorthand_property_identifier_pattern") {
              out.push({
                local_name:    prop.text,
                source_path:   sourcePath,
                imported_name: prop.text,
              });
              continue;
            }
            // pair_pattern — `{ a: b }`  (key=imported, value=local)
            if (prop.type === "pair_pattern") {
              const key = prop.childForFieldName("key");
              const val = prop.childForFieldName("value");
              const localText = val?.text;
              const importedText = key?.text;
              if (localText && importedText) {
                out.push({
                  local_name:    localText,
                  source_path:   sourcePath,
                  imported_name: importedText,
                });
              }
            }
          }
        }
      }
      continue;
    }
  }

  return out;
}

// Helper: if `value` is `require("...")` or `require("...").Member`, return
// { sourcePath, memberName? }. Otherwise null.
function unwrapRequireCall(
  value: Parser.SyntaxNode,
): { sourcePath: string; memberName?: string } | null {
  // Strip member_expression wrapper to handle `require("m").X`
  let node = value;
  let memberName: string | undefined;
  if (node.type === "member_expression") {
    const obj = node.childForFieldName("object");
    const prop = node.childForFieldName("property");
    if (obj && prop?.type === "property_identifier") {
      memberName = prop.text;
      node = obj;
    }
  }
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function");
  if (!fn || fn.type !== "identifier" || fn.text !== "require") return null;
  const argsNode = node.childForFieldName("arguments");
  if (!argsNode) return null;
  const arg = argsNode.namedChild(0);
  if (!arg) return null;
  // Accept "...", '...', `...` — string and template_string with no
  // substitutions.
  let txt: string | null = null;
  if (arg.type === "string") txt = arg.text;
  else if (arg.type === "template_string" && arg.namedChildCount === 0) txt = arg.text;
  if (!txt) return null;
  const sourcePath = txt.replace(/^['"`]|['"`]$/g, "");
  if (!sourcePath) return null;
  return { sourcePath, memberName };
}

// ── Reference walker (Phase 2b) ────────────────────────────────────────────

interface ScopeFrame {
  // Names bound at this scope (params + locals). Reference resolution skips
  // these to avoid attributing a local `verifyToken` to the file-level one.
  bindings: Set<string>;
  // Bug 4 — frames at the file-level scope must NOT mask resolution. The
  // file-level `const X = …` IS the resolution target, not a local that
  // shadows it. `isInScope` ignores frames where this flag is true.
  isFileLevel?: boolean;
}

interface RefWalkContext {
  fileSymbols: Map<string, string>;      // file-local name → symbol atom ID
  importedSymbols: ImportedNameMap;      // imported name → atom ID
  symbolStack: string[];                 // current containing-symbol IDs
  scopeStack: ScopeFrame[];              // lexical scope stack
  refs: ReferenceMap;                    // output
  symbolBySpan: Array<{ start: number; end: number; id: string }>;
}

// Symbol IDs are computed from rel_path#scope_chain elsewhere. To map a
// tree-sitter declaration node to its atom ID at reference-walk time, we
// need a `(node) → atomId` lookup. We pre-compute it from the symbol list.
//
// The simplest correlation is by byte range: each ExtractedSymbol carries a
// byte_range that uniquely identifies its declaration span.
function buildSymbolByRangeIndex(
  symbolsWithIds: Array<{ symbol: ExtractedSymbol; atom_id: string }>,
): Array<{ start: number; end: number; id: string }> {
  return symbolsWithIds.map((s) => ({
    start: s.symbol.byte_range.start,
    end:   s.symbol.byte_range.end,
    id:    s.atom_id,
  }));
}

// Find the smallest containing symbol for a position by byte range.
function innermostSymbolForPosition(
  pos: number,
  index: Array<{ start: number; end: number; id: string }>,
): string | null {
  let best: { start: number; end: number; id: string } | null = null;
  for (const s of index) {
    if (s.start <= pos && pos < s.end) {
      if (!best || (s.end - s.start) < (best.end - best.start)) best = s;
    }
  }
  return best?.id ?? null;
}

// Track local bindings as we descend so we don't resolve them as file/imports.
function collectBindings(node: Parser.SyntaxNode, frame: ScopeFrame): void {
  // Walk all `variable_declarator`, `parameter`, `formal_parameters` children.
  // We do this lazily: when entering a scope-creating node, collect names.
  const t = node.type;
  if (t === "identifier") {
    frame.bindings.add(node.text);
    return;
  }
  if (
    t === "required_parameter" ||
    t === "optional_parameter" ||
    t === "rest_parameter" ||
    t === "parameter"
  ) {
    const nameNode = node.childForFieldName("pattern") ?? node.namedChild(0);
    if (nameNode?.type === "identifier") frame.bindings.add(nameNode.text);
    return;
  }
  if (t === "variable_declarator") {
    const nameNode = node.childForFieldName("name");
    if (nameNode?.type === "identifier") frame.bindings.add(nameNode.text);
    return;
  }
  // Recurse for compound patterns
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) collectBindings(c, frame);
  }
}

const SCOPE_NODE_TYPES = new Set([
  "function_declaration",
  "function",
  "generator_function_declaration",
  "method_definition",
  "arrow_function",
  "function_expression",
]);

function isInScope(name: string, scopeStack: ScopeFrame[]): boolean {
  for (const frame of scopeStack) {
    if (frame.isFileLevel) continue;       // Bug 4 — see ScopeFrame doc
    if (frame.bindings.has(name)) return true;
  }
  return false;
}

function recordRef(ctx: RefWalkContext, fromSymbolId: string, targetId: string): void {
  if (fromSymbolId === targetId) return; // self-reference noise
  let arr = ctx.refs.get(fromSymbolId);
  if (!arr) {
    arr = [];
    ctx.refs.set(fromSymbolId, arr);
  }
  if (!arr.includes(targetId)) arr.push(targetId);
}

function walkRef(node: Parser.SyntaxNode, ctx: RefWalkContext): void {
  // Push a new lexical scope for function/method/arrow nodes.
  // We collect parameters before recursing into the body.
  const isScope = SCOPE_NODE_TYPES.has(node.type);
  if (isScope) {
    const frame: ScopeFrame = { bindings: new Set() };
    const params = node.childForFieldName("parameters");
    if (params) collectBindings(params, frame);
    ctx.scopeStack.push(frame);
  }

  // For lexical/variable_declaration nodes, add their names to the current scope.
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const top = ctx.scopeStack[ctx.scopeStack.length - 1];
    if (top) collectBindings(node, top);
  }

  // Identifier reference handling. We only resolve identifier nodes that
  // are *use sites* — identifier nodes inside declaration positions are
  // handled separately. tree-sitter's `identifier` includes both, so we
  // filter by parent type.
  if (node.type === "identifier" || node.type === "type_identifier") {
    const parentType = node.parent?.type ?? "";
    const inDecl =
      // declarators / declarations bind, don't reference
      (parentType === "variable_declarator" && node.parent?.childForFieldName("name") === node) ||
      (parentType === "function_declaration" && node.parent?.childForFieldName("name") === node) ||
      (parentType === "class_declaration" && node.parent?.childForFieldName("name") === node) ||
      (parentType === "method_definition" && node.parent?.childForFieldName("name") === node) ||
      (parentType === "type_alias_declaration" && node.parent?.childForFieldName("name") === node) ||
      (parentType === "interface_declaration" && node.parent?.childForFieldName("name") === node) ||
      (parentType === "enum_declaration" && node.parent?.childForFieldName("name") === node) ||
      // `import { X } from ...` — X is a binding, not a reference
      parentType === "import_specifier" ||
      parentType === "namespace_import" ||
      parentType === "import_clause" ||
      parentType === "import_statement" ||
      // property accesses on the right of `.` — `obj.method` — we skip these
      // to avoid false positives (would attribute the property to a file
      // symbol with the same name)
      (parentType === "member_expression" && node.parent?.childForFieldName("property") === node) ||
      // shorthand property in object literal
      parentType === "shorthand_property_identifier";

    if (!inDecl && !isInScope(node.text, ctx.scopeStack)) {
      const containerId = ctx.symbolStack.length > 0
        ? ctx.symbolStack[ctx.symbolStack.length - 1]
        : innermostSymbolForPosition(node.startIndex, ctx.symbolBySpan);

      if (containerId) {
        const targetFile     = ctx.fileSymbols.get(node.text);
        const targetImported = ctx.importedSymbols.get(node.text);
        const target = targetFile ?? targetImported;
        if (target) recordRef(ctx, containerId, target);
      }
    }
  }

  // Determine whether entering this node should push a containing symbol.
  // Declarations push their atom ID; we look it up via byte-range index.
  const declKind = declarationKind(node.type);
  const isMethodDef = node.type === "method_definition";
  const isVarDecl   = node.type === "variable_declarator";
  let pushed = false;

  if (declKind || isMethodDef || isVarDecl) {
    const id = innermostSymbolForPosition(node.startIndex, ctx.symbolBySpan);
    if (id) {
      ctx.symbolStack.push(id);
      pushed = true;
    }
  }

  // Recurse
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) walkRef(c, ctx);
  }

  if (pushed) ctx.symbolStack.pop();
  if (isScope) ctx.scopeStack.pop();
}

export function walkReferences(
  tree: Parser.Tree,
  _src: string,
  fileSymbols: Map<string, string>,
  importedSymbols: ImportedNameMap,
  symbolsWithIds: Array<{ symbol: ExtractedSymbol; atom_id: string }>,
): ReferenceMap {
  const ctx: RefWalkContext = {
    fileSymbols,
    importedSymbols,
    symbolStack: [],
    scopeStack:  [{ bindings: new Set(), isFileLevel: true }], // Bug 4 — file frame doesn't mask
    refs: new Map(),
    symbolBySpan: buildSymbolByRangeIndex(symbolsWithIds),
  };
  walkRef(tree.rootNode, ctx);
  return ctx.refs;
}
