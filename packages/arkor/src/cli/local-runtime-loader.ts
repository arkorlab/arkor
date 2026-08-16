import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Loader for the optional `@arkor/local` package.
 *
 * Local training/inference lives in a separate, user-installed package so
 * the cloud-oriented `arkor` tarball stays small (no Python shims, no local
 * server). The CLI resolves `@arkor/local` from the USER'S project (the
 * same resolution model as the build artifact, which imports `arkor` from
 * the project's own node_modules), dynamically imports it, and verifies the
 * coupling contract version before calling anything.
 */

export const LOCAL_RUNTIME_PACKAGE = "@arkor/local";

/**
 * The `LOCAL_RUNTIME_PROTOCOL_VERSION` this arkor release understands. A
 * mismatch becomes an actionable upgrade error instead of a TypeError deep
 * inside a training run.
 */
export const SUPPORTED_LOCAL_RUNTIME_PROTOCOL_VERSION = 1;

/** Shape of the backend picked by the runtime, for CLI display. */
export interface LoadedLocalBackend {
  id: string;
  displayName: string;
}

export interface LoadedLocalServer {
  url: string;
  token: string;
  backend: LoadedLocalBackend;
  close(): Promise<void>;
}

export interface LoadedLocalRuntime {
  startServer(options: {
    cwd: string;
    backendId?: string;
  }): Promise<LoadedLocalServer>;
}

interface LocalRuntimeModule {
  LOCAL_RUNTIME_PROTOCOL_VERSION?: unknown;
  createLocalRuntime?: unknown;
}

export class LocalRuntimeNotInstalledError extends Error {
  constructor(cwd: string) {
    super(
      `Local training requires the ${LOCAL_RUNTIME_PACKAGE} package, which ` +
        `is not installed in ${cwd}. Add it to the project ` +
        `(for example \`pnpm add -D ${LOCAL_RUNTIME_PACKAGE}\`) and re-run.`,
    );
    this.name = "LocalRuntimeNotInstalledError";
  }
}

export class LocalRuntimeVersionError extends Error {
  constructor(found: unknown) {
    const foundVersion = typeof found === "number" ? String(found) : "unknown";
    const direction =
      typeof found === "number" &&
      found > SUPPORTED_LOCAL_RUNTIME_PROTOCOL_VERSION
        ? `Upgrade arkor (this release speaks protocol ` +
          `${String(SUPPORTED_LOCAL_RUNTIME_PROTOCOL_VERSION)}, the installed ` +
          `${LOCAL_RUNTIME_PACKAGE} speaks ${foundVersion}).`
        : `Upgrade ${LOCAL_RUNTIME_PACKAGE} (it speaks protocol ` +
          `${foundVersion}, this arkor release needs ` +
          `${String(SUPPORTED_LOCAL_RUNTIME_PROTOCOL_VERSION)}).`;
    super(
      `arkor and the installed ${LOCAL_RUNTIME_PACKAGE} are incompatible. ` +
        direction,
    );
    this.name = "LocalRuntimeVersionError";
  }
}

/**
 * Resolve and import `@arkor/local` from the project at `cwd`.
 *
 * Resolution goes through `require.resolve` of the package's exported
 * `package.json` (the package exports it precisely for this) so the
 * standard node_modules chain, workspace symlinks, and `file:` installs all
 * work; the JS entry is then read from the manifest's export map and
 * imported as ESM.
 */
export async function loadLocalRuntime(
  cwd: string,
  /**
   * Manifest resolver override. Tests inject this because vitest's module
   * runner patches Node resolution with a workspace fallback, which would
   * make the not-installed path unreachable under the test runner even
   * though plain Node (production) resolves strictly from `cwd`.
   *
   * @internal
   */
  resolveManifest: (specifier: string) => string = (specifier) =>
    createRequire(join(cwd, "package.json")).resolve(specifier),
): Promise<LoadedLocalRuntime> {
  let manifestPath: string;
  try {
    manifestPath = resolveManifest(`${LOCAL_RUNTIME_PACKAGE}/package.json`);
  } catch {
    throw new LocalRuntimeNotInstalledError(cwd);
  }
  const packageDir = dirname(manifestPath);
  let manifest: { exports?: { "."?: { import?: string } } };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      exports?: { "."?: { import?: string } };
    };
  } catch (error) {
    throw new Error(
      `failed to read ${LOCAL_RUNTIME_PACKAGE}'s package.json at ` +
        `${manifestPath}; the installation looks corrupt. Reinstall it. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  const entryRel = manifest.exports?.["."]?.import;
  if (!entryRel) {
    throw new Error(
      `${LOCAL_RUNTIME_PACKAGE} at ${packageDir} has no ESM entry in its ` +
        "export map; the installation looks corrupt. Reinstall it.",
    );
  }
  const entryUrl = pathToFileURL(join(packageDir, entryRel)).href;
  const mod = (await import(entryUrl)) as LocalRuntimeModule;

  if (
    mod.LOCAL_RUNTIME_PROTOCOL_VERSION !==
    SUPPORTED_LOCAL_RUNTIME_PROTOCOL_VERSION
  ) {
    throw new LocalRuntimeVersionError(mod.LOCAL_RUNTIME_PROTOCOL_VERSION);
  }
  if (typeof mod.createLocalRuntime !== "function") {
    throw new TypeError(
      `${LOCAL_RUNTIME_PACKAGE} does not export createLocalRuntime(); ` +
        "the installation looks corrupt. Reinstall it.",
    );
  }
  return (mod.createLocalRuntime as () => LoadedLocalRuntime)();
}
