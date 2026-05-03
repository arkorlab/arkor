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
  /**
   * Set to `true` when at least one of the surfaced `warnings` is the
   * yarn-config hazard (existing `nodeLinker: pnp` or missing/no-file
   * setup that would default yarn 4 to PnP). The arkor runtime can't
   * resolve dependencies through PnP, so running `yarn install`
   * BEFORE the user fixes the config produces no `node_modules` and
   * leaves the scaffolded app broken — the install is worse than
   * useless. Both CLIs use this flag to skip the auto-install in
   * that case and surface a "fix-then-retry" hint instead. (Copilot
   * review on PR #99 round 17 — the warning loop alone wasn't
   * enough; we have to actually NOT run install.) The flag is
   * specifically about install-blocking; future non-blocking
   * advisories (e.g. soft deprecation notices) would land in
   * `warnings` without flipping `blockInstall`.
   */
  blockInstall: boolean;
}

const INDEX_PATH = "src/arkor/index.ts";
const TRAINER_PATH = "src/arkor/trainer.ts";
const CONFIG_PATH = "arkor.config.ts";
const README_PATH = "README.md";
const GITIGNORE_PATH = ".gitignore";
const PACKAGE_JSON_PATH = "package.json";
const YARNRC_YML_PATH = ".yarnrc.yml";
const DEFAULT_ARKOR_SPEC = "^0.0.1-alpha.7";

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
  // Two distinct entry sets:
  //
  //   - On CREATE (no pre-existing `.gitignore`): write a complete
  //     starter — `node_modules/`, `dist/`, `.arkor/`, plus the
  //     yarn-cache lines under the round-14 #2 / 15 gate. We own
  //     the file in this case, so a sensible baseline is fine.
  //
  //   - On PATCH (pre-existing `.gitignore`): only ensure
  //     `.arkor/` is present. `node_modules/` and `dist/` are NOT
  //     touched — Copilot (PR #99 round 16) flagged that existing
  //     repos may intentionally track them (publish forks of
  //     build outputs, static-site `dist/` checked into a deploy
  //     branch, etc), and silently flipping the ignore policy
  //     could drop generated artifacts from `git status` without
  //     the user opting in. The yarn-cache lines aren't touched
  //     either; round-14 #2 already kept them out of pre-existing
  //     repos. Only `.arkor/` is arkor-specific enough that we're
  //     confident the user wants it ignored — otherwise their
  //     trainer cache, build cache, and credentials would all
  //     leak into commits.
  //
  // The `packageManager` and `isExistingProject` arguments are
  // therefore only consulted on CREATE; the PATCH path is
  // pm-agnostic.
  if (!existsSync(path)) {
    const initial = ["node_modules/", "dist/", ".arkor/"];
    const shouldEmitYarnEntries =
      !isExistingProject &&
      (packageManager === "yarn" || packageManager === undefined);
    if (shouldEmitYarnEntries) {
      initial.push(...YARN_GITIGNORE_LINES);
    }
    await writeFile(path, initial.map((line) => `${line}\n`).join(""));
    return "created";
  }
  const current = await readFile(path, "utf8");
  const present = new Set(
    current.split(/\r?\n/).map((line) => line.trim()),
  );
  if (present.has(".arkor/")) return "ok";
  const separator = current.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${current}${separator}.arkor/\n`);
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
    // Skip YAML structural markers — directives (`%YAML 1.2`,
    // `%TAG …`) and document boundaries (`---`, `...`). They aren't
    // mapping entries, so anchoring `rootIndent` at their column
    // would misclassify legitimately top-level keys at the
    // document's actual indent as "nested" (e.g. an explicit
    // `---\n  nodeLinker: node-modules\n` would be read as
    // missing). PR #99 round-11 review.
    const trimmed = line.trim();
    if (
      trimmed === "---" ||
      trimmed === "..." ||
      trimmed.startsWith("%")
    ) {
      continue;
    }
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
  /**
   * Set when the patch path elected NOT to mutate yarn config in an
   * existing project (round 14: explicit `--use-yarn` shouldn't flip
   * the install mode of a surrounding yarn-berry workspace, even
   * when `.yarnrc.yml` is missing or has no `nodeLinker:` key).
   * `scaffold()` turns this into the yarn-berry caveat advisory —
   * same copy as the `inspectYarnConfig` path's `berry-without-linker`
   * outcome, just reached from the explicit-yarn arm.
   */
  needsBerryCaveat?: boolean;
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
  // file exists & nodeLinker:node-modules — nothing to flag
  | { kind: "ok" }
  // no .yarnrc.yml at all — can't tell if project is yarn-berry
  // from this signal alone; caller must consult corepack
  // declaration (round 10 noise reduction)
  | { kind: "no-config" }
  // .yarnrc.yml exists but has no nodeLinker key — file's mere
  // existence is yarn-berry evidence (yarn 1 reads `.yarnrc`,
  // not `.yarnrc.yml`), so caller can warn unconditionally
  // (round 11 review)
  | { kind: "berry-without-linker" }
  // file exists & nodeLinker pinned to a non-node-modules value
  | { kind: "conflict"; value: string };

/**
 * Read-only counterpart to `patchYarnConfig`: classifies the existing
 * yarn config without mutating it. Used by `scaffold()` in the
 * `pm === undefined && isExistingProject` case, where we deliberately
 * don't touch yarn config (so a yarn-berry workspace's deliberate
 * PnP setup stays intact) but still want to surface the runtime
 * hazard if the user later runs `yarn install` via the manual install
 * hint.
 *
 * Four outcomes — see the union above for the meaning of each.
 * Round 11 split the prior `needs-setup` outcome into `no-config`
 * vs `berry-without-linker` because they need different gating in
 * the caller: `.yarnrc.yml` is a yarn 2+ artifact (yarn 1 uses
 * `.yarnrc` without the `.yml`), so its mere presence is unambiguous
 * yarn-berry evidence even when `package.json#packageManager` is
 * absent.
 */
