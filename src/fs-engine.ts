import * as path from "path";
import { RawFSNode } from "./fs-walker";
import {
  FSM, FSM_VERSION, FSMAtom, FSMRoom, InclusionReason,
  FileRole, FileIntent, SymbolKind,
  GravityWeights, DEFAULT_GRAVITY_WEIGHTS,
  inferRole, inferIntent,
  buildAtomId, buildSymbolId, buildTetherId,
} from "./fs-manifest";
import { extractImports, loadPathAliases, resolveImport } from "./fs-imports";
import {
  extractSymbols, isSymbolExtractable, ExtractedSymbol,
  extractImportedNames, extractReferences, isReferenceExtractable,
  ImportNameRef, ImportedNameMap,
} from "./fs-symbols";
import { findDeclaredEntries, isPrimaryEntry } from "./fs-entry";
// Type-only import — Session is used only for buildRoom's signature.
// Runtime depends only one-way (session.ts → fs-engine.ts).
import type { Session } from "./session";

// ---------------------------------------------------------------------------
// Build options for the FSM. Tunable per project.
// ---------------------------------------------------------------------------
export interface FSMBuildOptions {
  gravity?: Partial<GravityWeights>;
  // Phase 4: when provided, atoms whose source files are unchanged (identical
  // mtime_ms) reuse `import_refs` and symbol atoms from the previous FSM
  // instead of re-extracting. The big saving is in Pass 4 (tree-sitter parse).
  previous?: FSM;
}

// Merge a partial weight override with defaults. Nested role_base /
// intent_bonus dictionaries are merged shallowly per key.
function resolveWeights(override?: Partial<GravityWeights>): GravityWeights {
  if (!override) return DEFAULT_GRAVITY_WEIGHTS;
  return {
    role_base:               { ...DEFAULT_GRAVITY_WEIGHTS.role_base,    ...(override.role_base    ?? {}) },
    intent_bonus:            { ...DEFAULT_GRAVITY_WEIGHTS.intent_bonus, ...(override.intent_bonus ?? {}) },
    depth_penalty_per_level: override.depth_penalty_per_level ?? DEFAULT_GRAVITY_WEIGHTS.depth_penalty_per_level,
    depth_penalty_max:       override.depth_penalty_max       ?? DEFAULT_GRAVITY_WEIGHTS.depth_penalty_max,
    in_degree_weight:        override.in_degree_weight        ?? DEFAULT_GRAVITY_WEIGHTS.in_degree_weight,
    recency_weight:          override.recency_weight          ?? DEFAULT_GRAVITY_WEIGHTS.recency_weight,
  };
}

// ---------------------------------------------------------------------------
// Gravity — how much context-pull does this node have?
// Drives what goes into a Room when the agent is nearby.
// ---------------------------------------------------------------------------
interface GravityInputs {
  depth: number;
  role: FileRole;
  intent: FileIntent;
  in_degree_normalized: number;   // 0..1 across the project
  temporal_score: number;         // 0..1 across the project
}

function computeGravity(inputs: GravityInputs, w: GravityWeights): number {
  let g = w.role_base[inputs.role] ?? 0.1;

  const intentBonus = w.intent_bonus[inputs.intent] ?? 0;
  g = Math.min(1.0, g + intentBonus);

  const depthPenalty = Math.min(w.depth_penalty_max, inputs.depth * w.depth_penalty_per_level);
  g = Math.max(0.0, g - depthPenalty);

  g = Math.min(1.0, g + w.in_degree_weight * inputs.in_degree_normalized);
  g = Math.min(1.0, g + w.recency_weight   * inputs.temporal_score);

  return Math.round(g * 100) / 100;
}

