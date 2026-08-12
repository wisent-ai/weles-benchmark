#!/usr/bin/env python3
import asyncio
import contextlib
import json
import os
import sys
from typing import Any


def required_env(name: str) -> str:
    value = os.environ.get(name, '').strip()
    if not value:
        raise RuntimeError(f'missing-{name.lower()}')
    return value


def top_level_schema(case: dict[str, Any]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for assertion in case['expected']['assertions']:
        path = assertion['path']
        if not path.startswith('/') or '/' in path[1:]:
            continue
        key = path[1:].replace('~1', '/').replace('~0', '~')
        if key in properties:
            continue
        value = assertion.get('value')
        kind = 'string' if isinstance(value, str) else 'boolean' if isinstance(value, bool) else 'number' if isinstance(value, (int, float)) else 'array' if isinstance(value, list) else 'object'
        properties[key] = {'type': kind}
        required.append(key)
    return {'type': 'object', 'additionalProperties': False, 'properties': properties, 'required': required}


def instruction(case: dict[str, Any]) -> str:
    return '\n'.join([
        case['instruction'],
        f"Start at: {case['input']['url']}",
        f"Return only one JSON object matching this schema: {json.dumps(top_level_schema(case), separators=(',', ':'))}",
        'Do not include Markdown, commentary, or values that were not read from the page.',
    ])


def parse_output(value: Any) -> Any:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise RuntimeError('agent-output-missing')
    text = value.strip()
    candidates = [text]
    if '```' in text:
        candidates.extend(part.split('```', 1)[0].removeprefix('json').strip() for part in text.split('```')[1::2])
    start = text.find('{')
    end = text.rfind('}')
    if start >= 0 and end > start:
        candidates.append(text[start:end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    raise RuntimeError('agent-output-invalid-json')


async def execute(request: dict[str, Any]) -> dict[str, Any]:
    os.environ.setdefault('BROWSER_USE_SETUP_LOGGING', 'false')
    with contextlib.redirect_stdout(sys.stderr):
        from browser_use import Agent, BrowserSession, ChatOpenAI
        llm = ChatOpenAI(
            model=os.environ.get('BRAMA_MODEL', 'gpt-5.4-mini'),
            api_key=required_env('BRAMA_API_KEY'),
            base_url=os.environ.get('BRAMA_BASE_URL', 'http://127.0.0.1:8080/v1'),
            temperature=None,
            frequency_penalty=None,
            reasoning_effort='low',
            max_retries=1,
            max_completion_tokens=None,
        )
        browser = BrowserSession(
            headless=True,
            executable_path=os.environ.get('BROWSER_EXECUTABLE_PATH') or None,
            user_data_dir=None,
        )
        agent = Agent(
            task=instruction(request['case']),
            llm=llm,
            browser_session=browser,
            use_vision=False,
            use_judge=False,
            calculate_cost=True,
            enable_signal_handler=False,
            directly_open_url=True,
        )
        history = await agent.run(max_steps=int(os.environ.get('BROWSER_USE_MAX_STEPS', '20')))
    usage = history.usage
    return {
        'schema': 'weles.benchmark.adapter-result.v1',
        'status': 'succeeded' if history.is_successful() is True else 'failed',
        'receiptVerified': False,
        'output': parse_output(history.final_result()),
        'telemetry': {
            'browserSteps': history.number_of_steps(),
            **({'inputTokens': usage.total_prompt_tokens, 'outputTokens': usage.total_completion_tokens, 'costUsd': usage.total_cost} if usage else {}),
        },
    }


def main() -> None:
    try:
        request = json.load(sys.stdin)
        result = asyncio.run(execute(request))
        sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
    except Exception as error:
        sys.stderr.write(f'browser-use-client: {type(error).__name__}: {error}\n')
        raise SystemExit(1)


if __name__ == '__main__':
    main()