async function inspectYarnConfig(cwd: string): Promise<YarnConfigStatus> {
  const path = join(cwd, YARNRC_YML_PATH);
  if (!existsSync(path)) return { kind: "no-config" };
  const value = readNodeLinkerValue(await readFile(path, "utf8"));
  if (value === undefined) return { kind: "berry-without-linker" };
  if (value === "node-modules") return { kind: "ok" };
  return { kind: "conflict", value };
}

/**
 * Read the corepack-style `packageManager` field from a
 * `package.json` at `pkgPath`. Returns the raw string or `undefined`
 * for any reason it can't be resolved (file missing, invalid JSON,
 * field missing or non-string). Conservative on errors so we never
 * misclassify on a malformed file.
 */
async function readPackageManagerField(
  pkgPath: string,
): Promise<string | undefined> {
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      packageManager?: unknown;
    };
    return typeof pkg.packageManager === "string"
      ? pkg.packageManager
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Walk from `cwd`'s parent up toward filesystem root looking for the
 * first `package.json` that declares a `packageManager` field. Bound
 * to 20 iterations as a defensive cap against pathological symlinks
 * (a realistic monorepo subdir is at most a handful of levels deep).
 *
 * Used by `resolveEnclosingPackageManagerField` below to cover the
 * round-16 (Copilot, PR #99) hazard: an `arkor init` scaffolded into
 * a yarn-berry monorepo subdir that has no local `package.json` yet.
 * Looking only at `cwd/package.json` would miss the parent
 * workspace's declaration entirely and silently suppress the
 * yarn-berry caveat. corepack itself uses the closest enclosing
 * declaration too, so picking the first match up the tree matches
 * runtime semantics.
 */
async function findEnclosingPackageManagerField(
  cwd: string,
): Promise<string | undefined> {
  let dir = dirname(cwd);
  for (let i = 0; i < 20; i++) {
    const declared = await readPackageManagerField(
      join(dir, PACKAGE_JSON_PATH),
    );
    if (declared !== undefined) return declared;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve the corepack-style `packageManager` declaration that
 * applies to `cwd`, preferring (in order):
 *
 *   1. The pre-existing `cwd/package.json#packageManager` field
 *      snapshotted by `preExistingPackageManagerField`.
 *      `patchPackageJson()` runs BEFORE the inspect path and
 *      replaces a missing local `package.json` with a freshly
 *      scaffolded one (no `packageManager` field), so reading
 *      from disk at this point would obscure both the
 *      pre-existing local declaration and any parent-workspace
 *      declaration. Using the pre-patch snapshot fixes that.
 *      (PR #99 round 16.)
 *   2. The closest enclosing parent's
 *      `package.json#packageManager`. Covers the
 *      "yarn-berry monorepo subdir without a local package.json"
 *      case Copilot called out — without this walk-up the round-15
 *      `isExistingProject` widening would silently suppress the
 *      caveat for those users.
 *
 * Returns `undefined` when no declaration is found anywhere up the
 * tree. The caller decides what to do with that (currently:
 * suppress the yarn-berry caveat — see
 * `pm === undefined && isExistingProject` arm).
 */
async function resolveEnclosingPackageManagerField(
  cwd: string,
  preExistingPackageManagerField: string | undefined,
): Promise<string | undefined> {
  if (preExistingPackageManagerField !== undefined) {
    return preExistingPackageManagerField;
  }
  return findEnclosingPackageManagerField(cwd);
}

/**
 * Best-effort check: does the resolved corepack-style declaration
 * name yarn 2+ (yarn-berry)?
 *
 * Returns `false` for: missing declaration, yarn 1.x (it ignores
 * `.yarnrc.yml`), pnpm, npm, bun, malformed values. Returns `true`
 * only when the value unambiguously declares yarn 2+ (e.g.
 * `yarn@4.6.0`, `yarn@2.4.3`). yarn-berry users who haven't
 * declared the field anywhere in their tree are silently missed
 * here, but the existing `conflict` advisory still catches them
 * when they have a `.yarnrc.yml` pinned to a non-`node-modules`
 * linker.
 *
 * (PR #99 round 10 introduced the gate; round 16 split the
 * resolution out so the corepack lookup uses the pre-patch local
 * snapshot + parent-tree walk-up.)
 */
function declaresYarnBerry(
  packageManagerField: string | undefined,
): boolean {
  if (typeof packageManagerField !== "string") return false;
  const m = /^yarn@(\d+)/.exec(packageManagerField.trim());
  if (!m) return false;
  const major = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(major) && major >= 2;
}

async function patchYarnConfig(
  cwd: string,
  isExistingProject: boolean,
): Promise<YarnConfigPatchResult> {
  const path = join(cwd, YARNRC_YML_PATH);
  if (!existsSync(path)) {
    if (isExistingProject) {
      // Round 14 (Copilot, PR #99): even with an explicit
      // `--use-yarn`, don't drop a brand-new `.yarnrc.yml` into a
      // pre-existing project. The surrounding workspace might be
      // a yarn-berry repo deliberately on its PnP default; writing
      // `nodeLinker: node-modules` at the root would flip the
      // install mode for the entire repo and could break
      // unrelated packages. Surface the yarn-berry caveat
      // (covering both yarnrc and gitignore) instead.
      return { action: "kept", needsBerryCaveat: true };
    }
    await writeFile(path, YARNRC_YML_CONTENT);
    return { action: "created" };
  }
  // Sub-cases for an existing `.yarnrc.yml`:
  //
  //   1. `nodeLinker: node-modules` already pinned — no-op.
  //   2. Some other explicit value (e.g. `nodeLinker: pnp`) — the
  //      user MADE a deliberate choice. Leave the file untouched
  //      and surface a conflict warning. (Round 5 + 8.)
  //   3. No `nodeLinker:` key at all — yarn 4 silently defaults to
  //      PnP. We *always* end up here with `isExistingProject=true`
  //      under round-15 semantics: a `.yarnrc.yml` on disk means
  //      `readdir(cwd)` returned at least one entry. So this
  //      branch never appends — it surfaces the same yarn-berry
  //      caveat as the no-file case. The earlier append path
  //      (round 12 had an `insertNodeLinkerIntoYarnrc` helper for
  //      YAML edge cases like trailing `...` terminators and
  //      indented root mappings) is unreachable post-round-15;
  //      removed to keep the patch surface honest.
  const current = await readFile(path, "utf8");
  const existingValue = readNodeLinkerValue(current);
  if (existingValue !== undefined) {
    if (existingValue === "node-modules") return { action: "ok" };
    return { action: "kept", conflictingNodeLinker: existingValue };
  }
  return { action: "kept", needsBerryCaveat: true };
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
  // Flipped to `true` whenever a yarn-config-blocking advisory fires
  // (conflict warning OR berry caveat). The CLIs use this to skip the
  // auto-install — see ScaffoldResult.blockInstall for the rationale.
  let blockInstall = false;
  // Snapshot whether the cwd already had any contents BEFORE
  // `ensureFile` / `patch*` start writing files. Drives the
  // yarn-config and gitignore-yarn-lines emission rules below — the
  // policy is "don't mutate workspace-level config in someone else's
  // project". Earlier rounds keyed off `existsSync(package.json)`,
  // but Copilot (PR #99 round 15) flagged that `scaffold()` also
  // supports merging into directories that aren't bootstrapped yet
  // (e.g. an existing git repo with just a README, a monorepo
  // sub-dir scaffolded for a new package, etc). Those would be
  // misclassified as "fresh" under the package.json predicate and
  // still get repo-level yarn writes — reintroducing the
  // workspace-mutation hazard rounds 5/14 closed. Use the same
  // "non-empty entries" predicate `ensureEmptyEnough` already
  // applies; the snapshot has to be taken AFTER `ensureDirExists`
  // (so the readdir doesn't ENOENT on a freshly-created dir) and
  // BEFORE the first ensureFile/patch (so we don't see our own
  // writes as pre-existing content).
  const isExistingProject =
    (await readdir(cwd)).filter((f) => f !== "." && f !== "..").length > 0;
  // Snapshot the pre-existing `package.json#packageManager` field
  // BEFORE `patchPackageJson` runs — same timing rationale as
  // `isExistingProject` above. `patchPackageJson` will create a
  // fresh `package.json` (no `packageManager` field) when none
  // exists, so a post-patch read in the inspect path would
  // obscure both the pre-existing local declaration and any
  // parent-workspace declaration we'd want to walk up to.
  // (PR #99 round 16 — Copilot flagged the timing bug after the
  // round-15 `isExistingProject` widening exposed the case.)
  const preExistingPackageManagerField = await readPackageManagerField(
    join(cwd, PACKAGE_JSON_PATH),
  );
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
    const yarn = await patchYarnConfig(cwd, isExistingProject);
    // Only record `.yarnrc.yml` in `files[]` when the file actually
    // exists on disk. The `kept + needsBerryCaveat` branch returns
    // `kept` for a file we deliberately did NOT create (round 14):
    // pushing it anyway makes both CLIs print "kept .yarnrc.yml"
    // for a file that doesn't exist, which is a confusing lie.
    // (Copilot, PR #99 round 18.) The `berry-without-linker` case
    // — file exists on disk, we declined to mutate — is still
    // legitimately `kept` and gets recorded.
    if (existsSync(join(cwd, YARNRC_YML_PATH))) {
      files.push({ path: YARNRC_YML_PATH, action: yarn.action });
    }
    if (yarn.conflictingNodeLinker !== undefined) {
      warnings.push(buildYarnLinkerConflictWarning(yarn.conflictingNodeLinker));
      blockInstall = true;
    } else if (yarn.needsBerryCaveat) {
      // Round 14: explicit `--use-yarn` against an existing project
      // where `.yarnrc.yml` is missing (or has no `nodeLinker:` key)
      // — patch path declined to mutate, surface the same caveat
      // the inspect path uses for the unknown-pm + existing-project
      // analogue. Same advisory copy, same remediation.
      warnings.push(buildYarnBerryCaveatAdvisory());
      blockInstall = true;
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
    //
    //   - `conflict` (`nodeLinker: pnp` etc) — round 8. ALWAYS
    //     surface; an existing yarnrc with a non-default linker is
    //     unambiguous evidence the project uses yarn-berry,
    //     regardless of corepack declaration.
    //   - `berry-without-linker` (`.yarnrc.yml` exists but has no
    //     `nodeLinker:` key) — round 11. ALSO unconditional: yarn 1
    //     reads `.yarnrc` (no `.yml`), so the file's mere existence
    //     is yarn-berry evidence even when `package.json#packageManager`
    //     is absent. yarn 4 would silently default to PnP here, so
    //     the user needs the same caveat as the no-file case.
    //   - `no-config` (no `.yarnrc.yml` at all) — round 9 hazard,
    //     gated by round 10 noise reduction. yarn-berry would
    //     default to PnP and the `.gitignore` we wrote doesn't
    //     cover the `.yarn/` artifacts. Only warn when the existing
    //     `package.json#packageManager` field declares yarn 2+;
    //     otherwise we'd spam pure npm/pnpm/bun projects with
    //     irrelevant noise (the CLI gets invoked via `node`/`tsx`
    //     a lot, which doesn't set `npm_config_user_agent`).
    const status = await inspectYarnConfig(cwd);
    if (status.kind === "conflict") {
      warnings.push(buildYarnLinkerConflictWarning(status.value));
      blockInstall = true;
    } else if (status.kind === "berry-without-linker") {
      warnings.push(buildYarnBerryCaveatAdvisory());
      blockInstall = true;
    } else if (status.kind === "no-config") {
      // Round 16 (Copilot, PR #99): consult the pre-patch
      // local snapshot AND the parent tree for the corepack
      // declaration. The bare cwd-only check would (a) misread
      // a freshly scaffolded `package.json` because
      // `patchPackageJson` already ran above, and (b) miss
      // the entire parent-workspace declaration in the
      // monorepo-subdir case round 15 widened us into.
      const declared = await resolveEnclosingPackageManagerField(
        cwd,
        preExistingPackageManagerField,
      );
      if (declaresYarnBerry(declared)) {
        warnings.push(buildYarnBerryCaveatAdvisory());
        blockInstall = true;
      }
    }
  }
  return { files, cwd, warnings, blockInstall };
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
