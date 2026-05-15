import * as fs from "fs";
import * as path from "path";
import ignore, { Ignore } from "ignore";

// Directories to always skip — build artifacts, deps, VCS.
// These apply even when an ignore file exists, since a project may forget to
// list them. .gitignore (and friends) layer on top of this set.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", "dist", "out", "build",
  ".next", ".nuxt", ".turbo", ".vercel", "__pycache__",
  ".pytest_cache", ".mypy_cache", "target", ".cargo",
  "vendor", ".venv", "venv", "env", ".tox",
  "coverage", ".nyc_output", ".cache",
]);

// Files in the project root whose contents are gitignore-style patterns we
// should respect. Only `.gitignore` is loaded by default; extend this list
// if you want the walker to honor additional ignore files.
const IGNORE_FILES = [".gitignore"];

function loadIgnoreMatcher(projectRoot: string): Ignore | null {
  let any = false;
  const ig = ignore();
  for (const f of IGNORE_FILES) {
    const p = path.join(projectRoot, f);
    try {
      const content = fs.readFileSync(p, "utf8");
      ig.add(content);
      any = true;
    } catch {
      // file missing or unreadable — skip
    }
  }
  return any ? ig : null;
}

// The `ignore` package expects POSIX-style relative paths.
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export interface RawFSNode {
  name: string;
  abs_path: string;
  rel_path: string;
  is_dir: boolean;
  ext: string;
  size_bytes: number;
  line_count: number;
  children_count: number;  // populated for dirs on second pass
  last_modified: string;
  mtime_ms: number;        // ms-precision mtime; 0 for unstattable nodes
  depth: number;
  sibling_index: number;
  siblings_total: number;  // total peers at this depth under same parent
  parent_name: string;
  parent_abs_path: string; // absolute path of parent dir (empty for root)
  unchanged?: boolean;     // walker hint: existing atom with same mtime can be reused
}

export interface WalkOptions {
  max_depth?: number;        // default: 10
  include_hidden?: boolean;  // default: false
  max_file_size_kb?: number; // skip line count for files larger than this (default: 500)
  // Gravity tuning is plumbed through the gateway → buildFSM. Walker ignores it.
  gravity_weights?: Partial<import("./fs-manifest").GravityWeights>;
  // Phase 4: incremental hint. Map of rel_path → cached { mtime_ms, line_count }.
  // When provided, the walker skips line counting for files whose mtime matches
  // and sets `unchanged: true` on the resulting node so buildFSM can reuse the
  // previous atom (including its symbol atoms) without re-extracting.
  existing_atoms?: Map<string, { mtime_ms: number; line_count: number }>;
  // Phase 7: caller-provided extra dirs to skip (in addition to SKIP_DIRS and
  // .gitignore). Useful when a project has a sub-tree (e.g. a benchmark
  // harness) that should not appear in the FSM for a given consumer.
  skip_dirs?: string[];
}

function countLines(filePath: string, maxSizeKb: number): number {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxSizeKb * 1024) return 0; // binary/large: skip
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

function isBinary(ext: string): boolean {
  const BINARY_EXTS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pdf", ".zip", ".tar", ".gz", ".7z",
    ".mp3", ".mp4", ".wav", ".ogg",
    ".exe", ".bin", ".so", ".dll", ".dylib",
  ]);
  return BINARY_EXTS.has(ext);
}

export function walkProject(
  projectRoot: string,
  options: WalkOptions = {}
): RawFSNode[] {
  const maxDepth      = options.max_depth       ?? 10;
  const includeHidden = options.include_hidden  ?? false;
  const maxSizeKb     = options.max_file_size_kb ?? 500;
  const extraSkip     = new Set(options.skip_dirs ?? []);

  const results: RawFSNode[] = [];
  const ig = loadIgnoreMatcher(projectRoot);

  function walk(dir: string, depth: number, parentName: string): number {
    // Returns the number of direct children (for parent dir's children_count)
    if (depth > maxDepth) return 0;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }

    // Filter and sort: dirs first, then files, both alphabetical
    const filtered = entries
      .filter((e) => {
        if (!includeHidden && isHidden(e.name)) return false;
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) return false;
        if (e.isDirectory() && extraSkip.has(e.name)) return false;
        if (ig) {
          const absPath = path.join(dir, e.name);
          const relPath = toPosix(path.relative(projectRoot, absPath));
          // The `ignore` package distinguishes dirs by trailing slash
          const testPath = e.isDirectory() ? relPath + "/" : relPath;
          if (ig.ignores(testPath)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // dirs before files
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    const siblingsTotal = filtered.length;

    filtered.forEach((entry, siblingIndex) => {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(projectRoot, absPath);
      const ext     = entry.isDirectory() ? "" : path.extname(entry.name).toLowerCase();

      let sizeByte  = 0;
      let lineCount = 0;
      let mtimeMs   = 0;
      let mtime     = new Date().toISOString();

      try {
        const stat = fs.statSync(absPath);
        sizeByte    = stat.size;
        mtime       = stat.mtime.toISOString();
        mtimeMs     = Math.floor(stat.mtimeMs);
      } catch {
        // skip unreadable
      }

      // Phase 4: reuse cached line_count when an existing atom has the same mtime.
      // Skips fs.readFileSync — the expensive hot path on warm refresh.
      let unchanged = false;
      const cached = options.existing_atoms?.get(relPath);
      if (
        cached &&
        !entry.isDirectory() &&
        mtimeMs > 0 &&
        cached.mtime_ms === mtimeMs
      ) {
        lineCount = cached.line_count;
        unchanged = true;
      } else if (!entry.isDirectory() && !isBinary(ext)) {
        lineCount = countLines(absPath, maxSizeKb);
      }

      const childCount = entry.isDirectory()
        ? walk(absPath, depth + 1, entry.name)
        : 0;

      results.push({
        name:             entry.name,
        abs_path:         absPath,
        rel_path:         relPath,
        is_dir:           entry.isDirectory(),
        ext,
        size_bytes:       sizeByte,
        line_count:       lineCount,
        children_count:   childCount,
        last_modified:    mtime,
        mtime_ms:         mtimeMs,
        depth,
        sibling_index:    siblingIndex,
        siblings_total:   siblingsTotal,
        parent_name:      parentName,
        parent_abs_path:  dir,
        unchanged,
      });
    });

    return filtered.length;
  }

  // Push root itself
  try {
    const stat = fs.statSync(projectRoot);
    results.push({
      name:             path.basename(projectRoot),
      abs_path:         projectRoot,
      rel_path:         ".",
      is_dir:           true,
      ext:              "",
      size_bytes:       stat.size,
      line_count:       0,
      children_count:   0, // will be filled after walk
      last_modified:    stat.mtime.toISOString(),
      mtime_ms:         Math.floor(stat.mtimeMs),
      depth:            0,
      sibling_index:    0,
      siblings_total:   1,
      parent_name:      "",
      parent_abs_path:  "",
    });
  } catch {
    // can't stat root
  }

  const rootChildCount = walk(projectRoot, 1, path.basename(projectRoot));

  // Back-fill root children_count
  const root = results.find((n) => n.rel_path === ".");
  if (root) root.children_count = rootChildCount;

  return results;
}
