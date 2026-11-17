import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from refactor import run_attempts


class SeedPanelTest(unittest.TestCase):
    def test_fixed_specialists_review_same_patch_and_stop_at_first_rejection(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            proposal = {"edits": [{"path": "lib.rs", "before": "fn before() {}", "after": "fn after() {}"}]}
            seed = root / "proposal.json"
            seed.write_text(json.dumps(proposal), encoding="utf-8")
            (root / "lib.rs").write_text("fn before() {}", encoding="utf-8")
            args = SimpleNamespace(agents="team", proposal=seed, review_seed=True,
                                   fixed_seed_panel=True, repairs=0, events=None, formal=None,
                                   review_domain="lifetime", workspace_git_links=False,
                                   max_regression_percent=None)
            cargo = Mock(return_value=[{"ok": True}])
            responses = [{"decision": "approve", "reason": "API remains valid"},
                         {"decision": "reject", "reason": "Ordering changed"}]
            with patch("refactor.ask", side_effect=responses) as ask:
                result = run_attempts(args, root, {"goal": "Move a method"},
                                      {"lib.rs": "fn before() {}"}, cargo)
            self.assertFalse(result["accepted"])
            self.assertEqual([review["role"] for review in result["reviews"]],
                             ["lifetime", "concurrency"])
            self.assertEqual(result["model_calls"], 2)
            self.assertTrue(all(call.args[1]["proposal"] == proposal for call in ask.call_args_list))
            cargo.assert_not_called()
