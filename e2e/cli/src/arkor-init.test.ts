import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ARKOR_BIN } from "./bins";
import { INSTALL_CASES, shouldSkipInstallCase } from "./install-matrix";
import { cleanup, makeTempDir, runCli, runGit } from "./spawn-cli";

let cwd: string;

beforeEach(() => {
  cwd = makeTempDir("arkor-init-e2e-");
});

afterEach(() => {
  cleanup(cwd);
});

const SKIP_INSTALL = process.env.SKIP_E2E_INSTALL === "1";

// pnpm 10 cannot parse Windows-drive `file:` URIs in any form
// (`file:D:\...`, `file:D:/...`, `file:///D:/...` all break: pnpm strips
// the prefix and joins to the install cwd, then aborts with
// `ENOENT: scandir '<cwd>\D:\...'`). The install-matrix tests sidestep
// that by pre-packing arkor into a tarball once per file and (per test)
// staging it ONE LEVEL ABOVE the project cwd (`parentDir/arkor-*.tgz`
// with the actual install running inside `parentDir/project/`), then
// overriding the scaffold spec to `file:../<basename>`. A parent-
// relative path has no drive letter to misparse and keeps the tarball
// outside the cwd where pnpm's tarball-cache resolution can re-read it.
// (Round 40 Copilot, PR #99: the earlier `cwd/vendor/<basename>` layout
// was renamed to this parentDir shape but the comment lagged behind.)
// SKIP_INSTALL=1 short-circuits the pack since none of the gated tests
// will run.
let arkorTarball: string | undefined;
let arkorPackDir: string | undefined;

