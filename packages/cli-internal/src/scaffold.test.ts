import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the yarn-version subprocess helper so unit tests are
// deterministic regardless of whether the test machine has yarn
// installed globally. Without this, scaffold's runtime-detection
// fallback (round 30, PR #99) would shell out to `yarn --version`
// in the explicit-`--use-yarn` + no-signal branch, and the test's
// caveat-fires-or-not outcome would depend on the dev box's yarn
// version. Default mock returns `undefined` (yarn not detected →
// caveat doesn't fire); per-test overrides below simulate yarn 1
// vs yarn 4 for the round-30 regression tests.
vi.mock("./yarn-version", () => ({
  detectYarnMajor: vi.fn(async () => undefined),
}));

import { scaffold, templateChoices } from "./scaffold";
import {
  detectPackageManager,
  resolvePackageManager,
} from "./package-manager";
import { detectYarnMajor } from "./yarn-version";

let cwd: string;
const ORIG_UA = process.env.npm_config_user_agent;
const ORIG_ARKOR_SPEC = process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cli-internal-test-"));
  delete process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC;
});

afterEach(() => {
  // Node coerces env-var assignments to strings, so a plain
  // `process.env.X = undefined` writes the literal string "undefined".
  // Mirror the spec restore: delete on undefined, otherwise reassign.
  if (ORIG_UA === undefined) {
    delete process.env.npm_config_user_agent;
  } else {
    process.env.npm_config_user_agent = ORIG_UA;
  }
  if (ORIG_ARKOR_SPEC === undefined) {
    delete process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC;
  } else {
    process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC = ORIG_ARKOR_SPEC;
  }
  rmSync(cwd, { recursive: true, force: true });
});

