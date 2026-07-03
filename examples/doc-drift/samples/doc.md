# relay CLI

`relay` is a small (fictional) command line tool used by this example. This
file plays the role of your project's README: the drift check compares it
against a code diff and reports statements that the diff makes stale.

## Usage

```text
relay send <artifact>
```

Uploads a build artifact to the relay server.

## Options

- `--max-retries <n>`: Retry a failed upload up to `n` times. Defaults to 3.
- `--timeout <seconds>`: Abort an upload attempt after this many seconds.
  Defaults to 30.
- `--quiet`: Suppress progress output. Errors are still printed.

## Exit codes

- `0`: the artifact was uploaded.
- `1`: all retries were exhausted.
