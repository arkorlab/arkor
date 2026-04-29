# arkor

The Arkor SDK + CLI + bundled local Studio. One package; three surfaces.

> Status: alpha (`0.0.1-alpha.4`). APIs may change without notice. No compat
> shims are offered between alpha versions — pin and re-read the changelog
> before bumping.

## Install

Most users get this package via the scaffolder:

```bash
pnpm create arkor my-app
```

Direct install is fine too:

```bash
pnpm add arkor
```

Requires Node.js 22.6+.

## SDK

Two factories. One for the project entry point, one per role.

```ts
// src/arkor/trainer.ts
import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "my-first-run",
  model: "unsloth/gemma-4-E4B-it",
  dataset: { type: "huggingface", name: "arkorlab/triage-demo" },
  lora: { r: 16, alpha: 16 },
  maxSteps: 50,
  callbacks: {
    onLog: ({ step, loss }) => console.log(`step=${step} loss=${loss}`),
    onCheckpoint: async ({ step, infer }) => {
      const res = await infer({
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      });
      console.log(`ckpt @ ${step}:`, await res.text());
    },
  },
});
```

```ts
// src/arkor/index.ts  ← discovered by the CLI / Studio
import { createArkor } from "arkor";
import { trainer } from "./trainer";

export const arkor = createArkor({ trainer });
```

`createArkor` returns an intentionally opaque, frozen manifest — room to
grow operation methods later without breaking callers. Keys are role-fixed
(`trainer`, future `deploy` / `eval`) so the CLI and Studio can predict
what's there.

### Trainer lifecycle

`createTrainer` returns a `Trainer` with:

- `start()` — submits the job to the cloud; resolves with `{ jobId }`
- `wait()` — opens an SSE stream and dispatches `callbacks.*` until the
  run reaches a terminal status; resolves with `{ job, artifacts }`
- `cancel()` — best-effort cancellation

Inside `onCheckpoint` you also get a bound `infer({ messages, stream? })`
helper that points at the checkpoint adapter for mid-training evaluation.

### Runtime context

`baseUrl`, `credentials`, and `cwd` come from the environment + `.arkor/`
state — never from user code. Set `ARKOR_CLOUD_API_URL` to point at a
non-default cloud-api deployment; everything else is managed by `arkor
login` / `arkor logout`.

## CLI

| Command | Purpose |
|---|---|
| `arkor init` | Scaffold a project in the current directory |
| `arkor login` / `logout` / `whoami` | Auth0 PKCE / anonymous tokens |
| `arkor dev` | Launch the local Studio (hot reload + GUI) |
| `arkor build [entry]` | Bundle `src/arkor/index.ts` (or `entry`) to `.arkor/build/index.mjs` |
| `arkor start [entry]` | Run the build artifact; rebuilds when an entry is supplied |

`arkor build` uses esbuild with `packages: "external"`, so bare specifiers
(`arkor`, anything from `node_modules`) resolve at runtime against the
project's installed copy. Relative imports get inlined.

## Studio

`arkor dev` boots a Hono server on `127.0.0.1:4000` and serves a Vite +
React SPA from the same origin. Two roles:

- **Hot reload** for the user's TypeScript so the UI reflects current
  source without restarts.
- **GUI operations** — running training, inspecting jobs, mid-training
  inference in a Playground.

Studio is loopback-only and per-launch CSRF-token-gated:

- `/api/*` requires the `X-Arkor-Studio-Token` header (or
  `?studioToken=` query for `EventSource`). The token is generated on
  every `arkor dev` launch and injected into the served `index.html` as
  a `<meta>` tag the same-origin SPA reads at startup.
- The middleware also rejects requests whose `Host` isn't `127.0.0.1` or
  `localhost` — defense against DNS rebinding.

## Public exports

```ts
import {
  // factories
  createArkor,
  createTrainer,
  isArkor,
  // types
  type Arkor,
  type ArkorInput,
  type DatasetSource,
  type LoraConfig,
  type Trainer,
  type TrainerCallbacks,
  type TrainerInput,
  type TrainingJob,
  type TrainingResult,
  // identity / state helpers
  ensureCredentials,
  readCredentials,
  writeCredentials,
  readState,
  writeState,
} from "arkor";
```

`runTrainer(file?)` is exported for power-user embedding (e.g. running
training from a custom Node script). `arkor start` uses it under the hood.

## Telemetry

The CLI sends anonymous usage events to PostHog so we can see which commands
are being run and where they fail. Three events are emitted per invocation:

- `cli_command_started`
- `cli_command_completed` (includes `duration_ms`)
- `cli_command_failed` (includes `duration_ms`, `error_name`, and the first
  200 chars of `error_message`)

Each event carries `command`, `sdk_version`, `node_version`, `platform`, and
`auth_mode` (`auth0` / `anon` / `none`). The distinct ID is your Auth0 `sub`
when logged in, your `anonymousId` after `arkor login --anonymous`, or a
locally generated UUID stored at `~/.arkor/telemetry-id`.

To opt out, set either of the following before running any `arkor` command:

```sh
export DO_NOT_TRACK=1
# or
export ARKOR_TELEMETRY_DISABLED=1
```

When opted out the PostHog client is never instantiated and no network
request is made.

## License

MIT. See [LICENSE.md](./LICENSE.md).
