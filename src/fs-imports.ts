import * as fs from "fs";
import * as path from "path";
import { parse as parseJsonc, ParseError } from "jsonc-parser";

// ---------------------------------------------------------------------------
// Import detection — extracts file-to-file relationships from source code.
// These become the semantic edges of the 3D graph.
//
// Returns resolved absolute paths of imports found in a file.
// Only intra-project imports are returned — external packages are ignored.
// ---------------------------------------------------------------------------

export interface PathAliasConfig {
  baseUrl: string;                    // absolute path
  paths: Record<string, string[]>;    // e.g. { "@/*": ["src/*"] }
}

// Load tsconfig.json#compilerOptions.paths from the project root.
// Returns null if no tsconfig, no paths field, or parse fails.
export function loadPathAliases(projectRoot: string): PathAliasConfig | null {
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  let content: string;
  try {
    content = fs.readFileSync(tsconfigPath, "utf8");
  } catch {
    return null;
  }
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  if (!parsed || typeof parsed !== "object") return null;
  const co = parsed.compilerOptions;
  if (!co || typeof co !== "object" || !co.paths) return null;
  const baseUrl = path.resolve(projectRoot, typeof co.baseUrl === "string" ? co.baseUrl : ".");
  return { baseUrl, paths: co.paths as Record<string, string[]> };
}

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVE_INDEXES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

function tryResolveCandidate(
  resolved: string,
  knownPaths: Set<string>
): string | null {
  if (knownPaths.has(resolved)) return resolved;
  for (const ext of RESOLVE_EXTS) {
    const c = resolved + ext;
    if (knownPaths.has(c)) return c;
  }
  for (const idx of RESOLVE_INDEXES) {
    const c = path.join(resolved, idx);
    if (knownPaths.has(c)) return c;
  }
  return null;
}

// Resolve an import path against tsconfig.paths aliases.
// Returns null if no alias matches or no candidate exists.
function resolveAlias(
  importPath: string,
  aliasConfig: PathAliasConfig | null,
  knownPaths: Set<string>
): string | null {
  if (!aliasConfig) return null;
  for (const [pattern, targets] of Object.entries(aliasConfig.paths)) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (importPath !== pattern) continue;
      for (const target of targets) {
        const resolved = path.resolve(aliasConfig.baseUrl, target);
        const hit = tryResolveCandidate(resolved, knownPaths);
        if (hit) return hit;
      }
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!importPath.startsWith(prefix) || !importPath.endsWith(suffix)) continue;
      const remainder = importPath.slice(
        prefix.length,
        importPath.length - suffix.length
      );
      for (const target of targets) {
        const ts = target.indexOf("*");
        const filled = ts === -1
          ? target
          : target.slice(0, ts) + remainder + target.slice(ts + 1);
        const resolved = path.resolve(aliasConfig.baseUrl, filled);
        const hit = tryResolveCandidate(resolved, knownPaths);
        if (hit) return hit;
      }
    }
  }
  return null;
}

// Extensions that can contain imports worth parsing
const PARSEABLE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py",
  ".go",
  ".rs",
]);

// Patterns per language — each returns an array of import path strings
const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  // TypeScript / JavaScript / JSX
  ts: [
    /from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s+['"]([^'"]+)['"]/g,
    // Dynamic imports: import("./x")
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  // Python
  py: [
    /^from\s+([\w.]+)\s+import/gm,
    /^import\s+([\w.]+)/gm,
  ],
  // Go
  go: [
    /"([^"]+)"/g, // inside import blocks — we'll filter to relative only
  ],
  // Rust
  rs: [
    /use\s+([\w:]+)/g,
    /mod\s+(\w+)/g,
  ],
};

function getLanguage(ext: string): string {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "ts";
  if (ext === ".py") return "py";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rs";
  return "";
}

// Resolve a relative or aliased import path to an absolute path.
// Tries common extensions if the import has none.
export function resolveImport(
  importPath: string,
  fromFile: string,
  projectRoot: string,
  knownPaths: Set<string>,
  aliasConfig: PathAliasConfig | null
): string | null {
  // Try tsconfig.paths aliases first (e.g. "@/lib/utils" → "src/lib/utils.ts")
  const aliased = resolveAlias(importPath, aliasConfig, knownPaths);
  if (aliased) return aliased;

  // Only resolve relative imports (start with . or ../)
  // and project-relative imports (no node_modules, no @scope external)
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
    return null; // external package — skip
  }

  const fromDir  = path.dirname(fromFile);
  const resolved = path.resolve(fromDir, importPath);

  // Try exact path
  if (knownPaths.has(resolved)) return resolved;

  // Try with common extensions
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]) {
    const candidate = resolved + ext;
    if (knownPaths.has(candidate)) return candidate;
  }

  // Try as directory index
  for (const idx of ["index.ts", "index.js", "index.tsx", "__init__.py"]) {
    const candidate = path.join(resolved, idx);
    if (knownPaths.has(candidate)) return candidate;
  }

  return null;
}

// Python: convert module notation to path
// e.g. "from .utils import x" in src/api/handler.py → src/api/utils.py
function resolvePythonImport(
  modulePath: string,
  fromFile: string,
  projectRoot: string,
  knownPaths: Set<string>
): string | null {
  if (!modulePath.startsWith(".")) {
    // Absolute module — try resolving from project root
    const parts  = modulePath.replace(/\./g, path.sep);
    const asPath = path.join(projectRoot, parts + ".py");
    if (knownPaths.has(asPath)) return asPath;
    const asInit = path.join(projectRoot, parts, "__init__.py");
    if (knownPaths.has(asInit)) return asInit;
    return null;
  }

  // Relative: count leading dots for directory traversal
  const dots     = modulePath.match(/^\.+/)?.[0].length ?? 1;
  const rest     = modulePath.replace(/^\.+/, "").replace(/\./g, path.sep);
  let   fromDir  = path.dirname(fromFile);
  for (let i = 1; i < dots; i++) fromDir = path.dirname(fromDir);

  const asPath = path.join(fromDir, rest + ".py");
  if (knownPaths.has(asPath)) return asPath;
  const asInit = path.join(fromDir, rest, "__init__.py");
  if (knownPaths.has(asInit)) return asInit;
  return null;
}

// ---------------------------------------------------------------------------
// extractImports — main export
// Given a file path and the set of all known project file paths,
// returns the absolute paths of files this file imports.
// ---------------------------------------------------------------------------
export function extractImports(
  filePath: string,
  ext: string,
  projectRoot: string,
  knownPaths: Set<string>,
  aliasConfig: PathAliasConfig | null = null
): string[] {
  if (!PARSEABLE_EXTS.has(ext)) return [];

  let content: string;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 500 * 1024) return []; // skip large files
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const lang     = getLanguage(ext);
  const patterns = IMPORT_PATTERNS[lang] ?? [];
  const resolved = new Set<string>();

  for (const pattern of patterns) {
    pattern.lastIndex = 0; // reset global regex state
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1].trim();
      if (!importPath) continue;

      let absResolved: string | null = null;

      if (lang === "py") {
        absResolved = resolvePythonImport(
          importPath, filePath, projectRoot, knownPaths
        );
      } else {
        absResolved = resolveImport(
          importPath, filePath, projectRoot, knownPaths, aliasConfig
        );
      }

      if (absResolved && absResolved !== filePath) {
        resolved.add(absResolved);
      }
    }
  }

  return Array.from(resolved);
}
