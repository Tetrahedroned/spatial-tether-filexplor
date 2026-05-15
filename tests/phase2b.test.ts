// Phase 2b — call graph (TS references) + polyglot symbol extraction.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { SpatialTetherFileExplorer } from "../src/gateway";
import { extractSymbols } from "../src/fs-symbols";

const TS_FIXTURE   = path.resolve(__dirname, "../fixtures/ts-app");
const PY_FIXTURE   = path.resolve(__dirname, "../fixtures/py-app");
const GO_FIXTURE   = path.resolve(__dirname, "../fixtures/go-app");
const RS_FIXTURE   = path.resolve(__dirname, "../fixtures/rs-app");
const SELF_PROJECT = path.resolve(__dirname, "..");

describe("Phase 2b: TS call graph", () => {
  let explorer: SpatialTetherFileExplorer;

  beforeAll(() => {
    explorer = new SpatialTetherFileExplorer(TS_FIXTURE);
    explorer.scan();
  });

  it("populates references on caller symbol", () => {
    const handle = explorer.getSymbol("src/main.ts#handleRequest");
    expect(handle).toBeDefined();
    expect(handle!.references.length).toBeGreaterThan(0);
  });

  it("populates referenced_by on callee symbol", () => {
    const verify = explorer.getSymbol("src/auth.ts#verifyToken");
    expect(verify).toBeDefined();
    expect(verify!.referenced_by.length).toBeGreaterThan(0);
  });

  it("findCallees(handleRequest) includes verifyToken (cross-file import)", () => {
    const callees = explorer.findCallees("src/main.ts#handleRequest");
    const names = callees.map((c) => c.rel_path);
    expect(names).toContain("src/auth.ts#verifyToken");
  });

  it("findCallees(handleRequest) includes query (cross-file import)", () => {
    const callees = explorer.findCallees("src/main.ts#handleRequest");
    const names = callees.map((c) => c.rel_path);
    expect(names).toContain("src/db.ts#query");
  });

  it("findCallees(handleRequest) includes formatDate (cross-file import via lib/)", () => {
    const callees = explorer.findCallees("src/main.ts#handleRequest");
    const names = callees.map((c) => c.rel_path);
    expect(names).toContain("src/lib/utils.ts#formatDate");
  });

  it("findCallers(verifyToken) includes handleRequest (inverse edge)", () => {
    const callers = explorer.findCallers("src/auth.ts#verifyToken");
    const names = callers.map((c) => c.rel_path);
    expect(names).toContain("src/main.ts#handleRequest");
  });

  it("getRelationship reports a_imports_b + a_calls_b for known connected files", () => {
    // main.ts imports verifyToken from auth.ts; handleRequest calls verifyToken.
    const rel = explorer.getRelationship("src/main.ts", "src/auth.ts");
    expect(rel.a).not.toBeNull();
    expect(rel.b).not.toBeNull();
    expect(rel.a_imports_b).toBe(true);
    expect(rel.b_imports_a).toBe(false);
    const handleId = explorer.getSymbol("src/main.ts#handleRequest")!.id;
    expect(rel.a_calls_b).toContain(handleId);
  });

  it("findCallers(query) includes both handleRequest and lookupUser", () => {
    const callers = explorer.findCallers("src/db.ts#query");
    const names = callers.map((c) => c.rel_path);
    expect(names).toContain("src/main.ts#handleRequest");
    expect(names).toContain("src/auth.ts#lookupUser");
  });

  it("findCallers/findCallees return [] for unknown symbol", () => {
    expect(explorer.findCallers("does/not#exist")).toEqual([]);
    expect(explorer.findCallees("does/not#exist")).toEqual([]);
  });

  it("findCallees results are gravity-sorted (descending)", () => {
    const callees = explorer.findCallees("src/main.ts#handleRequest");
    for (let i = 1; i < callees.length; i++) {
      expect(callees[i - 1].gravity).toBeGreaterThanOrEqual(callees[i].gravity);
    }
  });
});

describe("Phase 2b: self-referential call graph (project's own src/)", () => {
  let explorer: SpatialTetherFileExplorer;

  beforeAll(() => {
    // Scan the project's own source. Skip .spatial-tether cache + node_modules
    // — the walker already excludes node_modules and dot-dirs.
    explorer = new SpatialTetherFileExplorer(SELF_PROJECT);
    explorer.scan();
  });

  it("findCallees(buildFSM) returns at least one symbol", () => {
    const callees = explorer.findCallees("src/fs-engine.ts#buildFSM");
    expect(callees.length).toBeGreaterThan(0);
  });

  it("findCallees(buildFSM) includes file-local helper computeGravity", () => {
    const callees = explorer.findCallees("src/fs-engine.ts#buildFSM");
    const names = callees.map((c) => c.name);
    expect(names).toContain("computeGravity");
  });

  it("findCallees(buildFSM) includes cross-file callee extractSymbols", () => {
    const callees = explorer.findCallees("src/fs-engine.ts#buildFSM");
    const relPaths = callees.map((c) => c.rel_path);
    // extractSymbols is imported from src/fs-symbols.ts
    expect(relPaths).toContain("src/fs-symbols.ts#extractSymbols");
  });

  it("buildRoom is also discoverable as a symbol with references populated", () => {
    const buildRoom = explorer.getSymbol("src/fs-engine.ts#buildRoom");
    expect(buildRoom).toBeDefined();
    expect(buildRoom!.references.length).toBeGreaterThan(0);
  });
});

