import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
async function runCreateArkor(argv: string[]) {
  const targetDir = join(parentDir, "target");
  const result = await runCli(
    CREATE_ARKOR_BIN,
    ["target", ...argv],
    parentDir,
  );
  return { result, targetDir };
}

const SKIP_INSTALL = process.env.SKIP_E2E_INSTALL === "1";

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

    const pkg = JSON.parse(
      readFileSync(join(targetDir, "package.json"), "utf8"),
    ) as { name?: string };
    expect(pkg.name).toBe(basename(targetDir));

    const entry = readFileSync(join(targetDir, "src/arkor/index.ts"), "utf8");
    expect(entry).toContain("createTrainer");

    // No `--use-*` and CI=1 → pm undefined → manual install hint + npx train.
    expect(result.stdout).toContain("npx arkor train");
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
    expect(result.stdout).toContain("pnpm arkor train");
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
    expect(result.stdout).toContain("npx arkor train");
  });

  it.each([
    { pm: "yarn", trainCmd: "yarn arkor train" },
    { pm: "bun", trainCmd: "bun arkor train" },
  ])("renders the $pm next-steps when --use-$pm is set", async ({ pm, trainCmd }) => {
    const { result } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--skip-git",
      `--use-${pm}`,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${pm} install`);
    expect(result.stdout).toContain(trainCmd);
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

  it("does not prompt when --name + --template are provided without -y", async () => {
    // No `-y`, but every prompted value is supplied as a flag. The run
    // should complete without hanging and apply the flag values.
    const { result, targetDir } = await runCreateArkor([
      "--skip-install",
      "--skip-git",
      "--name",
      "no-prompt-app",
      "--template",
      "chatml",
    ]);
    expect(result.code).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(targetDir, "package.json"), "utf8"),
    ) as { name?: string };
    expect(pkg.name).toBe("no-prompt-app");

    const entry = readFileSync(join(targetDir, "src/arkor/index.ts"), "utf8");
    expect(entry).toContain('"chatml-run"');
  });

  it("honours --name --template alpaca", async () => {
    const { result, targetDir } = await runCreateArkor([
      "-y",
      "--skip-install",
      "--skip-git",
      "--name",
      "custom-app",
      "--template",
      "alpaca",
    ]);
    expect(result.code).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(targetDir, "package.json"), "utf8"),
    ) as { name?: string };
    expect(pkg.name).toBe("custom-app");

    const entry = readFileSync(join(targetDir, "src/arkor/index.ts"), "utf8");
    expect(entry).toContain('"alpaca-run"');
  });

  it.skipIf(SKIP_INSTALL).each([{ pm: "npm" }, { pm: "pnpm" }])(
    "runs real $pm install + git commit (gated by SKIP_E2E_INSTALL)",
    async ({ pm }) => {
      const { result, targetDir } = await runCreateArkor([
        "-y",
        `--use-${pm}`,
        "--git",
      ]);
      expect(result.code).toBe(0);
      expect(existsSync(join(targetDir, "node_modules"))).toBe(true);
      expect(existsSync(join(targetDir, ".git/HEAD"))).toBe(true);

      const log = await runGit(targetDir, ["log", "-1", "--format=%s"]);
      expect(log.stdout.trim()).toBe("Initial commit from Create Arkor");
    },
    180_000,
  );
});
