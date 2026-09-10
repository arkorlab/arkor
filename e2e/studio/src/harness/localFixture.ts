import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./seedFixture";

import type { FixturePaths } from "./seedFixture";

/**
 * Fixture builder for `arkor dev --local` specs.
 *
 * Unlike the cloud fixture, nothing cloud-shaped is seeded: no
 * credentials, no `.arkor/state.json`. The project gets the REAL `arkor`
 * and `@arkor/local` workspace builds linked into `node_modules` (the
 * layout a node-linker=node-modules install produces) plus a fake `uv`
 * on PATH whose "training" is a Node script speaking the shim protocol,
 * so the whole local stack short of Python/mlx-lm runs for real.
 */

const ARKOR_PKG_DIR = fileURLToPath(
  new URL("../../../../packages/arkor", import.meta.url),
);
const ARKOR_LOCAL_PKG_DIR = fileURLToPath(
  new URL("../../../../packages/arkor-local", import.meta.url),
);

export interface LocalFixturePaths extends FixturePaths {
  /** Directory holding the fake `uv`; prepend to PATH. */
  fakeUvBinDir: string;
}

const LOCAL_MANIFEST = `import { createArkor, createTrainer } from "arkor";

export const arkor = createArkor({
  trainer: createTrainer({
    name: "studio-local-e2e-trainer",
    model: "mlx-community/e2e-tiny-model",
    dataset: { type: "huggingface", name: "org/data" },
    datasetFormat: { type: "chatml" },
    maxSteps: 3,
  }),
});
`;

const FAKE_TRAINER = String.raw`import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runIdx = process.argv.indexOf("--run");
const runPath = runIdx === -1 ? undefined : process.argv[runIdx + 1];
if (!runPath) {
  process.stderr.write("fake-trainer: missing --run <run.json>\n");
  process.exit(2);
}
const run = JSON.parse(readFileSync(runPath, "utf8"));
const finalDir = join(run.paths.adaptersDir, "final");
mkdirSync(finalDir, { recursive: true });
writeFileSync(join(finalDir, "adapter_config.json"), "{}\n");
writeFileSync(join(finalDir, "adapters.safetensors"), "fake-weights\n");
const emit = (o) => process.stdout.write("@arkor " + JSON.stringify(o) + "\n");
emit({ type: "started" });
emit({ type: "log", step: 1, loss: 2.5 });
emit({ type: "log", step: 3, loss: 1.5 });
emit({ type: "completed", adapterDir: finalDir });
`;

function installFakeUv(projectDir: string): string {
  const binDir = join(projectDir, "fake-uv-bin");
  mkdirSync(binDir, { recursive: true });
  const trainerPath = join(binDir, "fake-trainer.mjs");
  writeFileSync(trainerPath, FAKE_TRAINER);
  const uvPath = join(binDir, "uv");
  writeFileSync(
    uvPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "uv 9.9.9 (fake)"
  exit 0
fi
RUN=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--run" ]; then RUN="$a"; fi
  prev="$a"
done
if [ -z "$RUN" ]; then
  echo "fake uv: no --run argument found in: $*" >&2
  exit 2
fi
exec "${process.execPath}" "${trainerPath}" --run "$RUN"
`,
  );
  chmodSync(uvPath, 0o755);
  return binDir;
}

export function createLocalFixture(): LocalFixturePaths {
  const home = makeTempDir("studio-local-e2e-home-");
  const projectDir = makeTempDir("studio-local-e2e-project-");
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      { name: "studio-local-e2e", version: "0.0.0", type: "module" },
      null,
      2,
    ) + "\n",
  );
  mkdirSync(join(projectDir, "src", "arkor"), { recursive: true });
  writeFileSync(join(projectDir, "src", "arkor", "index.ts"), LOCAL_MANIFEST);
  mkdirSync(join(projectDir, "node_modules", "@arkor"), { recursive: true });
  symlinkSync(
    ARKOR_PKG_DIR,
    join(projectDir, "node_modules", "arkor"),
    "junction",
  );
  symlinkSync(
    ARKOR_LOCAL_PKG_DIR,
    join(projectDir, "node_modules", "@arkor", "local"),
    "junction",
  );
  const fakeUvBinDir = installFakeUv(projectDir);
  return { home, projectDir, fakeUvBinDir };
}