describe("scaffold", () => {
  it("writes all starter files in an empty directory", async () => {
    const result = await scaffold({ cwd, name: "my-app", template: "triage" });
    // index.ts, trainer.ts, arkor.config.ts, README.md, .gitignore,
    // package.json, pnpm-workspace.yaml, .yarnrc.yml — the trailing
    // `.yarnrc.yml` fires because `packageManager` is undefined here
    // (no `--use-*` was simulated), and the manual-install-hint flow
    // defensively emits the file so a yarn-berry user reading the
    // hint and running `yarn install` doesn't land on PnP.
    // pnpm-workspace.yaml is unconditional (round 36): yarn / npm /
    // bun all ignore it, so emitting it always avoids a stale-config
    // pitfall if the user later switches to pnpm.
    expect(result.files.map((f) => f.action)).toEqual([
      "created",
      "created",
      "created",
      "created",
      "created",
      "created",
      "created",
      "created",
    ]);

    const index = readFileSync(join(cwd, "src/arkor/index.ts"), "utf8");
    expect(index).toContain("createArkor");
    expect(index).toContain('from "./trainer"');

    const trainer = readFileSync(join(cwd, "src/arkor/trainer.ts"), "utf8");
    expect(trainer).toContain("createTrainer");
    expect(trainer).toContain("unsloth/gemma-4-e4b-it");
    expect(trainer).toContain('"triage-run"');

    const pkg = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.name).toBe("my-app");
    expect(pkg.scripts).toMatchObject({
      dev: "arkor dev",
      build: "arkor build",
      start: "arkor start",
    });
    expect((pkg.scripts as Record<string, string>).train).toBeUndefined();

    const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain(".arkor/");
  });

  it("keeps existing src/arkor/index.ts and trainer.ts untouched", async () => {
    const existingIndex = "// custom index\nexport default {};\n";
    const existingTrainer = "// custom trainer\nexport const trainer = {};\n";
    writeFileSync(join(cwd, "placeholder.txt"), "keep me");
    const { readdirSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), existingIndex);
    writeFileSync(join(cwd, "src/arkor/trainer.ts"), existingTrainer);

    const result = await scaffold({ cwd, name: "foo", template: "triage" });
    const indexEntry = result.files.find(
      (f) => f.path === "src/arkor/index.ts",
    );
    const trainerEntry = result.files.find(
      (f) => f.path === "src/arkor/trainer.ts",
    );
    expect(indexEntry?.action).toBe("kept");
    expect(trainerEntry?.action).toBe("kept");
    expect(readFileSync(join(cwd, "src/arkor/index.ts"), "utf8")).toBe(
      existingIndex,
    );
    expect(readFileSync(join(cwd, "src/arkor/trainer.ts"), "utf8")).toBe(
      existingTrainer,
    );
    expect(readdirSync(cwd)).toContain("placeholder.txt");
  });

  it("patches an existing package.json without clobbering user fields", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          name: "already",
          private: true,
          dependencies: { react: "19.0.0" },
          scripts: { build: "tsc" },
        },
        null,
        2,
      ),
    );
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
    });
    const patched = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(patched.name).toBe("already");
    expect(patched.dependencies).toEqual({ react: "19.0.0" });
    const scripts = patched.scripts as Record<string, string>;
    // Existing user-defined `build` survives untouched.
    expect(scripts.build).toBe("tsc");
    expect(scripts.dev).toBe("arkor dev");
    expect(scripts.start).toBe("arkor start");
    const devDeps = patched.devDependencies as Record<string, string>;
    expect(devDeps.arkor).toBe("^0.0.1-alpha.9");

    const pkgEntry = files.find((f) => f.path === "package.json");
    expect(pkgEntry?.action).toBe("patched");
  });

  // Round 36 (PR #99 — CI runs 25349847532, 25351227697): pnpm 11
  // refuses postinstall scripts unless the project allow- or
  // deny-lists the dep, exiting with `ERR_PNPM_IGNORED_BUILDS` and
  // code 1. esbuild's postinstall is unnecessary in normal use —
  // pnpm already installs `@esbuild/<platform>` as an optional dep
  // — so the scaffolded default is `esbuild: false` (explicit
  // deny). That silences pnpm 11 without granting esbuild the
  // right to execute code at install time. Users who genuinely
  // need the postinstall (rare) can flip the entry to `true`.
  //
  // The first attempt wrote `package.json#pnpm.onlyBuiltDependencies`
  // — that works on pnpm 9/10 but pnpm 11 silently ignores the
  // package.json field; the allow-list moved to
  // `pnpm-workspace.yaml#allowBuilds`. These tests pin the
  // pnpm-workspace.yaml shape so a future refactor that regresses
  // back to the package.json approach (or silently flips deny to
  // allow) trips a unit test rather than re-breaking pnpm-11 CI.
  //
  // pnpm 9 *requires* `packages:` to be present whenever
  // `pnpm-workspace.yaml` exists or it errors "packages field
  // missing or empty" — hence the empty list. pnpm 10/11 accept the
  // file without `packages:` but tolerate `[]`. yarn / npm / bun
  // do not read the file.
  it("emits pnpm-workspace.yaml with packages:[] + allowBuilds esbuild=false (deny by default)", async () => {
    await scaffold({ cwd, name: "fresh", template: "triage" });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("packages: []");
    // Deny — supply-chain default is "do not run install scripts".
    expect(yaml).toMatch(/allowBuilds:\n[ \t]+esbuild:[ \t]+false/);
    expect(yaml).not.toMatch(/esbuild:[ \t]+true/);
    // package.json no longer carries the legacy `pnpm` field — it
    // had no effect on pnpm 11 anyway, and keeping a no-op there
    // would muddy the "single source of truth" story.
    const pkg = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.pnpm).toBeUndefined();
  });

  it("preserves an existing user-set esbuild=true allow (does not silently flip to deny)", async () => {
    // A user who explicitly opted INTO running esbuild's postinstall
    // (perhaps because they hit a binary-resolution edge case)
    // must keep their setting. Re-running the scaffold mustn't
    // override a deliberate `true` back to `false`.
    const original = `packages:\n  - "packages/*"\nallowBuilds:\n  esbuild: true\n  sharp: true\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({ cwd, name: "ignored", template: "triage" });
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(original);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("ok");
  });

  it("preserves an existing user-set esbuild=false deny (idempotent on re-run)", async () => {
    // Re-running the scaffold against its own previous output must
    // be a no-op — otherwise we'd churn the file on every `arkor
    // init` into an existing project.
    const original = `packages: []\nallowBuilds:\n  esbuild: false\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({ cwd, name: "ignored", template: "triage" });
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(original);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("ok");
  });

  it("appends esbuild=false into an existing block-form allowBuilds without dropping user entries", async () => {
    // User already has a workspace with their own native dep
    // allow-listed. The scaffold must merge `esbuild: false` in
    // without rewriting the rest of the block.
    const original = `packages:\n  - "packages/*"\nallowBuilds:\n  sharp: true\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({ cwd, name: "ignored", template: "triage" });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("sharp: true");
    expect(yaml).toContain("esbuild: false");
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("patched");
  });

  it("appends esbuild=false into an existing inline-form allowBuilds without rewriting siblings", async () => {
    // `pnpm approve-builds` writes the block form, but a user might
    // have hand-written the inline-mapping shape. Both must merge
    // safely.
    const original = `packages:\n  - "packages/*"\nallowBuilds: { sharp: true }\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({ cwd, name: "ignored", template: "triage" });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("sharp: true");
    expect(yaml).toContain("esbuild: false");
  });

  // Round 39 (Codex P2, PR #99): the inline-key reader used an
  // unbounded match for the package name, so `myesbuild: false`
  // would falsely satisfy the `esbuild` lookup and skip the
  // patch — leaving pnpm 11 to keep erroring on the real
  // (missing) `esbuild` entry. Anchor the lookup at a
  // mapping-start boundary (`{`, `,`, whitespace, or string
  // start) so substring keys aren't a false positive.
  it("does not treat `myesbuild` as a pinned `esbuild` in inline form", async () => {
    const original =
      `packages: []\nallowBuilds: { myesbuild: false }\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("myesbuild: false");
    expect(yaml).toContain("esbuild: false");
    // The merge keeps the `myesbuild` sibling and ADDS `esbuild`.
    expect(yaml).toMatch(/myesbuild: false, esbuild: false/);
  });

  // Round 39 (Codex P2, PR #99): hand-written
  // `allowBuilds: { sharp: true, }` with a trailing comma
  // would otherwise produce `sharp: true,, esbuild: false`
  // after the merge — invalid YAML pnpm rejects on parse. The
  // inline writer now strips a trailing comma (with optional
  // whitespace) before joining.
  it("strips a trailing comma in inline form before appending esbuild", async () => {
    const original =
      `packages: []\nallowBuilds: { sharp: true, }\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    // No double-comma in the merged output.
    expect(yaml).not.toContain(",,");
    expect(yaml).toContain("sharp: true, esbuild: false");
  });

  it("appends a fresh allowBuilds block to a pnpm-workspace.yaml that has none", async () => {
    // A workspace declared without any allowBuilds yet (e.g. on
    // pnpm 9 where the field is unused) — append the whole block
    // rather than trying to splice into a non-existent header.
    const original = `packages:\n  - "packages/*"\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({ cwd, name: "ignored", template: "triage" });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toMatch(/allowBuilds:\n[ \t]+esbuild:[ \t]+false/);
    expect(yaml).toContain('packages:\n  - "packages/*"');
  });

  // Round 39 (Copilot, PR #99): hand-edited pnpm-workspace.yaml
  // files often omit the trailing newline. The block-form
  // matcher in `appendEsbuildToAllowBuilds` requires `\r?\n`
  // after the header AND each body line, so the last entry
  // (`  sharp: true<EOF>`) would otherwise slip past the body
  // capture and the function would fall through to "no
  // allowBuilds at all" — appending a duplicate top-level
  // `allowBuilds:` block. The fix normalizes the input by
  // appending a newline if missing.
  it("merges esbuild into an existing allowBuilds block when the file lacks a trailing newline", async () => {
    const original =
      `packages: []\nallowBuilds:\n  sharp: true`; // no trailing \n
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("sharp: true");
    expect(yaml).toContain("esbuild: false");
    // Critical: only ONE top-level `allowBuilds:` key. Without
    // the trailing-newline normalization, the fallback would
    // append a second block.
    expect(yaml.match(/^allowBuilds:/gm)).toHaveLength(1);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("patched");
  });

  it("appends a fresh allowBuilds block when the file lacks a trailing newline and has no allowBuilds yet", async () => {
    const original = `packages: []`; // no trailing \n, no allowBuilds
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toMatch(/^allowBuilds:\n[ \t]+esbuild:[ \t]+false/m);
    // Original packages: [] line is intact and properly
    // separated from the new block by the normalizing newline.
    expect(yaml).toMatch(/^packages: \[\]\nallowBuilds:/m);
  });

  // `--allow-builds` opts users into running esbuild's postinstall.
  // The flag is plumbed through to `ScaffoldOptions.allowBuilds` and
  // flips the scaffolded value `false` → `true`. Pinning these
  // fresh-create + patch behaviours stops a future refactor from
  // silently breaking the opt-in path.
  it("emits allowBuilds esbuild=true on a fresh scaffold when --allow-builds is set", async () => {
    await scaffold({ cwd, name: "fresh", template: "triage", allowBuilds: true });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toMatch(/allowBuilds:\n[ \t]+esbuild:[ \t]+true/);
    expect(yaml).not.toMatch(/esbuild:[ \t]+false/);
  });

  it("appends esbuild=true into an existing block-form allowBuilds when --allow-builds is set", async () => {
    const original = `packages:\n  - "packages/*"\nallowBuilds:\n  sharp: true\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({ cwd, name: "ignored", template: "triage", allowBuilds: true });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("sharp: true");
    expect(yaml).toContain("esbuild: true");
  });

  it("preserves a user-set esbuild=false even when --allow-builds is passed", async () => {
    // The flag tells the scaffold what default to write, but never
    // overrides an explicit user pin — silently flipping false →
    // true would change the install-time threat model.
    const original = `packages: []\nallowBuilds:\n  esbuild: false\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      allowBuilds: true,
    });
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(original);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("ok");
  });

  // Round 37 (PR #99 — multi-reviewer P1: Codex + Copilot 2x):
  // dropping a fresh `pnpm-workspace.yaml` with `packages: []`
  // into a subdirectory of an EXISTING pnpm monorepo would
  // shadow the parent workspace root, so subsequent
  // `pnpm install` would stop resolving `workspace:*` deps from
  // the parent (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`). The scaffold
  // walks ancestors via `hasEnclosingPath` and skips creation in
  // that case. Patching a file the user already has at cwd is
  // still allowed — we only ever ADD esbuild to their existing
  // allow-list, never reroute the workspace root.
  it("does not create pnpm-workspace.yaml when an ancestor directory already has one", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-monorepo-"));
    writeFileSync(
      join(parent, "pnpm-workspace.yaml"),
      `packages:\n  - "packages/*"\n`,
    );
    const sub = join(parent, "packages", "new-pkg");
    mkdirSync(sub, { recursive: true });
    try {
      const { files } = await scaffold({
        cwd: sub,
        name: "new-pkg",
        template: "triage",
        packageManager: "pnpm",
      });
      expect(existsSync(join(sub, "pnpm-workspace.yaml"))).toBe(false);
      const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
      expect(entry).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // Round 39 (Codex P2): the previous 20-iteration cap on the
  // ancestor walk was misclassifying real deep-monorepo subdirs
  // as having no enclosing workspace, which would then create a
  // nested `pnpm-workspace.yaml` and shadow the actual root.
  // Walk to filesystem root (until `dirname()` returns the same
  // path) and trust that to terminate.
  it("finds an ancestor pnpm-workspace.yaml at depth > 20", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-deep-monorepo-"));
    writeFileSync(
      join(parent, "pnpm-workspace.yaml"),
      `packages:\n  - "packages/**"\n`,
    );
    // 25 nested dir levels under the parent — well past the
    // previous 20-level cap.
    const segments = Array.from({ length: 25 }, (_, i) => `lvl${i}`);
    const sub = join(parent, ...segments, "new-pkg");
    mkdirSync(sub, { recursive: true });
    try {
      const { files } = await scaffold({
        cwd: sub,
        name: "new-pkg",
        template: "triage",
        packageManager: "pnpm",
      });
      // Ancestor was found, so we DID NOT create a nested workspace yaml.
      expect(existsSync(join(sub, "pnpm-workspace.yaml"))).toBe(false);
      const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
      expect(entry).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not create pnpm-workspace.yaml when scaffolding into a non-empty existing project with no pm hint", async () => {
    // Mirror of the yarn-config rule: when pm is undetected AND
    // the dir already has content, treat it as someone else's
    // project and don't drop in workspace-level config.
    writeFileSync(join(cwd, "README.md"), "# pre-existing\n");
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
    });
    expect(existsSync(join(cwd, "pnpm-workspace.yaml"))).toBe(false);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry).toBeUndefined();
  });

  it("does not create pnpm-workspace.yaml when the user explicitly picked a non-pnpm package manager", async () => {
    // `--use-npm` / `--use-yarn` / `--use-bun` users don't need
    // pnpm config, and writing one anyway noises up their tree.
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "npm",
    });
    expect(existsSync(join(cwd, "pnpm-workspace.yaml"))).toBe(false);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry).toBeUndefined();
  });

  it("ignores nested allowBuilds keys (only top-level governs pnpm 11)", async () => {
    // pnpm 11 only consults the *top-level* `allowBuilds` key. A
    // nested mapping under another field is not honoured by pnpm,
    // so the scaffold must not be fooled into reporting "patched"
    // (which would leave `pnpm install` still erroring) or into
    // mutating that nested key (which would corrupt the user's
    // unrelated config without fixing the actual problem).
    const original = `packages: []\nsomeOtherKey:\n  allowBuilds:\n    esbuild: true\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    // The nested entry is left untouched.
    expect(yaml).toContain("someOtherKey:\n  allowBuilds:\n    esbuild: true");
    // A top-level `allowBuilds:` block is appended (deny by default).
    expect(yaml).toMatch(/^allowBuilds:\n[ \t]+esbuild:[ \t]+false/m);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("patched");
  });

  it("preserves a top-level scalar allowBuilds pin (does not append a duplicate sibling)", async () => {
    // `allowBuilds: false` (top-level scalar) is pnpm's "deny all"
    // global pin. Appending a fresh `allowBuilds:` block alongside
    // would yield two top-level keys — invalid/ambiguous YAML.
    // The scaffold must observe the scalar and bow out as `ok`.
    const original = `packages: []\nallowBuilds: false\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(original);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("ok");
  });

  // Round 38 (Codex P1): CRLF input must round-trip without
  // double-writing `allowBuilds:` (the patch regex previously
  // hard-coded `\n` and a Windows-checked-in workspace yaml fell
  // through to the "no allowBuilds at all" fallback even when one
  // was present).
  it("handles CRLF line endings when patching an existing block-form allowBuilds", async () => {
    const original =
      `packages: []\r\nallowBuilds:\r\n  sharp: true\r\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    // No duplicate top-level allowBuilds key: should still match
    // exactly once with `^allowBuilds:` anchored to column 0.
    expect(yaml.match(/^allowBuilds:/gm)).toHaveLength(1);
    expect(yaml).toContain("sharp: true");
    expect(yaml).toContain("esbuild: false");
    // Output should preserve CRLF — no LF-only newlines introduced.
    expect(yaml).not.toMatch(/[^\r]\n/);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("patched");
  });

  it("recognises esbuild already pinned even with a trailing YAML comment", async () => {
    // `esbuild: false # documented` is valid YAML and pnpm treats
    // it as a per-key pin. The reader must respect the user's
    // decision; otherwise the patcher would append a duplicate
    // entry under the same allowBuilds block.
    const original =
      `packages: []\nallowBuilds:\n  esbuild: false # documented deny\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(original);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("ok");
  });

  it("recognises top-level scalar allowBuilds with a trailing YAML comment", async () => {
    // Same comment-tolerance requirement for the global scalar
    // form. A duplicate `allowBuilds:` key would silently change
    // install policy if we didn't see this as a pin.
    const original = `packages: []\nallowBuilds: false # global pin\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(original);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("ok");
  });

  it("backfills packages:[] when patching a pnpm-workspace.yaml that omits it", async () => {
    // pnpm 9 errors "packages field missing or empty" whenever
    // pnpm-workspace.yaml exists without `packages:`. The patch
    // path must fix that for cross-version compatibility, even
    // when allowBuilds is already set up correctly.
    const original = `allowBuilds:\n  esbuild: false\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toMatch(/^packages:[ \t]*\[\]/m);
    expect(yaml).toContain("esbuild: false");
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("patched");
  });

  // Round 39 (Codex P1): `prependPackagesEmptyList` used to slap
  // `packages: []` at byte 0. If the existing file opened with a
  // YAML document marker (`---\n…`) or a `%YAML 1.2` directive,
  // that produced a multi-document stream which pnpm rejects with
  // "expected a single document". The fix walks past leading
  // directives, document markers, comments and blank lines so the
  // backfill lands inside the first document.
  it("backfills packages:[] AFTER a leading YAML document marker", async () => {
    const original = `---\nallowBuilds:\n  esbuild: false\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    // Marker stays on line 1, packages: [] is inserted after it.
    expect(yaml.startsWith("---\n")).toBe(true);
    expect(yaml).toMatch(/^---\npackages:[ \t]*\[\]/m);
    // Still exactly one document (no bare `packages:` before `---`).
    expect(yaml.match(/^---/gm)).toHaveLength(1);
  });

  it("backfills packages:[] AFTER a leading %YAML directive", async () => {
    const original = `%YAML 1.2\n---\nallowBuilds:\n  esbuild: false\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml.startsWith("%YAML 1.2\n---\n")).toBe(true);
    expect(yaml).toContain("packages: []");
    // Directive + marker still come first, then the synthetic
    // `packages: []` — one document, not two.
    expect(yaml.match(/^---/gm)).toHaveLength(1);
  });

  it("backfills packages:[] AFTER a leading comment header (preserves user note)", async () => {
    const original = `# pnpm config for the foo project\nallowBuilds:\n  esbuild: false\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    // Comment stays at the very top.
    expect(yaml.startsWith("# pnpm config for the foo project\n")).toBe(true);
    expect(yaml).toContain("packages: []");
  });

  // Round 39 (Copilot review): inline-form `allowBuilds: { ... }`
  // with a trailing YAML comment must keep the comment on patch.
  // The previous regex replacement rewrote the whole line and
  // silently dropped any post-`}` text, throwing away user-
  // authored explanation of build-script policy.
  it("preserves a trailing YAML comment on an inline-form allowBuilds when patching", async () => {
    const original =
      `packages: []\nallowBuilds: { sharp: true } # native deps approved\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("# native deps approved");
    expect(yaml).toContain("sharp: true");
    expect(yaml).toContain("esbuild: false");
    // Still exactly one top-level allowBuilds.
    expect(yaml.match(/^allowBuilds:/gm)).toHaveLength(1);
  });

  it("preserves a trailing YAML comment on a block-form allowBuilds header when patching", async () => {
    // The block-header path also needs to keep an explanatory
    // comment that lives on the `allowBuilds:` line itself.
    const original =
      `packages: []\nallowBuilds: # native deps approved\n  sharp: true\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("allowBuilds: # native deps approved");
    expect(yaml).toContain("sharp: true");
    expect(yaml).toContain("esbuild: false");
  });

  // Round 39 (Copilot review): YAML allows the document root to
  // be indented. A file like `  packages: []\n  allowBuilds:\n
  // esbuild: true` is valid, but the previous column-0 anchors
  // misread it as missing both keys, so the patcher prepended a
  // duplicate `packages:` and appended a duplicate `allowBuilds:`.
  // The reader/writer now anchor at the detected document-root
  // indent (mirroring `readNodeLinkerValue`).
  it("respects an indented document root when reading allowBuilds (does not double-write)", async () => {
    const original =
      `  packages: []\n  allowBuilds:\n    esbuild: true\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    // esbuild already pinned at root → no edit needed.
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(original);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("ok");
  });

  it("appends esbuild at the indented document root when patching such a file", async () => {
    // Same indented-root file but with esbuild missing from the
    // existing allowBuilds block. The new entry must use the same
    // body indent as the existing one (4 spaces here), and we must
    // NOT introduce a column-0 duplicate.
    const original =
      `  packages: []\n  allowBuilds:\n    sharp: true\n`;
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), original);
    const { files } = await scaffold({
      cwd,
      name: "ignored",
      template: "triage",
      packageManager: "pnpm",
    });
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("    sharp: true");
    expect(yaml).toContain("    esbuild: false");
    // No column-0 keys leaked in.
    expect(yaml).not.toMatch(/^packages:/m);
    expect(yaml).not.toMatch(/^allowBuilds:/m);
    const entry = files.find((f) => f.path === "pnpm-workspace.yaml");
    expect(entry?.action).toBe("patched");
  });

  // Round 38 (Codex P2): an ancestor `.yarnrc.yml` with
  // `nodeLinker: node-modules` is the safe case the berry caveat
  // is supposed to nudge users toward — the install runs without
  // PnP, and the arkor runtime can resolve modules normally. The
  // scaffold must NOT raise the caveat or set blockInstall in
  // that case, even when the local cwd looks like a yarn-berry
  // descendant (ancestor yarnrc + ancestor `.yarn/`).
  it("does not raise the berry caveat when an ancestor .yarnrc.yml pins nodeLinker: node-modules", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-yarn-safe-"));
    writeFileSync(
      join(parent, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );
    const sub = join(parent, "packages", "new-pkg");
    mkdirSync(sub, { recursive: true });
    try {
      const { warnings, blockInstall } = await scaffold({
        cwd: sub,
        name: "new-pkg",
        template: "triage",
        packageManager: "yarn",
      });
      expect(warnings).toEqual([]);
      expect(blockInstall).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // Round 39 (Copilot, PR #99): cwd's own `.yarnrc.yml` has no
  // `nodeLinker:` key, but yarn merges configs up the tree —
  // a parent yarnrc pinning `nodeLinker: node-modules` IS the
  // effective linker for cwd, so the bootstrap is safe and no
  // caveat / blockInstall should fire. The earlier helper bailed
  // at the first existing yarnrc and treated "found but no
  // nodeLinker" as `undefined`, raising a false-positive caveat
  // for this common monorepo layout.
  it("respects merged yarnrc nodeLinker: cwd has yarnrc without key, ancestor pins node-modules", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-yarn-merged-"));
    writeFileSync(
      join(parent, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );
    const sub = join(parent, "packages", "new-pkg");
    mkdirSync(sub, { recursive: true });
    // Pre-existing project content (so isExistingProject=true) +
    // a cwd-local `.yarnrc.yml` WITHOUT `nodeLinker:`. This is
    // the `kept + needsBerryCaveat` shape on the patch path.
    writeFileSync(join(sub, "README.md"), "# pre-existing\n");
    writeFileSync(
      join(sub, ".yarnrc.yml"),
      "# cache config but no linker\nenableImmutableCache: true\n",
    );
    try {
      const { warnings, blockInstall } = await scaffold({
        cwd: sub,
        name: "new-pkg",
        template: "triage",
        packageManager: "yarn",
      });
      expect(warnings).toEqual([]);
      expect(blockInstall).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // Same merged-config logic but on the inspect-only path:
  // pm undefined, existing project, cwd has yarnrc without
  // nodeLinker. The `berry-without-linker` branch must consult
  // the merged effective value before raising the caveat.
  it("inspect path: merged ancestor nodeLinker: node-modules suppresses the berry-without-linker caveat", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-yarn-inspect-"));
    writeFileSync(
      join(parent, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );
    const sub = join(parent, "packages", "new-pkg");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "README.md"), "# pre-existing\n");
    writeFileSync(
      join(sub, ".yarnrc.yml"),
      "enableImmutableCache: true\n",
    );
    try {
      const { warnings, blockInstall } = await scaffold({
        cwd: sub,
        name: "new-pkg",
        template: "triage",
        // pm undefined → inspect-only path runs.
      });
      expect(warnings).toEqual([]);
      expect(blockInstall).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("appends to an existing .gitignore only if the entry is missing", async () => {
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    const first = await scaffold({ cwd, name: "n", template: "triage" });
    const firstEntry = first.files.find((f) => f.path === ".gitignore");
    expect(firstEntry?.action).toBe("patched");
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toContain(".arkor/");

    const second = await scaffold({ cwd, name: "n", template: "triage" });
    const secondEntry = second.files.find((f) => f.path === ".gitignore");
    expect(secondEntry?.action).toBe("ok");
  });

  it("inserts a separating newline when the existing .gitignore lacks a trailing newline", async () => {
    // Without the `endsWith("\n") ? "" : "\n"` separator, the patched
    // file would smash the previous last line into the appended
    // entry — e.g. `node_modules/.arkor/`, which git would interpret
    // as a single path pattern. Round 16 (Copilot, PR #99) tightened
    // the patch path to ONLY append `.arkor/`: `node_modules/`,
    // `dist/`, and the yarn-cache lines are no longer added to a
    // pre-existing `.gitignore` (existing repos may intentionally
    // track build output under `dist/`, etc).
    writeFileSync(join(cwd, ".gitignore"), "node_modules/");
    await scaffold({ cwd, name: "n", template: "triage" });
    const contents = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(contents).toBe("node_modules/\n.arkor/\n");
  });

  // yarn-berry defaults to Plug'n'Play, which doesn't materialise
  // node_modules — and the arkor runtime (esbuild → `node ./.arkor/build/
  // index.mjs`) doesn't load PnP, so a vanilla yarn-4 install would leave
  // `arkor dev` unable to resolve dependencies. The scaffold writes a
  // `.yarnrc.yml` pinning `nodeLinker: node-modules` whenever the user
  // picked yarn; yarn 1.x ignores `.yarnrc.yml` (it reads `.yarnrc`), so
  // the file is harmless on the classic line.
  it("emits .yarnrc.yml with nodeLinker:node-modules when packageManager is yarn", async () => {
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("created");
    expect(readFileSync(join(cwd, ".yarnrc.yml"), "utf8")).toContain(
      "nodeLinker: node-modules",
    );
  });

  // Existing `.yarnrc.yml` with no `nodeLinker:` line — yarn 4 would
  // silently fall back to PnP, breaking the arkor runtime. Scaffold
  // must append `nodeLinker: node-modules` while preserving the
  // user's other settings (Copilot review on PR #99).
  // Pre-round-15 this test asserted "patched" via an append. Under
  // the round-15 `isExistingProject` predicate (= cwd is non-empty
  // before scaffold writes), pre-seeding `.yarnrc.yml` flips the
  // dir to existing-project, so the patch path now bows out with
  // `kept + needsBerryCaveat` instead of mutating the file.
  // Workspace-mutation policy wins over the missing-`nodeLinker:`
  // append; the caveat tells the user what to add themselves.
  // (The round-12 `insertNodeLinkerIntoYarnrc` helper that handled
  // YAML terminators / indented root mappings became unreachable
  // when round 15 closed this branch and was removed alongside.)
  it("does NOT mutate an existing .yarnrc.yml that lacks nodeLinker — surfaces the caveat", async () => {
    const yarnrcContent = "yarnPath: .yarn/releases/yarn-4.x.cjs\n";
    writeFileSync(join(cwd, ".yarnrc.yml"), yarnrcContent);
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("kept");
    // File is unchanged — the user's existing config wins.
    expect(readFileSync(join(cwd, ".yarnrc.yml"), "utf8")).toBe(yarnrcContent);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 4\+|yarn-berry/);
  });

  // Round 14 #1 (Copilot, PR #99): even with an explicit
  // `--use-yarn`, don't drop a brand-new `.yarnrc.yml` into a
  // pre-existing project. The surrounding workspace might be a
  // yarn-berry repo deliberately on its PnP default; writing
  // `nodeLinker: node-modules` would flip the install mode for
  // the entire repo. Surface the same yarn-berry caveat the
  // inspect path uses, but from the explicit-yarn arm.
  //
  // Round 20 (Copilot, PR #99): the caveat-fire condition is
  // gated on positive yarn-berry signal — `.yarnrc.yml` on disk
  // OR a corepack-style `packageManager: "yarn@2+"` declaration.
  // Without one of those, `--use-yarn` could mean yarn 1.x,
  // which doesn't read `.yarnrc.yml` and would install fine.
  // The fixture below declares yarn@4 to satisfy the gate.
  it("does NOT create .yarnrc.yml in --use-yarn + existing-project + no-yarnrc + yarn-berry signal — surfaces caveat instead", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify(
        { name: "existing", private: true, packageManager: "yarn@4.6.0" },
        null,
        2,
      ),
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    // Round 18 (Copilot, PR #99): when patchYarnConfig declines to
    // create the file in the existing-project case, scaffold must
    // NOT record a `.yarnrc.yml` entry in `files[]`. Both CLIs
    // print files verbatim in the "Files" note, so an entry here
    // would surface "kept .yarnrc.yml" for a file that doesn't
    // exist — confusing the user about repo state.
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc).toBeUndefined();
    expect(existsSync(join(cwd, ".yarnrc.yml"))).toBe(false);
    // The caveat IS surfaced (positive yarn-berry signal gates it).
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 4\+|yarn-berry/);
    expect(result.warnings[0]).toContain("nodeLinker: node-modules");
    expect(result.blockInstall).toBe(true);
  });

  // Round 33 (Copilot, PR #99) — final settle on the
  // detection-undefined trade-off (round 31 ↔ 32 ↔ 33): when
  // `--use-yarn` is passed, none of the on-disk signals are
  // present, AND `detectYarnMajor()` returns `undefined`
  // (yarn not on PATH / exec error / 5s timeout), DON'T fire
  // the caveat. The probe-failure modes (yarn missing,
  // corepack blocked by a non-yarn `packageManager`,
  // etc.) don't share a fix with the PnP hazard, so telling
  // the user to edit `.yarnrc.yml` would mislead them away
  // from the actual problem. Round 32 had tried fail-closed
  // here; round 33 pushed back. Install still runs, and any
  // real yarn issue surfaces with yarn's own diagnostic.
  //
  // The default mock for `detectYarnMajor` returns `undefined`,
  // so this test exercises the fall-through path without an
  // explicit override.
  it("does NOT fire the caveat in --use-yarn + existing-project + no signal + detection-undefined", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    // Round-14 policy: no `.yarnrc.yml` written.
    expect(existsSync(join(cwd, ".yarnrc.yml"))).toBe(false);
    expect(result.files.find((f) => f.path === ".yarnrc.yml")).toBeUndefined();
    // Probe couldn't confirm yarn 2+, no caveat. install runs;
    // any actual yarn issue (missing binary, corepack block)
    // surfaces with its own diagnostic.
    expect(result.warnings).toEqual([]);
    expect(result.blockInstall).toBe(false);
  });

  // Round 29 cont'd: `.yarn/` directory existence is a positive
  // signal even without `.yarnrc.yml` or a corepack declaration
  // — yarn 1 doesn't create that tree, so an existing `.yarn/`
  // dir means the user is on yarn-berry. Pin the contract so a
  // future tightening of the gate doesn't drop this signal.
  it("DOES fire the caveat in --use-yarn + existing-project when only `.yarn/` dir signals yarn-berry", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    // Just an empty `.yarn/` dir — common in yarn-berry repos
    // that haven't yet committed `.yarnrc.yml` (e.g. mid-bootstrap)
    // but already pinned a yarn release under `.yarn/releases/`.
    mkdirSync(join(cwd, ".yarn"));
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 2\+|yarn-berry/);
    expect(result.blockInstall).toBe(true);
  });

  // Round 34 (Copilot, PR #99): yarn itself walks up for
  // `.yarnrc.yml` and `.yarn/` during resolution — the workspace
  // root's config governs descendant packages. The cwd-only
  // signal check missed monorepo-subdir scaffolds (e.g.
  // `monorepo/packages/new-pkg`) whose root pins the yarn-berry
  // config. Now `hasEnclosingPath` walks up the tree.
  it("DOES fire the caveat for a monorepo-subdir --use-yarn scaffold whose ancestor has `.yarnrc.yml`", async () => {
    // Build: root has `.yarnrc.yml`, run scaffold in
    // `root/packages/new-pkg`.
    const subdir = join(cwd, "packages", "new-pkg");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(
      join(cwd, ".yarnrc.yml"),
      "yarnPath: .yarn/releases/yarn-4.x.cjs\n",
    );
    // Pre-seed something in subdir so isExistingProject=true
    // (round 15 widened predicate).
    writeFileSync(join(subdir, "README.md"), "# my package\n");
    const result = await scaffold({
      cwd: subdir,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 2\+|yarn-berry/);
    expect(result.blockInstall).toBe(true);
  });

  it("DOES fire the caveat for a monorepo-subdir --use-yarn scaffold whose ancestor has `.yarn/` dir", async () => {
    // Same shape but root has `.yarn/` instead of `.yarnrc.yml`.
    const subdir = join(cwd, "packages", "new-pkg");
    mkdirSync(subdir, { recursive: true });
    mkdirSync(join(cwd, ".yarn"));
    writeFileSync(join(subdir, "README.md"), "# my package\n");
    const result = await scaffold({
      cwd: subdir,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 2\+|yarn-berry/);
    expect(result.blockInstall).toBe(true);
  });

  // Mirror round-34 walk-up coverage on the inspect path
  // (`pm === undefined && isExistingProject`). The `no-config`
  // branch returns when cwd has no `.yarnrc.yml`; before round
  // 34 it then only checked the corepack declaration and the
  // local `.yarn/`, missing monorepo subdirs.
  it("inspect path: monorepo-subdir scaffold without packageManager fires caveat when ancestor has `.yarnrc.yml`", async () => {
    const subdir = join(cwd, "packages", "new-pkg");
    mkdirSync(subdir, { recursive: true });
    // Ancestor has `.yarnrc.yml` (no nodeLinker line, plain
    // yarn-berry pin).
    writeFileSync(
      join(cwd, ".yarnrc.yml"),
      "yarnPath: .yarn/releases/yarn-4.x.cjs\n",
    );
    // Pre-existing package.json in subdir but NO `packageManager`
    // field — without round 34's tree walk, this path saw
    // `no-config` (no local yarnrc) + no corepack declaration
    // and stayed silent.
    writeFileSync(
      join(subdir, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    const result = await scaffold({
      cwd: subdir,
      name: "n",
      template: "triage",
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 2\+|yarn-berry/);
    expect(result.blockInstall).toBe(true);
  });

  // Round 30 (Copilot, PR #99): the round-29 documented gap (yarn
  // 4 fresh bootstrap into existing dir with no on-disk signals
  // and no corepack declaration) was unacceptable because it left
  // a real silent break for that population. Resolution: layered
  // gate's last step shells out to `yarn --version` and treats
  // a yarn 2+ result as positive berry signal. Three new test
  // cases lock down the behaviour the helper enables, with
  // `vi.mocked(detectYarnMajor)` controlling the simulated
  // version per test:
  //
  //   - yarn 4 detected → caveat fires (the round-30 protection)
  //   - yarn 1 detected → no caveat (yarn 1 friendliness preserved)
  //   - detection returns undefined (yarn not on PATH / errored
  //     out) → no caveat (safe yarn-1-friendly default)
  it("DOES fire the caveat when only the runtime `yarn --version` signals yarn-berry (yarn 4 fresh bootstrap)", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    // No yarnrc, no .yarn/, no corepack declaration — the
    // documented round-29 gap. Runtime detection now closes it.
    vi.mocked(detectYarnMajor).mockResolvedValueOnce(4);
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 2\+|yarn-berry/);
    expect(result.blockInstall).toBe(true);
  });

  it("does NOT fire the caveat when the runtime `yarn --version` reports yarn 1 (yarn 1 friendliness)", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    vi.mocked(detectYarnMajor).mockResolvedValueOnce(1);
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    // yarn 1 ignores `.yarnrc.yml` so install would work — no caveat.
    expect(result.warnings).toEqual([]);
    expect(result.blockInstall).toBe(false);
  });

  it("does NOT fire the caveat when detection returns undefined (yarn not on PATH / exec error)", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    // Round 33 (Copilot, PR #99): probe-undefined falls through
    // to "no positive signal" and install runs. Probe-failure
    // causes (yarn missing, corepack blocked, subprocess error)
    // don't share a fix with the PnP hazard, so firing the
    // `nodeLinker:` caveat would mislead users whose actual
    // failure mode is something else.
    vi.mocked(detectYarnMajor).mockResolvedValueOnce(undefined);
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    expect(result.warnings).toEqual([]);
    expect(result.blockInstall).toBe(false);
  });

  // Round 14 #1 cont'd: same policy when the existing
  // `.yarnrc.yml` lacks a `nodeLinker:` key. The absence is itself
  // a deliberate PnP choice in an existing yarn-berry workspace —
  // appending would flip the install mode just as if we'd created
  // the file from scratch.
  it("does NOT append nodeLinker:node-modules in --use-yarn + existing-project + yarnrc-without-linker — surfaces caveat instead", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    const yarnrcContent = "yarnPath: .yarn/releases/yarn-4.x.cjs\n";
    writeFileSync(join(cwd, ".yarnrc.yml"), yarnrcContent);
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    // Counterpart to the no-yarnrc test above: HERE the
    // `.yarnrc.yml` does exist on disk (we declined to mutate it,
    // not to create it), so the round-18 phantom-entry guard does
    // NOT fire — the `kept` entry IS legitimate. Pin that down so
    // a future tightening of the existsSync check doesn't drop
    // the entry for the existing-but-unmodified case.
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("kept");
    // File untouched.
    expect(readFileSync(join(cwd, ".yarnrc.yml"), "utf8")).toBe(yarnrcContent);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 4\+|yarn-berry/);
  });

  // Round 14 #2 (Copilot, PR #99): `--use-yarn` against an
  // existing project must NOT add `.yarn/cache` /
  // `.yarn/install-state.gz` to `.gitignore`. Yarn zero-install
  // setups *commit* `.yarn/cache/`; silently ignoring those
  // archives makes future cache zips drop out of git on every
  // dependency change. The user can add the entries themselves
  // if they want them.
  it("does NOT add yarn-cache lines to .gitignore in --use-yarn + existing-project (zero-install repos)", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain(".arkor/");
    expect(gi).not.toContain(".yarn/");
  });

  // Round 15 (Copilot, PR #99): `isExistingProject` used to be
  // inferred from `existsSync(package.json)`, but `scaffold()`
  // also supports merging into directories that aren't
  // bootstrapped yet — e.g. an existing git repo with just a
  // README, a monorepo sub-dir scaffolded for a new package.
  // Under the package.json predicate those got `false` and the
  // patch path would still write `.yarnrc.yml` + add yarn-cache
  // lines, reintroducing the workspace-mutation hazard rounds
  // 5/14 had closed for the package.json-bearing case. The
  // predicate is now "cwd has any pre-existing entries" — these
  // tests pin that down for a representative non-package.json
  // case (just a README, no package.json).
  it("treats a non-empty directory without package.json as existing-project (no yarnrc + no yarn-cache gitignore lines under --use-yarn)", async () => {
    // Pre-seed a single non-package.json file. Mirrors the
    // "existing git repo with just a README" scenario from the
    // round-15 review. The point of this test is round-15's
    // existing-project policy (no yarnrc, no `.yarn/` gitignore
    // lines), not the round-32 fail-closed gate — so simulate
    // a successful yarn 1 detection so the caveat path stays
    // dormant and we can assert on the file-side semantics
    // cleanly.
    writeFileSync(join(cwd, "README.md"), "# my project\n");
    vi.mocked(detectYarnMajor).mockResolvedValueOnce(1);
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    // .yarnrc.yml is NOT created (the surrounding repo might
    // deliberately be on yarn-berry's PnP default), and round 18
    // also drops the `kept` entry from `files[]` so the CLI's
    // "Files" note doesn't print a phantom line for a file that
    // doesn't exist.
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc).toBeUndefined();
    expect(existsSync(join(cwd, ".yarnrc.yml"))).toBe(false);
    // No caveat — yarn 1 detected, no yarn-berry signal, so the
    // gate stays open. (Round 32's fail-closed only fires when
    // detection returns undefined.)
    expect(result.warnings).toEqual([]);
    expect(result.blockInstall).toBe(false);
    // .gitignore does NOT get yarn-cache lines either — Yarn
    // zero-install setups commit `.yarn/cache/` and silently
    // ignoring those archives is the round-14 #2 hazard.
    const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain(".arkor/");
    expect(gi).not.toContain(".yarn/");
  });

  // Counterpart of the above: a TRULY empty cwd (just made by
  // mkdtempSync, nothing in it) should still be treated as fresh
  // — that's the create-arkor `pnpm create arkor my-app` flow
  // and we want the defensive `.yarnrc.yml` + gitignore yarn
  // entries to fire there. This guards against accidentally
  // tightening the predicate too far (e.g. treating `["."]` as
  // non-empty would break this).
  it("still treats a freshly-created empty directory as fresh (writes .yarnrc.yml + yarn-cache gitignore lines under --use-yarn)", async () => {
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("created");
    expect(readFileSync(join(cwd, ".yarnrc.yml"), "utf8")).toContain(
      "nodeLinker: node-modules",
    );
    const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain(".yarn/cache");
    expect(gi).toContain(".yarn/install-state.gz");
    // No caveat — the patch path actually mutated, no advisory needed.
    expect(result.warnings).toEqual([]);
  });

  // Round 14 #1 still has an explicit-conflict counterpart that
  // must keep working: `--use-yarn` + existing project + yarnrc
  // pinned to `nodeLinker: pnp` — the conflict path has always
  // been "kept + warning"; the new isExistingProject gate must
  // not interfere with it (the conflict branch returns before the
  // gate runs).
  it("still surfaces the conflict warning when --use-yarn + existing-project + yarnrc pins nodeLinker: pnp", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    writeFileSync(join(cwd, ".yarnrc.yml"), "nodeLinker: pnp\n");
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("kept");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nodeLinker: pnp");
  });

  // Round 16 #1 (Copilot, PR #99): the corepack-declaration
  // resolver used to read `cwd/package.json` AFTER
  // `patchPackageJson` had already created it for the no-local-
  // package.json case. Round 15's `isExistingProject` widening
  // exposed this for the "yarn-berry monorepo subdir without a
  // local package.json" case — the helper read the freshly-
  // scaffolded manifest (no `packageManager` field) and
  // suppressed the caveat even though `yarn install` resolves
  // through the parent workspace and hits the unsupported PnP
  // setup. The resolver now (a) snapshots the pre-patch local
  // declaration before patchPackageJson runs and (b) walks up
  // parent directories looking for the closest enclosing
  // declaration when the local snapshot is empty.
  it("surfaces the yarn-berry caveat when scaffolding into a subdir whose parent declares yarn 2+ via packageManager", async () => {
    // Set up: parent dir has `package.json` with
    // `packageManager: yarn@4.x`. cwd is a subdir under it with
    // some pre-existing files but no local package.json.
    const parent = mkdtempSync(join(tmpdir(), "cli-internal-parent-"));
    try {
      writeFileSync(
        join(parent, "package.json"),
        JSON.stringify(
          {
            name: "monorepo-root",
            private: true,
            packageManager: "yarn@4.6.0",
          },
          null,
          2,
        ),
      );
      const subdir = join(parent, "packages", "new-pkg");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(subdir, { recursive: true });
      // Pre-existing content in the subdir so isExistingProject
      // fires (round-15 predicate). No local package.json.
      writeFileSync(join(subdir, "README.md"), "# new pkg\n");
      const result = await scaffold({
        cwd: subdir,
        name: "n",
        template: "triage",
      });
      // Caveat surfaces — the parent's declaration was found via
      // the walk-up.
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/yarn 4\+|yarn-berry/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // Counterpart of the above: when the local package.json HAS a
  // declaration, the snapshot is what the resolver uses. This
  // test guards against patchPackageJson somehow stripping the
  // field on patch (it doesn't today, but pinning the contract
  // here means a future patchPackageJson refactor that strips
  // unknown top-level fields would still surface the caveat
  // correctly via the snapshot).
  it("uses the pre-patch packageManager snapshot when the local package.json declares yarn 2+", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify(
        { name: "existing", private: true, packageManager: "yarn@4.6.0" },
        null,
        2,
      ),
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 4\+|yarn-berry/);
  });

  // Round 16 #2 (Copilot, PR #99): `patchGitignore` used to
  // append every missing required entry (node_modules/, dist/,
  // .arkor/) to a pre-existing gitignore. That silently changed
  // ignore policy for repos that intentionally tracked build
  // output under `dist/` (publish forks, static-site deploy
  // branches, etc), making future generated artifacts disappear
  // from `git status` without the user opting in. Patch path
  // now ONLY adds `.arkor/`; node_modules/ + dist/ are left
  // alone.
  it("does NOT append node_modules/ or dist/ to a pre-existing .gitignore that lacks them", async () => {
    // Pre-existing .gitignore that neither ignores node_modules
    // nor dist (the realistic scenario: a repo that deliberately
    // tracks build output). After scaffold only `.arkor/` should
    // be added; the other two stay missing.
    writeFileSync(join(cwd, ".gitignore"), "secrets.env\n");
    await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(gi).toBe("secrets.env\n.arkor/\n");
  });

  // Counterpart: `node_modules/` and `dist/` STILL get written
  // when we're creating a fresh `.gitignore` (= no pre-existing
  // file). Establishes that round-16's tightening only narrows
  // the patch path, not the create path. The create-path baseline
  // matters because most fresh scaffolds genuinely want both
  // entries ignored.
  it("STILL writes node_modules/ + dist/ + .arkor/ when creating a fresh .gitignore in an existing project", async () => {
    // README.md only — cwd is non-empty (round-15 isExistingProject
    // fires) but no `.gitignore` exists, so the create path runs.
    writeFileSync(join(cwd, "README.md"), "# my project\n");
    await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain("dist/");
    expect(gi).toContain(".arkor/");
    // round 14 #2 still applies — yarn-cache lines stay out of
    // existing-project scaffolds even on the create path.
    expect(gi).not.toContain(".yarn/");
  });

  // Existing `.yarnrc.yml` that explicitly pins a non-`node-modules`
  // linker (here PnP). Earlier rounds of this PR auto-rewrote `pnp`
  // → `node-modules`, but Copilot's PR #99 review pushed back: both
  // CLIs intentionally support scaffolding into existing
  // directories, so silently flipping the install mode would
  // change repo-wide behaviour and could break unrelated packages
  // in a yarn-berry workspace. Policy: report `kept` and leave the
  // file alone — the user's explicit choice wins, and the runtime
  // mismatch is a problem they get to reconcile (or arkor's
  // runtime grows PnP support).
  it("keeps an existing .yarnrc.yml that explicitly pins a non-node-modules linker and surfaces a warning", async () => {
    writeFileSync(join(cwd, ".yarnrc.yml"), "nodeLinker: pnp\nfoo: bar\n");
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("kept");
    const contents = readFileSync(join(cwd, ".yarnrc.yml"), "utf8");
    expect(contents).toBe("nodeLinker: pnp\nfoo: bar\n");
    // Without a warning the user wouldn't know `arkor dev` is going
    // to fail later — Copilot's follow-up review on PR #99 pushed
    // back on the silent `kept`, so the scaffolder now surfaces the
    // conflict to the CLI for it to render.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nodeLinker: pnp");
    expect(result.warnings[0]).toMatch(/arkor dev/);
  });

  // Existing `.yarnrc.yml` that already pins the right linker — no
  // mutation, no fake "patched" log entry, no warning.
  it("reports ok when existing .yarnrc.yml already pins nodeLinker:node-modules", async () => {
    writeFileSync(
      join(cwd, ".yarnrc.yml"),
      "nodeLinker: node-modules\nfoo: bar\n",
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("ok");
    expect(result.warnings).toEqual([]);
  });

  // packageManager === undefined + fresh dir (no pre-existing
  // `package.json`) fires when neither `--use-*` was passed nor
  // `npm_config_user_agent` told us anything. The manual install
  // hint says "yarn / bun install", so a yarn-berry user lands here
  // — without a `.yarnrc.yml` they'd hit PnP and break the arkor
  // runtime (Copilot review on PR #99).
  it("emits .yarnrc.yml when packageManager is undefined and the project is fresh", async () => {
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("created");
    expect(readFileSync(join(cwd, ".yarnrc.yml"), "utf8")).toContain(
      "nodeLinker: node-modules",
    );
  });

  // Counterpart of the above: when scaffolding into a directory that
  // already has a `package.json`, the surrounding repo could be a
  // yarn-berry workspace deliberately on the PnP default. Without
  // an explicit `--use-yarn` we can't tell, so silently dropping a
  // `.yarnrc.yml` would flip the install mode for the entire repo
  // — Copilot's follow-up review on PR #99 flagged exactly this
  // foot-gun. Defer to the user instead.
  it("does NOT emit .yarnrc.yml when packageManager is undefined and the project already exists", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    expect(result.files.find((f) => f.path === ".yarnrc.yml")).toBeUndefined();
    expect(existsSync(join(cwd, ".yarnrc.yml"))).toBe(false);
  });

  // Counterpart-of-the-counterpart (PR #99 round 8): the
  // undefined-pm + existing-project skip path was eating the
  // conflict warning entirely. The file is still NOT mutated (the
  // round-5 policy stands — we won't flip the install mode of an
  // unknown surrounding workspace), but if the user later acts on
  // the manual-install hint and runs `yarn install` against an
  // existing `nodeLinker: pnp` setup, `arkor dev` will fail the
  // same way as in the explicit-yarn path. The advisory now
  // surfaces here too so the user gets a heads-up before they hit
  // the runtime mismatch.
  it("surfaces the nodeLinker conflict warning even when not mutating an existing .yarnrc.yml in the undefined-pm + existing-project flow", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    writeFileSync(join(cwd, ".yarnrc.yml"), "nodeLinker: pnp\nfoo: bar\n");
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    // Policy: still NOT in the files list (we deliberately don't
    // touch yarn config in this branch).
    expect(result.files.find((f) => f.path === ".yarnrc.yml")).toBeUndefined();
    // And the file on disk is unchanged.
    expect(readFileSync(join(cwd, ".yarnrc.yml"), "utf8")).toBe(
      "nodeLinker: pnp\nfoo: bar\n",
    );
    // But the advisory still reaches the CLI for it to render.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nodeLinker: pnp");
    expect(result.warnings[0]).toMatch(/arkor dev/);
  });

  // Round 9 (Copilot): when undefined-pm merges into an existing
  // project that has NO usable yarn config (no `.yarnrc.yml` at
  // all here), the round-5 policy stripped both the defensive
  // `.yarnrc.yml` write AND the yarn-cache `.gitignore` lines —
  // but the manual install hint still says "yarn / bun install".
  // A yarn-berry user following it would land on PnP (no yarnrc)
  // and pollute the repo with `.yarn/cache` (no gitignore). The
  // file isn't mutated (round-5 policy stands), but a single
  // caveat advisory now covers both fixups so the user has a
  // chance to act before they hit the breakage.
  //
  // Round 10 (Copilot, scaffold.ts:489): the caveat used to fire
  // for *every* undefined-pm + existing-project scaffold (e.g.
  // CLI invoked via `node`/`tsx`, which doesn't set
  // `npm_config_user_agent`), even on pure npm/pnpm/bun projects.
  // It's now gated on the `package.json#packageManager` field
  // declaring yarn 2+, so the test fixture has to set it.
  it("warns about the yarn-berry caveat in undefined-pm + existing-project when no .yarnrc.yml exists and packageManager declares yarn 2+", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify(
        { name: "existing", private: true, packageManager: "yarn@4.6.0" },
        null,
        2,
      ),
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    // Still NOT mutating the repo: no `.yarnrc.yml`, no yarn
    // gitignore lines.
    expect(existsSync(join(cwd, ".yarnrc.yml"))).toBe(false);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).not.toContain(
      ".yarn/",
    );
    // But the caveat IS surfaced. Round 29 (Copilot, PR #99)
    // trimmed the prior `.yarn/cache` / `.yarn/install-state.gz`
    // gitignore prescription — `patchGitignore` deliberately
    // doesn't add those to existing repos (round-14 #2: Yarn
    // zero-install repos commit them on purpose), so prescribing
    // them in the advisory contradicted our own patch policy.
    // The advisory now only flags the runtime-blocking
    // `nodeLinker` fix.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 2\+|yarn-berry/);
    expect(result.warnings[0]).toContain("nodeLinker: node-modules");
    // No `.yarn/cache` / `.yarn/install-state.gz` recommendation —
    // see round-29 trim above.
    expect(result.warnings[0]).not.toContain(".yarn/cache");
    expect(result.warnings[0]).not.toContain(".yarn/install-state.gz");
  });

  // Round 31 (Copilot, PR #99): the inspect path's `no-config`
  // branch was narrower than the patch path's gate — it only
  // consulted the corepack `packageManager` declaration, missing
  // yarn-berry repos that committed `.yarn/releases/yarn-*.cjs`
  // but not yet a `packageManager` field. `.yarn/` is yarn-berry
  // -only (yarn 1 doesn't create it), so adding it as a positive
  // signal is safe. Pin the contract here.
  it("warns about the yarn-berry caveat in undefined-pm + existing-project when only `.yarn/` dir signals yarn-berry", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    // No `.yarnrc.yml`, no `packageManager` declaration — but
    // `.yarn/` directory exists (the bootstrap state where the
    // yarn binary was committed under `.yarn/releases/` but the
    // user hasn't yet committed a `.yarnrc.yml` or corepack
    // pin).
    mkdirSync(join(cwd, ".yarn"));
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 2\+|yarn-berry/);
    expect(result.blockInstall).toBe(true);
  });

  // Round 11 (Copilot): when `.yarnrc.yml` exists but lacks a
  // `nodeLinker:` key, the file's mere existence is yarn-berry
  // evidence (yarn 1 reads `.yarnrc` without the `.yml` suffix),
  // so the caveat must fire even when `package.json#packageManager`
  // is absent — the round-10 corepack-declaration gate would
  // otherwise silence a real hazard. yarn 4 will silently default
  // to PnP here, breaking the runtime just like the patch-path
  // case (which appends `nodeLinker: node-modules`; the inspect
  // branch can't mutate, so it surfaces the caveat instead).
  it("warns about the yarn-berry caveat when .yarnrc.yml exists without a nodeLinker key — even without a packageManager declaration", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    writeFileSync(
      join(cwd, ".yarnrc.yml"),
      "yarnPath: .yarn/releases/yarn-4.x.cjs\n",
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 4\+|yarn-berry/);
    expect(result.warnings[0]).toContain("nodeLinker: node-modules");
    // File is unchanged.
    expect(readFileSync(join(cwd, ".yarnrc.yml"), "utf8")).toBe(
      "yarnPath: .yarn/releases/yarn-4.x.cjs\n",
    );
  });

  // Round 10 noise-suppression cases: with no `package.json#
  // packageManager` declaration (or one that names a non-yarn-berry
  // pm), the inspect branch must NOT emit the caveat. These mirror
  // the realistic invocation patterns Copilot called out — `node`/
  // `tsx` invocation with no UA, npm/pnpm/bun projects that have
  // declared their pm via corepack, and yarn 1 (which ignores
  // `.yarnrc.yml` entirely so the caveat is irrelevant there too).
  it.each([
    {
      label: "no packageManager declaration",
      pkg: { name: "existing", private: true },
    },
    {
      label: "packageManager declares pnpm",
      pkg: {
        name: "existing",
        private: true,
        packageManager: "pnpm@10.33.2",
      },
    },
    {
      label: "packageManager declares npm",
      pkg: { name: "existing", private: true, packageManager: "npm@10" },
    },
    {
      label: "packageManager declares bun",
      pkg: { name: "existing", private: true, packageManager: "bun@1.3.13" },
    },
    {
      label: "packageManager declares yarn 1.x",
      pkg: {
        name: "existing",
        private: true,
        packageManager: "yarn@1.22.22",
      },
    },
  ])(
    "stays silent in undefined-pm + existing-project when $label",
    async ({ pkg }) => {
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify(pkg, null, 2),
      );
      const result = await scaffold({
        cwd,
        name: "n",
        template: "triage",
      });
      expect(result.warnings).toEqual([]);
    },
  );

  // Conflict still wins regardless of the packageManager field —
  // an existing `.yarnrc.yml` pinned to a non-`node-modules` value
  // is unambiguous evidence the project is using yarn-berry, so
  // the corepack declaration filter shouldn't gate the conflict
  // warning. (Otherwise an undeclared yarn-berry user with
  // `nodeLinker: pnp` would silently break.)
  it("emits the conflict warning even without a packageManager declaration when an existing .yarnrc.yml pins a non-node-modules linker", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    writeFileSync(join(cwd, ".yarnrc.yml"), "nodeLinker: pnp\n");
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nodeLinker: pnp");
    expect(result.warnings[0]).toMatch(/arkor dev/);
  });

  // And: an existing `.yarnrc.yml` that's already on
  // `nodeLinker: node-modules` is not a conflict, so no warning
  // either. Same skip path, same parser as the patch path —
  // covers the indented / quoted / comment forms transitively.
  it("does not warn in the undefined-pm + existing-project flow when the existing .yarnrc.yml already pins node-modules", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    writeFileSync(
      join(cwd, ".yarnrc.yml"),
      "nodeLinker: node-modules\nfoo: bar\n",
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    expect(result.warnings).toEqual([]);
  });

  // patchYarnConfig parses the `nodeLinker:` value out of YAML
  // through a small normaliser (strip trailing comment, strip a
  // single matched quote pair, trim). The Codex P2 / Copilot
  // reviews on PR #99 flagged that an exact-string equality check
  // misreads valid YAML forms — `node-modules` quoted, with a
  // trailing comment, with extra whitespace. Lock the normaliser
  // down so those forms are recognised as already-correct.
  it.each([
    { label: "double-quoted",   line: 'nodeLinker: "node-modules"' },
    { label: "single-quoted",   line: "nodeLinker: 'node-modules'" },
    { label: "trailing comment", line: "nodeLinker: node-modules # default" },
    { label: "extra whitespace", line: "nodeLinker:    node-modules" },
  ])("treats `$label` as already correct (no warning, action=ok)", async ({ line }) => {
    writeFileSync(join(cwd, ".yarnrc.yml"), `${line}\nfoo: bar\n`);
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("ok");
    expect(result.warnings).toEqual([]);
  });

  // YAML allows the root mapping to be indented. An existing
  // `.yarnrc.yml` like `  nodeLinker: node-modules` (every key at
  // 2-space indent) is still valid and yarn reads it normally.
  // Earlier rounds anchored the regex to column 0, so this kind of
  // file was misread as "missing nodeLinker" and a SECOND
  // `nodeLinker` got appended (Copilot follow-up review on PR #99).
  // The reader now snapshots the indent of the first content line
  // and treats keys at that indent as top-level.
  it("recognises an indented top-level nodeLinker as already correct", async () => {
    writeFileSync(
      join(cwd, ".yarnrc.yml"),
      "  yarnPath: .yarn/releases/yarn-4.x.cjs\n  nodeLinker: node-modules\n",
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("ok");
    expect(result.warnings).toEqual([]);
  });

  // Round 11 (Copilot): YAML structural markers (`---`, `...`,
  // `%YAML 1.2`, `%TAG ...`) aren't mapping entries. Earlier
  // rounds anchored `rootIndent` on the FIRST non-blank,
  // non-comment line, so a perfectly valid `---\n  nodeLinker:
  // node-modules\n` would set rootIndent=0 (from `---`) and then
  // skip the indented `nodeLinker:` as nested — misclassifying an
  // already-correct file as needs-setup and (in the patch path)
  // appending a duplicate `nodeLinker:`. The reader now skips
  // those markers.
  it.each([
    {
      label: "leading document marker",
      content: "---\nnodeLinker: node-modules\n",
    },
    {
      label: "leading document marker with indented body",
      content: "---\n  nodeLinker: node-modules\n  yarnPath: foo\n",
    },
    {
      label: "leading YAML directive",
      content: "%YAML 1.2\n---\nnodeLinker: node-modules\n",
    },
    {
      label: "trailing document end marker",
      content: "nodeLinker: node-modules\n...\n",
    },
  ])(
    "treats `$label` as already correct (no warning, action=ok)",
    async ({ content }) => {
      writeFileSync(join(cwd, ".yarnrc.yml"), content);
      const result = await scaffold({
        cwd,
        name: "n",
        template: "triage",
        packageManager: "yarn",
      });
      const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
      expect(yarnrc?.action).toBe("ok");
      expect(result.warnings).toEqual([]);
      // No duplicate append — file content is unchanged.
      expect(readFileSync(join(cwd, ".yarnrc.yml"), "utf8")).toBe(content);
    },
  );

  // Counterpart of the above: a `nodeLinker:` nested under another
  // key isn't a top-level setting and yarn would never honour it.
  // The reader rejects deeper-indented matches so we don't conflate
  // `parent.nodeLinker` with the root key.
  //
  // Pre-round-15 the patch path then APPENDED a top-level
  // `nodeLinker: node-modules`. Under round-15 semantics the
  // pre-seeded yarnrc makes the cwd non-empty → patch path bows
  // out with `kept + caveat` instead. The point of this test is
  // to assert the *parser* still treats the nested entry as
  // "no top-level nodeLinker" — i.e. no spurious conflict warning,
  // and the nested entry is preserved verbatim.
  it("treats a nested nodeLinker key as not-top-level (no conflict warning, file untouched)", async () => {
    const yarnrcContent =
      "yarnPath: .yarn/releases/yarn-4.x.cjs\nparent:\n  nodeLinker: pnp\n";
    writeFileSync(join(cwd, ".yarnrc.yml"), yarnrcContent);
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("kept");
    // File is untouched — the original nested entry survives verbatim,
    // and we did NOT spuriously add a top-level nodeLinker.
    expect(readFileSync(join(cwd, ".yarnrc.yml"), "utf8")).toBe(yarnrcContent);
    // The single warning is the yarn-berry caveat (no top-level
    // nodeLinker found = `berry-without-linker` route under
    // round 11 + 15). Crucially NOT a `nodeLinker: pnp` conflict
    // warning — the parser correctly ignored the nested key.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toMatch(/nodeLinker: pnp/);
    expect(result.warnings[0]).toMatch(/yarn 4\+|yarn-berry/);
  });

  // Mirror of the `.yarnrc.yml` policy on `.gitignore`: when
  // packageManager is undefined and we're scaffolding into an
  // existing project, don't sprinkle `.yarn/cache` etc into a
  // non-yarn repo's gitignore (Copilot follow-up review on PR #99
  // flagged the inconsistency where the yarnrc emission was
  // already gated this way).
  it("does NOT add yarn-cache lines to .gitignore when undefined-pm scaffolds into an existing project", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "existing", private: true }, null, 2),
    );
    await scaffold({
      cwd,
      name: "n",
      template: "triage",
    });
    const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain(".arkor/");
    expect(gi).not.toContain(".yarn/");
  });

  it("does not emit .yarnrc.yml when the user explicitly picked a non-yarn pm", async () => {
    for (const pm of ["pnpm", "npm", "bun"] as const) {
      rmSync(cwd, { recursive: true, force: true });
      const fresh = mkdtempSync(join(tmpdir(), `cli-internal-test-${pm}-`));
      try {
        const result = await scaffold({
          cwd: fresh,
          name: "n",
          template: "triage",
          packageManager: pm,
        });
        expect(result.files.find((f) => f.path === ".yarnrc.yml")).toBeUndefined();
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    }
    cwd = mkdtempSync(join(tmpdir(), "cli-internal-test-"));
  });

  it("adds yarn-cache lines to .gitignore for yarn or undetected pm", async () => {
    for (const pm of ["yarn", undefined] as const) {
      rmSync(cwd, { recursive: true, force: true });
      const fresh = mkdtempSync(join(tmpdir(), `cli-internal-test-${pm ?? "undef"}-`));
      try {
        await scaffold({
          cwd: fresh,
          name: "n",
          template: "triage",
          packageManager: pm,
        });
        const gi = readFileSync(join(fresh, ".gitignore"), "utf8");
        // `.yarn/cache` accumulates zip tarballs of every dependency
        // (~tens of MB); committing it would balloon the initial commit.
        expect(gi).toContain(".yarn/cache");
        expect(gi).toContain(".yarn/install-state.gz");
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    }
    cwd = mkdtempSync(join(tmpdir(), "cli-internal-test-"));
  });

  it("does not add yarn-cache lines to .gitignore when the user explicitly picked a non-yarn pm", async () => {
    await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "pnpm",
    });
    const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(gi).not.toContain(".yarn/");
  });

  it("uses ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC override when set", async () => {
    // The value is opaque to scaffold — only that it's faithfully
    // round-tripped into package.json matters, so use a relative
    // `file:` spec that is platform-neutral (no Unix-only `/tmp`).
    const overrideSpec = "file:./vendor/arkor-0.0.1-alpha.9.tgz";
    process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC = overrideSpec;
    const { files } = await scaffold({
      cwd,
      name: "override-app",
      template: "triage",
    });
    const pkg = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const devDeps = pkg.devDependencies as Record<string, string>;
    expect(devDeps.arkor).toBe(overrideSpec);
    const pkgEntry = files.find((f) => f.path === "package.json");
    expect(pkgEntry?.action).toBe("created");
  });

  it.each([
    { label: "empty string", value: "" },
    { label: "whitespace only", value: "   " },
  ])(
    "falls back to the default spec when ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC is $label",
    async ({ value }) => {
      // Without the trim+length guard, an empty/whitespace override would
      // be written verbatim into package.json (`"arkor": ""`), which is
      // not a valid dependency spec. Treat both as "unset".
      process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC = value;
      await scaffold({
        cwd,
        name: "blank-override",
        template: "triage",
      });
      const pkg = JSON.parse(
        readFileSync(join(cwd, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      const devDeps = pkg.devDependencies as Record<string, string>;
      expect(devDeps.arkor).toBe("^0.0.1-alpha.9");
    },
  );

  it("uses ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC override when patching an existing package.json", async () => {
    // The spec resolution is shared between the create path (above)
    // and the patch path that runs when `package.json` already exists
    // but has no `devDependencies.arkor`. Cover the patch path too so
    // the override doesn't silently regress to the default there.
    const overrideSpec = "file:./vendor/arkor-0.0.1-alpha.9.tgz";
    process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC = overrideSpec;
    writeFileSync(
      join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "existing-app",
          version: "1.0.0",
          private: true,
          devDependencies: { typescript: "^5.0.0" },
        },
        null,
        2,
      )}\n`,
    );
    const { files } = await scaffold({
      cwd,
      name: "existing-app",
      template: "triage",
    });
    const pkg = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const devDeps = pkg.devDependencies as Record<string, string>;
    expect(devDeps.arkor).toBe(overrideSpec);
    expect(devDeps.typescript).toBe("^5.0.0");
    const pkgEntry = files.find((f) => f.path === "package.json");
    expect(pkgEntry?.action).toBe("patched");
  });

  it("creates the target directory when it does not exist yet", async () => {
    // The fresh-scaffold path used by `npm create arkor my-new-app` runs
    // before the directory exists on disk. ensureDirExists's mkdir branch
    // only fires there — once the directory exists, scaffold reuses it.
    const parent = mkdtempSync(join(tmpdir(), "scaffold-fresh-"));
    const fresh = join(parent, "brand-new");
    try {
      await scaffold({ cwd: fresh, name: "brand-new", template: "triage" });
      expect(readFileSync(join(fresh, "package.json"), "utf8")).toContain(
        '"brand-new"',
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("renders each template with a distinct trainer body", async () => {
    const expectations: Record<"triage" | "translate" | "redaction", string> = {
      triage: `"triage-run"`,
      translate: `"translate-run"`,
      redaction: `"redaction-run"`,
    };
    for (const template of ["triage", "translate", "redaction"] as const) {
      const dir = mkdtempSync(join(tmpdir(), `scaffold-${template}-`));
      await scaffold({ cwd: dir, name: template, template });
      const trainer = readFileSync(join(dir, "src/arkor/trainer.ts"), "utf8");
      expect(trainer).toContain(expectations[template]);
      // The src/arkor/index.ts entry-point manifest is template-independent.
      const index = readFileSync(join(dir, "src/arkor/index.ts"), "utf8");
      expect(index).toContain("createArkor({ trainer })");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("detectPackageManager", () => {
  it("recognises pnpm via user-agent", () => {
    process.env.npm_config_user_agent = "pnpm/10.33.0 node/v22.12.0 linux x64";
    expect(detectPackageManager()).toBe("pnpm");
  });
  it("recognises yarn", () => {
    process.env.npm_config_user_agent = "yarn/1.22.19 node/v20";
    expect(detectPackageManager()).toBe("yarn");
  });
  it("recognises bun via user-agent", () => {
    // `bunx create-arkor` sets npm_config_user_agent to
    // `bun/<ver> npm/? …`. Without this branch, scaffolds run under bunx
    // would fall into the "no detected pm" path and ask the user to
    // install deps manually even though bun was just used to launch them.
    process.env.npm_config_user_agent = "bun/1.1.0 npm/? node/v22 linux x64";
    expect(detectPackageManager()).toBe("bun");
  });
  it("recognises npm via user-agent", () => {
    process.env.npm_config_user_agent = "npm/10.2.4 node/v20.10.0 linux x64";
    expect(detectPackageManager()).toBe("npm");
  });
  it("returns undefined when the user-agent is absent or unknown", () => {
    delete process.env.npm_config_user_agent;
    expect(detectPackageManager()).toBeUndefined();
    process.env.npm_config_user_agent = "something-else/1.0";
    expect(detectPackageManager()).toBeUndefined();
  });
});

describe("resolvePackageManager", () => {
  it("returns the explicit flag when exactly one is set", () => {
    delete process.env.npm_config_user_agent;
    expect(resolvePackageManager({ useBun: true })).toBe("bun");
    expect(resolvePackageManager({ useYarn: true })).toBe("yarn");
  });

  it("falls back to auto-detection when no flag is set", () => {
    process.env.npm_config_user_agent = "pnpm/10 node/v22";
    expect(resolvePackageManager()).toBe("pnpm");
  });

  it("returns undefined when no flag is set and UA is unknown", () => {
    delete process.env.npm_config_user_agent;
    expect(resolvePackageManager()).toBeUndefined();
  });

  it("rejects more than one --use-* flag", () => {
    expect(() =>
      resolvePackageManager({ useNpm: true, usePnpm: true }),
    ).toThrow(/Pick one of/);
  });
});

describe("templateChoices", () => {
  it("exposes every registered template with a hint", () => {
    const list = templateChoices();
    expect(list.map((t) => t.value).sort()).toEqual([
      "redaction",
      "translate",
      "triage",
    ]);
    for (const t of list) {
      expect(t.label).toBeTruthy();
      expect(t.hint).toBeTruthy();
    }
  });

  it("preserves the TEMPLATES insertion order (triage first, fastest)", () => {
    const list = templateChoices();
    expect(list.map((t) => t.value)).toEqual([
      "triage",
      "translate",
      "redaction",
    ]);
  });
});
