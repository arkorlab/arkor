"""Dataset preparation for the MLX training shim.

Turns an arkor ``datasetSource`` + ``datasetFormat`` into the local JSONL
layout mlx-lm trains from (``train.jsonl`` and optionally ``valid.jsonl`` in
a data directory), converting between arkor's cloud dataset formats and the
three shapes mlx-lm understands (``messages`` chat records, ``prompt`` /
``completion`` pairs, and raw ``text``).

Only stdlib + the ``datasets`` library (pulled in by ``mlx-lm[train]``) are
used here. This module is bundled into the published ``@arkor/local``
package and executed by uv at run time; it is never an npm dependency.
"""

from __future__ import annotations

import json
import random
import urllib.parse
import urllib.request
from pathlib import Path


class DatasetPrepError(RuntimeError):
    """Raised for user-addressable dataset problems (clear message, no traceback noise)."""


def prepare_data(run: dict, log) -> dict:
    """Prepare train/valid JSONL files.

    Returns ``{"data_dir": Path, "train_count": int, "valid_count": int}``.
    ``log`` is a callable used for progress notes (they end up in the job's
    console log, not the event stream).
    """
    source = run["datasetSource"]
    fmt = run.get("datasetFormat") or {"type": "chatml"}
    split_cfg = run["train"].get("datasetSplit") or {}
    dry_run = bool(run["train"].get("dryRun"))
    data_dir = Path(run["paths"]["dataDir"])
    data_dir.mkdir(parents=True, exist_ok=True)

    train_rows, valid_rows = _load_rows(source, log)

    train_examples = [_convert_row(row, fmt) for row in train_rows]
    valid_examples = [_convert_row(row, fmt) for row in valid_rows]

    split_enabled = split_cfg.get("enabled")
    if split_enabled and not valid_examples:
        test_size = split_cfg.get("testSize")
        if test_size is None:
            test_size = 0.1
        seed = split_cfg.get("seed")
        train_examples, valid_examples = _split(
            train_examples, test_size, 0 if seed is None else seed
        )
        log(
            f"[arkor] datasetSplit: held out {len(valid_examples)} of "
            f"{len(train_examples) + len(valid_examples)} examples for validation"
        )
    elif (
        split_enabled is not False
        and not valid_examples
        and not dry_run
        and len(train_examples) >= 2
    ):
        # mlx-lm requires a validation set whenever it trains, and eval
        # loss reporting needs one too. Auto-holding out a slice keeps
        # train-only datasets (including the starter templates) working
        # locally instead of failing deep inside mlx-lm. An explicit
        # `datasetSplit: {enabled: false}` opts out, and single-example
        # datasets are left whole (a holdout would empty the train set;
        # mlx-lm's own validation reports the missing valid set clearly).
        train_examples, valid_examples = _split(train_examples, 0.1, 0)
        log(
            "[arkor] the dataset has no validation split; auto-held out "
            f"{len(valid_examples)} examples for validation "
            "(configure datasetSplit to control this)"
        )

    if not train_examples:
        raise DatasetPrepError("the prepared training dataset is empty")

    _write_jsonl(data_dir / "train.jsonl", train_examples)
    if valid_examples:
        _write_jsonl(data_dir / "valid.jsonl", valid_examples)

    return {
        "data_dir": data_dir,
        "train_count": len(train_examples),
        "valid_count": len(valid_examples),
    }


def _load_rows(source: dict, log):
    """Load raw rows -> (train_rows, valid_rows). Rows are dict-like."""
    kind = source.get("type")
    if kind == "huggingface":
        return _load_huggingface(source, log)
    if kind == "blob":
        return _load_blob(source, log), []
    raise DatasetPrepError(f"unsupported datasetSource.type: {kind!r}")


def _load_huggingface(source: dict, log):
    try:
        from datasets import load_dataset
    except ImportError as error:  # pragma: no cover - env misconfiguration
        raise DatasetPrepError(
            "the `datasets` library is unavailable; the mlx-lm[train] "
            "environment did not install correctly"
        ) from error

    name = source.get("name")
    if not name or not isinstance(name, str):
        raise DatasetPrepError(
            "datasetSource.type is 'huggingface' but 'name' is missing"
        )
    subset = source.get("subset")
    split = source.get("split")
    log(f"[arkor] loading HuggingFace dataset {name}" + (f" ({subset})" if subset else ""))

    def load(split_name):
        if subset:
            return load_dataset(name, subset, split=split_name)
        return load_dataset(name, split=split_name)

    try:
        train = load(split or "train")
    except Exception as error:
        raise DatasetPrepError(
            f"failed to load HuggingFace dataset {name!r}: {error}"
        ) from error

    valid = []
    if not split:
        # Best effort: reuse an existing validation split when the dataset
        # ships one. An explicit `split` request disables this (the user
        # asked for exactly one split).
        for candidate in ("validation", "valid"):
            try:
                valid = load(candidate)
                log(f"[arkor] using the dataset's {candidate!r} split for eval")
                break
            except Exception as error:
                # Expected for datasets without that split; logged so a
                # real failure (auth, network) is diagnosable rather than
                # silently degrading to the auto-holdout path.
                log(f"[arkor] no usable {candidate!r} split: {error}")
                continue
    return train, valid


_BLOB_TIMEOUT_SECONDS = 120


class _AuthStrippingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Drop the Authorization header when a redirect leaves the original host.

    Pre-signed blob URLs commonly redirect to a CDN host; forwarding the
    bearer token there would leak it to a third party.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None:
            old_host = urllib.parse.urlparse(req.full_url).netloc
            new_host = urllib.parse.urlparse(new_req.full_url).netloc
            if old_host != new_host:
                new_req.remove_header("Authorization")
        return new_req


