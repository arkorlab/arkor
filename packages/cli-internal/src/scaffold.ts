import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  STARTER_CONFIG,
  STARTER_INDEX,
  STARTER_README,
  TEMPLATES,
  type TemplateId,
} from "./templates";

/**
 * - `created` — file was missing; the scaffolder wrote a new one.
 * - `kept` — file existed; the scaffolder left it untouched on disk.
 * - `patched` — file existed; the scaffolder modified it in place.
 * - `ok` — file existed and already matched the desired state; no write.
 * - `skipped` — the scaffolder declined to create or modify the file
 *   because some upstream guard tripped (currently: `CLAUDE.md` when
 *   `AGENTS.md` contains duplicate managed blocks). The file is **not**
 *   on disk afterwards, distinguishing this from `kept`.
 */
export type FileAction =
  | "created"
  | "kept"
  | "patched"
  | "ok"
  | "skipped";

export interface ScaffoldOptions {
  /** Destination directory — created if it does not already exist. */
  cwd: string;
  /** Project name used in package.json + README. */
  name: string;
  template: TemplateId;
  /**
   * Write `AGENTS.md` (and `CLAUDE.md` pointing at it) to brief AI coding
   * agents that arkor is newer than their training data. Defaults to off
   * when omitted — callers (e.g. `create-arkor`) opt in explicitly.
   */
  agentsMd?: boolean;
}

export interface ScaffoldResult {
  files: Array<{ path: string; action: FileAction }>;
  cwd: string;
  /**
   * Non-fatal advisories the scaffolder couldn't fix on its own. Empty
   * when there is nothing to flag. Currently populated by
   * `writeAgentsMd` when an existing `AGENTS.md` contains more than one
   * canonical managed block (auto-picking either copy is unsafe — the
   * user must dedupe before the next re-scaffold can patch in place).
   */
  warnings: string[];
}

const INDEX_PATH = "src/arkor/index.ts";
const TRAINER_PATH = "src/arkor/trainer.ts";
const CONFIG_PATH = "arkor.config.ts";
const README_PATH = "README.md";
const GITIGNORE_PATH = ".gitignore";
const PACKAGE_JSON_PATH = "package.json";
const AGENTS_MD_PATH = "AGENTS.md";
const CLAUDE_MD_PATH = "CLAUDE.md";
const DEFAULT_ARKOR_SPEC = "^0.0.1-alpha.9";

// Marker pair scoped to arkor — do not reuse Next.js's `nextjs-` markers.
// Anything between these markers is treated as canonical and replaced on
// re-scaffold; anything outside is preserved.
const AGENTS_BLOCK_BEGIN = "<!-- BEGIN:arkor-agent-rules -->";
const AGENTS_BLOCK_END = "<!-- END:arkor-agent-rules -->";

// Distinctive first content line of the canonical body. Used as a
// secondary signature when locating the managed block — see
// `findManagedBlock`. Treat as part of the on-wire contract: changing
// this string is a breaking change that orphans every existing
// AGENTS.md (the old block will no longer be detected and a fresh one
// will be appended on re-scaffold).
const AGENTS_BLOCK_SIGNATURE_LINE =
  "# arkor is newer than your training data";

