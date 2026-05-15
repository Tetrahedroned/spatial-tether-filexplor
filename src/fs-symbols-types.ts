// Shared types for the per-language symbol/reference walkers.
// Lives in its own module so language modules can import without pulling in
// other languages' tree-sitter parsers (which have native bindings).
import { SymbolKind } from "./fs-manifest";

export interface ExtractedSymbol {
  name: string;
  symbol_kind: SymbolKind;
  exported: boolean;
  span: { start_line: number; end_line: number };
  scope_chain: string[];
  byte_range: { start: number; end: number };
}

// Map from "imported local name" → "atom ID of the imported symbol in the
// source file". Built by the dispatcher per file before reference extraction.
export type ImportedNameMap = Map<string, string>;

// Map from "containing symbol atom ID" → array of referenced atom IDs.
// Output of the reference walker per file.
export type ReferenceMap = Map<string, string[]>;