beforeAll(() => {
  if (SKIP_INSTALL) return;
  arkorPackDir = makeTempDir("arkor-init-e2e-pack-");
  // Windows ships `pnpm` as a `.cmd` shim under the default Corepack /
  // global-install setup; Node refuses to execute `.cmd`/`.bat` files
  // through `execFile*` without a shell, so the sibling beforeAll would
  // otherwise crash before any test runs on a developer Windows box that
  // doesn't have `@pnpm/exe` in PATH. Mirror install.ts's `shell` policy
  // to delegate resolution to cmd.exe on win32 only.
  execFileSync(
    "pnpm",
    ["--filter", "arkor", "pack", "--pack-destination", arkorPackDir],
    { stdio: "pipe", shell: process.platform === "win32" },
  );
  const matches = readdirSync(arkorPackDir).filter(
    (f) => f.startsWith("arkor-") && f.endsWith(".tgz"),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one arkor-*.tgz in ${arkorPackDir}, got ${matches.length}: ${matches.join(", ")}`,
    );
  }
  arkorTarball = join(arkorPackDir, matches[0]!);
});

afterAll(() => {
  if (arkorPackDir) cleanup(arkorPackDir);
});


describe("arkor init (E2E)", () => {
  it("scaffolds with --skip-install --skip-git (hermetic happy path)", async () => {
    const result = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--skip-git"],
      cwd,
    );

    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, "src/arkor/index.ts"))).toBe(true);
    expect(existsSync(join(cwd, "arkor.config.ts"))).toBe(true);
    // AGENTS.md / CLAUDE.md ship by default and must match `create-arkor`
    // so users get the same project layout regardless of entry point.
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("<!-- BEGIN:arkor-agent-rules -->");
    expect(agents).toContain("arkor is newer than your training data");
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");

    expect(result.stdout).toContain("Next:");
    // pm undefined → manual install hint surfaces in the outro.
    expect(result.stdout).toContain(
      "install dependencies (npm i / pnpm install / yarn / bun install)",
    );
  });

  it("skips AGENTS.md and CLAUDE.md when --no-agents-md is passed", async () => {
    const result = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--skip-git", "--no-agents-md"],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    // Other starter files unaffected by the opt-out.
    expect(existsSync(join(cwd, "src/arkor/index.ts"))).toBe(true);
  });

  it("rejects --agents-md --no-agents-md with a clear error", async () => {
    const result = await runCli(
      ARKOR_BIN,
      [
        "init",
        "-y",
        "--skip-install",
        "--skip-git",
        "--agents-md",
        "--no-agents-md",
      ],
      cwd,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "Pick one of --agents-md / --no-agents-md, not both.",
    );
  });

  it("renders the pnpm next-steps when --use-pnpm is set", async () => {
    const result = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--skip-git", "--use-pnpm"],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pnpm install");
    expect(result.stdout).toContain("pnpm arkor dev");
  });

  it("renders the npm next-steps (npx for run) when --use-npm is set", async () => {
    const result = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--skip-git", "--use-npm"],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("npm install");
    expect(result.stdout).toContain("npx arkor dev");
  });

  it.each([
    { pm: "yarn", devCmd: "yarn arkor dev" },
    { pm: "bun", devCmd: "bun arkor dev" },
  ])("renders the $pm next-steps when --use-$pm is set", async ({ pm, devCmd }) => {
    const result = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--skip-git", `--use-${pm}`],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${pm} install`);
    expect(result.stdout).toContain(devCmd);
  });

  it("creates a real git repo and initial commit when --git is set", async () => {
    const result = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--git"],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, ".git/HEAD"))).toBe(true);

    const log = await runGit(cwd, ["log", "-1", "--format=%s"]);
    expect(log.code).toBe(0);
    expect(log.stdout.trim()).toBe("Initial commit from `arkor init`");
  });

  it("writes pnpm-workspace.yaml with allowBuilds esbuild=false by default (deny)", async () => {
    const result = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--skip-git", "--use-pnpm"],
      cwd,
    );
    expect(result.code).toBe(0);
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toMatch(/allowBuilds:\n[ \t]+esbuild:[ \t]+false/);
  });

  it("flips allowBuilds esbuild=true when --allow-builds is set", async () => {
    const result = await runCli(
      ARKOR_BIN,
      [
        "init",
        "-y",
        "--skip-install",
        "--skip-git",
        "--use-pnpm",
        "--allow-builds",
      ],
      cwd,
    );
    expect(result.code).toBe(0);
    const yaml = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toMatch(/allowBuilds:\n[ \t]+esbuild:[ \t]+true/);
    expect(yaml).not.toMatch(/esbuild:[ \t]+false/);
  });

  it("rejects --git --skip-git with a clear error", async () => {
    const result = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--git", "--skip-git"],
      cwd,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "Pick one of --git / --skip-git, not both.",
    );
  });

  it("does not prompt when --name + --template are provided without -y", async () => {
    // No `-y`, but every prompted value is supplied as a flag. The run
    // should complete without hanging and apply the flag values.
    const result = await runCli(
      ARKOR_BIN,
      [
        "init",
        "--skip-install",
        "--skip-git",
        "--name",
        "no-prompt-app",
        "--template",
        "redaction",
      ],
      cwd,
    );
    expect(result.code).toBe(0);

    const trainer = readFileSync(join(cwd, "src/arkor/trainer.ts"), "utf8");
    expect(trainer).toContain('"redaction-run"');

    const pkg = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as { name?: string };
    expect(pkg.name).toBe("no-prompt-app");
  });

  // Regression for ENG-357: `--name "Foo Bar"` previously fell through to
  // package.json verbatim because sanitisation only ran inside the
  // interactive branch.
  it("sanitises --name when prompts are skipped", async () => {
    const result = await runCli(
      ARKOR_BIN,
      [
        "init",
        "-y",
        "--skip-install",
        "--skip-git",
        "--name",
        "Foo Bar!",
      ],
      cwd,
    );
    expect(result.code).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as { name?: string };
    expect(pkg.name).toBe("foo-bar");
  });

  describe("CLAUDECODE=1 strict mode", () => {
    // Claude Code (the Anthropic agent CLI) spawns child processes with
    // `CLAUDECODE=1` and cannot answer interactive prompts. Falling through
    // to silent defaults would hide decisions the agent should be making, so
    // `arkor init` refuses to run unless every interactive-equivalent flag
    // is supplied (or `--yes` opts back into the legacy "accept defaults"
    // path).
    it("exits 1 with a flag list (and per-flag description) when no options are given", async () => {
      const result = await runCli(ARKOR_BIN, ["init"], cwd, {
        CLAUDECODE: "1",
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "arkor init: CLAUDECODE=1 detected",
      );
      expect(result.stderr).toContain("--template <triage|translate|redaction>");
      expect(result.stderr).toContain("--git (recommended) or --skip-git");
      expect(result.stderr).toContain("--use-pnpm");
      expect(result.stderr).toContain(
        "--agents-md (recommended) or --no-agents-md",
      );
      expect(result.stderr).toContain("-y/--yes");
      // Each flag is paired with a description so the agent can pick a
      // value without round-tripping to the docs.
      expect(result.stderr).toContain("Starter template");
      expect(result.stderr).toContain("git init");
      expect(result.stderr).toContain("package manager");
      expect(result.stderr).toContain("AGENTS.md");
      // No scaffold side effects must have occurred; the tree must be
      // pristine after the early exit.
      expect(existsSync(join(cwd, "src/arkor/index.ts"))).toBe(false);
      expect(existsSync(join(cwd, "package.json"))).toBe(false);
    });

    it("rejects an arkor init run whose cwd basename has no alphanumerics (would silently fall back to `arkor-project`)", async () => {
      // PR #141 review (Copilot): `arkor init` without `--name`
      // derives the project name from `basename(process.cwd())`. In
      // a directory like `!!!`, runtime would sanitise that to the
      // generic `arkor-project` fallback, which is exactly the
      // silent default strict mode is meant to surface for explicit
      // `--name` values. Strict mode now validates `basename(cwd)`
      // through the same alphanumeric check.
      const punctDir = join(cwd, "!!!");
      mkdirSync(punctDir, { recursive: true });
      const result = await runCli(
        ARKOR_BIN,
        [
          "init",
          "--template",
          "triage",
          "--skip-git",
          "--skip-install",
          "--no-agents-md",
        ],
        punctDir,
        { CLAUDECODE: "1" },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--name <name>");
      // Sanity: nothing scaffolded.
      expect(existsSync(join(punctDir, "package.json"))).toBe(false);
    });

    it("rejects explicit garbage --name even though strict mode does not require a name", async () => {
      // PR #141 review (Copilot): under strict mode `arkor init` does
      // not require `--name` (the runtime derives it from
      // `basename(cwd)`), but if the agent went out of its way to
      // pass `--name "!!!"` strict mode used to ignore it and let
      // `sanitise()` quietly collapse the value to `arkor-project`.
      // Now an explicit `--name` is validated regardless of the
      // `requireProjectName` branch.
      const result = await runCli(
        ARKOR_BIN,
        [
          "init",
          "--name",
          "!!!",
          "--template",
          "triage",
          "--skip-git",
          "--skip-install",
          "--no-agents-md",
        ],
        cwd,
        { CLAUDECODE: "1" },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--name <name>");
      // Sanity: nothing was scaffolded.
      expect(existsSync(join(cwd, "package.json"))).toBe(false);
    });

    it("runs to completion when every required flag is set", async () => {
      const result = await runCli(
        ARKOR_BIN,
        [
          "init",
          "--template",
          "triage",
          "--skip-git",
          "--skip-install",
          "--no-agents-md",
        ],
        cwd,
        { CLAUDECODE: "1" },
      );
      expect(result.code).toBe(0);
      expect(existsSync(join(cwd, "src/arkor/index.ts"))).toBe(true);
      // --no-agents-md was honoured.
      expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    });

    it("accepts --yes as a wholesale opt-out of the strict check", async () => {
      // `-y` keeps the legacy "use defaults for everything" semantics for
      // callers who have explicitly delegated those decisions.
      const result = await runCli(
        ARKOR_BIN,
        ["init", "-y", "--skip-install", "--skip-git"],
        cwd,
        { CLAUDECODE: "1" },
      );
      expect(result.code).toBe(0);
      expect(existsSync(join(cwd, "src/arkor/index.ts"))).toBe(true);
    });
  });

  it("skips git init when the target is already a git repo", async () => {
    // Pre-seed a git repo so isInGitRepo() short-circuits.
    const initRes = await runGit(cwd, ["init", "-q"]);
    expect(initRes.code).toBe(0);

    const result = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--git"],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      // eslint-disable-next-line local/no-em-dash
      "Directory is already inside a git repository — skipping git init.",
    );

    // No commit should have been added (the pre-seeded repo has no HEAD yet).
    const log = await runGit(cwd, ["log", "-1", "--format=%s"]);
    expect(log.code).not.toBe(0);
  });

  // Real `<pm> install` exercise across every package manager the SDK
  // accepts. Each case scaffolds a project, runs `<pm> install` through
  // the SDK, and verifies the deps tree + the git commit step landed.
  // The case list and skip rules live in `./install-matrix.ts` so the
  // CI yaml's `PM_LABEL` mapping and create-arkor.test.ts stay in sync
  // with one source of truth (Copilot review on PR #99).
  //
  // Per-case fixture mirrors create-arkor.test.ts's pattern
  // exactly: a per-test parent dir contains the tarball as a
  // single-segment sibling FILE, plus a fresh `project/` subdir
  // that `arkor init` runs in. The scaffold spec is therefore
  // `file:../<tgz>` (one level up to the parent + filename, no
  // intermediate directory components).
  //
  // Why this exact shape:
  //
  //   1. pnpm 10 can't parse absolute Windows-drive `file:` URIs
  //      (`file:D:\...`), so the path has to be relative. (See
  //      the top-of-file beforeAll for the full rationale.)
  //   2. Pre-seeding ANYTHING under the project dir BEFORE
  //      `arkor init` runs flips scaffold's round-15
  //      `isExistingProject` predicate to true, which activates
  //      the round-14 / round-20 "existing project" yarn-config
  //      policy: scaffold declines to write `.yarnrc.yml`,
  //      yarn-berry falls back to PnP at install time, and the
  //      tree has no `node_modules` (CI run 25323281510). The
  //      tarball must therefore live OUTSIDE the project dir.
  //   3. bun on Windows skips `bun.lock` generation for `file:`
  //      deps with multi-segment relative paths
  //      (`file:../<dir>/<tgz>`, observed in CI run 25326609066).
  //      A single-segment `file:../<tgz>` works (the create-arkor
  //      lane has been passing on Windows × bun all along with
  //      this exact shape). So the tarball must be a sibling
  //      FILE of the project, not a sibling DIRECTORY entry.
  //
  // The global `cwd` from beforeEach is unused by these tests:
  // afterEach still cleans it up, and the per-test `parentDir`
  // is cleaned up in the `finally` block below.
  //
  // Lockfile-by-flag drives the post-install assertion that
  // verifies git init runs *after* install (so the bootstrap
  // commit is reproducible).
  const LOCKFILE_BY_FLAG: Record<"npm" | "pnpm" | "yarn" | "bun", string> = {
    npm: "package-lock.json",
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
    bun: "bun.lock",
  };

  // bun on Windows skips `bun.lock` generation specifically for
  // `arkor init`'s spawn shape (Node parent → `cli-internal/
  // install.ts` → `spawn("bun", ["install"], {stdio: "inherit"})`),
  // but produces it reliably for the IDENTICAL fixture under
  // create-arkor (same bun 1.3.13, same `file:../<tgz>` spec,
  // same parentDir+project layout, verified passing on the
  // same CI runs that fail this lane). Rounds 22 → 23 → 25
  // narrowed the divergence to the CLI-binary axis with no other
  // observable difference.
  //
  // Round 40 (Copilot, PR #99): final answer. Earlier rounds
  // tried (a) assertion-skip with `console.warn`, (b) test-level
  // `it.skipIf`, then (c) `it.fails` as a forcing-function
  // expected-failure. Copilot escalated each one in turn:
  //   - (a) silently skipped the lockfile invariant.
  //   - (b) made the gap visible to the runner but Copilot still
  //     flagged the silent skip.
  //   - (c) turned the matrix green precisely when `arkor init
  //     --use-bun --git` is broken on Windows; Copilot's
  //     pushback was "fix the bug or gate outside the supported
  //     matrix, don't expected-fail it".
  //
  // Gate it outside the supported matrix. arkor init + bun on
  // Windows is a documented non-supported combination until the
  // CLI-binary-axis divergence is fixed; CI does NOT advertise
  // green for it. `it.skip` keeps it visible in the vitest
  // summary as a skipped case (each CI run prints a skip line),
  // while removing the implicit "we test this" claim that
  // `it.fails` / silent skip both made. create-arkor's bun lane
  // on Windows continues to assert the lockfile invariant
  // through `create-arkor.test.ts`, which IS in the supported
  // matrix. Adding bun-on-Windows back to the arkor-init lane
  // requires (a) fixing the spawn-shape divergence and (b)
  // dropping this gate.
  function isBunOnWindows(flag: string): boolean {
    return flag === "bun" && process.platform === "win32";
  }
  for (const { label, flag } of INSTALL_CASES) {
    const testFn =
      shouldSkipInstallCase(label) || isBunOnWindows(flag) ? it.skip : it;
    testFn(
      isBunOnWindows(flag)
        ? `runs real ${label} install + git commit (NOT IN SUPPORTED MATRIX on Windows × bun: see the block comment above)`
        : `runs real ${label} install + git commit (gated by SKIP_E2E_INSTALL)`,
      async () => {
        if (!arkorTarball) {
          throw new Error("arkor tarball wasn't packed in beforeAll");
        }
        const parentDir = makeTempDir("arkor-init-e2e-pkg-");
        try {
          const projectDir = join(parentDir, "project");
          mkdirSync(projectDir);
          const tarballName = basename(arkorTarball);
          copyFileSync(arkorTarball, join(parentDir, tarballName));

          const result = await runCli(
            ARKOR_BIN,
            ["init", "-y", `--use-${flag}`, "--git"],
            projectDir,
            { ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC: `file:../${tarballName}` },
          );
          // arkor init swallows `<pm> install` failures into a one-line
          // warning so the user can retry manually: that means a broken
          // pm setup leaves us with `result.code === 0` but no
          // node_modules and only a warn buried in stderr. Surface the
          // captured stdout/stderr eagerly when an assertion is about to
          // fail so the install-matrix CI logs are diagnostic rather than
          // a bare `expected false to be true`.
          //
          // Round 35 (PR #99) added a follow-up failure mode: install
          // can throw AFTER writing node_modules (pnpm 11 + bun on
          // Windows have been observed exiting non-zero post-install),
          // arkor init's catch fires, and git is now also skipped
          // (per round 35), leaving result.code===0 + node_modules
          // present + .git/HEAD missing. Trigger the diagnostic dump
          // for that combination too.
          const expectedGit = existsSync(join(projectDir, ".git/HEAD"));
          if (
            result.code !== 0 ||
            !existsSync(join(projectDir, "node_modules")) ||
            !expectedGit
          ) {

            console.error(
              `[install-matrix:${label}] arkor init missing expected artefact:\n` +
                `  exit: ${result.code}\n` +
                `  node_modules: ${existsSync(join(projectDir, "node_modules"))}\n` +
                `  .git/HEAD: ${expectedGit}\n` +
                `  --- stdout ---\n${result.stdout}\n` +
                `  --- stderr ---\n${result.stderr}`,
            );
          }
          expect(result.code).toBe(0);
          // Every pm (including yarn-berry) produces a real node_modules
          // tree because the scaffold writes `.yarnrc.yml` with
          // `nodeLinker: node-modules` whenever the user picked yarn (see
          // packages/cli-internal/src/scaffold.ts). Without that pin
          // yarn-berry would default to Plug'n'Play and the arkor runtime
          // would fail to resolve modules.
          expect(existsSync(join(projectDir, "node_modules"))).toBe(true);
          expect(existsSync(join(projectDir, ".git/HEAD"))).toBe(true);

          const log = await runGit(projectDir, ["log", "-1", "--format=%s"]);
          expect(log.stdout.trim()).toBe("Initial commit from `arkor init`");

          // Lockfile-in-initial-commit invariant: the git-init prompt
          // is surfaced *before* install so the user can walk away, but
          // git init execution still happens *after* install; otherwise
          // the lockfile wouldn't be tracked and the bootstrap commit
          // wouldn't be reproducible. The Windows × bun sub-case is
          // skipped at the `testFn` selection above (gated outside the
          // supported matrix, round 40), so by the time we reach this
          // line every running case is expected to have a lockfile
          // tracked in HEAD.
          {
            const tracked = await runGit(projectDir, [
              "ls-tree",
              "-r",
              "--name-only",
              "HEAD",
            ]);
            expect(tracked.stdout).toContain(LOCKFILE_BY_FLAG[flag]);
          }
        } finally {
          cleanup(parentDir);
        }
      },
      180_000,
    );
  }
});
