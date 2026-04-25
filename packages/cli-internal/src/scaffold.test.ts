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

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cli-internal-test-"));
});

afterEach(() => {
  process.env.npm_config_user_agent = ORIG_UA;
  rmSync(cwd, { recursive: true, force: true });
});

describe("scaffold", () => {
  it("writes all starter files in an empty directory", async () => {
    const result = await scaffold({ cwd, name: "my-app", template: "minimal" });
    expect(result.files.map((f) => f.action)).toEqual([
      "created",
      "created",
      "created",
      "created",
      "created",
    ]);

    const entry = readFileSync(join(cwd, "src/arkor/index.ts"), "utf8");
    expect(entry).toContain("createTrainer");
    expect(entry).toContain("unsloth/gemma-4-E4B-it");

    const pkg = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.name).toBe("my-app");
    expect(pkg.scripts).toMatchObject({ train: "arkor train", dev: "arkor dev" });

    const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain(".arkor/");
  });

  it("keeps existing src/arkor/index.ts untouched", async () => {
    const existing = "// custom\nexport default {};\n";
    writeFileSync(join(cwd, "placeholder.txt"), "keep me");
    const { readdirSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), existing);

    const result = await scaffold({ cwd, name: "foo", template: "minimal" });
    const entryFile = result.files.find(
      (f) => f.path === "src/arkor/index.ts",
    );
    expect(entryFile?.action).toBe("kept");
    expect(readFileSync(join(cwd, "src/arkor/index.ts"), "utf8")).toBe(existing);
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
    expect(scripts.build).toBe("tsc");
    expect(scripts.train).toBe("arkor train");
    expect(scripts.dev).toBe("arkor dev");
    const devDeps = patched.devDependencies as Record<string, string>;
    expect(devDeps.arkor).toBe("^0.0.1-alpha.0");

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

  it("renders each template with a distinct entry body", async () => {
    const expectations: Record<"minimal" | "alpaca" | "chatml", string> = {
      minimal: `"my-first-run"`,
      alpaca: `"alpaca-run"`,
      chatml: `"chatml-run"`,
    };
    for (const template of ["minimal", "alpaca", "chatml"] as const) {
      const dir = mkdtempSync(join(tmpdir(), `scaffold-${template}-`));
      await scaffold({ cwd: dir, name: template, template });
      const entry = readFileSync(join(dir, "src/arkor/index.ts"), "utf8");
      expect(entry).toContain(expectations[template]);
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
  it("exposes every template with a hint", () => {
    const list = templateChoices();
    expect(list.map((t) => t.value).sort()).toEqual([
      "alpaca",
      "chatml",
      "minimal",
    ]);
    for (const t of list) {
      expect(t.label).toBeTruthy();
      expect(t.hint).toBeTruthy();
    }
  });
});
