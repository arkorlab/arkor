import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FixturePaths {
  /** Test-scoped HOME — `~/.arkor/credentials.json` lands here. */
  home: string;
  /** Project root — holds `src/arkor/index.ts` and `.arkor/state.json`. */
  projectDir: string;
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Pre-seed an anonymous credential file so `ensureCredentialsForStudio()`
 * in `arkor dev` short-circuits. Without this the CLI would call
 * `fetchCliConfig` + `requestAnonymousToken` against the real cloud-api
 * on launch — which we explicitly want to avoid for hermetic E2E.
 *
 * Mirrors the pattern in `e2e/cli/src/arkor-whoami.test.ts` (`seedAnonCreds`)
 * with the same wire-format keys (`mode`, `token`, `anonymousId`,
 * `arkorCloudApiUrl`, `orgSlug`).
 */
function seedAnonCreds(home: string, baseUrl: string): void {
  const dir = join(home, ".arkor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({
      mode: "anon",
      token: "studio-e2e-anon-token",
      anonymousId: "studio-e2e-anon",
      arkorCloudApiUrl: baseUrl,
      orgSlug: "studio-e2e-org",
    }),
    { mode: 0o600 },
  );
}

/**
 * Pre-seed `.arkor/state.json` so the Studio backend doesn't fall into
 * `ensureProjectState`'s auto-bootstrap path (which would call out to
 * cloud-api). Tests can rely on `orgSlug` + `projectSlug` matching what
 * the fake cloud-api expects on `/v1/jobs?orgSlug=…`.
 */
function seedProjectState(projectDir: string): void {
  const dir = join(projectDir, ".arkor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify(
      {
        orgSlug: "studio-e2e-org",
        projectSlug: "studio-e2e-project",
        projectId: "proj_studio_e2e",
      },
      null,
      2,
    ) + "\n",
  );
}

/**
 * Write a minimal `src/arkor/index.ts` that satisfies
 * `readManifestSummary`'s `isArkor()` guard without importing the
 * runtime `arkor` SDK. Avoiding the import means esbuild's bundle
 * resolves cleanly with no `node_modules` present — we don't need to
 * `pnpm install` the fixture at all.
 *
 * The trainer methods are placeholders: Studio's `/api/manifest` only
 * reads `trainer.name`, and `/api/train` (which would actually invoke
 * them) is not exercised by the default E2E specs.
 */
function seedManifest(projectDir: string): void {
  const dir = join(projectDir, "src", "arkor");
  mkdirSync(dir, { recursive: true });
  // Plain JS object literal with `_kind: "arkor"` — `isArkor()` only
  // checks that field, so we don't need `Object.freeze` or the real
  // `createArkor` factory.
  writeFileSync(
    join(dir, "index.ts"),
    [
      "const trainer = {",
      '  name: "e2e-studio-trainer",',
      "  start: async () => ({ id: 'e2e-job', url: '' }),",
      "  wait: async () => ({ status: 'completed' as const }),",
      "  cancel: async () => {},",
      "};",
      'export const arkor = { _kind: "arkor" as const, trainer };',
      "export default arkor;",
      "",
    ].join("\n"),
  );
}

function seedPackageJson(projectDir: string): void {
  // The Studio server doesn't read package.json directly, but `runBuild`
  // (esbuild) walks up looking for one. Provide a minimum stub so build
  // resolution is deterministic.
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      {
        name: "studio-e2e-fixture",
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
  );
}

/**
 * Build a fresh tmp HOME + project pair. Both directories are inside
 * `os.tmpdir()` so the test runner can clean them up unconditionally
 * even when a test errors out.
 */
export function createFixture(baseUrl: string): FixturePaths {
  const home = makeTempDir("studio-e2e-home-");
  const projectDir = makeTempDir("studio-e2e-project-");
  seedAnonCreds(home, baseUrl);
  seedProjectState(projectDir);
  seedPackageJson(projectDir);
  seedManifest(projectDir);
  return { home, projectDir };
}
