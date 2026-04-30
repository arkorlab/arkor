import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const result = await scaffold({ cwd, name: "my-app", template: "minimal" });
    // index.ts, trainer.ts, arkor.config.ts, README.md, .gitignore, package.json
    expect(result.files.map((f) => f.action)).toEqual([
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
    expect(trainer).toContain('"my-first-run"');

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

    const result = await scaffold({ cwd, name: "foo", template: "minimal" });
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
      template: "minimal",
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
    expect(devDeps.arkor).toBe("^0.0.1-alpha.4");

    const pkgEntry = files.find((f) => f.path === "package.json");
    expect(pkgEntry?.action).toBe("patched");
  });

  it("appends to an existing .gitignore only if the entry is missing", async () => {
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    const first = await scaffold({ cwd, name: "n", template: "minimal" });
    const firstEntry = first.files.find((f) => f.path === ".gitignore");
    expect(firstEntry?.action).toBe("patched");
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toContain(".arkor/");

    const second = await scaffold({ cwd, name: "n", template: "minimal" });
    const secondEntry = second.files.find((f) => f.path === ".gitignore");
    expect(secondEntry?.action).toBe("ok");
  });

  it("uses ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC override when set", async () => {
    // The value is opaque to scaffold — only that it's faithfully
    // round-tripped into package.json matters, so use a relative
    // `file:` spec that is platform-neutral (no Unix-only `/tmp`).
    const overrideSpec = "file:./vendor/arkor-0.0.1-alpha.4.tgz";
    process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC = overrideSpec;
    const { files } = await scaffold({
      cwd,
      name: "override-app",
      template: "minimal",
    });
    const pkg = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const devDeps = pkg.devDependencies as Record<string, string>;
    expect(devDeps.arkor).toBe(overrideSpec);
    const pkgEntry = files.find((f) => f.path === "package.json");
    expect(pkgEntry?.action).toBe("created");
  });

  it("uses ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC override when patching an existing package.json", async () => {
    // The spec resolution is shared between the create path (above)
    // and the patch path that runs when `package.json` already exists
    // but has no `devDependencies.arkor`. Cover the patch path too so
    // the override doesn't silently regress to the default there.
    const overrideSpec = "file:./vendor/arkor-0.0.1-alpha.4.tgz";
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
      template: "minimal",
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

  it("renders each template with a distinct trainer body", async () => {
    const expectations: Record<"minimal" | "alpaca" | "chatml", string> = {
      minimal: `"my-first-run"`,
      alpaca: `"alpaca-run"`,
      chatml: `"chatml-run"`,
    };
    for (const template of ["minimal", "alpaca", "chatml"] as const) {
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
  it("exposes only the non-hidden templates with a hint", () => {
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
