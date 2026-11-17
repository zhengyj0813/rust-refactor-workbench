import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from process_trace import read_events
from refactor import run_attempts


class ModelJsonRetryTest(unittest.TestCase):
    def run_team(self, responses):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            args = SimpleNamespace(agents="team", proposal=None, events=root / "events.jsonl")
            with patch("refactor.ask", side_effect=responses) as ask:
                report = run_attempts(args, root, {}, {"src/lib.rs": "fn old() {}"}, None)
            return report, read_events(args.events), ask.call_args_list

    def test_retry_only_invalid_json_and_count_both_calls(self):
        bad = json.JSONDecodeError("Invalid control character", '{"reason":"a\nb"}', 12)
        report, events, calls = self.run_team([bad, {}])
        self.assertEqual(report["model_calls"], 2)
        self.assertEqual([e["status"] for e in events], ["started", "failed", "started", "passed"])
        self.assertIn("valid JSON", calls[1].args[0])
        self.assertEqual(calls[0].args[1], calls[1].args[1])

    def test_second_invalid_response_ends_the_run(self):
        bad = json.JSONDecodeError("Invalid control character", "", 0)
        report, events, calls = self.run_team([bad, bad])
        self.assertEqual(len(calls), 2)
        self.assertEqual(report["model_calls"], 2)
        self.assertIn("Invalid control character", report["proposal_error"])

    def test_other_failures_do_not_retry(self):
        report, _, calls = self.run_team([ValueError("unexpected payload")])
        self.assertEqual(len(calls), 1)
        self.assertEqual(report["model_calls"], 1)
