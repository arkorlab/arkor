import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PackageManager } from "./package-manager";
import {
  STARTER_CONFIG,
  STARTER_INDEX,
  STARTER_README,
  TEMPLATES,
  type TemplateId,
} from "./templates";

export type FileAction = "created" | "kept" | "patched" | "ok";

export interface ScaffoldOptions {
  /** Destination directory — created if it does not already exist. */
  cwd: string;
  /** Project name used in package.json + README. */
  name: string;
  template: TemplateId;
  /**
   * Package manager the user picked. Drives pm-specific scaffolding —
   * currently used to emit a `.yarnrc.yml` that pins
   * `nodeLinker: node-modules` so yarn-berry doesn't fall back to its
   * Plug'n'Play default. PnP omits `node_modules/` and requires a
   * runtime loader to resolve modules; the arkor runtime (esbuild →
   * `node ./.arkor/build/index.mjs`) doesn't load PnP, so a vanilla
   * yarn-4 install would leave `arkor dev` / `arkor train` unable to
   * find their dependencies. yarn 1.x ignores `.yarnrc.yml` (it reads
   * `.yarnrc`), so the file is harmless on the classic line.
   *
   * `undefined` is treated as "could be yarn" rather than "skip yarn
   * config" — both `arkor init` and `create-arkor` have a real
   * undetected-pm path that prints the manual install hint
   * (`install dependencies (npm i / pnpm install / yarn / bun
   * install)`), so a yarn-berry user reading the hint and running
   * `yarn install` would otherwise hit the PnP default. The
   * `.yarnrc.yml` and yarn-cache `.gitignore` lines are emitted in
   * the undefined case too. Only an explicit non-yarn pm
   * (`"npm" | "pnpm" | "bun"`) opts the project out — those signal
   * the user committed to a different package manager.
   */
  packageManager?: PackageManager;
}

export interface ScaffoldResult {
  files: Array<{ path: string; action: FileAction }>;
  cwd: string;
  /**
   * Non-fatal advisories the scaffolder couldn't fix on its own.
   * Currently the only emitter is the `.yarnrc.yml` patch path: when
   * the existing file pins `nodeLinker:` to a value the arkor runtime
   * can't load through (e.g. `pnp`), we leave the file `kept` (per
   * Copilot's PR #99 review — silently rewriting would change install
   * mode for the whole pre-existing yarn-berry workspace) and surface
   * a warning here so the CLI can tell the user the project will
   * install but not run until the linker is fixed. Empty when there
   * is nothing to flag.
   */
  warnings: string[];
}

const INDEX_PATH = "src/arkor/index.ts";
const TRAINER_PATH = "src/arkor/trainer.ts";
const CONFIG_PATH = "arkor.config.ts";
const README_PATH = "README.md";
const GITIGNORE_PATH = ".gitignore";
const PACKAGE_JSON_PATH = "package.json";
const YARNRC_YML_PATH = ".yarnrc.yml";
const DEFAULT_ARKOR_SPEC = "^0.0.1-alpha.6";

// Single-key config: `nodeLinker: node-modules` forces yarn-berry to
// materialise a real node_modules tree instead of its Plug'n'Play default.
// See ScaffoldOptions.packageManager for the why.
const YARNRC_YML_CONTENT = "nodeLinker: node-modules\n";

// .gitignore entries that yarn-berry generates inside `.yarn/` regardless
// of nodeLinker. `.yarn/cache/` holds zipped tarballs of every dependency
// (typically tens of MB) and `.yarn/install-state.gz` is a per-install
// state file — neither belongs in git. yarn classic (1.x) doesn't create
// `.yarn/` at all so these entries are harmless on that line.
const YARN_GITIGNORE_LINES = [".yarn/cache", ".yarn/install-state.gz"];

function resolveArkorScaffoldSpec(): string {
  // Treat unset, empty, and whitespace-only values the same: fall back to
  // the default. Without this, `ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC=""`
  // (or just spaces) would write `"arkor": ""` into the scaffolded
  // package.json, which is not a valid dependency spec.
  const override = process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC?.trim();
  return override && override.length > 0 ? override : DEFAULT_ARKOR_SPEC;
}

const SCRIPT_DEFAULTS: Record<string, string> = {
  dev: "arkor dev",
  build: "arkor build",
  start: "arkor start",
};

async function ensureDirExists(cwd: string): Promise<void> {
  if (!existsSync(cwd)) {
    await mkdir(cwd, { recursive: true });
  }
}

