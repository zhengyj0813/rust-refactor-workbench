import unittest

from adaptive import repair_owner, routing_decision


class MethodRoutingTest(unittest.TestCase):
    def test_restricted_visibility_in_multifile_patch_routes_to_lifetime(self):
        proposal = {"edits": [
            {"path": "src/lib.rs", "before": "fn old() {}", "after": "fn call() { child::f(); }"},
            {"path": "src/child.rs", "before": "", "after": "pub(super) fn f() {}"},
        ]}
        plan = routing_decision("Move the helper.", proposal)["plan"]
        self.assertEqual([item["role"] for item in plan], ["lifetime"])

    def test_extraction_with_nonlocal_flow_routes_to_concurrency(self):
        proposal = {"edits": [
            {"path": "src/lib.rs", "before": "if done { break; }", "after": "if stop() { break; }"},
        ]}
        plan = routing_decision("Extract a helper.", proposal)["plan"]
        self.assertEqual([item["role"] for item in plan], ["concurrency"])

    def test_compiler_visibility_diagnostic_can_select_repair_owner(self):
        self.assertEqual(repair_owner([], [], {"checks": [
            {"ok": False, "output": "error[E0624]: method is private"},
        ]}), "lifetime")
