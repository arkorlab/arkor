import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
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
// (`file:D:\...`, `file:D:/...`, `file:///D:/...` all break — pnpm strips
// the prefix and joins to the install cwd, then aborts with
// `ENOENT: scandir '<cwd>\D:\...'`). The install-matrix tests sidestep
// that by pre-packing arkor into a tarball once per file and copying it
// into each test's cwd as `vendor/arkor-*.tgz`, then overriding the
// scaffold spec to `file:./vendor/<basename>` — a relative path with no
// drive letter to misparse. SKIP_INSTALL=1 short-circuits the pack since
// none of the gated tests will run.
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

    expect(result.stdout).toContain("Next:");
    // pm undefined → manual install hint surfaces in the outro.
    expect(result.stdout).toContain(
      "install dependencies (npm i / pnpm install / yarn / bun install)",
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

  // Regression for ENG-357 — `--name "Foo Bar"` previously fell through to
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
  // Per-case the test stages a pre-packed `arkor-*.tgz` under
  // `cwd/vendor/` and points the scaffold spec at the relative path
  // — see the top-of-file beforeAll for why pnpm 10 can't parse an
  // absolute Windows `file:` URI directly. Lockfile-by-flag drives
  // the post-install assertion that verifies git init runs *after*
  // install (so the bootstrap commit is reproducible).
  const LOCKFILE_BY_FLAG: Record<"npm" | "pnpm" | "yarn" | "bun", string> = {
    npm: "package-lock.json",
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
    bun: "bun.lock",
  };
  for (const { label, flag } of INSTALL_CASES) {
    it.skipIf(shouldSkipInstallCase(label))(
      `runs real ${label} install + git commit (gated by SKIP_E2E_INSTALL)`,
      async () => {
        if (!arkorTarball) {
          throw new Error("arkor tarball wasn't packed in beforeAll");
        }
        const tarballName = basename(arkorTarball);
        mkdirSync(join(cwd, "vendor"), { recursive: true });
        copyFileSync(arkorTarball, join(cwd, "vendor", tarballName));

        const result = await runCli(
          ARKOR_BIN,
          ["init", "-y", `--use-${flag}`, "--git"],
          cwd,
          { ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC: `file:./vendor/${tarballName}` },
        );
        // arkor init swallows `<pm> install` failures into a one-line
        // warning so the user can retry manually — that means a broken
        // pm setup leaves us with `result.code === 0` but no
        // node_modules and only a warn buried in stderr. Surface the
        // captured stdout/stderr eagerly when an assertion is about to
        // fail so the install-matrix CI logs are diagnostic rather than
        // a bare `expected false to be true`.
        if (
          result.code !== 0 ||
          !existsSync(join(cwd, "node_modules"))
        ) {
          // eslint-disable-next-line no-console
          console.error(
            `[install-matrix:${label}] arkor init failed to produce node_modules:\n` +
              `  exit: ${result.code}\n` +
              `  --- stdout ---\n${result.stdout}\n` +
              `  --- stderr ---\n${result.stderr}`,
          );
        }
        expect(result.code).toBe(0);
        // Every pm — including yarn-berry — produces a real node_modules
        // tree because the scaffold writes `.yarnrc.yml` with
        // `nodeLinker: node-modules` whenever the user picked yarn (see
        // packages/cli-internal/src/scaffold.ts). Without that pin
        // yarn-berry would default to Plug'n'Play and the arkor runtime
        // would fail to resolve modules.
        expect(existsSync(join(cwd, "node_modules"))).toBe(true);
        expect(existsSync(join(cwd, ".git/HEAD"))).toBe(true);

        const log = await runGit(cwd, ["log", "-1", "--format=%s"]);
        expect(log.stdout.trim()).toBe("Initial commit from `arkor init`");

        // Lockfile-in-initial-commit invariant: the git-init prompt
        // is surfaced *before* install so the user can walk away, but
        // git init execution still happens *after* install — otherwise
        // the lockfile wouldn't be tracked and the bootstrap commit
        // wouldn't be reproducible.
        const tracked = await runGit(cwd, ["ls-tree", "-r", "--name-only", "HEAD"]);
        expect(tracked.stdout).toContain(LOCKFILE_BY_FLAG[flag]);
      },
      180_000,
    );
  }
});