async function ensureEmptyEnough(cwd: string): Promise<void> {
  const entries = (await readdir(cwd)).filter((f) => f !== "." && f !== "..");
  if (entries.length === 0) return;
  // Allow scaffolding into an existing project — but prevent overwriting if
  // any target files already exist. `ensureFile` below keeps existing files.
}

async function ensureFile(
  absPath: string,
  contents: string,
): Promise<FileAction> {
  if (existsSync(absPath)) return "kept";
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, contents);
  return "created";
}

async function patchGitignore(
  cwd: string,
  packageManager: PackageManager | undefined,
): Promise<FileAction> {
  const path = join(cwd, GITIGNORE_PATH);
  // Required entries — every pm gets these.
  const required = ["node_modules/", "dist/", ".arkor/"];
  // Yarn-specific entries fire when the user picked yarn or hasn't
  // picked anything yet (the manual install hint flow). Same defensive
  // logic as the .yarnrc.yml emission in `scaffold()` — protect the
  // user who reads "yarn / bun install" in the hint and picks yarn,
  // without polluting an explicit npm / pnpm / bun tree.
  if (packageManager === "yarn" || packageManager === undefined) {
    required.push(...YARN_GITIGNORE_LINES);
  }

  if (!existsSync(path)) {
    await writeFile(path, required.map((line) => `${line}\n`).join(""));
    return "created";
  }
  const current = await readFile(path, "utf8");
  const present = new Set(
    current.split(/\r?\n/).map((line) => line.trim()),
  );
  const missing = required.filter((line) => !present.has(line));
  if (missing.length === 0) return "ok";
  const separator = current.endsWith("\n") ? "" : "\n";
  await writeFile(
    path,
    `${current}${separator}${missing.map((line) => `${line}\n`).join("")}`,
  );
  return "patched";
}

interface YarnConfigPatchResult {
  action: FileAction;
  /**
   * Set when the existing `.yarnrc.yml` had `nodeLinker:` pinned to
   * a value other than `node-modules` and we elected to keep it.
   * `scaffold()` turns this into a user-facing warning — the project
   * will install but `arkor dev` / `arkor train` will fail until the
   * linker is changed.
   */
  conflictingNodeLinker?: string;
}