// Authored with LF; `withEol` re-targets line endings when patching a CRLF
// host file so the surrounding content stays uniform.
const AGENTS_BLOCK_BODY = `${AGENTS_BLOCK_BEGIN}
${AGENTS_BLOCK_SIGNATURE_LINE}

arkor was released recently and is likely not present in your model training data. Do not infer APIs, file structure, or CLI behavior from prior knowledge.

Before writing or changing any arkor code, consult one of these sources of truth (in order of preference):

1. \`node_modules/arkor/docs/\` — installed copy of the docs, present after \`npm install\` / \`pnpm install\` / \`yarn\` / \`bun install\`.
2. \`node_modules/arkor/dist/index.d.mts\` — installed type definitions for the public SDK exports.
3. <https://docs.arkor.ai> — public docs site. Use **only** when no installed copy is available locally (fresh scaffold without \`install\`, install failure, Yarn PnP). When \`node_modules/arkor/\` exists, prefer it: this project may be pinned to an older SDK version and the public site can document APIs that aren't in the installed release yet — code written against the public site can fail to compile against the pinned SDK.
4. <https://github.com/arkorlab/arkor> — source repository.

If the docs and your assumptions disagree, the docs win.

Key project files:
- \`src/arkor/index.ts\` registers arkor primitives.
- \`src/arkor/trainer.ts\` defines the trainer; training settings (\`maxSteps\`, \`lora\`, etc.) live on the Trainer itself.
- \`arkor.config.ts\` is currently a placeholder — the runtime does not read it yet.
${AGENTS_BLOCK_END}`;

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

