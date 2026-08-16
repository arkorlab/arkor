# @arkor/local

Local training and inference runtime for [arkor](https://www.npmjs.com/package/arkor). Runs LoRA fine-tuning and chat inference on your own machine behind the same API contract as Arkor Cloud, so the arkor SDK, CLI, and Studio work unchanged.

The first supported backend is [MLX](https://github.com/ml-explore/mlx) on Apple Silicon Macs. The backend interface is designed so NVIDIA (CUDA) and ROCm backends can be added later.

## Requirements

- An Apple Silicon Mac (M1 or newer)
- [uv](https://docs.astral.sh/uv/) on your `PATH` (`brew install uv`). Python packages such as `mlx-lm` are resolved by uv at run time; nothing is bundled here.
- `arkor` in the same project (this package is loaded by `arkor dev --local` and `arkor start --local`)

## Install

```bash
pnpm add -D @arkor/local
```

Then run training locally:

```bash
pnpm arkor start --local
```

or start Studio against the local runtime:

```bash
pnpm arkor dev --local
```

See the [local training guide](https://docs.arkor.ai/cli/local-training) for details.
