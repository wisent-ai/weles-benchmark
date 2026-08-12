#!/usr/bin/env python3
import asyncio
import contextlib
import json
import os
import sys
from typing import Any


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing-{name.lower()}")
    return value


def output_schema(case: dict[str, Any]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for assertion in case["expected"]["assertions"]:
        path = assertion["path"]
        if not isinstance(path, str) or not path.startswith("/") or "/" in path[1:]:
            continue
        key = path[1:].replace("~1", "/").replace("~0", "~")
        value = assertion.get("value")
        kind = (
            "boolean" if isinstance(value, bool)
            else "number" if isinstance(value, (int, float))
            else "string" if isinstance(value, str)
            else "array" if isinstance(value, list)
            else "object" if isinstance(value, dict)
            else None
        )
        properties[key] = {"type": kind} if kind else {}
        required.append(key)
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": required,
    }


def normalize_output(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, (dict, list, str, int, float, bool)) or value is None:
        return value
    return json.loads(json.dumps(value, default=str))


async def execute(request: dict[str, Any]) -> dict[str, Any]:
    from skyvern import Skyvern
    from skyvern.schemas.llm import LLMConfig

    case = request["case"]
    base_url = required_env("BRAMA_BASE_URL")
    api_key = required_env("BRAMA_API_KEY")
    model = os.environ.get("BRAMA_MODEL", "weles/agent/primary").strip() or "weles/agent/primary"
    model_name = model if model.startswith("openai/") else f"openai/{model}"
    llm_config = LLMConfig(
        model_name=model_name,
        required_env_vars=[],
        supports_vision=True,
        add_assistant_prefix=False,
        litellm_params={"api_key": api_key, "api_base": base_url},
    )
    skyvern = Skyvern.local(
        llm_config=llm_config,
        use_in_memory_db=True,
        settings={
            "BROWSER_TYPE": "chromium-headless",
            "MAX_STEPS_PER_RUN": int(os.environ.get("SKYVERN_MAX_STEPS", "20")),
            "ENABLE_CODE_BLOCK": False,
        },
    )
    try:
        result = await skyvern.run_task(
            prompt=case["instruction"],
            url=case["input"]["url"],
            data_extraction_schema=output_schema(case),
            max_steps=int(os.environ.get("SKYVERN_MAX_STEPS", "20")),
            wait_for_completion=True,
            timeout=request["timeoutMs"] / 1000,
        )
        raw_status = str(result.status).lower()
        status = raw_status.rsplit(".", 1)[-1]
        succeeded = status in {"completed", "succeeded"}
        return {
            "schema": "weles.benchmark.adapter-result.v1",
            "taskId": result.run_id,
            "status": "succeeded" if succeeded else "failed",
            "receiptVerified": False,
            "output": normalize_output(result.output) if result.output is not None else {},
            "telemetry": {"browserSteps": result.step_count or 0},
        }
    finally:
        await skyvern.aclose()


def main() -> None:
    try:
        request = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(execute(request))
        sys.stdout.write(json.dumps(result, separators=(",", ":")))
    except Exception as error:
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
