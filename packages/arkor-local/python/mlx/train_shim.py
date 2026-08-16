"""arkor MLX training shim.

Reads the ``run.json`` written by @arkor/local's RunManager, prepares the
dataset, drives mlx-lm LoRA fine-tuning, and reports progress as JSON lines
on stdout prefixed with ``@arkor `` (the protocol defined in the package's
``protocol.ts``). Everything else printed here or by mlx-lm lands in the
job's console log.

Executed as::

    uv run --no-project --with "mlx-lm[train]==<pin>" python train_shim.py --run <run.json>

The mlx-lm version is pinned by the Node side (MLX_LM_SPEC); this file is
written against that exact version's ``mlx_lm.lora.run(args,
training_callback)`` surface and is updated together with the pin.

License note: this file is arkor's own MIT-licensed code. It imports mlx-lm
(MIT) and the `datasets` library (Apache-2.0); it never imports unsloth.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import types
from pathlib import Path

MARKER = "@arkor "
PROTOCOL_VERSION = 1

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dataset_prep import DatasetPrepError, prepare_data  # noqa: E402


def _json_safe(value):
    """Replace non-finite floats with None, recursively.

    json.dumps would otherwise emit the bare tokens NaN/Infinity (invalid
    JSON), and the Node parser would drop the whole protocol line as
    malformed; a diverging run (NaN loss) would lose every log event.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if value is None or isinstance(value, (bool, int, str)):
        return value
    # numpy / mlx scalars from the training callback expose .item();
    # anything else non-JSON-native is dropped rather than crashing emit
    # inside a TrainingCallback (which would abort the whole run).
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _json_safe(item())
        except Exception:
            return None
    return None


def emit(payload: dict) -> None:
    print(MARKER + json.dumps(_json_safe(payload)), flush=True)