describe("Phase 2b: Python symbol extraction", () => {
  it("extracts top-level functions, consts, and classes", () => {
    const symbols = extractSymbols(
      path.join(PY_FIXTURE, "sample.py"),
      ".py",
    );
    const byChain = new Map(symbols.map((s) => [s.scope_chain.join("."), s]));

    expect(byChain.get("public_helper")?.symbol_kind).toBe("function");
    expect(byChain.get("public_helper")?.exported).toBe(true);

    expect(byChain.get("_private_helper")?.exported).toBe(false);

    expect(byChain.get("DEFAULT_TIMEOUT")?.symbol_kind).toBe("const");
    expect(byChain.get("DEFAULT_TIMEOUT")?.exported).toBe(true);

    expect(byChain.get("Connection")?.symbol_kind).toBe("class");
    expect(byChain.get("Connection")?.exported).toBe(true);
  });

  it("extracts methods scoped to their class", () => {
    const symbols = extractSymbols(
      path.join(PY_FIXTURE, "sample.py"),
      ".py",
    );
    const query = symbols.find(
      (s) => s.scope_chain.join(".") === "Connection.query"
    );
    expect(query).toBeDefined();
    expect(query!.symbol_kind).toBe("method");
    expect(query!.exported).toBe(true);

    const close = symbols.find(
      (s) => s.scope_chain.join(".") === "Connection._close"
    );
    expect(close).toBeDefined();
    expect(close!.exported).toBe(false); // PEP 8 underscore convention
  });
});

describe("Phase 2b: Go symbol extraction", () => {
  it("extracts functions, constants, structs, interfaces", () => {
    const symbols = extractSymbols(
      path.join(GO_FIXTURE, "sample.go"),
      ".go",
    );
    const byChain = new Map(symbols.map((s) => [s.scope_chain.join("."), s]));

    expect(byChain.get("PublicHelper")?.symbol_kind).toBe("function");
    expect(byChain.get("PublicHelper")?.exported).toBe(true);

    expect(byChain.get("privateHelper")?.exported).toBe(false);

    expect(byChain.get("DefaultTimeout")?.symbol_kind).toBe("const");
    expect(byChain.get("DefaultTimeout")?.exported).toBe(true);

    expect(byChain.get("Connection")?.symbol_kind).toBe("class");

    expect(byChain.get("Querier")?.symbol_kind).toBe("interface");
    expect(byChain.get("Querier")?.exported).toBe(true);
  });

  it("extracts methods with receiver type in scope chain", () => {
    const symbols = extractSymbols(
      path.join(GO_FIXTURE, "sample.go"),
      ".go",
    );
    const query = symbols.find(
      (s) => s.scope_chain.join(".") === "Connection.Query"
    );
    expect(query).toBeDefined();
    expect(query!.symbol_kind).toBe("method");
    expect(query!.exported).toBe(true);

    const close = symbols.find(
      (s) => s.scope_chain.join(".") === "Connection.close"
    );
    expect(close).toBeDefined();
    expect(close!.exported).toBe(false); // lowercase = unexported in Go
  });
});

describe("Phase 2b: Rust symbol extraction", () => {
  it("extracts functions, structs, enums, traits, consts", () => {
    const symbols = extractSymbols(
      path.join(RS_FIXTURE, "sample.rs"),
      ".rs",
    );
    const byChain = new Map(symbols.map((s) => [s.scope_chain.join("."), s]));

    expect(byChain.get("public_helper")?.symbol_kind).toBe("function");
    expect(byChain.get("public_helper")?.exported).toBe(true);

    expect(byChain.get("private_helper")?.exported).toBe(false);

    expect(byChain.get("DEFAULT_TIMEOUT")?.symbol_kind).toBe("const");
    expect(byChain.get("DEFAULT_TIMEOUT")?.exported).toBe(true);

    expect(byChain.get("Connection")?.symbol_kind).toBe("class"); // struct → class
    expect(byChain.get("Connection")?.exported).toBe(true);

    expect(byChain.get("InternalState")?.exported).toBe(false);

    expect(byChain.get("Status")?.symbol_kind).toBe("enum");

    expect(byChain.get("Querier")?.symbol_kind).toBe("interface"); // trait → interface
  });

  it("extracts impl-block methods with public flag", () => {
    const symbols = extractSymbols(
      path.join(RS_FIXTURE, "sample.rs"),
      ".rs",
    );

    const ctor = symbols.find(
      (s) => s.scope_chain.join(".") === "Connection.new"
    );
    expect(ctor).toBeDefined();
    expect(ctor!.symbol_kind).toBe("method");
    expect(ctor!.exported).toBe(true); // pub fn new

    const close = symbols.find(
      (s) => s.scope_chain.join(".") === "Connection.close"
    );
    expect(close).toBeDefined();
    expect(close!.exported).toBe(false); // no pub
  });
});
