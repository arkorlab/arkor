import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PackageManager } from "./package-manager";
import { detectYarnMajor } from "./yarn-version";
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
  /**
   * Opt esbuild's postinstall script into running on `pnpm install` —
   * sets `allowBuilds.esbuild` to `true` in the emitted
   * `pnpm-workspace.yaml`. Default `false` (deny) is the supply-chain
   * safe choice and is sufficient because pnpm already ships
   * `@esbuild/<platform>` as an `optionalDependency` (see
   * `pnpmWorkspaceContent()`'s comment for the exception cases).
   *
   * Wired only through `pnpm-workspace.yaml` — yarn / npm / bun ignore
   * the file, so this flag has no observable effect for those package
   * managers today. We still accept it unconditionally so scaffolding
   * a project with `--use-npm` and switching to pnpm later doesn't
   * silently strip the user's earlier `--allow-builds` choice.
   */
  allowBuilds?: boolean;
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
const PNPM_WORKSPACE_PATH = "pnpm-workspace.yaml";
const DEFAULT_ARKOR_SPEC = "^0.0.1-alpha.9";

// pnpm 11 errors out (`ERR_PNPM_IGNORED_BUILDS`, exit 1) on packages
// with postinstall scripts unless the project either approves or
// explicitly denies the dep. arkor's only flagged build script is
// esbuild's, which downloads/verifies the platform-specific binary
// — but pnpm already installs `@esbuild/<platform>` as an
// optionalDependency, so `arkor build` works *without* the
// postinstall in the common case. We therefore pin the scaffolded
// default to "deny" rather than "allow" — running arbitrary install
// scripts is a supply-chain hazard pnpm 11 deliberately makes the
// user opt into.
//
// Allow-list location across pnpm versions:
//
//   - pnpm 9:  no allow-list — runs build scripts unconditionally.
//              REQUIRES `packages:` if `pnpm-workspace.yaml` exists,
//              else errors "packages field missing or empty".
//   - pnpm 10: warns (but exits 0) on ignored builds. Honours
//              `package.json#pnpm.onlyBuiltDependencies` AND
//              `pnpm-workspace.yaml#allowBuilds`.
//   - pnpm 11: ERRORS on ignored builds. Does NOT honour
//              `package.json#pnpm.onlyBuiltDependencies` —
//              configuration moved to `pnpm-workspace.yaml#allowBuilds`
//              (map form: `{ <pkg>: true | false }`, what `pnpm
//              approve-builds` writes). The package.json field is
//              silently ignored. `false` counts as "considered" and
//              suppresses the error.
//
// Hence: write `pnpm-workspace.yaml` with both `packages: []` (for
// pnpm-9 compat — pnpm 10/11 don't require it but tolerate it) and
// `allowBuilds: { esbuild: false }` (silences pnpm 11's error
// without granting esbuild the right to run code at install time).
// Tested against pnpm 9.15.9, 10.33.2, and 11.0.3. (PR #99 round
// 36 — CI run 25351227697 showed `package.json#pnpm
// .onlyBuiltDependencies` had no effect on pnpm 11.)
//
// yarn / npm / bun do not read `pnpm-workspace.yaml`, so the file is
// inert for those package managers.
function pnpmWorkspaceContent(allowEsbuild: boolean): string {
  return `# pnpm config (yarn / npm / bun ignore this file).
# \`packages: []\` keeps pnpm 9 from erroring on the workspace file
# while leaving the project as a single non-workspace package.
#
# \`allowBuilds\` is pnpm 11's allow-list for postinstall scripts.
# pnpm already installs esbuild's platform-specific binary as an
# \`optionalDependency\`, so the postinstall script is unnecessary
# in normal use — the scaffold defaults to \`false\` (deny) as a
# supply-chain precaution. Pass \`--allow-builds\` to \`arkor init\` /
# \`create-arkor\` (or flip the entry to \`true\` here) if you hit a
# case where esbuild fails to find its binary (rare; usually a
# broken installer or unusual platform).
packages: []
allowBuilds:
  esbuild: ${allowEsbuild ? "true" : "false"}
`;
}

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
  //     This branch ALSO fires when scaffolding into an existing
  //     repo that simply has no `.gitignore` yet (e.g. a fresh
  //     `git init` + README pre-existing project — round-15
  //     widening's `isExistingProject=true`). That's intentional:
  //     the round-16 conservatism applies to the PATCH path's
  //     "don't flip an existing ignore policy"; if there's no
  //     gitignore at all, dropping the standard four-entry
  //     starter is strictly additive (we never DROP a track from
  //     git, only add ignores). Users who deliberately track
  //     `node_modules/` / `dist/` already have a `.gitignore`
  //     that excludes those entries, which sends us down the
  //     PATCH path and leaves their policy alone. The
  //     yarn-cache extras are still gated by `isExistingProject`
  //     so we don't add them when merging into someone else's
  //     repo (round 14 #2 / 15 — even on the CREATE branch).
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
  // The `packageManager` and `isExistingProject` arguments drive
  // the yarn-cache extras on CREATE; the PATCH path is
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

