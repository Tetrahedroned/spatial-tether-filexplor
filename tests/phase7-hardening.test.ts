// Phase 7 — bug-hunt + hardening regression suite.
//
// Each block guards against one of the bugs surfaced by the dungeon
// benchmark. Adding new tests here when new bugs are found.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { extractSymbols, extractImportedNames, extractReferences, ImportNameRef } from "../src/fs-symbols";
import { SpatialTetherFileExplorer } from "../src/gateway";
import { buildSymbolId } from "../src/fs-manifest";

const FIXTURE_LARGE = path.resolve(__dirname, "../fixtures/large-file/bigmodule.ts");
const FIXTURE_BARREL = path.resolve(__dirname, "../fixtures/barrel-app");
const FIXTURE_CJS = path.resolve(__dirname, "../fixtures/cjs-app");
const FIXTURE_LOCAL_CONST = path.resolve(__dirname, "../fixtures/local-const-app");
const FIXTURE_PKG = path.resolve(__dirname, "../fixtures/pkg-entry-app");

describe("Phase 7 — Bug 1: tree-sitter parse handles >32 KB files", () => {
  it("parses a 35+ KB TS source and extracts every top-level function", () => {
    const stat = fs.statSync(FIXTURE_LARGE);
    expect(stat.size).toBeGreaterThan(32 * 1024);
    const symbols = extractSymbols(FIXTURE_LARGE, ".ts");
    // Fixture has 900 fn_NNNN exports; at minimum we should see >>0
    expect(symbols.length).toBeGreaterThan(800);
    const fnNames = symbols.filter((s) => s.symbol_kind === "function").map((s) => s.name);
    expect(fnNames).toContain("fn_0000");
    expect(fnNames).toContain("fn_0500");
    expect(fnNames).toContain("fn_0899");
  });
});

