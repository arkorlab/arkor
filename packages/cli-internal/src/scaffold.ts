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

export type FileAction = "created" | "kept" | "patched" | "ok";

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
}

const INDEX_PATH = "src/arkor/index.ts";
const TRAINER_PATH = "src/arkor/trainer.ts";
const CONFIG_PATH = "arkor.config.ts";
const README_PATH = "README.md";
const GITIGNORE_PATH = ".gitignore";
const PACKAGE_JSON_PATH = "package.json";
const AGENTS_MD_PATH = "AGENTS.md";
const CLAUDE_MD_PATH = "CLAUDE.md";
const DEFAULT_ARKOR_SPEC = "^0.0.1-alpha.7";

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
3. <https://docs.arkor.ai> — public docs site, identical content to (1). Use this when dependencies are not installed (e.g. fresh scaffold without \`install\`, install failure, Yarn PnP) or when the installed copy is older than what is published.
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

/**
 * Locate the arkor-managed block in `s`.
 *
 * Three layered guards keep this from misclassifying user-authored prose
 * (or pasted documentation) as the managed block:
 *
 *   1. **Line-anchored markers.** BEGIN and END must each sit at the
 *      start of a line (optionally after a CR). Inline mentions inside
 *      backticks (e.g. "delimited by `<!-- BEGIN:arkor-agent-rules -->`")
 *      therefore do not register.
 *   2. **Signature line.** The line immediately after BEGIN must equal
 *      `AGENTS_BLOCK_SIGNATURE_LINE` ("# arkor is newer than your
 *      training data"). A user documenting the marker syntax inside a
 *      fenced code block almost certainly will not also reproduce that
 *      exact heading. If they do (or if the user wholesale rewrote the
 *      managed block to remove the heading) we deliberately fall through
 *      to the append path, which preserves their bytes and adds a fresh
 *      canonical block at the end.
 *   3. **Trailing pair.** When several signature-matching pairs exist
 *      (rare — e.g. an aggregator README that pastes the canonical block
 *      multiple times), pick the trailing one because the canonical block
 *      is always written at the end of the file by the append path.
 */
function findManagedBlock(
  s: string,
): { begin: number; end: number } | null {
  // All inter-line breaks accept either LF or CRLF. Hard-coding `\n`
  // would cause re-scaffolds of a CRLF AGENTS.md to miss the previously
  // inserted block (its line breaks are `\r\n`), fall through to the
  // append path, and stack a second canonical block on every run —
  // breaking idempotency on Windows checkouts.
  const NL = "(?:\\r\\n|\\n)";
  const re = new RegExp(
    `(?:^|${NL})${escapeRegExp(AGENTS_BLOCK_BEGIN)}${NL}${escapeRegExp(
      AGENTS_BLOCK_SIGNATURE_LINE,
    )}${NL}[\\s\\S]*?${NL}${escapeRegExp(AGENTS_BLOCK_END)}`,
    "gm",
  );
  const matches = [...s.matchAll(re)];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1]!;
  // Strip the leading-newline anchor so we replace the marker itself,
  // not the newline ahead of it. The leading anchor is either `\r\n`
  // (2 chars), `\n` (1 char), or absent (0 chars — file starts with the
  // marker). Match-boundary `m.index` always points at the newline
  // start, so the offset is just the leading-NL byte length.
  const leadingNl = m[0].startsWith("\r\n")
    ? 2
    : m[0].startsWith("\n")
      ? 1
      : 0;
  return {
    begin: m.index + leadingNl,
    end: m.index + m[0].length,
  };
}

async function writeAgentsMd(cwd: string): Promise<FileAction> {
  const path = join(cwd, AGENTS_MD_PATH);
  if (!existsSync(path)) {
    await writeFile(path, `${AGENTS_BLOCK_BODY}\n`);
    return "created";
  }
  const current = await readFile(path, "utf8");
  const eol = detectEol(current);
  const block = withEol(AGENTS_BLOCK_BODY, eol);

  const found = findManagedBlock(current);
  if (found) {
    // Replace block content only, preserving anything outside the markers.
    const before = current.slice(0, found.begin);
    const after = current.slice(found.end);
    const next = `${before}${block}${after}`;
    if (next === current) return "ok";
    await writeFile(path, next);
    return "patched";
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
  return "patched";
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
  files.push({
    path: README_PATH,
    action: await ensureFile(
      join(cwd, README_PATH),
      STARTER_README(options.name),
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
  if (options.agentsMd) {
    files.push({
      path: AGENTS_MD_PATH,
      action: await writeAgentsMd(cwd),
    });
    files.push({
      path: CLAUDE_MD_PATH,
      action: await writeClaudeMd(cwd),
    });
  }
  return { files, cwd };
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
