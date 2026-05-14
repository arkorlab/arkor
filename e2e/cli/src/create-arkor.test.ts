import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CREATE_ARKOR_BIN } from "./bins";
import { cleanup, makeTempDir, runCli, runGit } from "./spawn-cli";

let parentDir: string;

beforeEach(() => {
  parentDir = makeTempDir("create-arkor-e2e-");
});

afterEach(() => {
  cleanup(parentDir);
});

/**
 * Spawn `create-arkor` with `parentDir` as cwd. The CLI's first positional
 * is the target directory; we pass `"target"` so it scaffolds into a fresh
 * subdir. Returns the result + the absolute target path.
 */
async function runCreateArkor(
  argv: string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const targetDir = join(parentDir, "target");
  const result = await runCli(
    CREATE_ARKOR_BIN,
    ["target", ...argv],
    parentDir,
    extraEnv,
  );
  return { result, targetDir };
}

const SKIP_INSTALL = process.env.SKIP_E2E_INSTALL === "1";

// pnpm 10 cannot parse Windows-drive `file:` URIs in any form
// (`file:D:\...`, `file:D:/...`, `file:///D:/...` all break — pnpm strips
// the prefix and joins to the install cwd, then aborts with
// `ENOENT: scandir '<cwd>\D:\...'`). The install-matrix tests sidestep
// that by pre-packing arkor into a tarball once per file and referencing
// it via a *relative* `file:../arkor-*.tgz` path inside each test's
// parentDir, which has no drive letter to misparse. SKIP_INSTALL=1 short-
// circuits the whole pack since none of the gated tests will run.
let arkorTarball: string | undefined;
let arkorPackDir: string | undefined;

