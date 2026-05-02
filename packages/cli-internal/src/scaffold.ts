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
  isExistingProject: boolean,
): Promise<FileAction> {
  const path = join(cwd, GITIGNORE_PATH);
  // Required entries — every pm gets these.
  const required = ["node_modules/", "dist/", ".arkor/"];
  // Yarn-specific entries follow the same emission policy as
  // `.yarnrc.yml` in `scaffold()` (Copilot review on PR #99 round 5
  // pushed back on the inconsistency where gitignore added yarn
  // lines while yarnrc didn't):
  //   - explicit `pm === "yarn"` always adds them
  //   - undefined pm + fresh dir adds them defensively (yarn-berry
  //     user reading the manual install hint may run `yarn install`)
  //   - undefined pm + pre-existing project DOES NOT touch them —
  //     a merge into an npm/pnpm/bun repo shouldn't sprinkle yarn
  //     residue into their `.gitignore`
  const shouldEmitYarnEntries =
    packageManager === "yarn" ||
    (packageManager === undefined && !isExistingProject);
  if (shouldEmitYarnEntries) {
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

/**
 * Pull the value of the top-level `nodeLinker:` key out of a
 * `.yarnrc.yml`-shaped string, normalised to what yarn would actually
 * see at runtime. Returns `undefined` when no such key is set at the
 * root level.
 *
 * `.yarnrc.yml` is YAML; we don't pull in a full parser for one key,
 * but we do need to handle the realistic spelling variants the
 * Copilot / Codex reviews on PR #99 flagged:
 *
 *   nodeLinker: "node-modules"          # double-quoted
 *   nodeLinker: 'node-modules'          # single-quoted
 *   nodeLinker: node-modules # comment  # trailing comment
 *   nodeLinker:    node-modules         # extra whitespace
 *     nodeLinker: node-modules          # indented root mapping
 *   parent:                             # NESTED — must NOT match
 *     nodeLinker: pnp                   #   (this is parent.nodeLinker)
 *
 * Strategy: find the indentation of the first content (non-blank,
 * non-comment) line in the document — that establishes the root
 * indent. Then accept `nodeLinker:` only when it appears at exactly
 * that indent (so a deeper-indented `nodeLinker:` nested under
 * another key isn't mistaken for the root value). Within the value
 * itself, strip a trailing `# …` comment (only when preceded by
 * whitespace, so a `#` inside a quoted scalar still survives), trim,
 * then strip a single matched pair of surrounding quotes.
 */
function readNodeLinkerValue(yarnrc: string): string | undefined {
  let rootIndent: number | undefined;
  for (const line of yarnrc.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = /^(\s*)/.exec(line)?.[1].length ?? 0;
    if (rootIndent === undefined) rootIndent = indent;
    if (indent !== rootIndent) continue; // nested — skip
    const m = /^\s*nodeLinker\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[1] ?? "";
    value = value.replace(/\s+#.*$/, "").trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    return value;
  }
  return undefined;
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

// User-facing copy for the "existing `.yarnrc.yml` pins a non-`node-modules`
// linker" advisory. Centralised so the patch path (which discovers the
// conflict while attempting to write) and the inspect-only path (which
// runs when scaffold has elected NOT to mutate yarn config but still
// wants to flag the same hazard — see scaffold() comment for the
// undefined-pm + existing-project case) emit identical wording.
// Remediation says "change to node-modules" rather than "remove the
// line": yarn 4 falls back to PnP when `nodeLinker:` is absent, which
// would reproduce the same runtime failure.
function buildYarnLinkerConflictWarning(existingValue: string): string {
  return (
    `Existing .yarnrc.yml pins \`nodeLinker: ${existingValue}\`. ` +
    `arkor's runtime can't resolve dependencies through anything ` +
    `other than \`nodeLinker: node-modules\` — \`arkor dev\` and ` +
    `\`arkor train\` will fail until you change the value to ` +
    `\`node-modules\`.`
  );
}

// Caveat shown in the `pm === undefined && isExistingProject` branch
// when no usable yarn config is present (no `.yarnrc.yml`, OR a
// `.yarnrc.yml` that has no `nodeLinker:` key — both leave yarn 4 on
// its PnP default). The branch deliberately doesn't mutate the
// surrounding repo (round-5 policy: an unknown-pm merge mustn't flip
// the install mode of someone else's workspace). But the manual
// install hint still mentions `yarn install` (see init.ts /
// create-arkor's bin.ts: "npm i / pnpm install / yarn / bun
// install"), so a yarn-berry user following it lands on PnP and
// `arkor dev` fails — and yarn would also generate `.yarn/cache` /
// `.yarn/install-state.gz` that aren't covered by the
// non-yarn `.gitignore` we wrote here. Bundle both fixups into one
// advisory; clearly scope it to yarn-berry so npm/pnpm/yarn-1/bun
// users immediately know they can ignore. (PR #99 round-9 review,
// covering both flagged sites: scaffold.ts:142 and scaffold.ts:439.)
function buildYarnBerryCaveatAdvisory(): string {
  return (
    `Scaffolded into an existing project without an explicit package ` +
    `manager. If you'll install with yarn 4+ (yarn-berry), arkor's ` +
    `runtime requires \`nodeLinker: node-modules\` (its Plug'n'Play ` +
    `default is unsupported) — add \`nodeLinker: node-modules\` to a ` +
    `\`.yarnrc.yml\` and add \`.yarn/cache\` + ` +
    `\`.yarn/install-state.gz\` to \`.gitignore\` before running ` +
    `\`yarn install\`. Skip this if you're using npm, pnpm, yarn 1.x, ` +
    `or bun.`
  );
}

type YarnConfigStatus =
  | { kind: "ok" } // file exists & nodeLinker:node-modules
  | { kind: "needs-setup" } // no file, OR file with no nodeLinker key
  | { kind: "conflict"; value: string }; // file exists & nodeLinker:<other>

/**
 * Read-only counterpart to `patchYarnConfig`: classifies the existing
 * yarn config without mutating it. Used by `scaffold()` in the
 * `pm === undefined && isExistingProject` case, where we deliberately
 * don't touch yarn config (so a yarn-berry workspace's deliberate
 * PnP setup stays intact) but still want to surface the runtime
 * hazard if the user later runs `yarn install` via the manual install
 * hint.
 *
 * Three outcomes:
 *   - `ok`           — `nodeLinker: node-modules` already pinned; nothing to flag
 *   - `conflict`     — pinned to a non-`node-modules` value (e.g. `pnp`);
 *                      surface the conflict warning (PR #99 round-8)
 *   - `needs-setup`  — no `.yarnrc.yml`, OR a `.yarnrc.yml` without a
 *                      `nodeLinker:` key (yarn 4 silently defaults to PnP);
 *                      surface the yarn-berry caveat advisory (PR #99 round-9)
 */
async function inspectYarnConfig(cwd: string): Promise<YarnConfigStatus> {
  const path = join(cwd, YARNRC_YML_PATH);
  if (!existsSync(path)) return { kind: "needs-setup" };
  const value = readNodeLinkerValue(await readFile(path, "utf8"));
  if (value === undefined) return { kind: "needs-setup" };
  if (value === "node-modules") return { kind: "ok" };
  return { kind: "conflict", value };
}

/**
 * Best-effort check: does the existing `package.json` declare
 * yarn-berry (yarn 2+) via the corepack-style `packageManager` field?
 * Used to gate the `needs-setup` advisory in the
 * `pm === undefined && isExistingProject` flow — without this filter
 * the caveat fires on every undefined-pm scaffold (e.g. CLI invoked
 * via `node`/`tsx`, which doesn't set `npm_config_user_agent`),
 * including pure npm/pnpm/bun projects where it'd just be noise.
 * (PR #99 round-10 review.)
 *
 * Returns `false` (i.e. don't warn) on:
 *   - missing/unreadable/malformed `package.json`
 *   - missing or non-string `packageManager` field
 *   - `packageManager` declaring yarn 1 (it ignores `.yarnrc.yml`),
 *     pnpm, npm, or bun
 *
 * Returns `true` only when the field unambiguously declares yarn 2+
 * (e.g. `yarn@4.6.0`, `yarn@2.4.3`). yarn-berry users who haven't
 * declared the field are silently missed here, but the existing
 * `conflict` advisory still catches them when they have a `.yarnrc.yml`
 * pinned to a non-`node-modules` linker — the gap is just users who
 * are on yarn-berry, haven't declared it via corepack, and have no
 * `.yarnrc.yml` at all. They get the same silence the CLI gave them
 * before round 9; the round-10 noise reduction is the bigger win.
 */
async function existingProjectDeclaresYarnBerry(
  cwd: string,
): Promise<boolean> {
  const pkgPath = join(cwd, PACKAGE_JSON_PATH);
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      packageManager?: unknown;
    };
    const declared = pkg.packageManager;
    if (typeof declared !== "string") return false;
    const m = /^yarn@(\d+)/.exec(declared.trim());
    if (!m) return false;
    const major = Number.parseInt(m[1] ?? "", 10);
    return Number.isFinite(major) && major >= 2;
  } catch {
    // Invalid JSON / read error — be conservative and don't warn.
    return false;
  }
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
  const existingValue = readNodeLinkerValue(current);
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
  // Snapshot whether this is a merge into an already-bootstrapped
  // project BEFORE patchPackageJson runs (which would always make
  // `package.json` exist by the time we read it later). Used by the
  // yarn-config emission rules below.
  const isExistingProject = existsSync(join(cwd, PACKAGE_JSON_PATH));
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
    action: await patchGitignore(
      cwd,
      options.packageManager,
      isExistingProject,
    ),
  });
  files.push({
    path: PACKAGE_JSON_PATH,
    action: await patchPackageJson(cwd, options.name),
  });
  // Yarn-config emission rules:
  //
  //   - `pm === "yarn"` — the user explicitly opted into yarn. Always
  //     write/patch `.yarnrc.yml`, even when scaffolding into an
  //     existing project (the conflict warning above handles the
  //     case where they've already pinned a non-`node-modules` linker).
  //   - `pm === undefined` and there's NO existing `package.json` —
  //     this is a fresh scaffold where we don't yet know which pm
  //     the user will pick. The manual-install hint says "yarn /
  //     bun install", so a yarn-berry user reading it and running
  //     `yarn install` would otherwise hit the PnP default. Emit
  //     defensively. yarn 1 / npm / pnpm / bun all ignore
  //     `.yarnrc.yml`, so it's harmless for non-yarn flows.
  //   - `pm === undefined` and a `package.json` already exists —
  //     this is a merge into a pre-existing project. We can't tell
  //     whether the surrounding workspace is a yarn-berry repo
  //     deliberately on the PnP default, so silently writing
  //     `.yarnrc.yml` would flip the install mode for the whole
  //     repo. Don't touch yarn config — defer to the user (Copilot
  //     review on PR #99). Same skip applies when the user
  //     *explicitly* picked a non-yarn pm. `isExistingProject` was
  //     captured at the top of `scaffold()` before patchPackageJson
  //     overwrote that signal.
  const shouldEmitYarnConfig =
    options.packageManager === "yarn" ||
    (options.packageManager === undefined && !isExistingProject);
  if (shouldEmitYarnConfig) {
    const yarn = await patchYarnConfig(cwd);
    files.push({ path: YARNRC_YML_PATH, action: yarn.action });
    if (yarn.conflictingNodeLinker !== undefined) {
      warnings.push(buildYarnLinkerConflictWarning(yarn.conflictingNodeLinker));
    }
  } else if (
    options.packageManager === undefined &&
    isExistingProject
  ) {
    // Inspect-only counterpart to the patch path above. The
    // emission rules elected NOT to write `.yarnrc.yml` here (an
    // unknown-pm merge into a pre-existing project mustn't flip
    // the install mode of a surrounding yarn-berry workspace), but
    // the manual install hint still tells the user "yarn / bun
    // install" — so if they're on yarn-berry with `nodeLinker:
    // pnp` already pinned, `arkor dev` will fail just the same as
    // in the patch path. Read the existing config and surface the
    // appropriate advisory without touching the file:
    //   - explicit conflict (e.g. `nodeLinker: pnp`) — round 8.
    //     ALWAYS surface; an existing yarnrc with a non-default
    //     linker is unambiguous evidence the project uses
    //     yarn-berry, regardless of corepack declaration.
    //   - no usable yarn config — yarn-berry would default to PnP
    //     and the `.gitignore` we wrote here doesn't cover the
    //     `.yarn/` artifacts it'd generate either. Surface the
    //     yarn-berry caveat covering both the yarnrc and gitignore
    //     fixups the user would need (round 9). But ONLY when the
    //     existing `package.json#packageManager` field declares
    //     yarn 2+ — without that filter the caveat fires for every
    //     undefined-pm scaffold (e.g. CLI invoked via `node`/`tsx`,
    //     which doesn't set `npm_config_user_agent`), spamming
    //     pure npm/pnpm/bun projects with irrelevant noise
    //     (round 10, scaffold.ts:489 review comment).
    const status = await inspectYarnConfig(cwd);
    if (status.kind === "conflict") {
      warnings.push(buildYarnLinkerConflictWarning(status.value));
    } else if (
      status.kind === "needs-setup" &&
      (await existingProjectDeclaresYarnBerry(cwd))
    ) {
      warnings.push(buildYarnBerryCaveatAdvisory());
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
