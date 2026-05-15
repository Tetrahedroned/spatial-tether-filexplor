// ---------------------------------------------------------------------------
// fs-entry.ts — declared-entry detection (Bug 5).
//
// The original heuristic in `inferIntent` flagged any file named
// index.{ts,js,…}, main.{ts,js,…}, app.{ts,js,…}, server.{js,ts,…}, or cli.*
// as `intent: "entry"` — producing 40+ false positives on the vite monorepo
// (every template-*/src/main.ts plus every playground server.js gets tagged).
//
// This module collects the AUTHORITATIVE entry list by reading every
// package.json in the project tree and following its `main`, `module`,
// `exports`, and `bin` fields. The result is a set of rel_paths that should
// be treated as primary entry points; everything else gets demoted.
// ---------------------------------------------------------------------------
import * as fs from "fs";
import * as path from "path";
import { parse as parseJsonc } from "jsonc-parser";

export interface DeclaredEntries {
  // rel_paths that any package.json declares as a primary entry.
  primary: Set<string>;
  // rel_paths flagged by name heuristic but at depth ≤ 2 with no package.json
  // override — kept as "possible" entries (lower-confidence bonus).
  possible: Set<string>;
}

// True when the file appears in any package.json#main, exports[X], or bin[X].
export function findDeclaredEntries(
  projectRoot: string,
  knownPaths: Set<string>,
): Set<string> {
  const declared = new Set<string>();

  for (const abs of knownPaths) {
    if (path.basename(abs) !== "package.json") continue;
    let content: string;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > 256 * 1024) continue;
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    let pkg: unknown;
    try {
      pkg = parseJsonc(content);
    } catch { continue; }
    if (!pkg || typeof pkg !== "object") continue;

    const dir = path.dirname(abs);
    const add = (target: unknown) => {
      if (typeof target !== "string") return;
      // strip leading "./" so resolution is consistent
      const cleaned = target.replace(/^\.\//, "");
      const resolved = path.resolve(dir, cleaned);
      if (knownPaths.has(resolved)) {
        declared.add(path.relative(projectRoot, resolved));
        return;
      }
      // Try with common extensions if no extension
      if (!path.extname(cleaned)) {
        for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
          if (knownPaths.has(resolved + ext)) {
            declared.add(path.relative(projectRoot, resolved + ext));
            return;
          }
        }
      }
    };

    const o = pkg as Record<string, unknown>;
    add(o.main);
    add(o.module);
    add(o.types);

    // bin: string or { name: path } map
    if (typeof o.bin === "string") {
      add(o.bin);
    } else if (o.bin && typeof o.bin === "object") {
      for (const v of Object.values(o.bin as Record<string, unknown>)) add(v);
    }

    // exports: string, { ".": string }, or { ".": { default: string, ... } }
    walkExports(o.exports, add);
  }

  return declared;
}

// Recursively walk an `exports` field, calling `add` on every string we find.
// `exports` can be a deeply-nested condition map (default, node, browser, …).
function walkExports(
  node: unknown,
  add: (target: unknown) => void,
): void {
  if (typeof node === "string") {
    add(node);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      walkExports(v, add);
    }
  }
}

// Decide whether an existing name-heuristic entry candidate should keep its
// "entry" intent. Rule (per Bug 5 spec):
//   1. In `declared` → primary entry, keep it.
//   2. depth > 2 → demote (deep `index.ts` inside a template/playground/etc.
//      isn't the project's entry).
//   3. parent dir is template-*, fixture, __tests__, playground, examples,
//      __mocks__ → demote.
//   4. Otherwise → keep (depth ≤ 2 with name match — possible entry).
const DEMOTE_PARENT_PATTERNS: RegExp[] = [
  /^template-/i,         // create-vite/template-*/
  /^playground$/i,
  /^playgrounds$/i,
  /^examples?$/i,
  /^__tests__$/i,
  /^__mocks__$/i,
  /^fixtures?$/i,
  /^test$/i,
];

export function isPrimaryEntry(
  relPath: string,
  declared: Set<string>,
  depth: number,
  ancestorDirs: string[],
): boolean {
  if (declared.has(relPath)) return true;
  if (depth > 2) return false;
  for (const a of ancestorDirs) {
    for (const pat of DEMOTE_PARENT_PATTERNS) {
      if (pat.test(a)) return false;
    }
  }
  return true;     // shallow + benign-ancestor: name heuristic is allowed
}
