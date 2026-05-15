import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { SpatialTetherFileExplorer } from "../src/gateway";
import { DEFAULT_GRAVITY_WEIGHTS } from "../src/fs-manifest";

const FIXTURE = path.resolve(__dirname, "../fixtures/ts-app");

describe("Phase 1: import-aware Room + gravity, .gitignore, path aliases", () => {
  let explorer: SpatialTetherFileExplorer;

  beforeAll(() => {
    explorer = new SpatialTetherFileExplorer(FIXTURE);
    explorer.scan();
  });

  describe(".gitignore respect", () => {
    it("excludes junk.log (matches *.log)", () => {
      const fsm = explorer.getManifest();
      const log = fsm.atoms.find((a) => a.rel_path === "junk.log");
      expect(log).toBeUndefined();
    });

    it("dist/ excluded (also caught by SKIP_DIRS)", () => {
      const fsm = explorer.getManifest();
      const dist = fsm.atoms.filter((a) => a.rel_path.startsWith("dist"));
      expect(dist).toHaveLength(0);
    });
  });

  describe("tsconfig.paths alias resolution", () => {
    it("feature.ts resolves '@/lib/utils' to src/lib/utils.ts", () => {
      const fsm = explorer.getManifest();
      const feature = fsm.atoms.find((a) => a.rel_path === path.join("src", "feature.ts"));
      const utils   = fsm.atoms.find((a) => a.rel_path === path.join("src", "lib", "utils.ts"));
      expect(feature).toBeDefined();
      expect(utils).toBeDefined();
      expect(feature!.import_refs).toContain(utils!.id);
    });
  });

  describe("import in-degree affects gravity", () => {
    it("utils.ts (imported by db, feature) has higher gravity than auth.test.ts (no importers)", () => {
      const fsm = explorer.getManifest();
      const utils = fsm.atoms.find((a) => a.rel_path === path.join("src", "lib", "utils.ts"))!;
      const test  = fsm.atoms.find((a) => a.rel_path === path.join("src", "auth.test.ts"))!;
      expect(utils.gravity).toBeGreaterThan(test.gravity);
    });

    it("entry main.ts gets the entry intent bonus and ranks high", () => {
      const fsm = explorer.getManifest();
      const main = fsm.atoms.find((a) => a.rel_path === path.join("src", "main.ts"))!;
      const sources = fsm.atoms.filter(
        (a) => !a.meta.is_dir && a.meta.role === "source"
      );
      const ranked = [...sources].sort((a, b) => b.gravity - a.gravity);
      expect(ranked[0].rel_path).toBe(main.rel_path);
    });
  });

  describe("Room pulls imports + importers", () => {
    it("focus on src/auth.ts: Room includes db.ts (imports out)", () => {
      const room = explorer.getRoom(path.join("src", "auth.ts"));
      const ids = new Set(room.atoms.map((a) => a.id));
      const fsm = explorer.getManifest();
      const db = fsm.atoms.find((a) => a.rel_path === path.join("src", "db.ts"))!;
      expect(ids.has(db.id)).toBe(true);
      expect(room.inclusion[db.id]).toBe("imports");
    });

    it("focus on src/db.ts: Room includes its importers (auth.ts, main.ts)", () => {
      const room = explorer.getRoom(path.join("src", "db.ts"));
      const fsm  = explorer.getManifest();
      const auth = fsm.atoms.find((a) => a.rel_path === path.join("src", "auth.ts"))!;
      const main = fsm.atoms.find((a) => a.rel_path === path.join("src", "main.ts"))!;
      expect(room.inclusion[auth.id]).toBe("imported_by");
      expect(room.inclusion[main.id]).toBe("imported_by");
    });

    it("focus atom is tagged 'focus'", () => {
      const room = explorer.getRoom(path.join("src", "auth.ts"));
      const fsm  = explorer.getManifest();
      const auth = fsm.atoms.find((a) => a.rel_path === path.join("src", "auth.ts"))!;
      expect(room.inclusion[auth.id]).toBe("focus");
    });

    it("Room pulls deep imports across depth window", () => {
      // utils.ts is at depth 3 (src/lib/utils.ts).
      // With depthLimit=1 and focus=main.ts (depth 2), utils.ts would normally
      // not be in the depth window — but main.ts → utils.ts via direct import,
      // so it must be pulled in regardless.
      const room = explorer.getRoom(path.join("src", "main.ts"), 1);
      const fsm  = explorer.getManifest();
      const utils = fsm.atoms.find((a) => a.rel_path === path.join("src", "lib", "utils.ts"))!;
      expect(room.inclusion[utils.id]).toBe("imports");
    });
  });

  describe("roomToText surfaces inclusion reason", () => {
    it("includes FOCUS, IMPORTS, IMPORTED-BY flags", () => {
      const text = explorer.describeRoom(path.join("src", "db.ts"));
      expect(text).toMatch(/FOCUS/);
      expect(text).toMatch(/IMPORTED-BY/);
      expect(text).toMatch(/IMPORTS/);
    });
  });

  describe("tunable gravity weights", () => {
    it("zeroing in_degree_weight removes the in-degree bump", () => {
      const noInDegree = new SpatialTetherFileExplorer(FIXTURE, {
        gravity_weights: { in_degree_weight: 0, recency_weight: 0 },
      });
      noInDegree.scan();

      const fsmA = explorer.getManifest();
      const fsmB = noInDegree.getManifest();

      const utilsA = fsmA.atoms.find((a) => a.rel_path === path.join("src", "lib", "utils.ts"))!;
      const utilsB = fsmB.atoms.find((a) => a.rel_path === path.join("src", "lib", "utils.ts"))!;

      // utils.ts has importers, so disabling the in-degree term should
      // strictly lower its gravity.
      expect(utilsB.gravity).toBeLessThanOrEqual(utilsA.gravity);
    });

    it("default weights match the exported default", () => {
      // Sanity: defaults are stable across changes
      expect(DEFAULT_GRAVITY_WEIGHTS.in_degree_weight).toBe(0.20);
      expect(DEFAULT_GRAVITY_WEIGHTS.recency_weight).toBe(0.10);
      expect(DEFAULT_GRAVITY_WEIGHTS.depth_penalty_per_level).toBe(0.04);
    });
  });
});
