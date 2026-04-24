import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promptSelect, promptText, ui } from "../prompts";
import { detectPackageManager, install } from "../install";

const ENTRY_PATH = "src/arkor/index.ts";
const CONFIG_PATH = "arkor.config.ts";

type TemplateId = "minimal" | "alpaca" | "chatml";

const TEMPLATES: Record<TemplateId, string> = {
  minimal: `import { createTrainer } from "arkor";

export default createTrainer({
  name: "my-first-run",
  config: {
    model: "unsloth/gemma-4-E4B-it",
    datasetSource: {
      type: "huggingface",
      name: "yahma/alpaca-cleaned",
      split: "train[:500]",
    },
    maxSteps: 50,
    loraR: 16,
    loraAlpha: 16,
  },
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
  },
});
`,
  alpaca: `import { createTrainer } from "arkor";

export default createTrainer({
  name: "alpaca-run",
  config: {
    model: "unsloth/gemma-4-E4B-it",
    datasetSource: {
      type: "huggingface",
      name: "yahma/alpaca-cleaned",
      split: "train[:1000]",
    },
    datasetFormat: { type: "alpaca" },
    maxSteps: 100,
    loraR: 16,
    loraAlpha: 16,
  },
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
    onCheckpoint: async ({ step, infer }) => {
      const res = await infer({
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      });
      console.log(\`ckpt @ \${step}:\`, await res.text());
    },
  },
});
`,
  chatml: `import { createTrainer } from "arkor";

export default createTrainer({
  name: "chatml-run",
  config: {
    model: "unsloth/gemma-4-E4B-it",
    datasetSource: {
      type: "huggingface",
      name: "stingning/ultrachat",
      split: "train[:500]",
    },
    datasetFormat: { type: "chatml" },
    maxSteps: 100,
    loraR: 16,
    loraAlpha: 16,
  },
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
  },
});
`,
};

const STARTER_CONFIG = `// Training defaults. Project routing (orgSlug / projectSlug) is tracked
// automatically in .arkor/state.json — do not put it here.
export default {};
`;

async function ensureFile(
  path: string,
  contents: string,
): Promise<"created" | "kept"> {
  if (existsSync(path)) return "kept";
  await mkdir(join(path, "..").replace(/\/\.$/, ""), { recursive: true });
  await writeFile(path, contents);
  return "created";
}

async function patchGitignore(cwd: string): Promise<"created" | "patched" | "ok"> {
  const path = join(cwd, ".gitignore");
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

async function patchPackageJson(
  cwd: string,
  projectName: string,
): Promise<"created" | "patched" | "ok"> {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) {
    await writeFile(
      path,
      `${JSON.stringify(
        {
          name: projectName,
          private: true,
          type: "module",
          scripts: { train: "arkor train" },
          devDependencies: { arkor: "^0.0.1-alpha.0" },
        },
        null,
        2,
      )}\n`,
    );
    return "created";
  }
  const current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const scripts = (current.scripts as Record<string, string> | undefined) ?? {};
  let dirty = false;
  if (!scripts.train) {
    scripts.train = "arkor train";
    current.scripts = scripts;
    dirty = true;
  }
  const devDeps =
    (current.devDependencies as Record<string, string> | undefined) ?? {};
  if (!devDeps.arkor) {
    devDeps.arkor = "^0.0.1-alpha.0";
    current.devDependencies = devDeps;
    dirty = true;
  }
  if (!dirty) return "ok";
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);
  return "patched";
}

export interface InitOptions {
  yes?: boolean;
  name?: string;
  template?: TemplateId;
  skipInstall?: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const defaultName = cwd.split(/[/\\]/).pop() ?? "arkor-project";

  ui.intro("arkor init");
  const projectName = await promptText({
    message: "Project name?",
    initialValue: options.name ?? defaultName,
    skipWith: options.yes ? options.name ?? defaultName : undefined,
  });
  const template = await promptSelect<TemplateId>({
    message: "Starter template?",
    initialValue: options.template ?? "minimal",
    options: [
      { value: "minimal", label: "Minimal", hint: "bare createTrainer call" },
      { value: "alpaca", label: "Alpaca", hint: "instruction-tuning example" },
      { value: "chatml", label: "ChatML", hint: "multi-turn example" },
    ],
    skipWith: options.yes ? options.template ?? "minimal" : undefined,
  });

  const results: Array<[string, string]> = [];
  results.push([
    ENTRY_PATH,
    await ensureFile(join(cwd, ENTRY_PATH), TEMPLATES[template]),
  ]);
  results.push([
    CONFIG_PATH,
    await ensureFile(join(cwd, CONFIG_PATH), STARTER_CONFIG),
  ]);
  results.push([".gitignore", await patchGitignore(cwd)]);
  results.push(["package.json", await patchPackageJson(cwd, projectName)]);

  ui.note(
    results.map(([name, action]) => `${action.padEnd(8)} ${name}`).join("\n"),
    "Files",
  );

  const pm = detectPackageManager();

  let installed = false;
  if (!options.skipInstall) {
    ui.log.step(`Installing dependencies with ${pm}`);
    try {
      await install(pm, cwd);
      installed = true;
    } catch (err) {
      ui.log.warn(err instanceof Error ? err.message : String(err));
      ui.log.info(`Retry manually: ${pm} install`);
    }
  }

  ui.outro(
    installed
      ? "Next: `arkor train`"
      : `Next: ${pm} install, then \`arkor train\``,
  );
}