describe("Phase 7 — Bug 2: re-export walker (export {X} from, export *)", () => {
  beforeAll(() => {
    fs.mkdirSync(FIXTURE_BARREL, { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_BARREL, "package.json"), JSON.stringify({ name: "barrel-app", main: "src/index.ts" }));
    fs.mkdirSync(path.join(FIXTURE_BARREL, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(FIXTURE_BARREL, "src", "core.ts"),
      `export function coreFn() { return 1; }\nexport class CoreClass { x = 1 }\n`,
    );
    fs.writeFileSync(
      path.join(FIXTURE_BARREL, "src", "util.ts"),
      `export function helperFn(x: number) { return x * 2; }\nexport const PI = 3.14;\n`,
    );
    fs.writeFileSync(
      path.join(FIXTURE_BARREL, "src", "extra.ts"),
      `export const ALPHA = "a";\nexport const BETA = "b";\n`,
    );
    fs.writeFileSync(
      path.join(FIXTURE_BARREL, "src", "index.ts"),
      `export { coreFn, CoreClass } from "./core";\nexport { helperFn as helper, PI } from "./util";\nexport * from "./extra";\n`,
    );
  });

  it("walkSymbols emits one symbol per re-exported name", () => {
    const symbols = extractSymbols(path.join(FIXTURE_BARREL, "src", "index.ts"), ".ts");
    const names = symbols.map((s) => s.name).sort();
    // Named re-exports
    expect(names).toContain("coreFn");
    expect(names).toContain("CoreClass");
    // Aliased
    expect(names).toContain("helper");
    expect(names).toContain("PI");
    // export * — name is "*" placeholder (the wildcard is intentionally surfaced
    // as a re-export marker rather than expanded; expansion is a higher-level
    // pass once we know the target file's exports).
  });

  it("walkImportedNames returns a ref for each re-exported name (used by Pass 5)", () => {
    const refs: ImportNameRef[] = extractImportedNames(path.join(FIXTURE_BARREL, "src", "index.ts"), ".ts");
    const localNames = refs.map((r) => r.local_name).sort();
    expect(localNames).toContain("coreFn");
    expect(localNames).toContain("CoreClass");
    expect(localNames).toContain("helper");        // aliased
    expect(localNames).toContain("PI");
  });

  it("FSM populates import edges from the barrel to its targets", () => {
    const explorer = new SpatialTetherFileExplorer(FIXTURE_BARREL);
    explorer.scan();
    const fsm = explorer.getManifest();
    const idx = fsm.atoms.find((a) => a.rel_path === "src/index.ts");
    expect(idx).toBeDefined();
    // Should reference all three submodules
    const targets = idx!.import_refs
      .map((id) => fsm.atoms.find((a) => a.id === id)?.rel_path)
      .filter(Boolean) as string[];
    expect(targets).toContain("src/core.ts");
    expect(targets).toContain("src/util.ts");
    expect(targets).toContain("src/extra.ts");
  });
});

describe("Phase 7 — Bug 3: CJS require-destructure import edges", () => {
  beforeAll(() => {
    fs.mkdirSync(FIXTURE_CJS, { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_CJS, "package.json"), JSON.stringify({ name: "cjs-app", main: "index.js" }));
    fs.writeFileSync(
      path.join(FIXTURE_CJS, "lib.js"),
      "function helper(x) { return x + 1; }\nclass Helper {}\nmodule.exports = { helper, Helper };\nmodule.exports.PI = 3.14;\n",
    );
    fs.writeFileSync(
      path.join(FIXTURE_CJS, "index.js"),
      "const { helper, Helper } = require('./lib');\nconst pi = require('./lib').PI;\nfunction main() { return helper(2); }\nmodule.exports = main;\n",
    );
  });

  it("walkImportedNames detects CJS destructured require()", () => {
    const refs = extractImportedNames(path.join(FIXTURE_CJS, "index.js"), ".js");
    const local = refs.map((r) => r.local_name).sort();
    expect(local).toContain("helper");
    expect(local).toContain("Helper");
  });

  it("FSM resolves CJS require() into import edges", () => {
    const explorer = new SpatialTetherFileExplorer(FIXTURE_CJS);
    explorer.scan();
    const fsm = explorer.getManifest();
    const idx = fsm.atoms.find((a) => a.rel_path === "index.js");
    expect(idx).toBeDefined();
    const targets = idx!.import_refs
      .map((id) => fsm.atoms.find((a) => a.id === id)?.rel_path)
      .filter(Boolean) as string[];
    expect(targets).toContain("lib.js");
  });

  it("Pass 5 reference resolution links a CJS-imported callee", () => {
    const explorer = new SpatialTetherFileExplorer(FIXTURE_CJS);
    explorer.scan();
    const fsm = explorer.getManifest();
    const main = fsm.atoms.find((a) => a.rel_path === "index.js#main");
    const helper = fsm.atoms.find((a) => a.rel_path === "lib.js#helper");
    expect(main).toBeDefined();
    expect(helper).toBeDefined();
    expect(main!.references).toContain(helper!.id);
    expect(helper!.referenced_by).toContain(main!.id);
  });
});

describe("Phase 7 — Bug 4: file-level const → import target resolution", () => {
  beforeAll(() => {
    fs.mkdirSync(FIXTURE_LOCAL_CONST, { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_LOCAL_CONST, "package.json"), JSON.stringify({ name: "local-const-app", main: "main.ts" }));
    fs.writeFileSync(
      path.join(FIXTURE_LOCAL_CONST, "lib.ts"),
      "export function transform(x: number) { return x * 2; }\n",
    );
    // A top-level `const X = (…) => …` that calls an imported function.
    // Bug 4 caused isInScope() to mask the import target.
    fs.writeFileSync(
      path.join(FIXTURE_LOCAL_CONST, "main.ts"),
      "import { transform } from \"./lib\";\nconst doWork = (n: number) => transform(n) + 1;\nexport function run(n: number) { return doWork(n); }\n",
    );
  });

  it("references from file-level const arrow resolve to the imported symbol", () => {
    const explorer = new SpatialTetherFileExplorer(FIXTURE_LOCAL_CONST);
    explorer.scan();
    const fsm = explorer.getManifest();
    const transform = fsm.atoms.find((a) => a.rel_path === "lib.ts#transform");
    const doWork = fsm.atoms.find((a) => a.rel_path === "main.ts#doWork");
    expect(transform).toBeDefined();
    expect(doWork).toBeDefined();
    expect(doWork!.references).toContain(transform!.id);
    expect(transform!.referenced_by).toContain(doWork!.id);
  });
});

describe("Phase 7 — Bug 5: entry-point heuristic prefers package.json#main/exports/bin", () => {
  beforeAll(() => {
    fs.mkdirSync(FIXTURE_PKG, { recursive: true });
    fs.mkdirSync(path.join(FIXTURE_PKG, "src"), { recursive: true });
    fs.mkdirSync(path.join(FIXTURE_PKG, "templates", "preact", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(FIXTURE_PKG, "package.json"),
      JSON.stringify({
        name: "pkg-entry-app",
        main: "src/entry.ts",
        bin: { mybin: "src/cli.ts" },
      }, null, 2),
    );
    fs.writeFileSync(path.join(FIXTURE_PKG, "src", "entry.ts"), "export const VERSION = '1.0';\n");
    fs.writeFileSync(path.join(FIXTURE_PKG, "src", "cli.ts"), "#!/usr/bin/env node\nconsole.log('cli');\n");
    fs.writeFileSync(path.join(FIXTURE_PKG, "src", "util.ts"), "export const helper = 1;\n");
    // Decoy: deep template/index.ts that should NOT be flagged as a primary entry.
    fs.writeFileSync(path.join(FIXTURE_PKG, "templates", "preact", "src", "main.ts"), "// template\n");
  });

  it("the file referenced by package.json#main is tagged is_entry=true", () => {
    const explorer = new SpatialTetherFileExplorer(FIXTURE_PKG);
    explorer.scan();
    const fsm = explorer.getManifest();
    const entry = fsm.atoms.find((a) => a.rel_path === "src/entry.ts");
    expect(entry).toBeDefined();
    expect(entry!.meta.is_entry).toBe(true);
  });

  it("the file referenced by package.json#bin is tagged is_entry=true", () => {
    const explorer = new SpatialTetherFileExplorer(FIXTURE_PKG);
    explorer.scan();
    const cli = explorer.getManifest().atoms.find((a) => a.rel_path === "src/cli.ts");
    expect(cli).toBeDefined();
    expect(cli!.meta.is_entry).toBe(true);
  });

  it("a deep template/main.ts NOT referenced by package.json is NOT a primary entry", () => {
    const explorer = new SpatialTetherFileExplorer(FIXTURE_PKG);
    explorer.scan();
    const tpl = explorer.getManifest().atoms.find((a) => a.rel_path === "templates/preact/src/main.ts");
    expect(tpl).toBeDefined();
    expect(tpl!.meta.is_entry).toBe(false);
  });
});

describe("Phase 7 — Security: path traversal in MCP file accessors", () => {
  it("getAtom rejects paths that escape projectRoot", () => {
    const explorer = new SpatialTetherFileExplorer(path.join(__dirname, "../fixtures/ts-app"));
    explorer.scan();
    // Try to escape via ../../../ — must NOT return /etc/passwd
    const atom = explorer.getAtom("../../../etc/passwd");
    expect(atom).toBeNull();
  });

  it("session.requestFile denies traversal attempts even with a justification", () => {
    const explorer = new SpatialTetherFileExplorer(path.join(__dirname, "../fixtures/ts-app"));
    explorer.scan();
    const session = explorer.startSession();
    session.enterRoom("src/auth.ts");
    const result = session.requestFile("../../../etc/passwd", "I want to read passwd");
    expect(result.granted).toBe(false);
    // Should be denied (or atom_not_found), never granted with content.
    expect(result.content).toBeNull();
  });
});

describe("Phase 7 — Robustness: cycle-safe FSM serialization", () => {
  it("dumpFSM completes when two symbols mutually reference each other", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "cycle", main: "a.ts" }));
    fs.writeFileSync(
      path.join(dir, "a.ts"),
      "import { b } from './b';\nexport function a() { return b(); }\n",
    );
    fs.writeFileSync(
      path.join(dir, "b.ts"),
      "import { a } from './a';\nexport function b() { return a(); }\n",
    );
    const explorer = new SpatialTetherFileExplorer(dir);
    explorer.scan();
    const target = path.join(dir, ".spatial-tether", "fsm.json");
    await expect(explorer.save(target)).resolves.toBeTruthy();
    expect(fs.existsSync(target)).toBe(true);
  });
});

afterAll(() => {
  // Best-effort cleanup of generated fixtures (the large-file fixture is kept).
  for (const d of [FIXTURE_BARREL, FIXTURE_CJS, FIXTURE_LOCAL_CONST, FIXTURE_PKG]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});
