"""Explicit live acceptance probe: synthetic parallel file lookups, no disk access."""
import concurrent.futures
import json
import sys
import urllib.error
import urllib.request


def post(body):
    request = urllib.request.Request(
        "http://localhost:20128/v1/messages",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            if "text/event-stream" in response.headers.get("Content-Type", ""):
                message, blocks, arguments = {}, {}, {}
                for line in response:
                    if not line.startswith(b"data: "):
                        continue
                    event = json.loads(line[6:])
                    if event["type"] == "message_start":
                        message = event["message"]
                    elif event["type"] == "content_block_start":
                        blocks[event["index"]] = event["content_block"]
                    elif event["type"] == "content_block_delta":
                        index, delta = event["index"], event["delta"]
                        if delta["type"] == "input_json_delta":
                            arguments[index] = arguments.get(index, "") + delta["partial_json"]
                        elif delta["type"] in ["text_delta", "thinking_delta"]:
                            key = "text" if delta["type"] == "text_delta" else "thinking"
                            blocks[index][key] = blocks[index].get(key, "") + delta[key]
                    elif event["type"] == "message_delta":
                        message.update(event["delta"])
                    elif event["type"] == "error":
                        raise AssertionError(event)
                for index, argument in arguments.items():
                    blocks[index]["input"] = json.loads(argument)
                message["content"] = list(blocks.values())
                return response.status, message
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def probe(level):
    body = {
        "model": "agy-enterprise/gemini-3.8-flash-" + level,
        "max_tokens": 2048,
        "stream": "--stream" in sys.argv,
        "thinking": {"type": "enabled", "budget_tokens": 512},
        "messages": [{"role": "user", "content": "Call Glob exactly three times in parallel with pattern one, two, and three. Wait for all three results before answering."}],
        "tools": [{"name": "Glob", "description": "Look up synthetic file names", "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]}}],
    }
    original_prompt = body["messages"][0]["content"]
    if "--rebuilt-history" in sys.argv:
        body["messages"] = [
            {"role": "user", "content": [{"type": "text", "text": original_prompt + "\n"}, {"type": "text", "text": "Synthetic initial teammate reminder."}]},
            {"role": "user", "content": "Synthetic initial hook context."},
        ]
    status, initial = post(body)
    calls = [p for p in initial.get("content", []) if p.get("type") == "tool_use"]
    print(level, "initial", status, "calls", len(calls), flush=True)
    assert status == 200 and len(calls) == 3, initial.get("error")
    if "--rebuilt-history" in sys.argv:
        body["messages"] = [{"role": "user", "content": original_prompt}]
    body["messages"] += [
        {"role": "assistant", "content": initial["content"]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call["id"], "content": "synthetic-file.py"} for call in reversed(calls)]},
    ]
    if "--rebuilt-history" in sys.argv:
        body["messages"].append({"role": "user", "content": "Synthetic teammate mailbox wakeup: report the lookup results."})
    status, final = post(body)
    print(level, "continuation", status, "stop", final.get("stop_reason"), "error", final.get("error"), flush=True)
    assert status == 200 and final.get("stop_reason") == "end_turn"


with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    for result in pool.map(probe, ["high", "low"]):
        pass

status, error = post({"model": "agy-enterprise/gemini-3.8-flash-low", "max_tokens": 128, "messages": [{"role": "user", "content": "synthetic prompt"}, {"role": "assistant", "content": [{"type": "tool_use", "id": "missing-file-call", "name": "Glob", "input": {"pattern": "*"}}]}]})
message = error.get("error", {}).get("message", "")
print("diagnostic", status, message, flush=True)
assert status == 400 and "kind=call" in message and "reason=missing" in message
