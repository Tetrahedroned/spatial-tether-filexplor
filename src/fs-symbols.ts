// ---------------------------------------------------------------------------
// fs-symbols.ts — language dispatcher.
//
// Picks the right tree-sitter parser by extension and routes to the per-
// language walker. The walkers live in fs-symbols-{ts,python,go,rust}.ts and
// share the ExtractedSymbol contract from fs-symbols-types.ts.
//
// Public surface:
//   isSymbolExtractable(ext)       — does this extension have a walker?
//   extractSymbols(filePath, ext)  — read + parse + walk; returns symbols
//   extractReferences(...)         — TS/JS only; returns ReferenceMap
//   extractImportedNames(...)      — TS/JS only; raw import bindings
// ---------------------------------------------------------------------------
import * as fs from "fs";
import Parser from "tree-sitter";
import { ExtractedSymbol, ImportedNameMap, ReferenceMap } from "./fs-symbols-types";
import * as TS from "./fs-symbols-ts";
import * as PY from "./fs-symbols-python";
import * as GO from "./fs-symbols-go";
import * as RS from "./fs-symbols-rust";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TypeScriptGrammar = require("tree-sitter-typescript");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PythonGrammar = require("tree-sitter-python");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const GoGrammar = require("tree-sitter-go");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RustGrammar = require("tree-sitter-rust");

// Re-export for consumers (fs-engine.ts uses ExtractedSymbol type).
export type { ExtractedSymbol, ImportedNameMap, ReferenceMap } from "./fs-symbols-types";
export type { ImportNameRef } from "./fs-symbols-ts";

// ── Parser registry ────────────────────────────────────────────────────────

let tsParser: Parser | null = null;
let tsxParser: Parser | null = null;
let pyParser: Parser | null = null;
let goParser: Parser | null = null;
let rsParser: Parser | null = null;

function getParser(ext: string): { parser: Parser; lang: "ts" | "py" | "go" | "rs" } | null {
  if (ext === ".ts") {
    if (!tsParser) { tsParser = new Parser(); tsParser.setLanguage(TypeScriptGrammar.typescript); }
    return { parser: tsParser, lang: "ts" };
  }
  if (ext === ".tsx" || ext === ".jsx") {
    if (!tsxParser) { tsxParser = new Parser(); tsxParser.setLanguage(TypeScriptGrammar.tsx); }
    return { parser: tsxParser, lang: "ts" };
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    if (!tsParser) { tsParser = new Parser(); tsParser.setLanguage(TypeScriptGrammar.typescript); }
    return { parser: tsParser, lang: "ts" };
  }
  if (ext === ".py") {
    if (!pyParser) { pyParser = new Parser(); pyParser.setLanguage(PythonGrammar); }
    return { parser: pyParser, lang: "py" };
  }
  if (ext === ".go") {
    if (!goParser) { goParser = new Parser(); goParser.setLanguage(GoGrammar); }
    return { parser: goParser, lang: "go" };
  }
  if (ext === ".rs") {
    if (!rsParser) { rsParser = new Parser(); rsParser.setLanguage(RustGrammar); }
    return { parser: rsParser, lang: "rs" };
  }
  return null;
}

const SUPPORTED_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs",
]);

export function isSymbolExtractable(ext: string): boolean {
  return SUPPORTED_EXTS.has(ext);
}

// Extensions that support reference resolution (call graph). v1: TS family.
const REFERENCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function isReferenceExtractable(ext: string): boolean {
  return REFERENCE_EXTS.has(ext);
}

// ── Read + parse helper ────────────────────────────────────────────────────

function readSource(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 500 * 1024) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// node-tree-sitter's default buffer is 32 KB; any source larger than that
// fails with "Invalid argument". We size the buffer to source byte length
// + headroom, capped at the readSource() 500 KB limit. Without this, every
// 32 KB+ file (real-world: any large library entry, e.g. fastify.js at 33 KB
// or vite/src/node/index.ts is fine but server/index.ts at 60+ KB is not)
// silently produces zero symbols.
const TS_BUFFER_HEADROOM = 4 * 1024;
const TS_BUFFER_FLOOR    = 32 * 1024;

function parseFile(filePath: string, ext: string): { tree: Parser.Tree; src: string; lang: string } | null {
  const got = getParser(ext);
  if (!got) return null;
  const src = readSource(filePath);
  if (src === null) return null;
  // Use byteLength, not string length — multi-byte chars count more in the
  // native buffer than in JS string indices.
  const byteLen    = Buffer.byteLength(src, "utf8");
  const bufferSize = Math.max(TS_BUFFER_FLOOR, byteLen + TS_BUFFER_HEADROOM);
  try {
    const tree = got.parser.parse(src, undefined, { bufferSize });
    return { tree, src, lang: got.lang };
  } catch (err) {
    // Surface the failure so the operator knows the FSM is partial. Log to
    // stderr so MCP stdio JSON-RPC framing isn't corrupted.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[spatial-tether] parse failed: ${filePath} (${byteLen} bytes): ${msg}`);
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function extractSymbols(filePath: string, ext: string): ExtractedSymbol[] {
  const parsed = parseFile(filePath, ext);
  if (!parsed) return [];
  switch (parsed.lang) {
    case "ts": return TS.walkSymbols(parsed.tree, parsed.src);
    case "py": return PY.walkSymbols(parsed.tree, parsed.src);
    case "go": return GO.walkSymbols(parsed.tree, parsed.src);
    case "rs": return RS.walkSymbols(parsed.tree, parsed.src);
    default:   return [];
  }
}

// Extract the named imports from a TS/JS file. Used by the engine to build
// the ImportedNameMap for reference resolution.
export function extractImportedNames(filePath: string, ext: string) {
  if (!isReferenceExtractable(ext)) return [];
  const parsed = parseFile(filePath, ext);
  if (!parsed) return [];
  return TS.walkImportedNames(parsed.tree, parsed.src);
}

// Extract reference edges (call graph) from a TS/JS file.
// `fileSymbols` and `importedSymbols` are name → atom ID maps the engine
// builds before calling this.
export function extractReferences(
  filePath: string,
  ext: string,
  fileSymbols: Map<string, string>,
  importedSymbols: ImportedNameMap,
  symbolsWithIds: Array<{ symbol: ExtractedSymbol; atom_id: string }>,
): ReferenceMap {
  if (!isReferenceExtractable(ext)) return new Map();
  const parsed = parseFile(filePath, ext);
  if (!parsed) return new Map();
  return TS.walkReferences(parsed.tree, parsed.src, fileSymbols, importedSymbols, symbolsWithIds);
}