// ---------------------------------------------------------------------------
// Weight (geom.w) — normalized file size relative to project
// ---------------------------------------------------------------------------
function computeWeight(sizeBytes: number, maxSizeBytes: number): number {
  if (maxSizeBytes === 0) return 0;
  return Math.round((sizeBytes / maxSizeBytes) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Language profile — ext → count (counts files only, not dirs or symbols)
// ---------------------------------------------------------------------------
function buildLanguageProfile(atoms: FSMAtom[]): Record<string, number> {
  const profile: Record<string, number> = {};
  for (const atom of atoms) {
    if (atom.kind !== "file") continue;
    const ext = atom.meta.ext || "no-ext";
    profile[ext] = (profile[ext] ?? 0) + 1;
  }
  return profile;
}

// ---------------------------------------------------------------------------
// buildFSM — the main function
// ---------------------------------------------------------------------------
export function buildFSM(
  projectRoot: string,
  nodes: RawFSNode[],
  options: FSMBuildOptions = {}
): FSM {
  const now         = new Date().toISOString();
  const tetherId    = buildTetherId(projectRoot, now);
  const projectName = path.basename(projectRoot);
  const weights     = resolveWeights(options.gravity);

  const maxSizeBytes = Math.max(1, ...nodes.map((n) => n.size_bytes));

  // ── Pass 1: build path→id map ──────────────────────────────────────────
  // IDs are derived from rel_path so they survive project moves.
  const pathToId = new Map<string, string>();
  for (const node of nodes) {
    pathToId.set(node.abs_path, buildAtomId(node.rel_path));
  }

  const knownPaths = new Set(pathToId.keys());

  // Bug 5 — collect package.json#main / module / bin / exports targets so the
  // entry-point heuristic can prefer declared entries over name-only matches.
  const declaredEntries = findDeclaredEntries(projectRoot, knownPaths);

  // tsconfig.paths aliases — null if no tsconfig.json or no paths field
  const aliasConfig = loadPathAliases(projectRoot);

  // Index previous FSM (if any) so unchanged nodes can short-circuit
  // import-extraction and symbol-extraction passes.
  const prevAtomsById = new Map<string, FSMAtom>();
  const prevSymbolsByFileId = new Map<string, FSMAtom[]>();
  if (options.previous) {
    for (const a of options.previous.atoms) prevAtomsById.set(a.id, a);
    for (const a of options.previous.atoms) {
      if (a.kind !== "symbol" && a.kind !== "method") continue;
      // Walk up parent chain to find the containing file atom
      let walker: FSMAtom | undefined = a;
      while (walker && walker.kind !== "file" && walker.parent_id) {
        walker = prevAtomsById.get(walker.parent_id);
      }
      if (walker?.kind === "file") {
        const arr = prevSymbolsByFileId.get(walker.id) ?? [];
        arr.push(a);
        prevSymbolsByFileId.set(walker.id, arr);
      }
    }
  }

  // Temporal normalization — find oldest and newest mtime
  const mtimes = nodes
    .map((n) => new Date(n.last_modified).getTime())
    .filter((t) => !isNaN(t));
  const minMtime = Math.min(...mtimes);
  const maxMtime = Math.max(...mtimes);
  const mtimeRange = maxMtime - minMtime || 1;

  // ── Pass 2: extract imports per node so we can compute in-degree before
  //          finalizing gravity. Reuse previous import_refs for unchanged
  //          nodes (content hasn't changed; rel_paths are stable).
  const importsByNodeIdx: string[][] = nodes.map((node) => {
    if (node.is_dir) return [];
    if (node.unchanged) {
      const prev = prevAtomsById.get(buildAtomId(node.rel_path));
      if (prev) return prev.import_refs.slice();
    }
    const abs = extractImports(node.abs_path, node.ext, projectRoot, knownPaths, aliasConfig);
    return abs
      .map((p) => pathToId.get(p))
      .filter((id): id is string => id !== undefined);
  });

  // Compute in-degree per atom id (how many other atoms reference it)
  const inDegreeById = new Map<string, number>();
  for (const refs of importsByNodeIdx) {
    for (const id of refs) {
      inDegreeById.set(id, (inDegreeById.get(id) ?? 0) + 1);
    }
  }
  const maxInDegree = Math.max(1, ...Array.from(inDegreeById.values()));

  // ── Pass 3: build atoms with gravity that includes in-degree + recency ─
  const atoms: FSMAtom[] = nodes.map((node, idx) => {
    const role         = inferRole(node.name, node.ext, node.is_dir, node.parent_name);
    let   intent       = inferIntent(node.name, node.ext, role, node.parent_name, node.rel_path);

    // Bug 5 — package.json-driven entry override:
    //   1. If the file is in `declaredEntries`, force intent="entry".
    //   2. If the name-only heuristic flagged it but it's deep / inside a
    //      template/playground/fixture directory, demote to "module".
    let isPrimaryEntryFlag = false;
    if (declaredEntries.has(node.rel_path)) {
      intent = "entry";
      isPrimaryEntryFlag = true;
    } else if (intent === "entry") {
      const ancestors = node.rel_path.split(path.sep).slice(0, -1);
      if (!isPrimaryEntry(node.rel_path, declaredEntries, node.depth, ancestors)) {
        intent = "module";
      } else {
        isPrimaryEntryFlag = true;
      }
    }
    const weight  = computeWeight(node.size_bytes, maxSizeBytes);
    const atomId  = buildAtomId(node.rel_path);

    // parent_id: look up parent directory in the path→id map
    const parentId = node.parent_abs_path
      ? (pathToId.get(node.parent_abs_path) ?? null)
      : null;

    // temporal_score: 1.0 = most recently modified, 0.0 = oldest
    const mtime         = new Date(node.last_modified).getTime();
    const temporalScore = isNaN(mtime)
      ? 0
      : Math.round(((mtime - minMtime) / mtimeRange) * 100) / 100;

    const inDegree           = inDegreeById.get(atomId) ?? 0;
    const inDegreeNormalized = Math.round((inDegree / maxInDegree) * 100) / 100;

    const gravity = computeGravity(
      {
        depth:                node.depth,
        role,
        intent,
        in_degree_normalized: inDegreeNormalized,
        temporal_score:       temporalScore,
      },
      weights
    );

    return {
      id:             atomId,
      kind:           node.is_dir ? "dir" : "file",
      name:           node.name,
      rel_path:       node.rel_path,
      geom: {
        x: node.depth,           // hierarchy depth
        y: node.sibling_index,   // position among siblings
        w: weight,               // normalized size
        h: node.line_count,      // line count
      },
      gravity,
      parent_id:      parentId,
      siblings_total: node.siblings_total,
      import_refs:    importsByNodeIdx[idx],
      contains_refs:  [],         // populated in symbol pass below
      references:     [],         // Phase 2b — populated in reference pass for symbols
      referenced_by:  [],
      temporal_score: temporalScore,
      mtime_ms:       node.mtime_ms,
      meta: {
        role,
        intent,
        ext:            node.ext,
        size_bytes:     node.size_bytes,
        is_dir:         node.is_dir,
        is_entry:       isPrimaryEntryFlag,
        children_count: node.children_count,
      },
    };
  });

  // Map for quick "is this file's source unchanged?" lookup in Pass 4.
  const unchangedFileIds = new Set<string>();
  nodes.forEach((node, i) => {
    if (node.unchanged) unchangedFileIds.add(atoms[i].id);
  });

  // ── Pass 4: extract symbols from parseable files ───────────────────────
  // For unchanged files, reuse the previous symbol atoms wholesale — saves
  // the tree-sitter parse, which is the single most expensive operation in
  // a full rebuild. Symbol IDs are deterministic (rel_path#chain), so reusing
  // them is safe across rebuilds.
  //
  // Fix 5 — Pass 4's ExtractedSymbol[] (which carries byte_range) is cached
  // in `extractedByFileId` so Pass 5 doesn't re-parse the same file just to
  // recover byte ranges. Eliminates one full tree-sitter parse per TS/JS file
  // on cold scan; on fastify medium that was 17 ms × 243 .js files ≈ 4 s saved.
  const symbolAtoms: FSMAtom[] = [];
  const extractedByFileId = new Map<string, ExtractedSymbol[]>();
  for (const fileAtom of atoms) {
    if (fileAtom.kind !== "file" || !isSymbolExtractable(fileAtom.meta.ext)) continue;

    // Fast path: file's source is unchanged → reuse previous symbol atoms.
    if (unchangedFileIds.has(fileAtom.id)) {
      const prevSyms = prevSymbolsByFileId.get(fileAtom.id);
      if (prevSyms && prevSyms.length > 0) {
        for (const s of prevSyms) {
          symbolAtoms.push({ ...s, mtime_ms: fileAtom.mtime_ms });
        }
        // Back-fill contains_refs (top-level symbols of this file)
        fileAtom.contains_refs = prevSyms
          .filter((s) => s.parent_id === fileAtom.id)
          .map((s) => s.id);
        continue;
      }
    }

    const fileAbsPath = path.join(projectRoot, fileAtom.rel_path);
    const extracted = extractSymbols(fileAbsPath, fileAtom.meta.ext);
    extractedByFileId.set(fileAtom.id, extracted);
    if (extracted.length === 0) continue;

    // Build a map from scope_chain → atom_id so we can wire method parents.
    const chainToId = new Map<string, string>();

    extracted.forEach((sym, idx) => {
      const chainKey  = sym.scope_chain.join(".");
      const symId     = buildSymbolId(fileAtom.rel_path, chainKey);
      chainToId.set(chainKey, symId);

      // parent_id: methods point to their class atom; top-level points to file
      let parentId: string;
      if (sym.scope_chain.length > 1) {
        const parentChain = sym.scope_chain.slice(0, -1).join(".");
        parentId = chainToId.get(parentChain) ?? fileAtom.id;
      } else {
        parentId = fileAtom.id;
      }

      symbolAtoms.push({
        id:             symId,
        kind:           sym.symbol_kind === "method" ? "method" : "symbol",
        name:           sym.name,
        rel_path:       `${fileAtom.rel_path}#${chainKey}`,
        geom: {
          x: fileAtom.geom.x,                            // co-located with file in depth space
          y: idx,                                        // order within file
          w: 0,                                          // not file-sized
          h: sym.span.end_line - sym.span.start_line + 1,
        },
        gravity:        symbolGravity(sym),
        parent_id:      parentId,
        siblings_total: extracted.length,
        import_refs:    [],                              // file-level imports do not apply to symbols
        contains_refs:  [],                              // back-filled below for classes
        references:     [],                              // Phase 2b: populated in Pass 5
        referenced_by:  [],                              // Phase 2b: populated in Pass 5 sweep
        temporal_score: fileAtom.temporal_score,
        mtime_ms:       fileAtom.mtime_ms,               // symbols inherit their file's mtime
        symbol_kind:    sym.symbol_kind,
        span:           sym.span,
        exported:       sym.exported,
        meta: {
          role:           "source",
          intent:         "module",
          ext:            "",
          size_bytes:     sym.byte_range.end - sym.byte_range.start,
          is_dir:         false,
          is_entry:       false,
          children_count: 0,
        },
      });
    });

    // Back-fill contains_refs on file → its top-level symbols
    fileAtom.contains_refs = extracted
      .filter((s) => s.scope_chain.length === 1)
      .map((s) => buildSymbolId(fileAtom.rel_path, s.scope_chain.join(".")));
  }

  // Back-fill contains_refs on classes → their methods
  for (const sym of symbolAtoms) {
    if (sym.symbol_kind !== "class") continue;
    sym.contains_refs = symbolAtoms
      .filter((s) => s.parent_id === sym.id)
      .map((s) => s.id);
  }

  // ── Pass 5: reference resolution (call graph) — Phase 2b ───────────────
  // For each parseable file with reference support (TS family in v1):
  //   1. Build fileSymbols: top-level name → its symbol atom ID
  //   2. Build importedSymbols: local_name → atom ID of the imported symbol
  //      in another file (resolved by source_path → file atom → name lookup)
  //   3. Build symbolsWithIds: byte-range index for the file's symbols
  //   4. Walk references; merge result into symbol atoms' `references`.
  // After all files are processed, sweep to populate inverse `referenced_by`.
  //
  // Symbols whose source files are unchanged keep their previous edges,
  // since we already short-circuited their parse in Pass 4. The symbols we
  // re-extracted have empty references arrays at this point.
  //
  // Build helpers:
  //  - filesByAbsPath: abs_path → file atom (for resolving import targets)
  //  - topSymbolsByFileId: fileAtomId → Map<name, symbolAtomId>
  //  - allSymbolsByFileId: fileAtomId → ExtractedSymbol-shaped entries
  //    (we keep just what walkReferences needs: byte_range + atom_id)
  const filesByRelPath = new Map<string, FSMAtom>();
  for (const a of atoms) {
    if (a.kind === "file") filesByRelPath.set(a.rel_path, a);
  }

  // Map of fileAtomId → top-level symbol name → atom ID
  const topSymbolsByFileId = new Map<string, Map<string, string>>();
  for (const sym of symbolAtoms) {
    if (sym.parent_id == null) continue;
    const parent = atoms.find((a) => a.id === sym.parent_id);
    if (parent?.kind !== "file") continue;
    let m = topSymbolsByFileId.get(parent.id);
    if (!m) { m = new Map(); topSymbolsByFileId.set(parent.id, m); }
    if (!m.has(sym.name)) m.set(sym.name, sym.id);
  }

  // Re-extract per-file symbol byte ranges to build the byte-range index
  // for walkReferences. We can't reuse ExtractedSymbol from Pass 4 because we
  // discarded the byte_range after producing FSMAtoms. The fast path: skip
  // the extraction entirely for unchanged files (their references were
  // populated in a prior scan and we copied them in Pass 4 — but we didn't
  // copy `references` because the original Pass 4 produced empty arrays.
  // For correctness on incremental refresh, we *do* preserve previous
  // references when the file is unchanged.)
  for (const fileAtom of atoms) {
    if (fileAtom.kind !== "file") continue;
    if (!isReferenceExtractable(fileAtom.meta.ext)) continue;

    // Unchanged file → restore references from previous FSM (if available)
    if (unchangedFileIds.has(fileAtom.id)) {
      const prevSyms = prevSymbolsByFileId.get(fileAtom.id);
      if (prevSyms) {
        const prevById = new Map(prevSyms.map((s) => [s.id, s] as const));
        for (const sym of symbolAtoms) {
          const prev = prevById.get(sym.id);
          if (prev) sym.references = prev.references.slice();
        }
        continue; // skip re-extraction
      }
    }

    // Get the symbols of this file with byte_range. Reuse the Pass-4 cache
    // when present; only parse fresh if Pass 4 didn't run for this file.
    const fileAbsPath = path.join(projectRoot, fileAtom.rel_path);
    const extracted = extractedByFileId.get(fileAtom.id)
      ?? extractSymbols(fileAbsPath, fileAtom.meta.ext);
    if (extracted.length === 0) continue;

    // Re-derive the symbol atom IDs by chain (matches Pass 4's IDs)
    const symbolsWithIds: Array<{ symbol: ExtractedSymbol; atom_id: string }> = [];
    for (const sym of extracted) {
      const chainKey = sym.scope_chain.join(".");
      symbolsWithIds.push({
        symbol: sym,
        atom_id: buildSymbolId(fileAtom.rel_path, chainKey),
      });
    }

    // fileSymbols: top-level names → atom ID (used to resolve internal calls)
    const fileSymbols: Map<string, string> = topSymbolsByFileId.get(fileAtom.id) ?? new Map();

    // importedSymbols: local_name → imported symbol atom ID in another file
    const importedSymbols: ImportedNameMap = new Map();
    const importNames: ImportNameRef[] = extractImportedNames(fileAbsPath, fileAtom.meta.ext) as ImportNameRef[];
    for (const ref of importNames) {
      const absResolved = resolveImport(
        ref.source_path,
        fileAbsPath,
        projectRoot,
        knownPaths,
        aliasConfig,
      );
      if (!absResolved) continue;
      const targetRel = path.relative(projectRoot, absResolved);
      const targetFile = filesByRelPath.get(targetRel);
      if (!targetFile) continue;
      const namedMap = topSymbolsByFileId.get(targetFile.id);
      if (!namedMap) continue;

      // We only resolve named/aliased imports in v1. Default and namespace
      // imports map onto symbols only if the imported_name is a real symbol
      // name in the target file (rare for default; never for "*").
      const targetSymbolId = namedMap.get(ref.imported_name);
      if (targetSymbolId) importedSymbols.set(ref.local_name, targetSymbolId);
    }

    // Walk references for this file
    const refMap = extractReferences(
      fileAbsPath,
      fileAtom.meta.ext,
      fileSymbols,
      importedSymbols,
      symbolsWithIds,
    );

    // Apply to symbol atoms
    for (const [containerId, targets] of refMap) {
      const sym = symbolAtoms.find((s) => s.id === containerId);
      if (!sym) continue;
      // Deduplicate while preserving order
      const seen = new Set(sym.references);
      for (const t of targets) {
        if (!seen.has(t)) { sym.references.push(t); seen.add(t); }
      }
    }
  }

  // Pass 5b: populate referenced_by (inverse edges) on every atom that has
  // anything pointing at it. We sweep symbolAtoms (callers) and accumulate
  // into a callee map, then write back.
  const referencedByAcc = new Map<string, Set<string>>();
  for (const sym of symbolAtoms) {
    for (const targetId of sym.references) {
      let s = referencedByAcc.get(targetId);
      if (!s) { s = new Set(); referencedByAcc.set(targetId, s); }
      s.add(sym.id);
    }
  }
  for (const sym of symbolAtoms) {
    const inv = referencedByAcc.get(sym.id);
    if (inv) sym.referenced_by = Array.from(inv);
  }

  atoms.push(...symbolAtoms);

  const files = atoms.filter((a) => a.kind === "file");
  const dirs  = atoms.filter((a) => a.kind === "dir");

  return {
    fsm_version:      FSM_VERSION,
    tether_id:        tetherId,
    project_root:     projectRoot,
    project_name:     projectName,
    total_files:      files.length,
    total_dirs:       dirs.length,
    atoms,
    captured_at:      now,
    language_profile: buildLanguageProfile(atoms),
  };
}

// ---------------------------------------------------------------------------
// Symbol gravity — kind-based base + exported bonus.
// In-degree from references is added in Phase 2b once call-graph lands.
// ---------------------------------------------------------------------------
const SYMBOL_BASE_GRAVITY: Record<SymbolKind, number> = {
  function:  0.50,
  class:     0.60,
  method:    0.45,
  const:     0.30,
  var:       0.25,
  type:      0.40,
  interface: 0.45,
  enum:      0.40,
};

function symbolGravity(sym: ExtractedSymbol): number {
  let g = SYMBOL_BASE_GRAVITY[sym.symbol_kind] ?? 0.30;
  if (sym.exported) g = Math.min(1.0, g + 0.10);
  return Math.round(g * 100) / 100;
}

// ---------------------------------------------------------------------------
// Session-relative gravity bonuses — applied at Room build time.
// Static FSM gravity is unchanged; the Room's atoms are clones with bumped
// gravity so the agent's own activity feeds back into ranking.
// ---------------------------------------------------------------------------
const SESSION_BONUS_INVENTORY        = 0.15;
const SESSION_BONUS_MODIFIED         = 0.20;
const SESSION_BONUS_RECENTLY_VISITED = 0.10;

function applySessionBonuses(
  atom: FSMAtom,
  session: Session,
  recent_focus_paths: Set<string>,
): FSMAtom {
  let bonus = 0;
  if (session.inventory.has(atom.id))         bonus += SESSION_BONUS_INVENTORY;
  if (session.session_modified.has(atom.id))  bonus += SESSION_BONUS_MODIFIED;
  if (recent_focus_paths.has(atom.rel_path))  bonus += SESSION_BONUS_RECENTLY_VISITED;
  if (bonus === 0) return atom;
  const newGravity = Math.min(1.0, atom.gravity + bonus);
  return { ...atom, gravity: Math.round(newGravity * 100) / 100 };
}

// ---------------------------------------------------------------------------
// buildRoom — generate a bounded Room Description for the agent.
// The agent gets this instead of the whole FSM.
//
// Inclusion sources (with priority):
//   1. focus              — the focus atom itself
//   2. imports            — files focus imports (regardless of depth)
//   3. imported_by        — files that import focus (regardless of depth)
//   4. depth_window       — within ±depth_limit of focus
//
// When `session` is provided, atoms in the returned Room carry session-
// relative gravity bonuses (inventory / session-modified / recently visited).
// The FSM's atoms are not mutated — clones are returned.
// ---------------------------------------------------------------------------
export function buildRoom(
  fsm: FSM,
  focusPath: string,
  depthLimit: number = 2,
  session?: Session,
): FSMRoom {
  // Build byId + path-lookup + imported_by inverse index in a single pass.
  // Replaces 3+ O(N) `fsm.atoms.find()` / `.filter()` scans below; on a 6.8K-
  // atom FSM (vite expert), the contains walk's nested `find(parent_id)` was
  // O(N · depth · N) ≈ 50M ops — the dominant cost of buildRoom.
  const byId = new Map<string, FSMAtom>();
  const importedByMap = new Map<string, string[]>();
  let focusAtom: FSMAtom | undefined;
  // Caller may pass an absolute path (legacy API) or a rel_path. Normalize
  // to rel_path for the lookup; absolute paths under projectRoot become rel.
  const focusRel = path.isAbsolute(focusPath)
    ? path.relative(fsm.project_root, focusPath)
    : focusPath;
  for (const a of fsm.atoms) {
    byId.set(a.id, a);
    if (!focusAtom && a.rel_path === focusRel) {
      focusAtom = a;
    }
    for (const tgt of a.import_refs) {
      let arr = importedByMap.get(tgt);
      if (!arr) { arr = []; importedByMap.set(tgt, arr); }
      arr.push(a.id);
    }
  }

  const focusDepth = focusAtom?.geom.x ?? 0;

  // Breadcrumb: all ancestors of focus
  const breadcrumb: string[] = [];
  const parts = (focusAtom?.rel_path ?? "").split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    breadcrumb.push(parts.slice(0, i + 1).join(path.sep) || ".");
  }

  const inclusion: Record<string, InclusionReason> = {};
  const PRIORITY: Record<InclusionReason, number> = {
    focus:        4,
    imports:      3,
    imported_by:  3,
    contains:     2,
    depth_window: 1,
  };
  const include = (atom: FSMAtom, reason: InclusionReason) => {
    const existing = inclusion[atom.id];
    if (existing && PRIORITY[existing] >= PRIORITY[reason]) return;
    inclusion[atom.id] = reason;
  };

  // Depth-window atoms — files and dirs only. Symbols only enter via contains.
  const minDepth = Math.max(0, focusDepth - depthLimit);
  const maxDepth = focusDepth + depthLimit;
  for (const atom of fsm.atoms) {
    if (atom.kind === "symbol" || atom.kind === "method") continue;
    if (atom.geom.x >= minDepth && atom.geom.x <= maxDepth) {
      include(atom, "depth_window");
    }
  }

  // Import-pulled atoms (depth-independent)
  if (focusAtom) {
    // What focus imports (out-edges) — direct id lookup, no scan
    for (const id of focusAtom.import_refs) {
      const a = byId.get(id);
      if (a) include(a, "imports");
    }
    // What imports focus (in-edges) — inverted index lookup
    const importers = importedByMap.get(focusAtom.id);
    if (importers) {
      for (const id of importers) {
        const a = byId.get(id);
        if (a) include(a, "imported_by");
      }
    }
    // When focus is a file, include its top-level symbols (and methods of
    // contained classes) so the agent sees what the file actually defines.
    if (focusAtom.kind === "file") {
      for (const atom of fsm.atoms) {
        if (atom.kind !== "symbol" && atom.kind !== "method") continue;
        // Walk parent chain via byId map (O(1) per hop) instead of fsm.atoms.find.
        let walker: FSMAtom | undefined = atom;
        while (walker && walker.kind !== "file" && walker.parent_id) {
          walker = byId.get(walker.parent_id);
        }
        if (walker?.id === focusAtom.id) include(atom, "contains");
      }
    }
    // Mark focus last so it overrides any prior tagging
    include(focusAtom, "focus");
  }

  // ── Apply MAX_ROOM_ATOMS cap ────────────────────────────────────────────
  // Direct connections (focus + imports + imported_by + contains) are always
  // kept regardless of gravity — a Room missing its direct edges or its own
  // symbols would yield wrong answers. Remaining slots up to MAX_ROOM_ATOMS
  // are filled with the highest-gravity remaining (depth_window) atoms.
  //
  // Fix 6 — `contains` is in the guaranteed set so a low-gravity build artifact
  // imported by a config file (or any focus-owned symbol with low gravity)
  // never gets dropped. Cap correctness > cap precision.
  const MAX_ROOM_ATOMS = 150;
  const guaranteedReasons = new Set<InclusionReason>(["focus", "imports", "imported_by", "contains"]);
  const guaranteed: FSMAtom[] = [];
  const others: FSMAtom[] = [];
  for (const a of fsm.atoms) {
    const reason = inclusion[a.id];
    if (reason === undefined) continue;
    if (guaranteedReasons.has(reason)) guaranteed.push(a);
    else others.push(a);
  }
  const totalIncluded = guaranteed.length + others.length;
  const remainingSlots = Math.max(0, MAX_ROOM_ATOMS - guaranteed.length);
  const othersCapped = remainingSlots >= others.length
    ? others
    : [...others].sort((a, b) => b.gravity - a.gravity).slice(0, remainingSlots);
  const visibleRaw = [...guaranteed, ...othersCapped];

  // Drop dropped atoms from the inclusion map so consumers don't see stale ids.
  if (othersCapped.length < others.length) {
    const keepIds = new Set(visibleRaw.map((a) => a.id));
    for (const id of Object.keys(inclusion)) {
      if (!keepIds.has(id)) delete inclusion[id];
    }
    if (process.env.SPATIAL_TETHER_DEBUG) {
      process.stderr.write(
        `[getRoom] capped focus=${focusRel} full=${totalIncluded} kept=${visibleRaw.length} (guaranteed=${guaranteed.length})\n`,
      );
    }
  }

  // Exits: immediate children of focus dir + siblings of focus file.
  // Symbols share their file's rel_path prefix, so filter them out — exits
  // are navigable filesystem nodes, not in-file declarations.
  const focusDirRel = focusAtom?.meta.is_dir
    ? focusAtom.rel_path
    : path.dirname(focusAtom?.rel_path ?? focusRel);
  const focusOwnRel = focusAtom?.rel_path ?? focusRel;

  const exitsRaw = fsm.atoms.filter((a) => {
    if (a.kind === "symbol" || a.kind === "method") return false;
    const parentDir = path.dirname(a.rel_path);
    return parentDir === focusDirRel && a.rel_path !== focusOwnRel;
  });

  // Apply session-relative gravity bonuses (cloning atoms — FSM is untouched)
  let visible: FSMAtom[];
  let exits:   FSMAtom[];
  if (session) {
    const recent = session.recentFocusPaths();
    visible = visibleRaw.map((a) => applySessionBonuses(a, session, recent));
    exits   = exitsRaw.map((a)   => applySessionBonuses(a, session, recent));
  } else {
    visible = visibleRaw;
    exits   = exitsRaw;
  }

  return {
    focus_path:  focusPath,
    depth_limit: depthLimit,
    atoms:       visible,
    breadcrumb,
    exits,
    inclusion,
  };
}

// ---------------------------------------------------------------------------
// roomToText — convert a Room into a plain-English description for the agent
// This is what the coding agent actually reads.
//
// When `session` is provided, atoms in inventory or session_modified get
// extra flags, the header includes the session start time, and the last
// three Investigation Check entries are appended at the bottom.
// ---------------------------------------------------------------------------
export function roomToText(
  room: FSMRoom,
  projectName: string,
  session?: Session | null,
): string {
  const lines: string[] = [];

  lines.push(`=== ROOM: ${room.focus_path} ===`);
  lines.push(`Project: ${projectName}`);
  lines.push(`Breadcrumb: ${room.breadcrumb.join(" > ")}`);
  lines.push(`Depth window: ±${room.depth_limit} levels from focus`);
  if (session) {
    lines.push(`Session started: ${session.started_at}`);
  }
  lines.push("");

  const dirs    = room.atoms.filter((a) => a.kind === "dir");
  const files   = room.atoms.filter((a) => a.kind === "file");
  const symbols = room.atoms.filter((a) => a.kind === "symbol" || a.kind === "method");

  if (dirs.length > 0) {
    lines.push("DIRECTORIES:");
    for (const d of dirs) {
      lines.push(
        `  [${d.geom.x}] ${d.rel_path}/ — ${d.meta.children_count} items`
      );
    }
    lines.push("");
  }

  if (files.length > 0) {
    lines.push("FILES:");
    for (const f of files.sort((a, b) => b.gravity - a.gravity)) {
      const flags: string[] = [];
      if (f.meta.is_entry) flags.push("ENTRY");
      if (f.meta.role === "test") flags.push("TEST");
      if (f.meta.role === "config") flags.push("CONFIG");
      const reason = room.inclusion[f.id];
      if (reason === "imports")     flags.push("IMPORTS");
      if (reason === "imported_by") flags.push("IMPORTED-BY");
      if (reason === "focus")       flags.push("FOCUS");
      if (session?.inventory.has(f.id))         flags.push("INVENTORY");
      if (session?.session_modified.has(f.id))  flags.push("MODIFIED");
      const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
      lines.push(
        `  [d:${f.geom.x} g:${f.gravity}] ${f.rel_path}${flagStr} — ${f.geom.h} lines`
      );
    }
    lines.push("");
  }

  if (symbols.length > 0) {
    lines.push("SYMBOLS (defined in focus):");
    for (const s of symbols.sort((a, b) => b.gravity - a.gravity)) {
      const tag = s.exported ? " [exported]" : "";
      const span = s.span ? ` L${s.span.start_line}-${s.span.end_line}` : "";
      const chain = s.rel_path.split("#")[1] ?? s.name;
      lines.push(
        `  [g:${s.gravity}] ${s.symbol_kind} ${chain}${tag}${span}`
      );
    }
    lines.push("");
  }

  if (room.exits.length > 0) {
    lines.push("EXITS (adjacent nodes):");
    for (const e of room.exits) {
      const suffix = e.meta.is_dir ? "/" : "";
      lines.push(`  ${e.name}${suffix}`);
    }
    lines.push("");
  }

  // Session footer: last three Investigation Check entries, oldest first.
  if (session && session.investigation_log.length > 0) {
    const tail = session.investigation_log.slice(-3);
    lines.push("RECENT INVESTIGATION CHECKS:");
    for (const e of tail) {
      const j = e.justification ? ` — "${e.justification}"` : "";
      lines.push(`  ${e.outcome.padEnd(22)} ${e.rel_path}${j}`);
    }
  }

  return lines.join("\n");
}