async function patchYarnConfig(cwd: string): Promise<YarnConfigPatchResult> {
  const path = join(cwd, YARNRC_YML_PATH);
  if (!existsSync(path)) {
    await writeFile(path, YARNRC_YML_CONTENT);
    return { action: "created" };
  }
  // Three sub-cases for an existing `.yarnrc.yml`:
  //
  //   1. No `nodeLinker:` key at all — yarn 4 silently defaults to
  //      PnP. The user clearly didn't make a deliberate linker
  //      choice, so it's safe to APPEND `nodeLinker: node-modules`;
  //      other settings are preserved verbatim.
  //   2. `nodeLinker: node-modules` already pinned — no-op.
  //   3. Some other explicit value (e.g. `nodeLinker: pnp`) — the
  //      user MADE a deliberate choice. `arkor init` /
  //      `create-arkor .` both support merging into existing
  //      directories, so silently rewriting `pnp` → `node-modules`
  //      would flip the install mode for the entire repo and could
  //      break unrelated packages (Copilot review on PR #99). Leave
  //      the file untouched and surface a warning via
  //      `conflictingNodeLinker`; the CLI shows it to the user so a
  //      `kept` doesn't silently set them up for an `arkor dev`
  //      failure (Copilot follow-up review).
  const current = await readFile(path, "utf8");
  const lines = current.split(/\r?\n/);
  // Match `nodeLinker:` at line start (yarnrc.yml is YAML, top-level
  // keys live at column 0). Capture the value (rest of the line,
  // trimmed) so the warning can quote it back to the user.
  const nodeLinkerRe = /^nodeLinker\s*:\s*(.*)$/;
  let existingValue: string | undefined;
  for (const line of lines) {
    const m = nodeLinkerRe.exec(line);
    if (m) {
      existingValue = m[1]?.trim() ?? "";
      break;
    }
  }
  if (existingValue !== undefined) {
    if (existingValue === "node-modules") return { action: "ok" };
    return { action: "kept", conflictingNodeLinker: existingValue };
  }
  // No `nodeLinker:` line at all — append. Keep the existing
  // trailing-newline shape (mirrors patchGitignore).
  const separator = current.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${current}${separator}${YARNRC_YML_CONTENT}`);
  return { action: "patched" };
}

async function patchPackageJson(
  cwd: string,
  name: string,
): Promise<FileAction> {
  const path = join(cwd, PACKAGE_JSON_PATH);
  if (!existsSync(path)) {
    await writeFile(
      path,
      `${JSON.stringify(
        {
          name,
          private: true,
          type: "module",
          scripts: { ...SCRIPT_DEFAULTS },
          devDependencies: { arkor: resolveArkorScaffoldSpec() },
        },
        null,
        2,
      )}\n`,
    );
    return "created";
  }
  const current = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  const scripts =
    (current.scripts as Record<string, string> | undefined) ?? {};
  let dirty = false;
  for (const [key, value] of Object.entries(SCRIPT_DEFAULTS)) {
    if (!scripts[key]) {
      scripts[key] = value;
      current.scripts = scripts;
      dirty = true;
    }
  }
  const devDeps =
    (current.devDependencies as Record<string, string> | undefined) ?? {};
  if (!devDeps.arkor) {
    devDeps.arkor = resolveArkorScaffoldSpec();
    current.devDependencies = devDeps;
    dirty = true;
  }
  if (!dirty) return "ok";
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);
  return "patched";
}

export async function scaffold(
  options: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const cwd = resolve(options.cwd);
  await ensureDirExists(cwd);
  await ensureEmptyEnough(cwd);

  const files: ScaffoldResult["files"] = [];
  const warnings: string[] = [];
  files.push({
    path: INDEX_PATH,
    action: await ensureFile(join(cwd, INDEX_PATH), STARTER_INDEX),
  });
  files.push({
    path: TRAINER_PATH,
    action: await ensureFile(
      join(cwd, TRAINER_PATH),
      TEMPLATES[options.template].trainer,
    ),
  });
  files.push({
    path: CONFIG_PATH,
    action: await ensureFile(join(cwd, CONFIG_PATH), STARTER_CONFIG),
  });
  files.push({
    path: README_PATH,
    action: await ensureFile(
      join(cwd, README_PATH),
      STARTER_README(options.name),
    ),
  });
  files.push({
    path: GITIGNORE_PATH,
    action: await patchGitignore(cwd, options.packageManager),
  });
  files.push({
    path: PACKAGE_JSON_PATH,
    action: await patchPackageJson(cwd, options.name),
  });
  // Defensive yarn config emission: also fires when pm is undefined.
  // Both `arkor init` and `create-arkor` have a real "we couldn't
  // detect a pm" path that prints the manual install hint (`install
  // dependencies (npm i / pnpm install / yarn / bun install)`) and
  // hands off — at that point a yarn-berry user reading the hint and
  // running `yarn install` would otherwise hit the PnP default and
  // get a project the arkor runtime can't load. yarn 1.x and yarn-
  // berry both ignore `.yarnrc.yml` when not in use (yarn 1 reads
  // `.yarnrc`; berry only consults it if you're actually invoking
  // yarn), and npm / pnpm / bun don't read it at all, so emitting
  // for the undefined-pm case is harmless for non-yarn flows. Only
  // skip when the user *explicitly* picked another pm (npm / pnpm /
  // bun) — that's a clear signal they aren't going to switch.
  if (
    options.packageManager === "yarn" ||
    options.packageManager === undefined
  ) {
    const yarn = await patchYarnConfig(cwd);
    files.push({ path: YARNRC_YML_PATH, action: yarn.action });
    if (yarn.conflictingNodeLinker !== undefined) {
      // The user's existing `.yarnrc.yml` pins `nodeLinker:` to a
      // value the arkor runtime can't load through. Scaffold
      // succeeds (we don't want to corrupt their pre-existing yarn
      // workspace by silently rewriting it — see patchYarnConfig
      // for the rationale) but the project won't actually run
      // until the linker is changed. Surface it loud.
      warnings.push(
        `Existing .yarnrc.yml pins \`nodeLinker: ${yarn.conflictingNodeLinker}\`. ` +
          `arkor's runtime requires \`nodeLinker: node-modules\` to resolve ` +
          `dependencies — \`arkor dev\` and \`arkor train\` will fail until ` +
          `you change it (or remove the line so yarn uses the scaffolded ` +
          `\`.yarnrc.yml\` default).`,
      );
    }
  }
  return { files, cwd, warnings };
}

export function templateChoices(): Array<{
  value: TemplateId;
  label: string;
  hint: string;
}> {
  return (Object.keys(TEMPLATES) as TemplateId[]).map((key) => ({
    value: key,
    label: TEMPLATES[key].label,
    hint: TEMPLATES[key].hint,
  }));
}