async function patchGitignore(cwd: string): Promise<FileAction> {
  const path = join(cwd, GITIGNORE_PATH);
  if (!existsSync(path)) {
    await writeFile(path, "node_modules/\ndist/\n.arkor/\n");
    return "created";
  }
  const current = await readFile(path, "utf8");
  if (current.split(/\r?\n/).some((line) => line.trim() === ".arkor/")) {
    return "ok";
  }
  const separator = current.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${current}${separator}.arkor/\n`);
  return "patched";
}

function detectEol(s: string): "\r\n" | "\n" {
  // Pick the dominant convention by count, not "any CRLF wins". A single
  // stray CRLF in an otherwise-LF file shouldn't flip the inserted block to
  // CRLF (and vice versa). LF-counting uses a negative lookbehind to avoid
  // double-counting the LF that already belongs to a CRLF pair. Ties (and
  // empty files) fall through to LF.
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

function withEol(content: string, eol: "\r\n" | "\n"): string {
  // Author content always uses LF; re-target only when patching CRLF hosts.
  if (eol === "\n") return content;
  return content.replace(/\r?\n/g, "\r\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ManagedBlockLookup =
  | { kind: "none" }
  | { kind: "single"; begin: number; end: number }
  | { kind: "ambiguous"; count: number };

/**
 * Locate the arkor-managed block in `s`.
 *
 * Three layered guards keep this from misclassifying user-authored prose
 * (or pasted documentation) as the managed block:
 *
 *   1. **Line-anchored markers.** BEGIN and END must each sit at the
 *      start of a line — at file start (optionally after a UTF-8 BOM),
 *      or after a CR/LF newline. Inline mentions inside backticks
 *      (e.g. "delimited by `<!-- BEGIN:arkor-agent-rules -->`")
 *      therefore do not register.
 *   2. **Signature line.** The line immediately after BEGIN must equal
 *      `AGENTS_BLOCK_SIGNATURE_LINE` ("# arkor is newer than your
 *      training data"). A user documenting the marker syntax inside a
 *      fenced code block almost certainly will not also reproduce that
 *      exact heading. If they do (or if the user wholesale rewrote the
 *      managed block to remove the heading) we deliberately fall through
 *      to the append path, which preserves their bytes and adds a fresh
 *      canonical block at the end.
 *   3. **Single match required.** When several signature-matching pairs
 *      exist we refuse to patch and surface a warning to the caller.
 *      Earlier rounds tried "pick the first" / "pick the last", but both
 *      are unsafe — `writeAgentsMd` preserves user content on either side
 *      of the managed block, so a user can legitimately put the block at
 *      the top, middle, or bottom of their file. Auto-picking either end
 *      would update the wrong copy and silently leave a stale set of
 *      rules in the file. Keeping the file untouched + warning is the
 *      conservative default; the user resolves the duplication and the
 *      next re-scaffold patches in place.
 */
function findManagedBlock(s: string): ManagedBlockLookup {
  // All inter-line breaks accept either LF or CRLF. Hard-coding `\n`
  // would cause re-scaffolds of a CRLF AGENTS.md to miss the previously
  // inserted block (its line breaks are `\r\n`), fall through to the
  // append path, and stack a second canonical block on every run —
  // breaking idempotency on Windows checkouts. The leading anchor also
  // skips an optional UTF-8 BOM (U+FEFF) at the file start so AGENTS.md
  // saved by editors that prepend a BOM (Windows Notepad's pre-2019
  // default, etc.) still detect the existing block on re-scaffold.
  const NL = "(?:\\r\\n|\\n)";
  const re = new RegExp(
    `(?:^\\uFEFF?|${NL})${escapeRegExp(AGENTS_BLOCK_BEGIN)}${NL}${escapeRegExp(
      AGENTS_BLOCK_SIGNATURE_LINE,
    )}${NL}[\\s\\S]*?${NL}${escapeRegExp(AGENTS_BLOCK_END)}`,
    "gm",
  );
  const matches = [...s.matchAll(re)];
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) {
    return { kind: "ambiguous", count: matches.length };
  }
  const m = matches[0]!;
  // Strip the leading-newline (or BOM) anchor so we replace the marker
  // itself, not the newline / BOM ahead of it. Possible prefixes:
  //   - "\r\n" (2 chars)
  //   - "\n"   (1 char)
  //   - "﻿" (1 char — UTF-16 code unit; both String#slice and the
  //     scaffolder's downstream `string.slice(start, end)` are UTF-16
  //     code-unit-indexed, matching `m.index` semantics)
  //   - "" when the marker sits at byte 0 of an unBOM'd file
  let leading = 0;
  if (m[0].startsWith("\r\n")) leading = 2;
  else if (m[0].startsWith("\n")) leading = 1;
  else if (m[0].startsWith("﻿")) leading = 1;
  return {
    kind: "single",
    begin: m.index + leading,
    end: m.index + m[0].length,
  };
}

async function writeAgentsMd(
  cwd: string,
): Promise<{ action: FileAction; warning?: string }> {
  const path = join(cwd, AGENTS_MD_PATH);
  if (!existsSync(path)) {
    await writeFile(path, `${AGENTS_BLOCK_BODY}\n`);
    return { action: "created" };
  }
  const current = await readFile(path, "utf8");
  const eol = detectEol(current);
  const block = withEol(AGENTS_BLOCK_BODY, eol);

  const found = findManagedBlock(current);
  if (found.kind === "ambiguous") {
    // Conservative: don't guess which copy is canonical. Auto-picking
    // first/last is unsafe — `writeAgentsMd` lets users put content on
    // either side of the managed block, so a duplicate could be a real
    // earlier block + a user-pasted example below it (or vice versa).
    // Patching the wrong one silently leaves stale rules in the file.
    // Surface a warning and let the user dedupe; the next re-scaffold
    // will patch in place.
    return {
      action: "kept",
      warning: `${AGENTS_MD_PATH} contains ${found.count} arkor-managed blocks (delimited by ${AGENTS_BLOCK_BEGIN} / ${AGENTS_BLOCK_END} with the canonical signature line). Refusing to patch automatically — remove the duplicate(s) and re-run.`,
    };
  }
  if (found.kind === "single") {
    // Replace block content only, preserving anything outside the markers.
    const before = current.slice(0, found.begin);
    const after = current.slice(found.end);
    const next = `${before}${block}${after}`;
    if (next === current) return { action: "ok" };
    await writeFile(path, next);
    return { action: "patched" };
  }
  // No markers yet — append the block at the end. Preserve the user's
  // existing trailing-newline pattern verbatim (a previous version
  // collapsed any trailing run of newlines, which destroyed the user's
  // intentional formatting and broke the non-destructive guarantee).
  // We only need to *guarantee* there's at least one blank line of
  // separation between the existing tail and the inserted block, then
  // a single trailing newline at the end.
  let separator: string;
  if (current.length === 0) {
    separator = "";
  } else if (current.endsWith(`${eol}${eol}`)) {
    // Already ends with at least one blank line — no separator needed.
    separator = "";
  } else if (current.endsWith(eol)) {
    // Single trailing newline → one more makes the blank line.
    separator = eol;
  } else {
    // No trailing newline → newline + blank line.
    separator = `${eol}${eol}`;
  }
  await writeFile(path, `${current}${separator}${block}${eol}`);
  return { action: "patched" };
}

async function writeClaudeMd(cwd: string): Promise<FileAction> {
  // Claude Code auto-loads CLAUDE.md; the `@AGENTS.md` directive imports the
  // shared instructions so the two files stay in sync without duplication.
  // Never overwrite an existing CLAUDE.md — users may have project-specific
  // instructions there already.
  const path = join(cwd, CLAUDE_MD_PATH);
  if (existsSync(path)) return "kept";
  await writeFile(path, "@AGENTS.md\n");
  return "created";
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
  // Determine the AGENTS.md / CLAUDE.md outcome *before* writing README.
  // STARTER_README documents whichever agent files actually land on
  // disk, so generating the README earlier locks in the wrong content
  // when `writeAgentsMd` later refuses to patch (duplicate-block case)
  // and `CLAUDE.md` is consequently skipped.
  const warnings: string[] = [];
  type AgentEntry = { path: string; action: FileAction };
  const agentEntries: AgentEntry[] = [];
  let claudeWritten = false;
  if (options.agentsMd) {
    const agents = await writeAgentsMd(cwd);
    agentEntries.push({ path: AGENTS_MD_PATH, action: agents.action });
    if (agents.warning) warnings.push(agents.warning);
    if (agents.warning) {
      // AGENTS.md was kept untouched because it contains duplicate
      // canonical blocks. Skip CLAUDE.md too: it's a one-line
      // `@AGENTS.md` shim that auto-imports AGENTS.md into Claude
      // Code's context, so creating it now would feed the unresolved
      // duplicate rules straight to the agent. Wait for the user to
      // dedupe and re-run. Action `skipped` (not `kept`) so the CLI
      // line doesn't lie about the file being on disk.
      const claudeAlreadyOnDisk = existsSync(join(cwd, CLAUDE_MD_PATH));
      if (claudeAlreadyOnDisk) {
        agentEntries.push({ path: CLAUDE_MD_PATH, action: "kept" });
        claudeWritten = true; // user's existing CLAUDE.md still references AGENTS.md
      } else {
        agentEntries.push({ path: CLAUDE_MD_PATH, action: "skipped" });
        warnings.push(
          `${CLAUDE_MD_PATH} not created because ${AGENTS_MD_PATH} has duplicate managed blocks (would auto-import the unresolved rules into Claude Code). Dedupe ${AGENTS_MD_PATH} and re-run.`,
        );
      }
    } else {
      const claudeAction = await writeClaudeMd(cwd);
      agentEntries.push({ path: CLAUDE_MD_PATH, action: claudeAction });
      claudeWritten = true;
    }
  }

  files.push({
    path: README_PATH,
    action: await ensureFile(
      join(cwd, README_PATH),
      // Document the AGENTS.md / CLAUDE.md bullet only when both files
      // are present on disk after this run. Skipped CLAUDE.md (duplicate
      // AGENTS.md case) means the README would describe a file that
      // isn't there; the bullet is suppressed to keep the README
      // truthful.
      STARTER_README(options.name, {
        agentsMd: options.agentsMd === true && claudeWritten,
      }),
    ),
  });
  files.push({
    path: GITIGNORE_PATH,
    action: await patchGitignore(cwd),
  });
  files.push({
    path: PACKAGE_JSON_PATH,
    action: await patchPackageJson(cwd, options.name),
  });
  for (const entry of agentEntries) files.push(entry);
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