def log(message: str) -> None:
    """Console note (NOT a protocol event)."""
    print(message, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    run_path = parser.parse_args().run
    run = json.loads(Path(run_path).read_text(encoding="utf-8"))

    version = run.get("protocolVersion")
    if version != PROTOCOL_VERSION:
        raise RuntimeError(
            f"run.json protocol version {version!r} does not match this "
            f"shim's version {PROTOCOL_VERSION}; arkor and @arkor/local are "
            "out of sync"
        )

    emit({"type": "started"})
    for warning in run.get("warnings", []):
        log(f"[arkor] {warning}")

    prepared = prepare_data(run, log)
    train_cfg = run["train"]
    iters, batch_size = _resolve_iterations(train_cfg, prepared["train_count"])

    if train_cfg.get("dryRun"):
        log("[arkor] dry run: dataset prepared and config validated; skipping training")
        emit(
            {
                "type": "completed",
                "adapterDir": None,
                "metrics": {
                    "dryRun": True,
                    "trainExamples": prepared["train_count"],
                    "validExamples": prepared["valid_count"],
                    "plannedIters": iters,
                },
            }
        )
        return 0

    adapters_dir = Path(run["paths"]["adaptersDir"])
    raw_dir = adapters_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    args = _build_lora_args(run, prepared, iters, batch_size, raw_dir)
    callback = _make_callback(run, prepared, iters, batch_size, raw_dir, adapters_dir)

    from mlx_lm import lora as lora_mod

    lora_mod.run(args, training_callback=callback)

    # Flush any checkpoint saved after the last loss report, then publish
    # the final adapter under a stable, normalised path.
    callback.publish_new_checkpoints()
    final_dir = _publish_adapter(raw_dir, adapters_dir / "final")
    emit({"type": "completed", "adapterDir": str(final_dir)})
    return 0


def _resolve_iterations(train_cfg: dict, train_count: int):
    batch_size = train_cfg.get("batchSize") or 4
    max_steps = train_cfg.get("maxSteps")
    if max_steps is not None:
        return int(max_steps), batch_size
    epochs = train_cfg["numTrainEpochs"]
    iters = max(1, math.ceil(epochs * train_count / batch_size))
    log(
        f"[arkor] numTrainEpochs={epochs} over {train_count} examples at "
        f"batch size {batch_size} resolves to {iters} iterations"
    )
    return iters, batch_size


def _steps_of(value, iters: int, default: int) -> int:
    """Resolve a normalised {steps}|{ratio} shape against the total iters."""
    if value is None:
        return default
    if value.get("steps") is not None:
        return int(value["steps"])
    return max(1, int(round(value["ratio"] * iters)))


def _build_lora_args(run, prepared, iters, batch_size, raw_dir: Path):
    from mlx_lm import lora as lora_mod

    train_cfg = run["train"]
    overrides = {
        "model": run["model"],
        "train": True,
        "data": str(prepared["data_dir"]),
        "iters": iters,
        "batch_size": batch_size,
        "adapter_path": str(raw_dir),
        "optimizer": train_cfg["optimizer"],
        "mask_prompt": bool(train_cfg["maskPrompt"]),
        "steps_per_report": _steps_of(train_cfg.get("loggingSteps"), iters, 10),
        "steps_per_eval": _steps_of(train_cfg.get("evalSteps"), iters, 200),
        "save_every": _steps_of(train_cfg.get("saveSteps"), iters, 100),
    }
    if train_cfg.get("learningRate") is not None:
        overrides["learning_rate"] = train_cfg["learningRate"]
    if train_cfg.get("maxSeqLength") is not None:
        overrides["max_seq_length"] = int(train_cfg["maxSeqLength"])
    if prepared["valid_count"] == 0:
        # No validation data: disable eval instead of letting mlx-lm fail
        # when it looks for valid.jsonl.
        overrides["steps_per_eval"] = iters + 1

    args = types.SimpleNamespace(**{**lora_mod.CONFIG_DEFAULTS, **overrides})

    lora_params = dict(getattr(args, "lora_parameters", None) or {})
    if train_cfg.get("loraR") is not None:
        rank = int(train_cfg["loraR"])
        lora_params["rank"] = rank
        if train_cfg.get("loraAlpha") is not None:
            # mlx-lm expresses LoRA strength as `scale`; alpha / rank is the
            # standard conversion.
            lora_params["scale"] = float(train_cfg["loraAlpha"]) / rank
    args.lora_parameters = lora_params

    if train_cfg.get("weightDecay") is not None:
        optimizer_config = dict(getattr(args, "optimizer_config", None) or {})
        entry = dict(optimizer_config.get(args.optimizer) or {})
        entry["weight_decay"] = train_cfg["weightDecay"]
        optimizer_config[args.optimizer] = entry
        args.optimizer_config = optimizer_config

    schedule = _lr_schedule_config(train_cfg, args, iters)
    if schedule is not None:
        args.lr_schedule = schedule

    return args


def _lr_schedule_config(train_cfg: dict, args, iters: int):
    name = train_cfg.get("lrSchedule") or "constant"
    warmup = train_cfg.get("warmupSteps") or 0
    lr = getattr(args, "learning_rate", 1e-5)
    if name == "cosine":
        config = {"name": "cosine_decay", "arguments": [lr, iters]}
    elif name == "linear":
        config = {"name": "linear_schedule", "arguments": [lr, 0.0, iters]}
    elif warmup > 0:
        # Constant schedule with warmup: a flat "linear" segment after the
        # warmup join keeps the effective rate constant.
        config = {"name": "linear_schedule", "arguments": [lr, lr, max(1, iters)]}
    else:
        return None
    if warmup > 0:
        config["warmup"] = int(warmup)
    return config


def _make_callback(run, prepared, iters, batch_size, raw_dir: Path, adapters_dir: Path):
    from mlx_lm.tuner.trainer import TrainingCallback

    train_count = prepared["train_count"]

    class ArkorCallback(TrainingCallback):
        def __init__(self) -> None:
            self._published: set[str] = set()

        def on_train_loss_report(self, train_info: dict) -> None:
            iteration = int(train_info.get("iteration", 0))
            its_per_second = train_info.get("iterations_per_second")
            emit(
                {
                    "type": "log",
                    "step": iteration,
                    "loss": train_info.get("train_loss"),
                    "learningRate": train_info.get("learning_rate"),
                    "epoch": iteration * batch_size / train_count if train_count else None,
                    "samplesPerSecond": (
                        its_per_second * batch_size if its_per_second is not None else None
                    ),
                }
            )
            self.publish_new_checkpoints()

        def on_val_loss_report(self, val_info: dict) -> None:
            emit(
                {
                    "type": "log",
                    "step": int(val_info.get("iteration", 0)),
                    "evalLoss": val_info.get("val_loss"),
                }
            )

        def publish_new_checkpoints(self) -> None:
            # mlx-lm writes `{iteration:07d}_adapters.safetensors` snapshots
            # into the adapter path on every save; publish each one as a
            # self-contained `step-<N>/` adapter directory.
            for snapshot in sorted(raw_dir.glob("*_adapters.safetensors")):
                if snapshot.name in self._published:
                    continue
                self._published.add(snapshot.name)
                step = int(snapshot.name.split("_", 1)[0])
                step_dir = adapters_dir / f"step-{step}"
                step_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(snapshot, step_dir / "adapters.safetensors")
                config = raw_dir / "adapter_config.json"
                if config.exists():
                    shutil.copy2(config, step_dir / "adapter_config.json")
                emit({"type": "checkpoint", "step": step, "adapterDir": str(step_dir)})

    return ArkorCallback()


def _publish_adapter(raw_dir: Path, final_dir: Path) -> Path:
    weights = raw_dir / "adapters.safetensors"
    if not weights.exists():
        raise RuntimeError(
            f"training finished but no adapter weights were written to {raw_dir}"
        )
    final_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(weights, final_dir / "adapters.safetensors")
    config = raw_dir / "adapter_config.json"
    if config.exists():
        shutil.copy2(config, final_dir / "adapter_config.json")
    return final_dir


if __name__ == "__main__":
    try:
        sys.exit(main())
    except DatasetPrepError as error:
        emit({"type": "failed", "error": str(error)})
        sys.exit(1)
    except Exception as error:  # noqa: BLE001 - the protocol needs every failure
        import traceback

        traceback.print_exc()
        emit({"type": "failed", "error": f"{type(error).__name__}: {error}"})
        sys.exit(1)