beforeAll(() => {
  if (SKIP_INSTALL) return;
  arkorPackDir = makeTempDir("create-arkor-e2e-pack-");
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

describe("create-arkor (E2E)", () => {
  it("scaffolds with --skip-install --skip-git (hermetic happy path)", async () => {
    const { result, targetDir } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--skip-git",
    ]);

    expect(result.code).toBe(0);
    expect(existsSync(join(targetDir, "package.json"))).toBe(true);
    expect(existsSync(join(targetDir, "src/arkor/index.ts"))).toBe(true);
    expect(existsSync(join(targetDir, "arkor.config.ts"))).toBe(true);
    expect(existsSync(join(targetDir, ".gitignore"))).toBe(true);
    // AGENTS.md / CLAUDE.md ship by default to brief AI coding agents that
    // arkor post-dates their training data.
    expect(existsSync(join(targetDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(targetDir, "CLAUDE.md"))).toBe(true);
    const agents = readFileSync(join(targetDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("<!-- BEGIN:arkor-agent-rules -->");
    expect(agents).toContain("<!-- END:arkor-agent-rules -->");
    expect(agents).toContain("arkor is newer than your training data");
    expect(readFileSync(join(targetDir, "CLAUDE.md"), "utf8")).toBe(
      "@AGENTS.md\n",
    );
    // Files note in the outro lists both new entries.
    expect(result.stdout).toContain("AGENTS.md");
    expect(result.stdout).toContain("CLAUDE.md");

    const pkg = JSON.parse(
      readFileSync(join(targetDir, "package.json"), "utf8"),
    ) as { name?: string };
    expect(pkg.name).toBe(basename(targetDir));

    const index = readFileSync(join(targetDir, "src/arkor/index.ts"), "utf8");
    expect(index).toContain("createArkor");
    const trainer = readFileSync(
      join(targetDir, "src/arkor/trainer.ts"),
      "utf8",
    );
    expect(trainer).toContain("createTrainer");

    // No `--use-*` and CI=1 → pm undefined → manual install hint + npx dev.
    expect(result.stdout).toContain("npx arkor dev");
    expect(result.stdout).toContain(
      "install dependencies (npm i / pnpm install / yarn / bun install)",
    );
  });

  it("renders the pnpm next-steps when --use-pnpm is set", async () => {
    const { result } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--skip-git",
      "--use-pnpm",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pnpm install");
    expect(result.stdout).toContain("pnpm arkor dev");
  });

  it("renders the npm next-steps (npx for run) when --use-npm is set", async () => {
    const { result } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--skip-git",
      "--use-npm",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("npm install");
    // npm forces `npx arkor` since `npm arkor` isn't a thing.
    expect(result.stdout).toContain("npx arkor dev");
  });

  it.each([
    { pm: "yarn", devCmd: "yarn arkor dev" },
    { pm: "bun", devCmd: "bun arkor dev" },
  ])("renders the $pm next-steps when --use-$pm is set", async ({ pm, devCmd }) => {
    const { result } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--skip-git",
      `--use-${pm}`,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${pm} install`);
    expect(result.stdout).toContain(devCmd);
  });

  it("creates a real git repo and initial commit when --git is set", async () => {
    const { result, targetDir } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--git",
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(join(targetDir, ".git/HEAD"))).toBe(true);

    const log = await runGit(targetDir, ["log", "-1", "--format=%s"]);
    expect(log.code).toBe(0);
    expect(log.stdout.trim()).toBe("Initial commit from Create Arkor");
  });

  it("skips AGENTS.md and CLAUDE.md when --no-agents-md is passed", async () => {
    const { result, targetDir } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--skip-git",
      "--no-agents-md",
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(join(targetDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(targetDir, "CLAUDE.md"))).toBe(false);
    // Other starter files are unaffected.
    expect(existsSync(join(targetDir, "src/arkor/index.ts"))).toBe(true);
  });

  it("preserves an existing AGENTS.md and patches in the managed block", async () => {
    // Pre-create the target dir + a hand-written AGENTS.md to simulate
    // scaffolding into an existing project that already has agent rules.
    const targetDir = join(parentDir, "existing-agents");
    mkdirSync(targetDir);
    const userContent = "# Existing rules\n\nWritten by hand.\n";
    writeFileSync(join(targetDir, "AGENTS.md"), userContent);

    const result = await runCli(
      CREATE_ARKOR_BIN,
      ["existing-agents", "-y", "--skip-install", "--skip-git"],
      parentDir,
    );
    expect(result.code).toBe(0);

    const body = readFileSync(join(targetDir, "AGENTS.md"), "utf8");
    expect(body.startsWith(userContent)).toBe(true);
    expect(body).toContain("<!-- BEGIN:arkor-agent-rules -->");
    expect(body).toContain("<!-- END:arkor-agent-rules -->");
  });

  it("rejects --git --skip-git with a clear error", async () => {
    const { result } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--git",
      "--skip-git",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "create-arkor failed: Pick one of --git / --skip-git, not both.",
    );
  });

  it("generates AGENTS.md and CLAUDE.md when --agents-md is passed explicitly", async () => {
    // Belt-and-braces: the default-on path covers the common case, but
    // the explicit `--agents-md` flag exercises a separate Commander
    // option binding. Without this case, a future Commander upgrade that
    // changed how `--no-foo` interacts with an explicit `--foo` could
    // silently break opt-in users while default-on tests stayed green.
    const { result, targetDir } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--skip-git",
      "--agents-md",
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(join(targetDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(targetDir, "CLAUDE.md"))).toBe(true);
  });

  it("rejects --agents-md --no-agents-md with a clear error", async () => {
    const { result } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--skip-git",
      "--agents-md",
      "--no-agents-md",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "create-arkor failed: Pick one of --agents-md / --no-agents-md, not both.",
    );
  });

  it("does not treat tokens after the POSIX `--` sentinel as flags for the mutex check", async () => {
    // Regression: a previous mutex check scanned the whole argv with
    // `process.argv.includes(...)`, so a positional `[dir]` that happens
    // to start with `--` (passed after `--` to disambiguate from a flag)
    // wrongly tripped the conflict error even though `--no-agents-md`
    // here is the *directory name*, not the negated flag. The fixed
    // check stops scanning at the POSIX `--` sentinel.
    const dirName = "--no-agents-md";
    const targetDir = join(parentDir, dirName);
    const result = await runCli(
      CREATE_ARKOR_BIN,
      ["-y", "--skip-install", "--skip-git", "--agents-md", "--", dirName],
      parentDir,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("--agents-md / --no-agents-md");
    // The scaffold completed in a directory literally named `--no-agents-md`
    // and AGENTS.md was generated (because --agents-md is the only effective
    // agent flag — the post-sentinel token was a positional, not a flag).
    expect(existsSync(join(targetDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(targetDir, "CLAUDE.md"))).toBe(true);
  });

  it("does not prompt when --name + --template are provided without -y", async () => {
    // No `-y`, but every prompted value is supplied as a flag. The run
    // should complete without hanging and apply the flag values.
    const { result, targetDir } = await runCreateArkor([
      "--skip-install",
      "--skip-git",
      "--name",
      "no-prompt-app",
      "--template",
      "redaction",
    ]);
    expect(result.code).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(targetDir, "package.json"), "utf8"),
    ) as { name?: string };
    expect(pkg.name).toBe("no-prompt-app");

    const trainer = readFileSync(
      join(targetDir, "src/arkor/trainer.ts"),
      "utf8",
    );
    expect(trainer).toContain('"redaction-run"');
  });

  // Regression for ENG-357 — `--name "Foo Bar"` previously fell through to
  // package.json verbatim because sanitisation only ran inside the
  // interactive branch.
  it("sanitises --name when prompts are skipped", async () => {
    const { result, targetDir } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--skip-git",
      "--name",
      "Foo Bar!",
    ]);
    expect(result.code).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(targetDir, "package.json"), "utf8"),
    ) as { name?: string };
    expect(pkg.name).toBe("foo-bar");
  });

  // Regression for ENG-359 — `process.cwd()` / `options.dir` ending in `/`
  // (Docker root, `--dir foo/`, etc.) used to produce an empty defaultName
  // because `cwd.split(/[/\\]/).pop()` returned "" and `??` only fires on
  // null/undefined. `path.basename` correctly strips the trailing slash.
  it("derives defaultName via basename when --dir has a trailing slash", async () => {
    const targetDir = join(parentDir, "trail");
    const result = await runCli(
      CREATE_ARKOR_BIN,
      ["trail/", "-y", "--skip-install", "--skip-git"],
      parentDir,
    );
    expect(result.code).toBe(0);
    const pkg = JSON.parse(
      readFileSync(join(targetDir, "package.json"), "utf8"),
    ) as { name?: string };
    // Before the fix this would have been "arkor-project" (the sanitise
    // fallback for empty input).
    expect(pkg.name).toBe("trail");
  });

  // Regression for ENG-426 — without an explicit `[dir]` the CLI used to
  // scaffold straight into `process.cwd()`, littering whatever directory the
  // user happened to be in. The new behaviour mirrors `create-vite`: derive
  // the project name (prompted in interactive mode, `arkor-project` under
  // `-y`) and create a fresh subdirectory named after it.
  it("scaffolds into ./arkor-project/ when no [dir] is passed", async () => {
    const result = await runCli(
      CREATE_ARKOR_BIN,
      ["-y", "--skip-install", "--skip-git"],
      parentDir,
    );
    expect(result.code).toBe(0);

    const targetDir = join(parentDir, "arkor-project");
    expect(existsSync(join(targetDir, "package.json"))).toBe(true);
    expect(existsSync(join(targetDir, "src/arkor/index.ts"))).toBe(true);

    // Nothing should land directly in parentDir except the new subdir.
    expect(readdirSync(parentDir).sort()).toEqual(["arkor-project"]);

    // Outro should tell the user to `cd arkor-project`.
    expect(result.stdout).toContain("cd arkor-project");
  });

  // Companion to the regression above: the explicit "scaffold here" opt-in.
  it("scaffolds into the current directory when `.` is passed", async () => {
    const result = await runCli(
      CREATE_ARKOR_BIN,
      [".", "-y", "--skip-install", "--skip-git"],
      parentDir,
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(parentDir, "package.json"))).toBe(true);
    expect(existsSync(join(parentDir, "src/arkor/index.ts"))).toBe(true);

    // No `cd` line in the outro when scaffolding in place.
    expect(result.stdout).not.toMatch(/\bcd \./);
  });

  // `--name foo` without [dir] should also create `./foo/`, not pollute cwd.
  it("scaffolds into ./<name>/ when --name is passed without [dir]", async () => {
    const result = await runCli(
      CREATE_ARKOR_BIN,
      ["-y", "--skip-install", "--skip-git", "--name", "named-app"],
      parentDir,
    );
    expect(result.code).toBe(0);

    const targetDir = join(parentDir, "named-app");
    expect(existsSync(join(targetDir, "package.json"))).toBe(true);
    const pkg = JSON.parse(
      readFileSync(join(targetDir, "package.json"), "utf8"),
    ) as { name?: string };
    expect(pkg.name).toBe("named-app");
    expect(readdirSync(parentDir).sort()).toEqual(["named-app"]);
  });

  // Collision guards for the auto-derived `./<name>/` path. When the user
  // didn't pass `[dir]` we refuse to merge into a non-empty existing
  // directory — easy to hit by accident (typo, forgotten earlier scaffold)
  // and the silent merge would surprise users.
  it("refuses to scaffold when ./arkor-project/ already exists and is non-empty", async () => {
    const collidingDir = join(parentDir, "arkor-project");
    mkdirSync(collidingDir);
    writeFileSync(join(collidingDir, "sentinel.txt"), "do not touch\n");

    const result = await runCli(
      CREATE_ARKOR_BIN,
      ["-y", "--skip-install", "--skip-git"],
      parentDir,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'Directory "arkor-project/" already exists and is not empty.',
    );
    // Sentinel survives — we bailed before touching anything.
    expect(readFileSync(join(collidingDir, "sentinel.txt"), "utf8")).toBe(
      "do not touch\n",
    );
    expect(existsSync(join(collidingDir, "package.json"))).toBe(false);
  });

  it("refuses to scaffold when --name target dir exists and is non-empty", async () => {
    const collidingDir = join(parentDir, "taken");
    mkdirSync(collidingDir);
    writeFileSync(join(collidingDir, "sentinel.txt"), "x\n");

    const result = await runCli(
      CREATE_ARKOR_BIN,
      ["-y", "--skip-install", "--skip-git", "--name", "taken"],
      parentDir,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'Directory "taken/" already exists and is not empty.',
    );
    expect(existsSync(join(collidingDir, "package.json"))).toBe(false);
  });

  // Back-compat: explicit `[dir]` keeps the "scaffold into an existing
  // project" semantics (patches package.json / .gitignore in place,
  // preserves existing files).
  it("still merges into an explicitly-given [dir] that exists", async () => {
    const targetDir = join(parentDir, "existing");
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "sentinel.txt"), "kept\n");

    const result = await runCli(
      CREATE_ARKOR_BIN,
      ["existing", "-y", "--skip-install", "--skip-git"],
      parentDir,
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(targetDir, "package.json"))).toBe(true);
    expect(readFileSync(join(targetDir, "sentinel.txt"), "utf8")).toBe("kept\n");
  });

  // Collision check should NOT fire when the would-be target is empty —
  // makes sure the guard discriminates between empty placeholders (e.g. a
  // pre-created mount point) and real existing projects.
  it("scaffolds into an empty pre-existing ./<name>/ without complaining", async () => {
    const target = join(parentDir, "arkor-project");
    mkdirSync(target);

    const result = await runCli(
      CREATE_ARKOR_BIN,
      ["-y", "--skip-install", "--skip-git"],
      parentDir,
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(target, "package.json"))).toBe(true);
  });

  it.skipIf(SKIP_INSTALL).each([
    { pm: "npm", lockfile: "package-lock.json" },
    { pm: "pnpm", lockfile: "pnpm-lock.yaml" },
  ])(
    "runs real $pm install + git commit (gated by SKIP_E2E_INSTALL)",
    async ({ pm, lockfile }) => {
      if (!arkorTarball) throw new Error("arkor tarball wasn't packed in beforeAll");
      // Copy the pre-packed tarball into parentDir so the scaffolded
      // project (target/) can resolve it via a relative `file:../<tgz>`
      // path. See the beforeAll comment for why we can't pass an
      // absolute Windows path through pnpm 10's URL parser.
      const tarballName = basename(arkorTarball);
      copyFileSync(arkorTarball, join(parentDir, tarballName));

      const { result, targetDir } = await runCreateArkor(
        ["-y", `--use-${pm}`, "--git"],
        { ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC: `file:../${tarballName}` },
      );
      expect(result.code).toBe(0);
      expect(existsSync(join(targetDir, "node_modules"))).toBe(true);
      expect(existsSync(join(targetDir, ".git/HEAD"))).toBe(true);

      const log = await runGit(targetDir, ["log", "-1", "--format=%s"]);
      expect(log.stdout.trim()).toBe("Initial commit from Create Arkor");

      // Lockfile-in-initial-commit invariant: the git-init prompt is
      // surfaced *before* install so the user can walk away, but git init
      // execution still happens *after* install — otherwise the lockfile
      // wouldn't be tracked and the bootstrap commit wouldn't be reproducible.
      const tracked = await runGit(targetDir, ["ls-tree", "-r", "--name-only", "HEAD"]);
      expect(tracked.stdout).toContain(lockfile);
    },
    180_000,
  );

  describe("CLAUDECODE=1 strict mode", () => {
    // Claude Code (the Anthropic agent CLI) spawns child processes with
    // `CLAUDECODE=1` and cannot answer interactive prompts. Falling through
    // to silent defaults would hide decisions the agent should be making, so
    // `create-arkor` refuses to run unless every interactive-equivalent flag
    // is supplied (or `--yes` opts back into the legacy "accept defaults"
    // path). Unlike `arkor init`, this includes `[dir]` / `--name` because
    // the otherwise-default project name (`arkor-project`) is generic enough
    // that it almost always reflects an oversight rather than intent.
    it("exits 1 with a flag list (and per-flag description) when no options are given (missing [dir])", async () => {
      // Bypass `runCreateArkor` because that helper always injects
      // `target` as the positional; to exercise the missing-[dir]
      // branch we need an argv with no positional at all.
      const result = await runCli(CREATE_ARKOR_BIN, [], parentDir, {
        CLAUDECODE: "1",
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "create-arkor: CLAUDECODE=1 detected",
      );
      expect(result.stderr).toContain("[dir]");
      expect(result.stderr).toContain("--template <triage|translate|redaction>");
      expect(result.stderr).toContain("--git (recommended) or --skip-git");
      expect(result.stderr).toContain("--use-pnpm");
      expect(result.stderr).toContain(
        "--agents-md (recommended) or --no-agents-md",
      );
      // Each flag is paired with a description so the agent can pick a
      // value without round-tripping to the docs.
      expect(result.stderr).toContain("Project directory");
      expect(result.stderr).toContain("Starter template");
      expect(result.stderr).toContain("git init");
      expect(result.stderr).toContain("package manager");
      expect(result.stderr).toContain("AGENTS.md");
      // Sanity: exit happened before any scaffold work. Without [dir],
      // a non-strict create-arkor run would have created
      // `./arkor-project/` (its auto-derived default subdirectory) and
      // a `package.json` inside it — not in parentDir itself — so
      // asserting `parentDir/package.json` alone wouldn't catch a
      // regression where strict mode failed and the scaffolder still
      // ran. Assert that `parentDir` is byte-for-byte unchanged
      // instead (it was empty going in via `makeTempDir`).
      expect(existsSync(join(parentDir, "package.json"))).toBe(false);
      expect(existsSync(join(parentDir, "arkor-project"))).toBe(false);
      expect(readdirSync(parentDir)).toEqual([]);
    });

    it("still exits 1 when [dir] is given but other prompts are missing", async () => {
      // Mirror an agent invocation that knows the project name but hasn't
      // yet committed to template / git / pm / agents-md; the [dir]
      // alone is not enough to bypass the strict check.
      const { result } = await runCreateArkor([], { CLAUDECODE: "1" });
      expect(result.code).toBe(1);
      // `[dir]` is satisfied (runCreateArkor passes "target"), so the
      // missing list must omit it.
      expect(result.stderr).not.toContain("[dir]");
      expect(result.stderr).toContain("--template");
      expect(result.stderr).toContain("--git (recommended) or --skip-git");
      expect(result.stderr).toContain(
        "--agents-md (recommended) or --no-agents-md",
      );
    });

    it.each([
      ["empty string", ""],
      ["whitespace only", "   "],
      ["punctuation only", "!!!"],
    ])(
      "rejects --name %s because sanitise() would collapse it to the generic arkor-project fallback",
      async (_label, name) => {
        // ENG-736 PR review (#141): the previous check only looked at
        // whether `--name` was defined, so empty strings and inputs that
        // sanitise away to nothing both satisfied strict mode and then
        // silently became `package.json: { name: "arkor-project" }`,
        // exactly the silent-default outcome strict mode is meant to
        // surface.
        const result = await runCli(
          CREATE_ARKOR_BIN,
          [
            "--name",
            name,
            "--template",
            "triage",
            "--skip-git",
            "--skip-install",
            "--no-agents-md",
          ],
          parentDir,
          { CLAUDECODE: "1" },
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("[dir]");
        // Even though `--name <something>` was passed, the requirement
        // is reported as missing because the value would have collapsed
        // to the fallback. The description hints at that subtlety.
        expect(result.stderr).toContain("arkor-project");
      },
    );

    it("accepts `create-arkor .` (resolves to the parent dir basename, not the literal `.`)", async () => {
      // Regression for PR #141 review (codex + Copilot): the strict
      // check used to compute the project name as `basename(opts.dir)`
      // which is `"."` for `create-arkor .`, then sanitise() collapsed
      // it to the `arkor-project` fallback and strict mode falsely
      // refused the run. The check now mirrors `create-arkor`'s own
      // default-name derivation (`basename(resolve(opts.dir))`), so
      // `.` resolves to the parent dir's basename: a meaningful name.
      const result = await runCli(
        CREATE_ARKOR_BIN,
        [
          ".",
          "--template",
          "triage",
          "--skip-git",
          "--skip-install",
          "--no-agents-md",
        ],
        parentDir,
        { CLAUDECODE: "1" },
      );
      expect(result.code).toBe(0);
      // Sanity: the run reached scaffold (package.json is present in
      // the parent dir because `.` was the target).
      expect(existsSync(join(parentDir, "package.json"))).toBe(true);
    });

    it("runs to completion when every required flag is set", async () => {
      const { result, targetDir } = await runCreateArkor(
        [
          "--template",
          "triage",
          "--skip-git",
          "--skip-install",
          "--no-agents-md",
        ],
        { CLAUDECODE: "1" },
      );
      expect(result.code).toBe(0);
      expect(existsSync(join(targetDir, "src/arkor/index.ts"))).toBe(true);
      expect(existsSync(join(targetDir, "AGENTS.md"))).toBe(false);
    });

    it("accepts --yes as a wholesale opt-out of the strict check", async () => {
      // `-y` keeps the legacy "use defaults for everything" semantics for
      // callers who have explicitly delegated those decisions.
      const { result, targetDir } = await runCreateArkor(
        ["-y", "--skip-install", "--skip-git"],
        { CLAUDECODE: "1" },
      );
      expect(result.code).toBe(0);
      expect(existsSync(join(targetDir, "src/arkor/index.ts"))).toBe(true);
    });
  });
});
