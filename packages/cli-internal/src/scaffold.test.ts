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

const AGENTS_BEGIN = "<!-- BEGIN:arkor-agent-rules -->";
const AGENTS_END = "<!-- END:arkor-agent-rules -->";
// Mirror of the signature line that scaffold.ts looks for as a secondary
// guard against false-positive marker matches (e.g. user-authored docs
// inside fenced code blocks). Test fixtures that want their block to be
// recognised as the managed one must include this line right after BEGIN.
const AGENTS_SIGNATURE_LINE = "# arkor is newer than your training data";

describe("scaffold", () => {
  it("writes all starter files in an empty directory", async () => {
    const result = await scaffold({ cwd, name: "my-app", template: "triage" });
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
    expect(trainer).toContain('"triage-run"');

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

    const result = await scaffold({ cwd, name: "foo", template: "triage" });
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
      template: "triage",
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
    expect(devDeps.arkor).toBe("^0.0.1-alpha.7");

    const pkgEntry = files.find((f) => f.path === "package.json");
    expect(pkgEntry?.action).toBe("patched");
  });

  it("appends to an existing .gitignore only if the entry is missing", async () => {
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    const first = await scaffold({ cwd, name: "n", template: "triage" });
    const firstEntry = first.files.find((f) => f.path === ".gitignore");
    expect(firstEntry?.action).toBe("patched");
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toContain(".arkor/");

    const second = await scaffold({ cwd, name: "n", template: "triage" });
    const secondEntry = second.files.find((f) => f.path === ".gitignore");
    expect(secondEntry?.action).toBe("ok");
  });

  it("inserts a separating newline when the existing .gitignore lacks a trailing newline", async () => {
    // Without the `endsWith("\n") ? "" : "\n"` separator, the patched file
    // would smash the previous last line into the new `.arkor/` entry —
    // e.g. `node_modules/.arkor/`, which git would interpret as a single
    // path pattern.
    writeFileSync(join(cwd, ".gitignore"), "node_modules/");
    await scaffold({ cwd, name: "n", template: "triage" });
    const contents = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(contents).toBe("node_modules/\n.arkor/\n");
  });

  it("uses ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC override when set", async () => {
    // The value is opaque to scaffold — only that it's faithfully
    // round-tripped into package.json matters, so use a relative
    // `file:` spec that is platform-neutral (no Unix-only `/tmp`).
    const overrideSpec = "file:./vendor/arkor-0.0.1-alpha.7.tgz";
    process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC = overrideSpec;
    const { files } = await scaffold({
      cwd,
      name: "override-app",
      template: "triage",
    });
    const pkg = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const devDeps = pkg.devDependencies as Record<string, string>;
    expect(devDeps.arkor).toBe(overrideSpec);
    const pkgEntry = files.find((f) => f.path === "package.json");
    expect(pkgEntry?.action).toBe("created");
  });

  it.each([
    { label: "empty string", value: "" },
    { label: "whitespace only", value: "   " },
  ])(
    "falls back to the default spec when ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC is $label",
    async ({ value }) => {
      // Without the trim+length guard, an empty/whitespace override would
      // be written verbatim into package.json (`"arkor": ""`), which is
      // not a valid dependency spec. Treat both as "unset".
      process.env.ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC = value;
      await scaffold({
        cwd,
        name: "blank-override",
        template: "triage",
      });
      const pkg = JSON.parse(
        readFileSync(join(cwd, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      const devDeps = pkg.devDependencies as Record<string, string>;
      expect(devDeps.arkor).toBe("^0.0.1-alpha.7");
    },
  );

  it("uses ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC override when patching an existing package.json", async () => {
    // The spec resolution is shared between the create path (above)
    // and the patch path that runs when `package.json` already exists
    // but has no `devDependencies.arkor`. Cover the patch path too so
    // the override doesn't silently regress to the default there.
    const overrideSpec = "file:./vendor/arkor-0.0.1-alpha.7.tgz";
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
      template: "triage",
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

  it("creates the target directory when it does not exist yet", async () => {
    // The fresh-scaffold path used by `npm create arkor my-new-app` runs
    // before the directory exists on disk. ensureDirExists's mkdir branch
    // only fires there — once the directory exists, scaffold reuses it.
    const parent = mkdtempSync(join(tmpdir(), "scaffold-fresh-"));
    const fresh = join(parent, "brand-new");
    try {
      await scaffold({ cwd: fresh, name: "brand-new", template: "triage" });
      expect(readFileSync(join(fresh, "package.json"), "utf8")).toContain(
        '"brand-new"',
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not write AGENTS.md or CLAUDE.md when agentsMd is omitted", async () => {
    // Default behavior: scaffold() leaves AGENTS.md / CLAUDE.md alone unless
    // the caller opts in. Protects existing arkor init flow that doesn't pass
    // the flag.
    const { existsSync } = await import("node:fs");
    const result = await scaffold({ cwd, name: "no-agents", template: "triage" });
    expect(result.files.map((f) => f.path)).not.toContain("AGENTS.md");
    expect(result.files.map((f) => f.path)).not.toContain("CLAUDE.md");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
  });

  it("creates AGENTS.md and CLAUDE.md when agentsMd is true and neither file exists", async () => {
    const result = await scaffold({
      cwd,
      name: "agentic",
      template: "triage",
      agentsMd: true,
    });
    const agents = result.files.find((f) => f.path === "AGENTS.md");
    const claude = result.files.find((f) => f.path === "CLAUDE.md");
    expect(agents?.action).toBe("created");
    expect(claude?.action).toBe("created");

    const agentsBody = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsBody).toContain(AGENTS_BEGIN);
    expect(agentsBody).toContain(AGENTS_END);
    expect(agentsBody).toContain("arkor is newer than your training data");
    expect(agentsBody).toContain("node_modules/arkor/docs/");
    // No trailing junk past the closing marker on a fresh write.
    expect(agentsBody.endsWith(`${AGENTS_END}\n`)).toBe(true);

    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("appends the managed block to an existing AGENTS.md without markers", async () => {
    const existing = "# My project\n\nSome notes from the user.\n";
    writeFileSync(join(cwd, "AGENTS.md"), existing);
    const result = await scaffold({
      cwd,
      name: "merge",
      template: "triage",
      agentsMd: true,
    });
    const agents = result.files.find((f) => f.path === "AGENTS.md");
    expect(agents?.action).toBe("patched");

    const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    // Existing user content must survive verbatim ahead of the block.
    expect(body.startsWith(existing)).toBe(true);
    expect(body).toContain(AGENTS_BEGIN);
    expect(body).toContain(AGENTS_END);
    // Exactly one blank line between user content and the block.
    expect(body).toMatch(/Some notes from the user\.\n\n<!-- BEGIN:arkor-agent-rules -->/);
  });

  it("replaces only the block contents when AGENTS.md already has the markers", async () => {
    const before = "# Project\n\n";
    const after = "\n\n## Manual notes outside the block\n";
    // The fixture must include the signature line to be recognised as
    // the managed block (otherwise the patch path treats it as user
    // content and falls through to append).
    const stale = `${before}${AGENTS_BEGIN}\n${AGENTS_SIGNATURE_LINE}\nstale content\n${AGENTS_END}${after}`;
    writeFileSync(join(cwd, "AGENTS.md"), stale);
    const result = await scaffold({
      cwd,
      name: "patch",
      template: "triage",
      agentsMd: true,
    });
    const agents = result.files.find((f) => f.path === "AGENTS.md");
    expect(agents?.action).toBe("patched");

    const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(body.startsWith(before)).toBe(true);
    expect(body.endsWith(after)).toBe(true);
    // Stale content gone; canonical body present.
    expect(body).not.toContain("stale content");
    expect(body).toContain("arkor is newer than your training data");
  });

  it("ignores stray marker mentions outside the managed block (does not duplicate on re-scaffold)", async () => {
    // Regression: previously the END marker was located via
    // `current.indexOf(END)` from the start of the file, so a user-
    // authored mention of the END marker (in notes / explanation text)
    // before the real managed block would either patch the wrong span
    // (when END appeared between BEGIN and the real END) or fall through
    // to the append path entirely (when END appeared before BEGIN). On
    // every re-scaffold the append path would add a fresh canonical
    // block, growing the file unboundedly.
    const userNotes =
      "# Project\n" +
      "\n" +
      "Note: the canonical block is delimited by `<!-- BEGIN:arkor-agent-rules -->` " +
      "and `<!-- END:arkor-agent-rules -->`.\n" +
      "\n";
    // Real managed block sits *after* the prose mentions above. The END
    // string in the prose appears earlier in the file than the real END.
    // Signature line distinguishes the real managed block from any
    // line-anchored marker pair the user might paste in their notes.
    const realBlock = `${AGENTS_BEGIN}\n${AGENTS_SIGNATURE_LINE}\noriginal canonical body\n${AGENTS_END}`;
    writeFileSync(join(cwd, "AGENTS.md"), `${userNotes}${realBlock}\n`);

    // Counting helper: only line-anchored markers (start of file or
    // immediately after a newline) count as canonical markers; inline
    // mentions inside prose / backticks are just text that must be
    // preserved verbatim.
    const countAnchored = (s: string, marker: string): number => {
      const re = new RegExp(`(?:^|\\n)${marker.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`, "g");
      return (s.match(re) ?? []).length;
    };

    // First re-scaffold: should patch the real block in place.
    const first = await scaffold({
      cwd,
      name: "stray-marker",
      template: "triage",
      agentsMd: true,
    });
    expect(first.files.find((f) => f.path === "AGENTS.md")?.action).toBe(
      "patched",
    );
    const after = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(after).toContain("arkor is newer than your training data");
    expect(after).not.toContain("original canonical body");
    // Exactly one canonical (line-anchored) BEGIN/END pair — the prose
    // mention is preserved verbatim but does not count as a canonical
    // marker because it is inside backticks.
    expect(countAnchored(after, AGENTS_BEGIN)).toBe(1);
    expect(countAnchored(after, AGENTS_END)).toBe(1);
    expect(after).toContain("Note: the canonical block is delimited by");

    // Second re-scaffold: must be idempotent — file size and marker
    // count both stable, no second block appended.
    const second = await scaffold({
      cwd,
      name: "stray-marker",
      template: "triage",
      agentsMd: true,
    });
    expect(second.files.find((f) => f.path === "AGENTS.md")?.action).toBe(
      "ok",
    );
    const final = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(final).toBe(after);
    expect(countAnchored(final, AGENTS_BEGIN)).toBe(1);
    expect(countAnchored(final, AGENTS_END)).toBe(1);
  });

  it("returns 'ok' when AGENTS.md already has the canonical block", async () => {
    // First scaffold creates the file; second scaffold should detect the
    // block is already up-to-date and skip the write.
    await scaffold({ cwd, name: "idempotent", template: "triage", agentsMd: true });
    const before = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    const second = await scaffold({
      cwd,
      name: "idempotent",
      template: "triage",
      agentsMd: true,
    });
    const agents = second.files.find((f) => f.path === "AGENTS.md");
    expect(agents?.action).toBe("ok");
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("preserves CRLF line endings when patching a CRLF AGENTS.md", async () => {
    // The block is authored with LF; without the eol-aware patch path it
    // would land as LF inside an otherwise-CRLF file, mixing styles and
    // breaking diff hygiene on Windows checkouts.
    const existing = "# Project\r\n\r\nNotes.\r\n";
    writeFileSync(join(cwd, "AGENTS.md"), existing);
    await scaffold({
      cwd,
      name: "crlf",
      template: "triage",
      agentsMd: true,
    });
    const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    // No bare LFs anywhere in the patched file.
    expect(body).not.toMatch(/[^\r]\n/);
    expect(body).toContain(`${AGENTS_BEGIN}\r\n`);
    expect(body).toContain(`\r\n${AGENTS_END}`);
  });

  it("treats a stray CRLF in an otherwise-LF AGENTS.md as LF (dominant style)", async () => {
    // Regression for the previous detectEol implementation that flipped
    // the inserted block to CRLF as soon as a single \r\n appeared
    // anywhere in the file. Real-world AGENTS.md files often pick up a
    // stray CRLF from a copy-paste; the patch must keep matching the
    // dominant convention (LF here, three lines vs. one).
    const existing = "# Project\nLine A\nLine B (stray)\r\nLine C\n";
    writeFileSync(join(cwd, "AGENTS.md"), existing);
    await scaffold({
      cwd,
      name: "mixed-eol",
      template: "triage",
      agentsMd: true,
    });
    const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    // The pre-existing stray CRLF must survive untouched outside the block.
    expect(body).toContain("Line B (stray)\r\n");
    // The inserted block — checked via its first newline after BEGIN —
    // must be LF, not CRLF.
    expect(body).toContain(`${AGENTS_BEGIN}\n`);
    expect(body).not.toContain(`${AGENTS_BEGIN}\r\n`);
  });

  it("preserves the user's trailing-newline pattern when appending the block", async () => {
    // Regression: previously the append path called
    // `current.replace(/(\r?\n)+$/, "")` which collapsed any trailing
    // run of newlines, destroying intentional formatting (a user's file
    // ending in two blank lines would silently lose them on first
    // re-scaffold). The non-destructive guarantee requires the user's
    // own bytes outside the managed block to be byte-identical.
    const existing = "# Project\n\nNotes.\n\n\n\n"; // four trailing newlines
    writeFileSync(join(cwd, "AGENTS.md"), existing);
    await scaffold({
      cwd,
      name: "trailing-newlines",
      template: "triage",
      agentsMd: true,
    });
    const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    // The original tail (including all four trailing newlines) survives
    // intact ahead of the appended block.
    expect(body.startsWith(existing)).toBe(true);
    // And the canonical block follows.
    expect(body).toContain(AGENTS_BEGIN);
    expect(body).toContain(AGENTS_END);
  });

  it("ignores a fenced-code-block marker example earlier in AGENTS.md (canonical block is the trailing one)", async () => {
    // Coverage for the lastIndexOf-style block discovery. A user can
    // legitimately document the marker syntax inside a fenced code
    // block, putting the markers on their own lines. Earlier passes
    // would treat the example as the managed block and overwrite it on
    // re-scaffold. The fix is to pick the *trailing* line-anchored
    // BEGIN..END pair: the canonical block is always written at the
    // end of the file, so any earlier line-anchored pair must be user-
    // authored prose / examples and must be preserved verbatim.
    const docExample =
      "# AGENTS.md primer\n" +
      "\n" +
      "Tools that follow the AGENTS.md spec emit a managed block like this:\n" +
      "\n" +
      "```md\n" +
      `${AGENTS_BEGIN}\n` +
      "<!-- canonical content from a tool would go here -->\n" +
      `${AGENTS_END}\n` +
      "```\n" +
      "\n" +
      "End of primer.\n";
    writeFileSync(join(cwd, "AGENTS.md"), docExample);

    await scaffold({
      cwd,
      name: "fenced-example",
      template: "triage",
      agentsMd: true,
    });
    const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");

    // The fenced documentation example survives byte-for-byte at the
    // top of the file (we only verify the example's distinctive line —
    // the surrounding fence + markers stay because they are not the
    // trailing line-anchored pair).
    expect(body).toContain(
      "<!-- canonical content from a tool would go here -->",
    );
    expect(body).toContain("End of primer.");
    // A real canonical block was appended after the example.
    expect(body).toContain("arkor is newer than your training data");

    // Re-scaffold must be idempotent: only the trailing pair gets
    // patched, so file content is byte-stable across runs and the
    // documentation example is never touched.
    await scaffold({
      cwd,
      name: "fenced-example",
      template: "triage",
      agentsMd: true,
    });
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(body);
  });

  it("never overwrites an existing CLAUDE.md", async () => {
    const userClaude = "# my own claude file\nproject-specific instructions\n";
    writeFileSync(join(cwd, "CLAUDE.md"), userClaude);
    const result = await scaffold({
      cwd,
      name: "claude-kept",
      template: "triage",
      agentsMd: true,
    });
    const claude = result.files.find((f) => f.path === "CLAUDE.md");
    expect(claude?.action).toBe("kept");
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe(userClaude);
  });

  it("renders each template with a distinct trainer body", async () => {
    const expectations: Record<"triage" | "translate" | "redaction", string> = {
      triage: `"triage-run"`,
      translate: `"translate-run"`,
      redaction: `"redaction-run"`,
    };
    for (const template of ["triage", "translate", "redaction"] as const) {
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
  it("recognises bun via user-agent", () => {
    // `bunx create-arkor` sets npm_config_user_agent to
    // `bun/<ver> npm/? …`. Without this branch, scaffolds run under bunx
    // would fall into the "no detected pm" path and ask the user to
    // install deps manually even though bun was just used to launch them.
    process.env.npm_config_user_agent = "bun/1.1.0 npm/? node/v22 linux x64";
    expect(detectPackageManager()).toBe("bun");
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
  it("exposes every registered template with a hint", () => {
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
