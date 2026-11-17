from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

from refactor import evaluate


class CfgPreflightTest(unittest.TestCase):
    def test_invalid_or_missing_attribute_stops_before_cargo(self):
        attr = '#[cfg(target_pointer_width = "32")]'
        original = f"fn update() {{\n    {attr}\n    original();\n}}\n"
        for statement in (f"{attr}\n    value = 1;", "value = 1;",
                          'if cfg!(target_pointer_width = "32") { value = 1; }'):
            with self.subTest(statement=statement), TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / "lib.rs"
                source.write_bytes(original.encode())
                candidate = original.replace(f"{attr}\n    original();", statement)
                check = Mock()
                result = evaluate(root, [{"path": source.name, "before": original,
                                          "after": candidate}], check, preserve_statement_cfg=True)
                self.assertFalse(result["accepted"])
                self.assertTrue(result["preflight"])
                check.assert_not_called()

    def test_guarded_block_reaches_cargo_and_ignores_comment(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "lib.rs"
            original = ('fn update() {\n    #[cfg(feature = "values")]\n'
                        '    original();\n}\n')
            source.write_bytes(original.encode())
            candidate = original.replace("original();", "{ value = 1; }")
            candidate += '// #[cfg(test)] fake = 3;\n'
            check = Mock(return_value=[{"ok": True}])
            result = evaluate(root, [{"path": source.name, "before": original,
                                      "after": candidate}], check, preserve_statement_cfg=True)
            self.assertTrue(result["accepted"])
            check.assert_called_once()