// Caveat shown when scaffold detected yarn 2+ (yarn-berry) on an
// existing project but no usable `nodeLinker: node-modules` setup.
// arkor's runtime can't resolve dependencies through Plug'n'Play
// (yarn-berry's default), so `yarn install` would land on PnP and
// `arkor dev` / `arkor train` would break.
//
// Path-agnostic copy — emitted from BOTH the explicit `--use-yarn`
// patch path (via `needsBerryCaveat`) AND the
// `pm === undefined && isExistingProject` inspect path (when the
// inspect helpers find positive yarn-berry signal).
//
// Round 29 (Copilot, PR #99) trimmed the round-9 `.yarn/cache` /
// `.yarn/install-state.gz` `.gitignore` recommendation: the
// surrounding `patchGitignore` deliberately doesn't add those
// entries to existing repos (round-14 #2 / 15 — Yarn zero-install
// setups commit `.yarn/cache/` on purpose), so prescribing them
// in the advisory contradicted our own patch policy. The user
// keeps full control over their `.yarn/` policy; the advisory
// only flags the runtime-blocking `nodeLinker` fix.
//
// Round 30 (Copilot, PR #99) widened "yarn 4+" → "yarn 2+":
// `declaresYarnBerry()` and the rest of the gate treat yarn 2 /
// 3 / 4 as equivalent (all use Plug'n'Play by default), so the
// advisory text needs to match.
function buildYarnBerryCaveatAdvisory(): string {
  return (
    `yarn 2+ (yarn-berry) on an existing project, but ` +
    `\`nodeLinker: node-modules\` isn't set. arkor's runtime can't ` +
    `resolve dependencies through Plug'n'Play (yarn-berry's default), ` +
    `so \`arkor dev\` and \`arkor train\` will fail until the linker ` +
    `is set. Before running \`yarn install\`, add ` +
    `\`nodeLinker: node-modules\` to \`.yarnrc.yml\`.`
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
 * Walk from `cwd` up toward filesystem root checking whether any
 * ancestor (including `cwd` itself) contains an entry named
 * `name`. Used to detect yarn-berry workspace artefacts —
 * `.yarnrc.yml` and `.yarn/` — that yarn itself walks up to find
 * during resolution. Bound to 20 iterations as a defensive cap
 * against pathological symlinks; matches the
 * `findEnclosingPackageManagerField` budget.
 *
 * (PR #99 round 34 — Copilot flagged that the cwd-only check
 * missed monorepo-subdir scaffolds whose workspace root pins the
 * yarn-berry config: `monorepo/packages/foo` has neither
 * `.yarnrc.yml` nor `.yarn/` locally but inherits both from
 * `monorepo/`.)
 */
function hasEnclosingPath(cwd: string, name: string): boolean {
  return findEnclosingPath(cwd, name) !== undefined;
}

/**
 * Like `hasEnclosingPath` but returns the absolute path of the
 * matched ancestor (or `undefined`). Lets callers inspect the
 * matched file's contents — round-38 Codex P2 needs this to read
 * the enclosing `.yarnrc.yml`'s `nodeLinker:` value before deciding
 * whether the yarn-berry caveat should fire.
 *
 * Walks until `dirname()` returns the same path it was given —
 * the canonical "reached filesystem root" signal — instead of
 * capping at an arbitrary depth. The earlier 20-iteration limit
 * was a defensive guard against pathological symlinks, but
 * `dirname` is purely syntactic (doesn't follow links) so it
 * terminates at `/` (POSIX) or the drive root (Windows) on its
 * own. The cap was rejecting real deep monorepo layouts (PR #99
 * round 39 Codex P2).
 */
function findEnclosingPath(cwd: string, name: string): string | undefined {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

/**
 * Resolve the *effective* `nodeLinker:` value yarn-berry would
 * see for `cwd`, walking every `.yarnrc.yml` from `cwd` up to
 * the filesystem root and returning the FIRST one that defines
 * the key. Returns `undefined` when no ancestor yarnrc names
 * `nodeLinker:` at all.
 *
 * Mirrors yarn's actual config merge: `cwd/.yarnrc.yml` wins
 * for any key it defines, but a key it OMITS falls through to
 * the closest ancestor yarnrc that defines it. The earlier
 * helper (round 38) stopped at the first existing yarnrc and
 * returned that file's `nodeLinker:` even when it was
 * `undefined`, so the safe case "cwd yarnrc has no nodeLinker
 * but parent pins `node-modules`" was misclassified as PnP and
 * raised a false-positive caveat (round-39 Copilot review).
 *
 * Used by the patch path's `kept + needsBerryCaveat` branch
 * (cwd has yarnrc without nodeLinker) and by the inspect path's
 * `berry-without-linker` and `no-config` branches. Returns
 * `undefined` when the file is unreadable so the caller falls
 * back to its other heuristics rather than asserting "safe"
 * incorrectly.
 */
async function readEnclosingYarnrcNodeLinker(
  cwd: string,
): Promise<string | undefined> {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, YARNRC_YML_PATH);
    if (existsSync(candidate)) {
      try {
        const value = readNodeLinkerValue(await readFile(candidate, "utf8"));
        if (value !== undefined) return value;
      } catch {
        // Unreadable yarnrc: keep walking. We never assert
        // "safe" without a positive read.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

/**
 * Walk from `cwd`'s parent up toward filesystem root looking for the
 * first `package.json` that declares a `packageManager` field. Walks
 * until `dirname()` returns the same path it was given — the
 * canonical "reached filesystem root" signal. (PR #99 round 39
 * Codex P2 removed the earlier 20-iteration cap, which was
 * misclassifying real deeply-nested monorepo subdirs as having no
 * enclosing declaration.)
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
  // Walk to filesystem root via `dirname() === self` — same
  // termination signal as `findEnclosingPath`. The earlier
  // 20-iteration cap was rejecting real deep monorepo layouts
  // (PR #99 round 39 Codex P2).
  while (true) {
    const declared = await readPackageManagerField(
      join(dir, PACKAGE_JSON_PATH),
    );
    if (declared !== undefined) return declared;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
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

// Ensure `pnpm-workspace.yaml` exists with `allowBuilds: { esbuild: <value> }`
// so pnpm 11 doesn't refuse `pnpm install` over esbuild's postinstall.
// See `pnpmWorkspaceContent()` for the full per-version rationale.
//
// Existing-file path uses regex-based YAML parsing rather than pulling
// in a YAML lib (the rest of `cli-internal` deliberately ships zero
// runtime deps via tsdown's `deps.alwaysBundle`). The file is small
// (key-value pairs at top level), and we only need to detect the
// **top-level** `allowBuilds:` (block / inline / scalar) and merge
// `esbuild: <value>` into it. If the user has already pinned an
// explicit value — per-key OR a top-level scalar like
// `allowBuilds: false` — we leave the file alone: overriding their
// decision either way would silently change the install-time threat
// model of their project, and a scalar form is a deliberate global
// pin we must not stomp on.
//
// All regexes anchor with `^${rootIndent}` (start-of-line + the
// document's detected root indent — see `detectYamlRootIndent`)
// so a nested `allowBuilds:` under some other key (round-37
// Copilot review) can't be mistaken for the top-level pnpm
// setting that pnpm 11 actually consults. `rootIndent` is `""`
// for canonical column-0 YAML and a fixed leading-whitespace
// string for files whose root mapping is indented; either way
// the anchor identifies "starts at root mapping column", not
// "starts at column 0".
async function patchPnpmWorkspace(
  cwd: string,
  allowEsbuild: boolean,
): Promise<FileAction> {
  const path = join(cwd, PNPM_WORKSPACE_PATH);
  if (!existsSync(path)) {
    await writeFile(path, pnpmWorkspaceContent(allowEsbuild));
    return "created";
  }
  const current = await readFile(path, "utf8");
  let patched = current;
  // Already pinned per-key → trust the user.
  // Top-level `allowBuilds: <bool>` (scalar) → also a deliberate user
  // pin (global allow / deny). Don't append a sibling block — that'd
  // produce two top-level `allowBuilds` keys, ambiguous YAML.
  const esbuildAlreadyPinned =
    readAllowBuildsValue(current, "esbuild") !== undefined ||
    hasTopLevelAllowBuildsScalar(current);
  if (!esbuildAlreadyPinned) {
    patched = appendEsbuildToAllowBuilds(patched, allowEsbuild);
  }
  // pnpm 9 errors with "packages field missing or empty" whenever a
  // `pnpm-workspace.yaml` exists without a `packages:` key, even
  // when no actual workspace is intended. The fresh-create path
  // already emits `packages: []` for that reason; the patch path
  // must backfill it for the same cross-version compatibility, or
  // pnpm 9 (and only pnpm 9) breaks on `pnpm install` against a
  // user file like `allowBuilds: {}` (round-38 Copilot review).
  if (!hasTopLevelPackagesKey(patched)) {
    patched = prependPackagesEmptyList(patched);
  }
  if (patched === current) return "ok";
  await writeFile(path, patched);
  return "patched";
}

// Detect the line-ending style used by `contents`. CRLF wins if it
// appears anywhere — Windows editors sometimes leave a stray `\r`
// even in mostly-LF files, but if even one `\r\n` is present the
// file is canonically CRLF and we should preserve that on write.
// Defaults to `\n` for empty files. (Round-38 Codex P1: regexes
// previously hard-coded `\n` and silently double-wrote `allowBuilds:`
// against Windows-checked-in workspace yamls.)
function detectEol(contents: string): "\r\n" | "\n" {
  return contents.includes("\r\n") ? "\r\n" : "\n";
}

// Allow trailing whitespace **and** an optional `# ...` YAML comment
// before end-of-line. Used at the end of every "key: value" anchor
// so `esbuild: false # documented` (round-38 Copilot review) doesn't
// fall through to the no-match fallback and double-write.
const TRAILING_COMMENT_AND_EOL = "[ \\t]*(?:#[^\\r\\n]*)?\\r?$";

// Like `TRAILING_COMMENT_AND_EOL` but captures the trailing
// whitespace + optional comment as a single group so a regex
// replacement can re-emit it verbatim. Lets the inline / block
// patchers preserve a user-authored explanation of their build-
// script policy across re-runs (round-39 Copilot review:
// `allowBuilds: { ... } # explanation` had its trailing comment
// silently dropped on patch).
const TRAILING_COMMENT_AND_EOL_CAPTURED = "([ \\t]*(?:#[^\\r\\n]*)?)\\r?$";

// Returns the document root's leading whitespace (or `""` for
// canonical column-0 YAML). YAML allows the root mapping to be
// indented (e.g. `  packages: []\n  allowBuilds:\n    esbuild:
// true`); without anchoring our matchers at the actual root
// column, an indented file is misread as missing both keys and
// the patcher writes a duplicate block instead of respecting the
// existing config (round-39 Copilot review). Mirrors the
// `rootIndent` logic in `readNodeLinkerValue` for `.yarnrc.yml`.
//
// Skips empty lines, comments, and YAML structural markers
// (directives `%YAML 1.2`, document boundaries `---` / `...`)
// so an explicit document boundary doesn't anchor `rootIndent`
// to its column.
function detectYamlRootIndent(contents: string): string {
  for (const rawLine of contents.split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const trimmed = rawLine.trim();
    if (
      trimmed === "---" ||
      trimmed === "..." ||
      trimmed.startsWith("%")
    ) {
      continue;
    }
    return /^(\s*)/.exec(rawLine)?.[1] ?? "";
  }
  return "";
}

// Returns the explicit `esbuild:` value under the **top-level**
// `allowBuilds:` mapping, or `undefined` if esbuild isn't named
// there. Tolerates the two shapes `pnpm approve-builds` produces:
//
//   allowBuilds:
//     esbuild: false
//
// and the inline-object form a user might hand-write:
//
//   allowBuilds: { esbuild: false }
//
// Top-level only — anchored at `^${rootIndent}` (start-of-line
// + the document's detected root indent, see
// `detectYamlRootIndent`) so a nested `allowBuilds:` under
// another key can't be mistaken for the top-level pnpm setting
// pnpm itself reads. `rootIndent` is `""` for canonical column-0
// YAML and a leading-whitespace string for indented document
// roots; the anchor encodes "starts at root mapping column",
// NOT "starts at column 0" — important because round-39
// surfaced real `pnpm-workspace.yaml` files with indented roots
// that the column-0-only matchers had been silently writing
// duplicate blocks into (round-37 / round-39 Copilot review).
//
// Tolerates CRLF line endings and trailing `# comment`s on entries
// (round-38 reviewer feedback). Scalar form (`allowBuilds: false`)
// is intentionally NOT detected here — it's a global pin not
// specifically about esbuild. `hasTopLevelAllowBuildsScalar`
// handles that.
function readAllowBuildsValue(
  contents: string,
  pkg: string,
): boolean | undefined {
  const root = detectYamlRootIndent(contents);
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Inline mapping at the document root: `allowBuilds: { esbuild: false, ... }`.
  const inlineMatch = contents.match(
    new RegExp(
      `^${root}allowBuilds:[ \\t]*\\{([^}]*)\\}${TRAILING_COMMENT_AND_EOL}`,
      "m",
    ),
  );
  if (inlineMatch) {
    // Round 39 (Codex P2, PR #99): anchor the key match at a
    // mapping-start boundary so `esbuild` doesn't match as a
    // substring of another key (e.g. `myesbuild: false`). Valid
    // contexts for a key inside `{ … }` are: start of inner
    // text, comma-then-whitespace, or an opening quote
    // immediately preceded by either of those. The lookbehind
    // matches "start of string OR a non-key character (`{`, `,`,
    // whitespace)" so we don't false-match into another key.
    const pairRe = new RegExp(
      `(?:^|[\\s,{])["']?${escaped}["']?[ \\t]*:[ \\t]*(true|false)`,
    );
    const inner = inlineMatch[1].match(pairRe);
    if (inner) return inner[1] === "true";
    return undefined;
  }
  // Block mapping: an `allowBuilds:` line at the document root
  // followed by indented `pkg: <bool>` entries. Body indent must be
  // strictly greater than the root indent so a sibling at the same
  // column doesn't get mistaken for a body line.
  const blockHeaderRe = new RegExp(
    `^${root}allowBuilds:${TRAILING_COMMENT_AND_EOL}`,
    "m",
  );
  const headerMatch = blockHeaderRe.exec(contents);
  if (!headerMatch) return undefined;
  const after = contents.slice(headerMatch.index + headerMatch[0].length);
  // Split on either CRLF or LF; the `\r?` keeps the resulting line
  // strings free of trailing `\r` so the per-entry regex can use
  // `\r?$` consistently.
  const lines = after.split(/\r?\n/);
  // Skip the empty trailing slice that comes from the header newline.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    const indentMatch = line.match(/^[ \t]+/);
    if (!indentMatch || indentMatch[0].length <= root.length) break; // dedent
    const m = line.match(
      new RegExp(
        `^[ \\t]+["']?${escaped}["']?[ \\t]*:[ \\t]*(true|false)${TRAILING_COMMENT_AND_EOL}`,
      ),
    );
    if (m) return m[1] === "true";
  }
  return undefined;
}

// True when the file pins `allowBuilds` to a **document-root scalar**
// (`allowBuilds: true` / `allowBuilds: false`) — pnpm's "approve all"
// / "deny all" global form. The append path must bail in that case;
// blindly writing a fresh `allowBuilds:` block would leave two
// root-level `allowBuilds` keys (round-37 Copilot review).
//
// Tolerates CRLF + trailing comments (round-38 reviewer feedback)
// and indented document roots (round-39 Copilot review).
function hasTopLevelAllowBuildsScalar(contents: string): boolean {
  const root = detectYamlRootIndent(contents);
  return new RegExp(
    `^${root}allowBuilds:[ \\t]+(?:true|false)${TRAILING_COMMENT_AND_EOL}`,
    "m",
  ).test(contents);
}

// True when the file declares a document-root `packages:` key (in
// any form — inline `[]`, inline list, or block list). pnpm 9
// errors "packages field missing or empty" whenever
// `pnpm-workspace.yaml` exists without it, so the patch path must
// backfill `packages: []` when the user's existing file omits it
// (round-38 Copilot review). Anchored at the detected root indent
// so a nested `packages:` key (e.g. inside a tool-specific
// section) isn't mistaken for the pnpm-level one.
function hasTopLevelPackagesKey(contents: string): boolean {
  const root = detectYamlRootIndent(contents);
  return new RegExp(`^${root}packages:`, "m").test(contents);
}

// Prepend `packages: []` to an existing pnpm-workspace.yaml that
// lacks the key. Preserves the file's existing line-ending style
// and document-root indent so the new key sits at the same column
// as the rest of the root mapping (round-39 Copilot review).
//
// Inserts AFTER any leading YAML directives (`%YAML 1.2`,
// `%TAG …`), document boundary markers (`---`), comments, and
// blank lines. Inserting at byte 0 would push our key in front of
// a `---` start marker, which YAML treats as a separate document
// and pnpm rejects with "expected a single document in the stream"
// (round-39 Codex P1). Leading comments are also skipped past so
// a user's header comment stays at the top of the file rather than
// being shoved below a synthetic `packages: []`.
function prependPackagesEmptyList(contents: string): string {
  const eol = detectEol(contents);
  const root = detectYamlRootIndent(contents);
  const insertion = `${root}packages: []${eol}`;
  let offset = 0;
  while (offset < contents.length) {
    const nl = contents.indexOf("\n", offset);
    const lineEnd = nl === -1 ? contents.length : nl + 1;
    const trimmed = contents
      .slice(offset, nl === -1 ? contents.length : nl)
      .replace(/\r$/, "")
      .trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("#") ||
      trimmed === "---" ||
      trimmed.startsWith("%")
    ) {
      offset = lineEnd;
      continue;
    }
    break;
  }
  return `${contents.slice(0, offset)}${insertion}${contents.slice(offset)}`;
}

// Append `esbuild: <value>` to an existing pnpm-workspace.yaml
// without destructive rewrites. Three branches:
//
//   1. Inline `allowBuilds: { ... }` (top-level) — splice
//      `esbuild: <value>` into the mapping.
//   2. Block `allowBuilds:` (top-level) with no esbuild entry —
//      append an `  esbuild: <value>` line at the end of the
//      block, keeping the block's indentation.
//   3. No top-level `allowBuilds:` key (and no scalar pin —
//      `patchPnpmWorkspace` already gates that out via
//      `hasTopLevelAllowBuildsScalar`) — append a fresh block.
//
// All matchers anchor with `^${rootIndent}` (start-of-line +
// the document's detected root indent — see
// `detectYamlRootIndent`) so a nested `allowBuilds:` under some
// other key can't be edited; that file would falsely report
// "patched" while pnpm 11 keeps erroring (round-37 Copilot
// review). `rootIndent` is `""` for canonical column-0 YAML and
// a fixed leading-whitespace string for indented document
// roots — the anchor identifies "starts at root mapping
// column", not "starts at column 0", which is what lets the
// patcher correctly handle `pnpm-workspace.yaml` files whose
// root mapping is indented (round-39 Copilot review).
//
// Tolerates CRLF line endings (round-38 Codex P1) and trailing
// `# comment`s on the header line (round-38 Copilot). Newly
// appended content reuses the file's detected line-ending style
// so we don't introduce mixed-EOL output.
function appendEsbuildToAllowBuilds(
  contents: string,
  allowEsbuild: boolean,
): string {
  const eol = detectEol(contents);
  const root = detectYamlRootIndent(contents);
  const value = allowEsbuild ? "true" : "false";
  // Round 39 (Copilot, PR #99): the block-form matcher below
  // requires `\r?\n` after the header AND after every body
  // line. A hand-edited `pnpm-workspace.yaml` that ends without
  // a trailing newline (e.g. `…\n  sharp: true<EOF>`) would
  // otherwise miss the body line and slip past the block
  // matcher entirely, falling through to "no allowBuilds at
  // all" and appending a duplicate top-level `allowBuilds:`
  // key. Normalize the input by appending a single newline so
  // every existing entry is properly terminated; the inline
  // and block patches then preserve the user's content
  // unchanged, and the file gains a single conventional
  // trailing newline as a side-effect.
  if (!/\r?\n$/.test(contents)) {
    contents = `${contents}${eol}`;
  }
  // Inline form. Captures the body of the inline mapping AND the
  // trailing whitespace + optional `# comment` so we can re-emit
  // the comment verbatim (round-39 Copilot review). Without the
  // capture, a re-run of the scaffold silently dropped a user's
  // explanation of their build-script policy.
  const inlineRe = new RegExp(
    `^${root}allowBuilds:[ \\t]*\\{([^}]*)\\}${TRAILING_COMMENT_AND_EOL_CAPTURED}`,
    "m",
  );
  const inlineMatch = contents.match(inlineRe);
  if (inlineMatch) {
    // Round 39 (Codex P2, PR #99): a hand-written
    // `allowBuilds: { sharp: true, }` (trailing comma) would
    // otherwise produce `sharp: true,, esbuild: false` after
    // the merge — invalid YAML pnpm rejects on parse. Strip a
    // trailing comma (with optional whitespace) before joining
    // so the result is well-formed regardless of how the
    // original was written.
    const inner = inlineMatch[1].trim().replace(/,\s*$/, "");
    const trailing = inlineMatch[2];
    const merged = inner.length > 0
      ? `${inner}, esbuild: ${value}`
      : `esbuild: ${value}`;
    return contents.replace(
      inlineRe,
      `${root}allowBuilds: { ${merged} }${trailing}`,
    );
  }
  // Block form. The header line tolerates a trailing comment
  // (captured verbatim) and CRLF (round-38 Codex P1). The body
  // capture runs as long as each line is indented strictly deeper
  // than the document root, which lets the body live under any
  // root indent and stops at the first dedent/blank/sibling.
  const blockRe = new RegExp(
    `^${root}allowBuilds:([ \\t]*(?:#[^\\r\\n]*)?)\\r?\\n((?:[ \\t]{${root.length + 1},}[^\\r\\n]*\\r?\\n)*)`,
    "m",
  );
  const blockMatch = contents.match(blockRe);
  if (blockMatch) {
    const headerTrailing = blockMatch[1];
    const body = blockMatch[2];
    // Reuse the existing entry indent if there is one; otherwise
    // default to root + two spaces (pnpm's convention).
    const entryIndentMatch = body.match(/^([ \t]+)/);
    const entryIndent = entryIndentMatch?.[1] ?? `${root}  `;
    const replacement =
      `${root}allowBuilds:${headerTrailing}${eol}${body}${entryIndent}esbuild: ${value}${eol}`;
    return contents.replace(blockRe, replacement);
  }
  // No allowBuilds at all — append a fresh block at the document
  // root, in the file's EOL. The trailing-newline normalization
  // at the top of the function guarantees `contents` already
  // ends with one, so we don't need to insert a separator.
  return `${contents}${root}allowBuilds:${eol}${root}  esbuild: ${value}${eol}`;
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
  // pnpm-workspace.yaml emission rules. Two axes:
  //
  //   (1) Should we *handle* the file at all (patch existing or
  //       create fresh)? Skip when the chosen pm is explicitly NOT
  //       pnpm — user picked a different toolchain, leave their
  //       (or our) pnpm config untouched.
  //   (2) Should we *create* the file when it's missing at cwd?
  //       Mirror the yarn-config gating: `pm === "pnpm"` always,
  //       OR `pm === undefined && !isExistingProject` (fresh
  //       scaffold of unknown pm — emit defensively, yarn / npm /
  //       bun ignore the file). Plus an extra "no ancestor
  //       pnpm-workspace.yaml" guard so we never shadow a parent
  //       monorepo: dropping `packages: []` into a pnpm subdir
  //       redirects pnpm's workspace root and breaks
  //       `workspace:*` resolution above (round-37 multi-reviewer
  //       P1: Codex + Copilot 2x). `dirname(cwd)` walks strictly
  //       ancestors — a pre-existing file at cwd is handled by
  //       the patch path below, not this guard.
  //
  // When axis (1) admits handling (pm is pnpm or undefined) AND
  // cwd already has the file, we patch it regardless of axis (2)
  // — the user clearly has pnpm config locally and we just need
  // to ensure `esbuild` is allow-listed, OR observe that the user
  // already pinned a value and bow out. Round 40 (Copilot, PR
  // #99): the previous wording said "we ALWAYS patch it
  // (regardless of (2))", which read as if the patch path
  // bypassed axis (1) too — but it doesn't. An explicit
  // `--use-npm` / `--use-yarn` / `--use-bun` keeps the existing
  // `pnpm-workspace.yaml` untouched (per axis (1): "leave their
  // (or our) pnpm config untouched"); axis (2) is the only gate
  // the cwd-has-file shortcut bypasses.
  const cwdHasPnpmWorkspace = existsSync(join(cwd, PNPM_WORKSPACE_PATH));
  const enclosingPnpmWorkspaceAbove = hasEnclosingPath(
    dirname(cwd),
    PNPM_WORKSPACE_PATH,
  );
  const pmIsPnpmOrUndefined =
    options.packageManager === "pnpm" ||
    options.packageManager === undefined;
  const shouldCreateFreshPnpmWorkspace =
    !cwdHasPnpmWorkspace &&
    !enclosingPnpmWorkspaceAbove &&
    (options.packageManager === "pnpm" ||
      (options.packageManager === undefined && !isExistingProject));
  if (
    pmIsPnpmOrUndefined &&
    (cwdHasPnpmWorkspace || shouldCreateFreshPnpmWorkspace)
  ) {
    const action = await patchPnpmWorkspace(
      cwd,
      options.allowBuilds === true,
    );
    files.push({ path: PNPM_WORKSPACE_PATH, action });
  }
  // Yarn-config emission rules:
  //
  //   - `pm === "yarn"` — the user explicitly opted into yarn.
  //     Run `patchYarnConfig` so it can either:
  //       (a) Create `.yarnrc.yml` with `nodeLinker: node-modules`
  //           when the cwd was empty pre-scaffold (`!isExistingProject`).
  //       (b) Patch / leave-alone an existing `.yarnrc.yml`:
  //           `node-modules` already pinned → no-op; non-default
  //           value → keep + emit conflict warning (round 5/8);
  //           no `nodeLinker:` key + `isExistingProject` → keep +
  //           emit berry caveat (the round-15 widening folds this
  //           into the same advisory as the no-file case).
  //       (c) DECLINE to create when `.yarnrc.yml` is missing AND
  //           `isExistingProject` is true (round 14): writing
  //           `nodeLinker: node-modules` at the root of an
  //           unfamiliar project could flip install mode for an
  //           enclosing yarn-berry workspace deliberately on PnP.
  //           In that case the function returns `kept +
  //           needsBerryCaveat` and the caller surfaces the
  //           caveat instead of an emitted file.
  //   - `pm === undefined` and the cwd was EMPTY pre-scaffold
  //     (`!isExistingProject`) — this is a fresh scaffold where
  //     we don't yet know which pm the user will pick. The
  //     manual-install hint says "yarn / bun install", so a
  //     yarn-berry user reading it and running `yarn install`
  //     would otherwise hit the PnP default. Emit defensively.
  //     yarn 1 / npm / pnpm / bun all ignore `.yarnrc.yml`, so
  //     it's harmless for non-yarn flows.
  //   - `pm === undefined` and the cwd had any pre-existing
  //     content (`isExistingProject`) — this is a merge into
  //     someone else's project. We can't tell whether the
  //     surrounding workspace is a yarn-berry repo deliberately
  //     on the PnP default, so silently writing `.yarnrc.yml`
  //     would flip the install mode for the whole repo. Don't
  //     touch yarn config — defer to the user (Copilot review on
  //     PR #99). Same skip applies when the user *explicitly*
  //     picked a non-yarn pm. The `isExistingProject` snapshot is
  //     a "non-empty directory entries" check captured at the top
  //     of `scaffold()` before `patchPackageJson()` runs (round
  //     15 widened the check from `existsSync(package.json)` for
  //     exactly this reason — a fresh git-init'd repo with only
  //     a README would have been misclassified as fresh under
  //     the package.json predicate). (Round-39 Copilot review:
  //     the older comment still described the predicate as
  //     `package.json`-based, which was misleading after the
  //     round-15 widening.)
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
      // — patch path declined to mutate. Whether to surface the
      // caveat depends on whether the project is actually on
      // yarn-berry, gated on layered signals:
      //
      //   1. `.yarnrc.yml` exists on disk → unambiguous yarn-berry
      //      evidence (yarn 1 reads `.yarnrc`, not `.yarnrc.yml`).
      //   2. `.yarn/` directory exists → also yarn-berry-only
      //      (yarn 1 doesn't create that tree). Catches the
      //      yarn-berry-with-cached-releases case where the user
      //      committed `.yarn/releases/yarn-*.cjs` but no
      //      `.yarnrc.yml` yet.
      //   3. corepack `packageManager: yarn@2+` declared anywhere
      //      up the tree → yarn-berry signal.
      //   4. (last resort) `yarn --version` reports a yarn 2+
      //      major. Rounds 20 / 27 / 29 ping-ponged because the
      //      filesystem signals alone can't distinguish the
      //      "yarn 4 fresh bootstrap into a non-empty existing
      //      dir, no setup committed yet" case from "yarn 1
      //      user scaffolding into existing dir". Round 30
      //      (Copilot, PR #99) flagged that without runtime
      //      detection the round-29 documented-gap was a real
      //      silent break for the yarn 4 bootstrap case.
      //      `detectYarnMajor` shells out to `yarn --version`
      //      and returns `undefined` if yarn isn't on PATH /
      //      errors out — that fallback keeps the yarn 1 happy
      //      path intact when detection isn't possible.
      // Round 34 (Copilot, PR #99): walk up the ancestor tree
      // for `.yarnrc.yml` and `.yarn/` rather than checking only
      // cwd. yarn itself walks up to find these during
      // resolution (workspace root config governs descendant
      // packages), so a `monorepo/packages/foo` scaffold whose
      // root has either signal is unambiguously yarn-berry.
      // Round 38 (Codex P2, PR #99): the round-34 walk-up fires the
      // berry caveat whenever an ancestor `.yarnrc.yml` exists, but
      // a workspace root that already pins `nodeLinker: node-modules`
      // is *exactly* the safe case the caveat is supposed to nudge
      // users toward. Reading the enclosing yarnrc's linker first
      // lets us short-circuit the signal: if it's `node-modules`,
      // install runs without trouble and any block here would be a
      // false positive that misleads the user about their setup.
      const enclosingNodeLinker = await readEnclosingYarnrcNodeLinker(cwd);
      const enclosingLinkerIsSafe = enclosingNodeLinker === "node-modules";
      const yarnrcInTree = hasEnclosingPath(cwd, YARNRC_YML_PATH);
      const yarnDirInTree = hasEnclosingPath(cwd, ".yarn");
      let positiveBerrySignal =
        !enclosingLinkerIsSafe &&
        (yarnrcInTree ||
          yarnDirInTree ||
          declaresYarnBerry(
            await resolveEnclosingPackageManagerField(
              cwd,
              preExistingPackageManagerField,
            ),
          ));
      if (!positiveBerrySignal && !enclosingLinkerIsSafe) {
        // Round 30 (Copilot, PR #99): runtime detection closes
        // the yarn-4-fresh-bootstrap gap by reporting the actual
        // yarn major.
        //
        // Round 32 → 33 (Copilot, PR #99): the trade-off for
        // `undefined` (yarn not on PATH / exec error / 5s
        // timeout) settled on "don't fire". Round 32 had tried
        // fail-closed (treat undefined as yarn 2+) for safety,
        // but round 33 pushed back: conflating probe-failure
        // with PnP hazard misleads users whose actual failure
        // mode is something else — yarn missing, corepack
        // blocked by an enclosing non-yarn `packageManager`,
        // etc. Telling those users to "edit `.yarnrc.yml`" when
        // the real fix is "install yarn" or "fix corepack" is
        // worse than letting `yarn install` surface its own
        // clear error.
        //
        // Settled: only fire when the probe positively reports
        // yarn 2+. Probe-undefined falls through to "no
        // positive signal" and install runs, where any actual
        // yarn issue surfaces with its own diagnostic.
        const yarnMajor = await detectYarnMajor(cwd);
        if (yarnMajor !== undefined && yarnMajor >= 2) {
          positiveBerrySignal = true;
        }
      }
      if (positiveBerrySignal) {
        warnings.push(buildYarnBerryCaveatAdvisory());
        blockInstall = true;
      }
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
      // Round 39 (Copilot, PR #99): cwd's yarnrc has no
      // `nodeLinker:` key, but yarn merges configs up the tree —
      // an ancestor workspace root pinning `nodeLinker: node-modules`
      // is the safe case the caveat is supposed to nudge users
      // toward. `readEnclosingYarnrcNodeLinker` walks ancestor
      // yarnrcs until it finds the first definitive `nodeLinker:`,
      // so it correctly resolves the merged effective value here.
      const merged = await readEnclosingYarnrcNodeLinker(cwd);
      if (merged !== "node-modules") {
        warnings.push(buildYarnBerryCaveatAdvisory());
        blockInstall = true;
      }
    } else if (status.kind === "no-config") {
      // Round 16 (Copilot, PR #99): consult the pre-patch
      // local snapshot AND the parent tree for the corepack
      // declaration. The bare cwd-only check would (a) misread
      // a freshly scaffolded `package.json` because
      // `patchPackageJson` already ran above, and (b) miss
      // the entire parent-workspace declaration in the
      // monorepo-subdir case round 15 widened us into.
      //
      // Round 31 (Copilot, PR #99): also consult `.yarn/` on
      // disk — the patch path adopted that as a positive
      // yarn-berry signal in round 29 (yarn 1 doesn't create
      // that tree, so its existence is unambiguous yarn-berry
      // evidence) but the inspect path was still narrower,
      // missing yarn-berry repos that have committed
      // `.yarn/releases/yarn-*.cjs` but not yet a corepack
      // `packageManager` field. We DO NOT mirror the patch
      // path's runtime `detectYarnMajor` fallback here:
      // the inspect path fires when the user did NOT opt into
      // yarn (`pm === undefined`), so probing `yarn --version`
      // would false-positive on every pnpm/npm/bun project that
      // happens to have yarn installed in its dev env.
      //
      // Round 34 (Copilot, PR #99): walk up the ancestor tree
      // for both `.yarnrc.yml` and `.yarn/` (matching the patch
      // path's round-34 fix) so monorepo-subdir scaffolds whose
      // workspace root pins the yarn-berry config are detected.
      // The cwd-only `inspectYarnConfig` returned `no-config`
      // because the local dir doesn't have `.yarnrc.yml`, but
      // the parent workspace's `.yarnrc.yml` still governs
      // `yarn install` from this subdir.
      // Round 38 (Codex P2, PR #99): same enclosing-linker
      // short-circuit as the patch path above. An ancestor
      // workspace root that already pins `nodeLinker: node-modules`
      // is the safe case — no caveat needed.
      const enclosingNodeLinker = await readEnclosingYarnrcNodeLinker(cwd);
      if (enclosingNodeLinker !== "node-modules") {
        const yarnrcInTree = hasEnclosingPath(cwd, YARNRC_YML_PATH);
        const yarnDirInTree = hasEnclosingPath(cwd, ".yarn");
        const declared = await resolveEnclosingPackageManagerField(
          cwd,
          preExistingPackageManagerField,
        );
        if (yarnrcInTree || yarnDirInTree || declaresYarnBerry(declared)) {
          warnings.push(buildYarnBerryCaveatAdvisory());
          blockInstall = true;
        }
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
