import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Imports above are used by helpers + the new "empty cwd" test below.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiClient, CloudApiError } from "./client";
import type { AnonymousCredentials, Auth0Credentials } from "./credentials";
import { ensureProjectState } from "./projectState";
import { readState, writeState } from "./state";

let cwd: string;

const anonCreds: AnonymousCredentials = {
  mode: "anon",
  token: "tok",
  anonymousId: "abc",
  arkorCloudApiUrl: "http://mock",
  orgSlug: "anon-abc",
};

const auth0Creds: Auth0Credentials = {
  mode: "auth0",
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 0,
  auth0Domain: "d",
  audience: "a",
  clientId: "c",
};

function fakeClient(
  overrides: Partial<{
    createProject: CloudApiClient["createProject"];
    listProjects: CloudApiClient["listProjects"];
  }> = {},
): CloudApiClient {
  // Construct a real CloudApiClient (so type-compatibility holds), then
  // monkey-patch only the methods exercised by ensureProjectState. The
  // other methods would throw on first use because no fetcher is wired,
  // which is fine: projectState should never reach them.
  const client = new CloudApiClient({
    baseUrl: "http://mock",
    credentials: anonCreds,
    fetch: (async () => {
      throw new Error("ensureProjectState should not call fetch directly");
    }) as typeof fetch,
  });
  if (overrides.createProject) client.createProject = overrides.createProject;
  if (overrides.listProjects) client.listProjects = overrides.listProjects;
  return client;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-projectstate-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ensureProjectState", () => {
  it("returns existing state without calling the API when state.json is present", async () => {
    await writeState(
      { orgSlug: "anon-abc", projectSlug: "proj", projectId: "pid-1" },
      cwd,
    );
    const createProject = vi.fn();
    const client = fakeClient({
      createProject: createProject as unknown as CloudApiClient["createProject"],
    });

    const state = await ensureProjectState({
      cwd,
      client,
      credentials: anonCreds,
    });

    expect(state).toEqual({
      orgSlug: "anon-abc",
      projectSlug: "proj",
      projectId: "pid-1",
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("throws for auth0 callers without state: they must run `arkor init`", async () => {
    const client = fakeClient();
    await expect(
      ensureProjectState({ cwd, client, credentials: auth0Creds }),
    ).rejects.toThrow(/arkor init/);
  });

  it("creates a project for anonymous callers and persists state.json", async () => {
    const created = { id: "pid-new", slug: "my-app", name: "my-app" };
    const createProject = vi
      .fn()
      .mockResolvedValue({ project: created });
    const client = fakeClient({
      createProject: createProject as unknown as CloudApiClient["createProject"],
    });

    // Use a cwd whose basename should sanitise to "my-app".
    const projectDir = mkdtempSync(join(tmpdir(), "my-app-"));
    try {
      const state = await ensureProjectState({
        cwd: projectDir,
        client,
        credentials: anonCreds,
      });
      expect(state).toEqual({
        orgSlug: "anon-abc",
        projectSlug: "my-app",
        projectId: "pid-new",
      });
      expect(createProject).toHaveBeenCalledWith({
        orgSlug: "anon-abc",
        name: expect.stringMatching(/^my-app/),
        // Sanitised slug: basename starts with "my-app-<random>", and we
        // expect the sanitiser to keep dashes.
        slug: expect.stringMatching(/^my-app/),
      });

      // state.json was written.
      expect(await readState(projectDir)).toEqual(state);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("falls back to listing projects on 409 and reuses the existing match", async () => {
    const conflict = new CloudApiError(409, "slug already exists");
    const createProject = vi.fn().mockRejectedValue(conflict);
    const listProjects = vi.fn().mockResolvedValue({
      projects: [
        { id: "other-id", slug: "other", name: "other" },
        { id: "pid-existing", slug: "wanted-slug", name: "wanted" },
      ],
    });
    const client = fakeClient({
      createProject: createProject as unknown as CloudApiClient["createProject"],
      listProjects: listProjects as unknown as CloudApiClient["listProjects"],
    });

    // Force the cwd basename to sanitise to "wanted-slug" so the lookup
    // matches the second row above.
    const projectDir = mkdtempSync(join(tmpdir(), "scratch-"));
    const targetDir = join(projectDir, "wanted-slug");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(targetDir, { recursive: true });

    try {
      const state = await ensureProjectState({
        cwd: targetDir,
        client,
        credentials: anonCreds,
      });
      expect(state.projectId).toBe("pid-existing");
      expect(state.projectSlug).toBe("wanted-slug");
      expect(listProjects).toHaveBeenCalledWith("anon-abc");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("rethrows the 409 when the listing does not contain the conflicting slug", async () => {
    // E.g. the project belongs to a different org the API filtered out;
    // we shouldn't silently invent state for a project we can't see.
    const conflict = new CloudApiError(409, "slug already exists");
    const createProject = vi.fn().mockRejectedValue(conflict);
    const listProjects = vi.fn().mockResolvedValue({ projects: [] });
    const client = fakeClient({
      createProject: createProject as unknown as CloudApiClient["createProject"],
      listProjects: listProjects as unknown as CloudApiClient["listProjects"],
    });

    const projectDir = mkdtempSync(join(tmpdir(), "ghost-"));
    try {
      await expect(
        ensureProjectState({
          cwd: projectDir,
          client,
          credentials: anonCreds,
        }),
      ).rejects.toBe(conflict);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("rethrows non-409 CloudApiErrors without listing", async () => {
    const err = new CloudApiError(500, "internal");
    const createProject = vi.fn().mockRejectedValue(err);
    const listProjects = vi.fn();
    const client = fakeClient({
      createProject: createProject as unknown as CloudApiClient["createProject"],
      listProjects: listProjects as unknown as CloudApiClient["listProjects"],
    });

    await expect(
      ensureProjectState({ cwd, client, credentials: anonCreds }),
    ).rejects.toBe(err);
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("sanitises a basename with disallowed characters and falls back to 'project' when empty", async () => {
    const captured: { name: string; slug: string }[] = [];
    const createProject = vi
      .fn()
      .mockImplementation(async (input: { name: string; slug: string }) => {
        captured.push({ name: input.name, slug: input.slug });
        return {
          project: { id: "pid", slug: input.slug, name: input.name },
        };
      });
    const client = fakeClient({
      createProject: createProject as unknown as CloudApiClient["createProject"],
    });

    // basename "!!!" sanitises to empty → fallback "project".
    const weirdParent = mkdtempSync(join(tmpdir(), "weird-"));
    const { mkdirSync } = await import("node:fs");
    const weirdDir = join(weirdParent, "!!!");
    mkdirSync(weirdDir);

    try {
      const state = await ensureProjectState({
        cwd: weirdDir,
        client,
        credentials: anonCreds,
      });
      expect(state.projectSlug).toBe("project");
      // The unsanitised basename is still passed as `name`, so the user
      // sees their original directory name in the dashboard.
      expect(captured[0]?.name).toBe("!!!");
      expect(captured[0]?.slug).toBe("project");
    } finally {
      rmSync(weirdParent, { recursive: true, force: true });
    }
  });

  it("falls back to 'project' as the basename when cwd has no extractable component", async () => {
    // `"".split(/[/\\]/).filter(Boolean).pop()` is `undefined`. Without
    // the `?? "project"` fallback, basename would be undefined and slug
    // generation would crash on `.toLowerCase()`. Use empty-string cwd
    // so writeState resolves relative to a real (writable) tempdir we
    // chdir into for this single test.
    const ORIG_CWD = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "root-cwd-"));
    process.chdir(tmp);
    try {
      const captured: { name: string; slug: string }[] = [];
      const createProject = vi
        .fn()
        .mockImplementation(async (input: { name: string; slug: string }) => {
          captured.push({ name: input.name, slug: input.slug });
          return {
            project: { id: "pid", slug: input.slug, name: input.name },
          };
        });
      const client = fakeClient({
        createProject:
          createProject as unknown as CloudApiClient["createProject"],
      });

      const state = await ensureProjectState({
        cwd: "",
        client,
        credentials: anonCreds,
      });

      expect(state.projectSlug).toBe("project");
      expect(captured[0]?.name).toBe("project");
    } finally {
      process.chdir(ORIG_CWD);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("caps the derived slug at 40 characters", async () => {
    const captured: { slug: string }[] = [];
    const createProject = vi
      .fn()
      .mockImplementation(async (input: { name: string; slug: string }) => {
        captured.push({ slug: input.slug });
        return {
          project: { id: "pid", slug: input.slug, name: input.name },
        };
      });
    const client = fakeClient({
      createProject: createProject as unknown as CloudApiClient["createProject"],
    });

    const longParent = mkdtempSync(join(tmpdir(), "long-"));
    const { mkdirSync } = await import("node:fs");
    const longDir = join(longParent, "a".repeat(80));
    mkdirSync(longDir);

    try {
      await ensureProjectState({
        cwd: longDir,
        client,
        credentials: anonCreds,
      });
      expect(captured[0]?.slug.length).toBe(40);
    } finally {
      rmSync(longParent, { recursive: true, force: true });
    }
  });
});
