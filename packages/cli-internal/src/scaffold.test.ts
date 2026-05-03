import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, templateChoices } from "./scaffold";
import {
  detectPackageManager,
  resolvePackageManager,
} from "./package-manager";

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
    // package.json, .yarnrc.yml — the trailing `.yarnrc.yml` fires
    // because `packageManager` is undefined here (no `--use-*` was
    // simulated), and the manual-install-hint flow defensively emits
    // the file so a yarn-berry user reading the hint and running
    // `yarn install` doesn't land on PnP.
    expect(result.files.map((f) => f.action)).toEqual([
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
    expect(trainer).toContain("unsloth/gemma-4-E4B-it");
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
    expect(devDeps.arkor).toBe("^0.0.1-alpha.7");

    const pkgEntry = files.find((f) => f.path === "package.json");
    expect(pkgEntry?.action).toBe("patched");
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
    // file would smash the previous last line into the first appended
    // entry — e.g. `node_modules/dist/`, which git would interpret as
    // a single path pattern. Existing entries that already match
    // (here: `node_modules/`) are deduped; missing required entries
    // (`dist/`, `.arkor/`) are appended one-per-line under the
    // separator. The yarn-cache lines also fire because the
    // packageManager is undefined here (manual install hint flow).
    writeFileSync(join(cwd, ".gitignore"), "node_modules/");
    await scaffold({ cwd, name: "n", template: "triage" });
    const contents = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(contents).toBe(
      "node_modules/\ndist/\n.arkor/\n.yarn/cache\n.yarn/install-state.gz\n",
    );
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
  it("appends nodeLinker:node-modules when existing .yarnrc.yml lacks it", async () => {
    writeFileSync(
      join(cwd, ".yarnrc.yml"),
      "yarnPath: .yarn/releases/yarn-4.x.cjs\n",
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("patched");
    const contents = readFileSync(join(cwd, ".yarnrc.yml"), "utf8");
    expect(contents).toContain("yarnPath: .yarn/releases/yarn-4.x.cjs");
    expect(contents).toContain("nodeLinker: node-modules");
  });

  // Round 12 (Copilot, PR #99): the verbatim-append path produced
  // invalid YAML for two realistic existing-`.yarnrc.yml` shapes.
  // The patch path now uses a structure-preserving inserter that
  // covers both — these tests pin down the contract.
  //
  // (1) Trailing document end marker `...` — appending after it
  // would put `nodeLinker: node-modules` *outside* the document and
  // yarn would silently stop reading the config. Insert before the
  // marker instead.
  it("inserts nodeLinker:node-modules BEFORE a trailing `...` YAML document terminator", async () => {
    writeFileSync(
      join(cwd, ".yarnrc.yml"),
      "yarnPath: .yarn/releases/yarn-4.x.cjs\n...\n",
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("patched");
    const contents = readFileSync(join(cwd, ".yarnrc.yml"), "utf8");
    // nodeLinker appears in the document body, BEFORE the terminator.
    expect(contents).toBe(
      "yarnPath: .yarn/releases/yarn-4.x.cjs\n" +
        "nodeLinker: node-modules\n" +
        "...\n",
    );
  });

  // (2) Indented root mapping (yarn parses indented top-level keys
  // as long as every key sits at the same column). Appending an
  // unindented `nodeLinker: node-modules` after `  yarnPath: …`
  // produces a mid-document indent change, which is invalid YAML.
  // Match the existing root indent.
  it("preserves the existing root indent when appending nodeLinker:node-modules to an indented .yarnrc.yml", async () => {
    writeFileSync(
      join(cwd, ".yarnrc.yml"),
      "  yarnPath: .yarn/releases/yarn-4.x.cjs\n",
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("patched");
    const contents = readFileSync(join(cwd, ".yarnrc.yml"), "utf8");
    // The new key matches the existing 2-space indent.
    expect(contents).toBe(
      "  yarnPath: .yarn/releases/yarn-4.x.cjs\n" +
        "  nodeLinker: node-modules\n",
    );
  });

  // Round 14 #1 (Copilot, PR #99): even with an explicit
  // `--use-yarn`, don't drop a brand-new `.yarnrc.yml` into a
  // pre-existing project. The surrounding workspace might be a
  // yarn-berry repo deliberately on its PnP default; writing
  // `nodeLinker: node-modules` would flip the install mode for
  // the entire repo. Surface the same yarn-berry caveat the
  // inspect path uses, but from the explicit-yarn arm.
  it("does NOT create .yarnrc.yml in --use-yarn + existing-project + no-yarnrc — surfaces caveat instead", async () => {
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
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    // Reported as `kept` (no mutation), file is NOT created on disk.
    expect(yarnrc?.action).toBe("kept");
    expect(existsSync(join(cwd, ".yarnrc.yml"))).toBe(false);
    // But the caveat IS surfaced.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 4\+|yarn-berry/);
    expect(result.warnings[0]).toContain("nodeLinker: node-modules");
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
    // But the caveat IS surfaced — and it mentions both fixups
    // (yarnrc nodeLinker, gitignore yarn-cache entries) so a user
    // who reads it can address both before running `yarn install`.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/yarn 4\+|yarn-berry/);
    expect(result.warnings[0]).toContain("nodeLinker: node-modules");
    expect(result.warnings[0]).toContain(".yarn/cache");
    expect(result.warnings[0]).toContain(".yarn/install-state.gz");
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
  it("ignores a nested nodeLinker key and appends the missing top-level one", async () => {
    writeFileSync(
      join(cwd, ".yarnrc.yml"),
      "yarnPath: .yarn/releases/yarn-4.x.cjs\nparent:\n  nodeLinker: pnp\n",
    );
    const result = await scaffold({
      cwd,
      name: "n",
      template: "triage",
      packageManager: "yarn",
    });
    const yarnrc = result.files.find((f) => f.path === ".yarnrc.yml");
    expect(yarnrc?.action).toBe("patched");
    const contents = readFileSync(join(cwd, ".yarnrc.yml"), "utf8");
    expect(contents).toContain("nodeLinker: node-modules");
    // The original nested entry survives untouched.
    expect(contents).toContain("parent:\n  nodeLinker: pnp");
    // No spurious warning — the nested key wasn't a real conflict.
    expect(result.warnings).toEqual([]);
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
    const overrideSpec = "file:./vendor/arkor-0.0.1-alpha.7.tgz";
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
      expect(devDeps.arkor).toBe("^0.0.1-alpha.7");
    },
  );

  it("uses ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC override when patching an existing package.json", async () => {
    // The spec resolution is shared between the create path (above)
    // and the patch path that runs when `package.json` already exists
    // but has no `devDependencies.arkor`. Cover the patch path too so
    // the override doesn't silently regress to the default there.
    const overrideSpec = "file:./vendor/arkor-0.0.1-alpha.7.tgz";
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
