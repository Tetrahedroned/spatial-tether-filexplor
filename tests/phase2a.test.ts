import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { SpatialTetherFileExplorer } from "../src/gateway";
import { buildRoom } from "../src/fs-engine";
import { FSM, FSMAtom } from "../src/fs-manifest";

const FIXTURE = path.resolve(__dirname, "../fixtures/ts-app");

describe("Phase 2a: TS symbol extraction", () => {
  let explorer: SpatialTetherFileExplorer;

  beforeAll(() => {
    explorer = new SpatialTetherFileExplorer(FIXTURE);
    explorer.scan();
  });

  describe("symbol atoms in FSM", () => {
    it("extracts top-level functions from auth.ts", () => {
      const fsm = explorer.getManifest();
      const verifyToken = fsm.atoms.find(
        (a) => a.rel_path === "src/auth.ts#verifyToken"
      );
      expect(verifyToken).toBeDefined();
      expect(verifyToken!.kind).toBe("symbol");
      expect(verifyToken!.symbol_kind).toBe("function");
      expect(verifyToken!.exported).toBe(true);
      expect(verifyToken!.span?.start_line).toBe(3);
      expect(verifyToken!.name).toBe("verifyToken");
    });

    it("extracts lookupUser as exported function", () => {
      const lookup = explorer.getSymbol("src/auth.ts#lookupUser");
      expect(lookup).toBeDefined();
      expect(lookup!.exported).toBe(true);
      expect(lookup!.symbol_kind).toBe("function");
    });

    it("extracts top-level const formatDate from utils.ts", () => {
      const formatDate = explorer.getSymbol("src/lib/utils.ts#formatDate");
      expect(formatDate).toBeDefined();
      expect(formatDate!.symbol_kind).toBe("function");
      expect(formatDate!.exported).toBe(true);
    });

    it("symbol parent_id chains to its file atom", () => {
      const fsm = explorer.getManifest();
      const verifyToken = explorer.getSymbol("src/auth.ts#verifyToken")!;
      const file = fsm.atoms.find((a) => a.rel_path === "src/auth.ts");
      expect(verifyToken.parent_id).toBe(file!.id);
    });

    it("file's contains_refs lists its top-level symbols", () => {
      const fsm = explorer.getManifest();
      const file = fsm.atoms.find((a) => a.rel_path === "src/auth.ts")!;
      const verifyToken = explorer.getSymbol("src/auth.ts#verifyToken")!;
      const lookupUser  = explorer.getSymbol("src/auth.ts#lookupUser")!;
      expect(file.contains_refs).toContain(verifyToken.id);
      expect(file.contains_refs).toContain(lookupUser.id);
    });

    it("dynamic-import target also gets its symbols extracted", () => {
      const runFeature = explorer.getSymbol("src/feature.ts#runFeature");
      expect(runFeature).toBeDefined();
      expect(runFeature!.exported).toBe(true);
    });
  });

  describe("symbol gravity", () => {
    it("exported function gets the export bonus", () => {
      const verifyToken = explorer.getSymbol("src/auth.ts#verifyToken")!;
      // Base function gravity is 0.50; exported adds 0.10 = 0.60
      expect(verifyToken.gravity).toBeCloseTo(0.60, 2);
    });
  });

  describe("findSymbol", () => {
    it("substring match finds verifyToken", () => {
      const matches = explorer.findSymbol("verify");
      const names = matches.map((a) => a.name);
      expect(names).toContain("verifyToken");
    });

    it("kind filter narrows results", () => {
      const fns = explorer.findSymbol("*", { kind: "function" });
      expect(fns.length).toBeGreaterThan(0);
      expect(fns.every((s) => s.symbol_kind === "function")).toBe(true);
    });

    it("returns gravity-sorted results", () => {
      const matches = explorer.findSymbol("*");
      for (let i = 1; i < matches.length; i++) {
        expect(matches[i - 1].gravity).toBeGreaterThanOrEqual(matches[i].gravity);
      }
    });
  });

  describe("findFile excludes symbols", () => {
    it("findFile('verify') returns no symbol matches", () => {
      const files = explorer.findFile("verify");
      expect(files.every((a) => a.kind === "file")).toBe(true);
    });
  });

  describe("Room shows symbols when focus is a file", () => {
    it("getRoom on src/auth.ts includes its symbols with 'contains' inclusion", () => {
      const room = explorer.getRoom("src/auth.ts");
      const verifyToken = explorer.getSymbol("src/auth.ts#verifyToken")!;
      const lookupUser  = explorer.getSymbol("src/auth.ts#lookupUser")!;
      expect(room.inclusion[verifyToken.id]).toBe("contains");
      expect(room.inclusion[lookupUser.id]).toBe("contains");
    });

    it("getRoom on src/auth.ts does NOT include symbols of other files", () => {
      const room = explorer.getRoom("src/auth.ts");
      const formatDate = explorer.getSymbol("src/lib/utils.ts#formatDate")!;
      // utils.ts is in the room (depth-window), but its symbols are not
      expect(room.inclusion[formatDate.id]).toBeUndefined();
    });

    it("describeRoom output surfaces SYMBOLS section", () => {
      const text = explorer.describeRoom("src/auth.ts");
      expect(text).toMatch(/SYMBOLS \(defined in focus\):/);
      expect(text).toMatch(/function verifyToken/);
      expect(text).toMatch(/\[exported\]/);
    });

    it("Room exits exclude symbol atoms", () => {
      const room = explorer.getRoom("src/auth.ts");
      expect(room.exits.every((a) => a.kind !== "symbol" && a.kind !== "method")).toBe(true);
    });
  });

  describe("FSM totals exclude symbols from total_files", () => {
    it("total_files counts only kind='file'", () => {
      const fsm = explorer.getManifest();
      const fileCount = fsm.atoms.filter((a) => a.kind === "file").length;
      expect(fsm.total_files).toBe(fileCount);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fix 6 — when MAX_ROOM_ATOMS=150 binds, the cap must NEVER drop a direct
// connection (focus / imports / imported_by / contains) regardless of how
// low its gravity is. Construct a synthetic FSM where the depth window has
// 200+ high-gravity files plus 5 intentionally low-gravity direct imports
// of focus, then assert all 5 still appear in the Room.
// ─────────────────────────────────────────────────────────────────────────
describe("Phase 2a: Room cap edge case (Fix 6)", () => {
  it("low-gravity direct imports are never excluded by MAX_ROOM_ATOMS", () => {
    const mkFile = (relPath: string, gravity: number, importRefs: string[] = []): FSMAtom => ({
      id: relPath,
      kind: "file",
      name: relPath.split("/").pop() ?? relPath,
      rel_path: relPath,
      geom: { x: 1, y: 0, w: 0, h: 0 },
      gravity,
      parent_id: null,
      siblings_total: 1,
      import_refs: importRefs,
      contains_refs: [],
      references: [],
      referenced_by: [],
      temporal_score: 0,
      mtime_ms: 0,
      meta: {
        role: "source", intent: "module", ext: ".ts",
        size_bytes: 100, is_dir: false, is_entry: false, children_count: 0,
      },
    });

    // 5 low-gravity files (build-artifact-like) — focus directly imports them.
    const lowImports = ["build/a.ts", "build/b.ts", "build/c.ts", "build/d.ts", "build/e.ts"]
      .map((p) => mkFile(p, 0.05));

    // The focus file imports all 5 low-gravity files.
    const focus = mkFile("src/focus.ts", 0.50, lowImports.map((a) => a.id));

    // 200 high-gravity depth-window files that would otherwise outrank the
    // low-gravity imports in any gravity-based ranking.
    const highWindow: FSMAtom[] = [];
    for (let i = 0; i < 200; i++) {
      highWindow.push(mkFile(`src/window/file${i}.ts`, 0.95));
    }

    const fsm: FSM = {
      fsm_version: "1.0",
      tether_id: "test",
      project_root: "/tmp/synthetic",
      project_name: "synthetic",
      total_files: 1 + lowImports.length + highWindow.length,
      total_dirs: 0,
      atoms: [focus, ...lowImports, ...highWindow],
      captured_at: new Date().toISOString(),
      language_profile: { ".ts": 206 },
    };

    const room = buildRoom(fsm, "src/focus.ts", 2);

    // Cap should bind (we have 206 atoms, cap is 150).
    expect(room.atoms.length).toBeLessThanOrEqual(150);

    // All 5 low-gravity direct imports MUST appear in the room with reason "imports".
    for (const lo of lowImports) {
      expect(room.inclusion[lo.id]).toBe("imports");
      const inAtoms = room.atoms.find((a) => a.id === lo.id);
      expect(inAtoms).toBeDefined();
    }

    // The focus itself must be present.
    expect(room.inclusion[focus.id]).toBe("focus");
  });
});