def _is_loopback_host(hostname):
    return hostname in ("127.0.0.1", "localhost", "::1")


def _load_blob(source: dict, log):
    url = source.get("url")
    if not url or not isinstance(url, str):
        raise DatasetPrepError("datasetSource.type is 'blob' but 'url' is missing")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise DatasetPrepError(
            f"blob dataset URL must be http(s), got {parsed.scheme!r}"
        )
    token = source.get("token")
    if token and parsed.scheme != "https" and not _is_loopback_host(parsed.hostname):
        raise DatasetPrepError(
            "refusing to send the blob dataset token over plain http to a "
            "non-loopback host; use an https URL"
        )
    log(f"[arkor] downloading blob dataset from {url}")
    request = urllib.request.Request(url)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    opener = urllib.request.build_opener(_AuthStrippingRedirectHandler())
    rows = []
    try:
        with opener.open(request, timeout=_BLOB_TIMEOUT_SECONDS) as response:
            # Stream line by line instead of buffering the whole body:
            # datasets can be large and JSONL is naturally line-oriented.
            for line_number, raw_line in enumerate(response, start=1):
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as error:
                    raise DatasetPrepError(
                        f"blob dataset line {line_number} is not valid JSON: {error}"
                    ) from error
    except DatasetPrepError:
        raise
    except Exception as error:
        raise DatasetPrepError(f"failed to download blob dataset: {error}") from error
    return rows


def _convert_row(row, fmt: dict) -> dict:
    kind = fmt.get("type", "chatml")
    mapping = fmt.get("columnMapping") or {}
    if kind == "chatml":
        messages = _column(row, mapping.get("messages", "messages"))
        return {"messages": _normalise_messages(messages)}
    if kind == "sharegpt":
        conversations = _column(row, mapping.get("conversations", "conversations"))
        return {"messages": _sharegpt_to_messages(conversations)}
    if kind == "alpaca":
        instruction = _column(row, mapping.get("instruction", "instruction"))
        extra_input = _optional_column(row, mapping.get("input", "input"))
        output = _column(row, mapping.get("output", "output"))
        prompt = instruction if not extra_input else f"{instruction}\n\n{extra_input}"
        return {"prompt": prompt, "completion": output}
    if kind == "prompt_completion":
        return {
            "prompt": _column(row, mapping.get("prompt", "prompt")),
            "completion": _column(row, mapping.get("completion", "completion")),
        }
    if kind == "text":
        return {"text": _column(row, mapping.get("text", "text"))}
    raise DatasetPrepError(f"unsupported datasetFormat.type: {kind!r}")


def _column(row, name: str):
    value = _optional_column(row, name)
    if value is None:
        raise DatasetPrepError(
            f"dataset row is missing the {name!r} column "
            "(set datasetFormat.columnMapping if your columns differ)"
        )
    return value


def _optional_column(row, name: str):
    try:
        value = row[name]
    except (KeyError, IndexError, TypeError):
        return None
    return value


_SHAREGPT_ROLES = {
    "human": "user",
    "user": "user",
    "gpt": "assistant",
    "assistant": "assistant",
    "system": "system",
}


def _sharegpt_to_messages(conversations) -> list:
    if not isinstance(conversations, list) or not conversations:
        raise DatasetPrepError(
            "sharegpt rows must carry a non-empty conversation list"
        )
    messages = []
    for turn in conversations:
        if not isinstance(turn, dict):
            raise DatasetPrepError(
                f"sharegpt conversation turns must be objects, got {type(turn).__name__}"
            )
        speaker = turn.get("from") or turn.get("role")
        role = _SHAREGPT_ROLES.get(speaker)
        if role is None:
            raise DatasetPrepError(
                f"unsupported sharegpt speaker {speaker!r} (expected one of "
                f"{sorted(_SHAREGPT_ROLES)})"
            )
        content = turn.get("value") if "value" in turn else turn.get("content")
        if not isinstance(content, str):
            raise DatasetPrepError(
                f"sharegpt turn for {speaker!r} has no string 'value'/'content'"
            )
        messages.append({"role": role, "content": content})
    return messages


def _normalise_messages(messages) -> list:
    if not isinstance(messages, list) or not messages:
        raise DatasetPrepError("chatml rows must carry a non-empty message list")
    out = []
    for message in messages:
        if not isinstance(message, dict):
            raise DatasetPrepError(
                f"chatml messages must be objects, got {type(message).__name__}"
            )
        role = message.get("role")
        content = message.get("content")
        if role not in ("system", "user", "assistant", "tool"):
            raise DatasetPrepError(f"unsupported chat role {role!r}")
        if not isinstance(content, str):
            raise DatasetPrepError(
                f"chatml message for role {role!r} has no string 'content'"
            )
        out.append({"role": role, "content": content})
    return out


def _split(examples: list, test_size: float, seed: int):
    shuffled = list(examples)
    random.Random(seed).shuffle(shuffled)
    held_out = max(1, int(len(shuffled) * test_size))
    if held_out >= len(shuffled):
        raise DatasetPrepError(
            "datasetSplit.testSize leaves no training examples "
            f"({held_out} of {len(shuffled)} held out)"
        )
    return shuffled[held_out:], shuffled[:held_out]


def _write_jsonl(path: Path, examples: list) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for example in examples:
            handle.write(json.dumps(example, ensure_ascii=False) + "\n")
