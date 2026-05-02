import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARKOR_BIN } from "./bins";
import { cleanup, makeTempDir, runCli, runGit } from "./spawn-cli";

let cwd: string;

beforeEach(() => {
  cwd = makeTempDir("arkor-init-e2e-");
});

afterEach(() => {
  cleanup(cwd);
});

const SKIP_INSTALL = process.env.SKIP_E2E_INSTALL === "1";
// Selects which package manager the install-matrix sub-suite exercises.
// CI sets one value per runner via the install-matrix job (see
// .github/workflows/ci.yaml). Locally this is unset and only the
// `localDefault` cases run.
const E2E_PM = process.env.ARKOR_E2E_PM;

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
        "chatml",
      ],
      cwd,
    );
    expect(result.code).toBe(0);

    const trainer = readFileSync(join(cwd, "src/arkor/trainer.ts"), "utf8");
    expect(trainer).toContain('"chatml-run"');

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
  // accepts. Each case scaffolds a project, runs `<pm> install` through the
  // SDK, and verifies the deps tree + the git commit step landed.
  //
  // Gating:
  //   - `SKIP_E2E_INSTALL=1`: opt out globally (fast-iteration CI lanes).
  //   - `ARKOR_E2E_PM=<label>`: run exactly one case. The CI install-matrix
  //     job uses this so each runner exercises one pm with the right
  //     binary version on PATH (e.g. `pnpm-9` vs `pnpm-11`, `yarn`
  //     classic vs berry).
  //   - When `ARKOR_E2E_PM` is unset, only `localDefault` cases run.
  //     yarn / yarn-berry / bun aren't local prerequisites for working on
  //     arkor, so they only run on the CI matrix where the runtime is
  //     installed beforehand. npm + pnpm stay locally runnable to keep
  //     the existing dev loop working.
  const installCases = [
    { label: "npm",        flag: "npm",  localDefault: true  },
    { label: "pnpm",       flag: "pnpm", localDefault: true  },
    { label: "yarn",       flag: "yarn", localDefault: false },
    // yarn-berry shares the SDK's `--use-yarn` flag; the CI matrix swaps
    // the `yarn` binary in PATH between 1.x (classic) and 4.x (berry).
    { label: "yarn-berry", flag: "yarn", localDefault: false },
    { label: "bun",        flag: "bun",  localDefault: false },
  ] as const;

  for (const { label, flag, localDefault } of installCases) {
    const skip =
      SKIP_INSTALL ||
      (E2E_PM !== undefined && E2E_PM !== label) ||
      (E2E_PM === undefined && !localDefault);

    it.skipIf(skip)(
      `runs real ${label} install + git commit`,
      async () => {
        const result = await runCli(
          ARKOR_BIN,
          ["init", "-y", `--use-${flag}`, "--git"],
          cwd,
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
      },
      180_000,
    );
  }
});
