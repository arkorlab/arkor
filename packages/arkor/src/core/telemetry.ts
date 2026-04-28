import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import { readCredentials, type Credentials } from "./credentials";
import { SDK_VERSION } from "./version";

declare const __ARKOR_POSTHOG_KEY__: string;
declare const __ARKOR_POSTHOG_HOST__: string;

const POSTHOG_KEY: string =
  typeof __ARKOR_POSTHOG_KEY__ !== "undefined" ? __ARKOR_POSTHOG_KEY__ : "";
const POSTHOG_HOST: string =
  typeof __ARKOR_POSTHOG_HOST__ !== "undefined"
    ? __ARKOR_POSTHOG_HOST__
    : "https://us.i.posthog.com";

function envFlag(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return v !== "0" && v.toLowerCase() !== "false";
}

export function isEnabled(): boolean {
  if (envFlag("DO_NOT_TRACK")) return false;
  if (envFlag("ARKOR_TELEMETRY_DISABLED")) return false;
  if (!POSTHOG_KEY) return false;
  return true;
}

function debugLog(...args: unknown[]): void {
  if (envFlag("ARKOR_TELEMETRY_DEBUG")) {
    console.error("[arkor:telemetry]", ...args);
  }
}

let client: PostHog | null = null;
let clientInitFailed = false;
function getClient(): PostHog | null {
  if (!isEnabled()) return null;
  if (clientInitFailed) return null;
  if (client) return client;
  try {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    });
  } catch (err) {
    clientInitFailed = true;
    debugLog("client init failed", err);
    return null;
  }
  return client;
}

interface Identity {
  distinctId: string;
  authMode: "auth0" | "anon" | "none";
}

function decodeJwtSub(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const json = Buffer.from(padded, "base64").toString("utf8");
    const obj = JSON.parse(json) as { sub?: unknown };
    return typeof obj.sub === "string" && obj.sub.length > 0 ? obj.sub : null;
  } catch {
    return null;
  }
}

function telemetryIdPath(): string {
  return join(homedir(), ".arkor", "telemetry-id");
}

function readOrCreateTelemetryId(): string {
  const path = telemetryIdPath();
  try {
    if (existsSync(path)) {
      const v = readFileSync(path, "utf8").trim();
      if (v) return v;
    }
  } catch (err) {
    debugLog("read telemetry-id failed", err);
  }
  const id = randomUUID();
  try {
    mkdirSync(join(homedir(), ".arkor"), { recursive: true });
    writeFileSync(path, id, { mode: 0o600 });
  } catch (err) {
    debugLog("write telemetry-id failed", err);
  }
  return id;
}

export async function getIdentity(): Promise<Identity> {
  let creds: Credentials | null = null;
  try {
    creds = await readCredentials();
  } catch (err) {
    debugLog("readCredentials failed", err);
  }
  if (creds?.mode === "auth0") {
    const sub = decodeJwtSub(creds.accessToken);
    if (sub) return { distinctId: sub, authMode: "auth0" };
    return { distinctId: readOrCreateTelemetryId(), authMode: "auth0" };
  }
  if (creds?.mode === "anon") {
    return { distinctId: creds.anonymousId, authMode: "anon" };
  }
  return { distinctId: readOrCreateTelemetryId(), authMode: "none" };
}

interface BaseProps {
  command: string;
  sdk_version: string;
  node_version: string;
  platform: NodeJS.Platform;
  auth_mode: "auth0" | "anon" | "none";
}

function safeCapture(
  distinctId: string,
  event: string,
  properties: Record<string, unknown>,
): void {
  try {
    const c = getClient();
    if (!c) return;
    c.capture({ distinctId, event, properties });
  } catch (err) {
    debugLog("capture failed", err);
  }
}

export interface TelemetryOptions {
  // Mark commands like `dev` whose handler resolves once the server is up but
  // the process keeps serving until the user interrupts. Skips the synthetic
  // `cli_command_completed` (which would otherwise report a near-zero
  // duration_ms while the session is still live); `cli_command_started` still
  // fires, and a failure during bring-up still emits `cli_command_failed`.
  longRunning?: boolean;
}

export function withTelemetry<TArgs extends unknown[]>(
  command: string,
  handler: (...args: TArgs) => Promise<void>,
  options: TelemetryOptions = {},
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    if (!isEnabled()) {
      return handler(...args);
    }
    const start = Date.now();
    let identity: Identity | null = null;
    try {
      identity = await getIdentity();
    } catch (err) {
      debugLog("getIdentity failed", err);
    }
    const baseProps: BaseProps = {
      command,
      sdk_version: SDK_VERSION,
      node_version: process.version,
      platform: process.platform,
      auth_mode: identity?.authMode ?? "none",
    };
    if (identity) {
      safeCapture(identity.distinctId, "cli_command_started", { ...baseProps });
    }
    try {
      await handler(...args);
      if (identity && !options.longRunning) {
        safeCapture(identity.distinctId, "cli_command_completed", {
          ...baseProps,
          duration_ms: Date.now() - start,
        });
      }
    } catch (err) {
      if (identity) {
        const e = err instanceof Error ? err : new Error(String(err));
        safeCapture(identity.distinctId, "cli_command_failed", {
          ...baseProps,
          duration_ms: Date.now() - start,
          error_name: e.name,
          error_message: e.message.slice(0, 200),
        });
      }
      throw err;
    }
  };
}

export async function shutdownTelemetry(): Promise<void> {
  const c = client;
  if (!c) return;
  client = null;
  try {
    await c.shutdown();
  } catch (err) {
    debugLog("shutdown failed", err);
  }
}
