"""Synthetic role-placement acceptance probe; never executes returned tools."""
import glob
import json
import pathlib
import sqlite3
import sys
import urllib.error
import urllib.request
import uuid

run_id = "synthetic-instruction-roles-" + uuid.uuid4().hex
hook = "Synthetic harness metadata: projectSessionStart installs a model tier mapping for helper agents. This metadata describes the harness, not the workspace."
summary = {"run": run_id, "trials": [], "wire": []}
capture_ids = []


def post(body):
    correlation_id = str(uuid.uuid4())
    request = urllib.request.Request(
        "http://localhost:20128/v1/messages",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-omniroute-no-cache": "true", "x-correlation-id": correlation_id},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            if body.get("stream") and response.status == 200:
                capture_ids.append(correlation_id)
                blocks = {}
                for line in response:
                    if not line.startswith(b"data: "):
                        continue
                    event = json.loads(line[6:])
                    if event.get("type") == "content_block_start":
                        block = event["content_block"]
                        if block.get("type") in ["text", "tool_use"]:
                            blocks[event["index"]] = block
                    elif event.get("type") == "content_block_delta":
                        delta = event["delta"]
                        if delta.get("type") == "text_delta":
                            block = blocks[event["index"]]
                            block["text"] = block.get("text", "") + delta["text"]
                    elif event.get("type") == "error":
                        return 502, {"error": {"message": "Synthetic probe stream failed"}}
                return response.status, {"content": list(blocks.values())}
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


for trial in range(3):
    for variant, role in [("old", "user"), ("corrected", "system")]:
        body = {
            "model": "agy-enterprise/gemini-3.8-flash-high",
            "max_tokens": 2048,
            "stream": True,
            "temperature": 0,
            "system": "You are analyzing synthetic-project. For a request to analyze this project, call inspect_workspace first to learn its files. Harness metadata is instruction context. " + run_id,
            "messages": [
                {"role": "user", "content": "Hello, analyse this project."},
                {"role": role, "content": hook},
            ],
            "tools": [{"name": "inspect_workspace", "description": "Inspect the synthetic workspace files before analyzing the project.", "input_schema": {"type": "object", "properties": {}}}],
        }
        status, result = post(body)
        blocks = result.get("content", [])
        visible = "".join(p.get("text", "") for p in blocks if p.get("type") == "text")
        calls = [p for p in blocks if p.get("type") == "tool_use"]
        record = {
            "variant": variant, "trial": trial + 1, "status": status,
            "inspect_calls": sum(p.get("name") == "inspect_workspace" for p in calls),
            "visible_chars": len(visible),
            "unsolicited_harness_analysis": not calls and any(s in visible.lower() for s in ["projectsessionstart", "model tier", "helper agents"]),
        }
        summary["trials"].append(record)
        print(json.dumps(record), flush=True)

invalid_status, invalid_result = post({
    "model": "agy-enterprise/gemini-3.8-flash-high", "max_tokens": 128,
    "messages": [{"role": "system", "content": [{"type": "tool_use", "id": "synthetic-secret", "name": "read", "input": {}}]}, {"role": "user", "content": run_id}],
})
summary["invalid_instruction"] = {
    "status": invalid_status,
    "fixed_error": invalid_result.get("error", {}).get("message") == "Unsupported Gemini instruction content: only text blocks are supported",
    "secret_leaked": "synthetic-secret" in json.dumps(invalid_result),
}

# Only inspect bodies correlated to our requests; print shapes only.
log_root = pathlib.Path.home() / ".omniroute" / "call_logs"
database = sqlite3.connect((log_root.parent / "storage.sqlite").as_uri() + "?mode=ro", uri=True)
request_ids = [str(uuid.UUID(row[0])) for correlation_id in capture_ids for row in database.execute("SELECT id FROM call_logs WHERE correlation_id = ?", (correlation_id,))]
database.close()
for request_id in request_ids:
    for filename in glob.glob(str(log_root / "*" / ("*_" + request_id + ".json"))):
        record = json.loads(pathlib.Path(filename).read_text(encoding="utf-8"))
        pipeline = record.get("pipeline", {})
        client = pipeline.get("clientRawRequest", {}).get("body", {})
        if run_id not in json.dumps(client) or hook not in json.dumps(client):
            continue
        native = pipeline.get("providerRequest", {}).get("body", {})
        variant = "corrected" if client["messages"][1]["role"] == "system" else "old"
        wire = {
            "variant": variant,
            "hook_in_system": hook in json.dumps(native.get("systemInstruction", {})),
            "hook_in_contents": hook in json.dumps(native.get("contents", [])),
            "system_role": native.get("systemInstruction", {}).get("role"),
        }
        summary["wire"].append(wire)

pathlib.Path(sys.argv[1]).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"wire": summary["wire"], "invalid_instruction": summary["invalid_instruction"]}), flush=True)
passed = all(p["status"] == 200 for p in summary["trials"])
passed &= summary["invalid_instruction"] == {"status": 400, "fixed_error": True, "secret_leaked": False}
corrected = [p for p in summary["wire"] if p["variant"] == "corrected"]
passed &= len(corrected) == 3 and all(p["hook_in_system"] and not p["hook_in_contents"] and p["system_role"] == "user" for p in corrected)
sys.exit(0 if passed else 1)
