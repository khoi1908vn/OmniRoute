"""Prove the synthetic probe never opens unrelated capture bodies."""
import io
import json
import pathlib
import runpy
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid


class ProbeLogIsolationTest(unittest.TestCase):
    def test_only_response_correlated_captures_are_opened(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            logs = home / ".omniroute" / "call_logs" / "synthetic"
            logs.mkdir(parents=True)
            database = sqlite3.connect(home / ".omniroute" / "storage.sqlite")
            database.execute("CREATE TABLE call_logs (id TEXT, correlation_id TEXT)")

            def respond(request, timeout):
                (logs / "unrelated.json").write_text("PRIVATE: not valid JSON")
                body = json.loads(request.data)
                request_id = str(uuid.uuid4())
                if len(body["messages"]) == 2 and isinstance(body["messages"][0]["content"], list):
                    result = {"error": {"message": "Unsupported Gemini instruction content: only text blocks are supported"}}
                    status = 400
                else:
                    corrected = body["messages"][1]["role"] == "system"
                    hook = body["messages"][1]["content"]
                    native = {"systemInstruction": {"role": "user", "parts": [{"text": body["system"] + ("\n" + hook if corrected else "")}]}, "contents": [{"role": "user", "parts": [{"text": "task"}]}]}
                    if not corrected:
                        native["contents"].append({"role": "user", "parts": [{"text": hook}]})
                    (logs / ("synthetic_" + request_id + ".json")).write_text(json.dumps({"pipeline": {"clientRawRequest": {"body": body}, "providerRequest": {"body": native}}}))
                    headers = {key.lower(): value for key, value in request.header_items()}
                    database.execute("INSERT INTO call_logs VALUES (?, ?)", (request_id, headers["x-correlation-id"]))
                    database.commit()
                    result = {"content": [{"type": "tool_use", "name": "inspect_workspace"}]}
                    status = 200
                if body.get("stream"):
                    events = [{"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "name": "inspect_workspace"}}]
                    data = "".join("data: " + json.dumps(e) + "\n\n" for e in events)
                else:
                    data = json.dumps(result)
                response = io.BytesIO(data.encode())
                response.status = status
                response.headers = {"x-omniroute-request-id": request_id}
                return response

            output = home / "summary.json"
            script = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "ad-hoc" / "probe-gemini-instruction-roles.py"
            with patch("pathlib.Path.home", return_value=home), patch("urllib.request.urlopen", side_effect=respond), patch("sys.argv", [str(script), str(output)]), patch("sys.stdout", new=io.StringIO()):
                with self.assertRaises(SystemExit) as exit_result:
                    runpy.run_path(str(script), run_name="__main__")
            self.assertEqual(exit_result.exception.code, 0)
            summary = json.loads(output.read_text())
            self.assertEqual(len(summary["wire"]), 6)
            database.close()


if __name__ == "__main__":
    unittest.main()
