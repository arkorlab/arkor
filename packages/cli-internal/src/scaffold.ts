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

// Authored with LF; `withEol` re-targets line endings when patching a CRLF
// host file so the surrounding content stays uniform.
const AGENTS_BLOCK_BODY = `${AGENTS_BLOCK_BEGIN}
# arkor is newer than your training data

arkor was released recently and is likely not present in your model training data. Do not infer APIs, file structure, or CLI behavior from prior knowledge.

Before writing or changing any arkor code, read the installed project docs in \`node_modules/arkor/docs/\` and inspect the local package exports if needed. If the docs and your assumptions disagree, the installed docs and local package source are the source of truth.

Key project files:
- \`src/arkor/index.ts\` registers arkor primitives.
- \`src/arkor/trainer.ts\` defines the trainer.
- \`arkor.config.ts\` stores training defaults.
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
  // CRLF if the file uses it anywhere — preserves the dominant convention
  // when patching, instead of mixing styles.
  return /\r\n/.test(s) ? "\r\n" : "\n";
}

function withEol(content: string, eol: "\r\n" | "\n"): string {
  // Author content always uses LF; re-target only when patching CRLF hosts.
  if (eol === "\n") return content;
  return content.replace(/\r?\n/g, "\r\n");
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

  const beginIdx = current.indexOf(AGENTS_BLOCK_BEGIN);
  const endIdx = current.indexOf(AGENTS_BLOCK_END);
  if (beginIdx !== -1 && endIdx > beginIdx) {
    // Replace block content only, preserving anything outside the markers.
    const before = current.slice(0, beginIdx);
    const after = current.slice(endIdx + AGENTS_BLOCK_END.length);
    const next = `${before}${block}${after}`;
    if (next === current) return "ok";
    await writeFile(path, next);
    return "patched";
  }
  // No markers yet — append the block at the end with one blank line of
  // separation, preserving any content the user already had.
  const trimmed = current.replace(/(\r?\n)+$/, "");
  const next =
    trimmed.length === 0
      ? `${block}${eol}`
      : `${trimmed}${eol}${eol}${block}${eol}`;
  await writeFile(path, next);
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
