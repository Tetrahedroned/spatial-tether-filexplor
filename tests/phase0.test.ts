import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import * as crypto from "crypto";
import { SpatialTetherFileExplorer } from "../src/gateway";
import { buildAtomId } from "../src/fs-manifest";

const FIXTURE = path.resolve(__dirname, "../fixtures/ts-app");

describe("Phase 0: foundation + bug fixes", () => {
  let explorer: SpatialTetherFileExplorer;

  beforeAll(() => {
    explorer = new SpatialTetherFileExplorer(FIXTURE);
    explorer.scan();
  });

  it("scans the fixture and finds the expected files", () => {
    const fsm = explorer.getManifest();
    const relPaths = new Set(fsm.atoms.filter((a) => !a.meta.is_dir).map((a) => a.rel_path));

    expect(relPaths.has("package.json")).toBe(true);
    expect(relPaths.has("tsconfig.json")).toBe(true);
    expect(relPaths.has("README.md")).toBe(true);
    expect(relPaths.has(path.join("src", "main.ts"))).toBe(true);
    expect(relPaths.has(path.join("src", "lib", "utils.ts"))).toBe(true);
  });

  it("excludes dist/ via SKIP_DIRS (pre-gitignore)", () => {
    const fsm = explorer.getManifest();
    const distFiles = fsm.atoms.filter((a) => a.rel_path.startsWith("dist"));
    expect(distFiles).toHaveLength(0);
  });

  describe("atom ID portability", () => {
    it("derives id from rel_path (not abs_path)", () => {
      const fsm = explorer.getManifest();
      const main = fsm.atoms.find((a) => a.rel_path === path.join("src", "main.ts"));
      expect(main).toBeDefined();

      const expected = crypto
        .createHash("sha256")
        .update(main!.rel_path)
        .digest("hex")
        .slice(0, 16);
      expect(main!.id).toBe(expected);
    });

    it("buildAtomId is stable for the same rel_path", () => {
      const a = buildAtomId("src/auth.ts");
      const b = buildAtomId("src/auth.ts");
      expect(a).toBe(b);
      expect(a).toHaveLength(16);
    });

    it("different IDs across two different absolute roots", () => {
      // Same fixture mounted from a synthetic path → IDs depend only on rel_path,
      // so two SpatialTetherFileExplorers over different mountpoints would
      // produce identical IDs for the same rel_path. We can't simulate two
      // mountpoints cheaply; assert the contract directly.
      const fsm = explorer.getManifest();
      const main = fsm.atoms.find((a) => a.rel_path === path.join("src", "main.ts"));
      // FSMAtom no longer carries an absolute `path` field; reconstruct one
      // from project_root + rel_path purely to verify the ID is NOT derived
      // from the absolute form.
      const reconstructedAbs = path.join(fsm.project_root, main!.rel_path);
      const expectedFromAbs = crypto
        .createHash("sha256")
        .update(reconstructedAbs)
        .digest("hex")
        .slice(0, 16);
      expect(main!.id).not.toBe(expectedFromAbs);
    });
  });

  describe("findFile", () => {
    it("substring match", () => {
      const matches = explorer.findFile("auth");
      const names = matches.map((a) => a.name).sort();
      expect(names).toContain("auth.ts");
      expect(names).toContain("auth.test.ts");
    });

    it("glob match", () => {
      const matches = explorer.findFile("*.test.ts");
      expect(matches.map((a) => a.name)).toEqual(["auth.test.ts"]);
    });

    it("results sorted by gravity desc and capped by limit", () => {
      const matches = explorer.findFile(".ts", 3);
      expect(matches).toHaveLength(3);
      for (let i = 1; i < matches.length; i++) {
        expect(matches[i - 1].gravity).toBeGreaterThanOrEqual(matches[i].gravity);
      }
    });

    it("excludes directories", () => {
      const matches = explorer.findFile("src");
      expect(matches.every((a) => !a.meta.is_dir)).toBe(true);
    });
  });

  describe("dynamic import capture", () => {
    it("import('./feature') in main.ts is captured as import_ref", () => {
      const fsm = explorer.getManifest();
      const main = fsm.atoms.find((a) => a.rel_path === path.join("src", "main.ts"));
      const feature = fsm.atoms.find((a) => a.rel_path === path.join("src", "feature.ts"));
      expect(main).toBeDefined();
      expect(feature).toBeDefined();
      expect(main!.import_refs).toContain(feature!.id);
    });
  });

  describe("role + intent inference", () => {
    it("main.ts is intent: entry", () => {
      const fsm = explorer.getManifest();
      const main = fsm.atoms.find((a) => a.rel_path === path.join("src", "main.ts"));
      expect(main!.meta.intent).toBe("entry");
      expect(main!.meta.is_entry).toBe(true);
    });

    it("auth.test.ts is role: test", () => {
      const fsm = explorer.getManifest();
      const test = fsm.atoms.find((a) => a.rel_path === path.join("src", "auth.test.ts"));
      expect(test!.meta.role).toBe("test");
    });

    it("package.json is role: config", () => {
      const fsm = explorer.getManifest();
      const pkg = fsm.atoms.find((a) => a.rel_path === "package.json");
      expect(pkg!.meta.role).toBe("config");
    });

    it("README.md is role: doc", () => {
      const fsm = explorer.getManifest();
      const readme = fsm.atoms.find((a) => a.rel_path === "README.md");
      expect(readme!.meta.role).toBe("doc");
    });
  });
});
