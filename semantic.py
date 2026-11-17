"""Small function-level syntax and compiler IR summaries for agent context."""
import re
from collections import Counter


def syntax_summary(source, symbol):
    import tree_sitter_rust
    from tree_sitter import Language, Parser

    encoded = source.encode()
    parser = Parser(Language(tree_sitter_rust.language()))
    tree = parser.parse(encoded)
    if tree.root_node.has_error:
        raise ValueError("source contains syntax errors")
    pending = [tree.root_node]
    matches = []
    while pending:
        item = pending.pop()
        name = item.child_by_field_name("name")
        if item.type == "function_item" and name and name.text.decode() == symbol:
            matches.append(item)
        pending.extend(item.named_children)
    if len(matches) != 1:
        raise ValueError(f"expected one syntax node for {symbol}")
    item = matches[0]

    def describe(current, depth):
        result = {"kind": current.type, "line": current.start_point.row + 1,
                  "column_bytes": current.start_point.column + 1}
        if depth and current.named_children:
            result["children"] = [describe(child, depth - 1) for child in current.named_children]
        elif current.end_byte - current.start_byte <= 160:
            result["text"] = current.text.decode()
        return result

    return describe(item, 4)


def select_mir(text, symbol):
    pattern = r"(?m)^fn (?:[^\n(]*::)?" + re.escape(symbol) + r"\([^\n]*\{\n"
    match = re.search(pattern, text)
    if not match:
        return None
    end = text.find("\n}", match.end())
    if end >= 0:
        return text[match.start():end + 2][:12000]


def statement_cfg_issues(original, candidate, *, preserve):
    """Check direct statement attributes inside functions in parseable Rust."""
    if not re.search(r"#\s*\[\s*cfg\s*\(", original + candidate):
        return []
    try:
        import tree_sitter_rust
        from tree_sitter import Language, Parser
    except ImportError:
        return []
    parser = Parser(Language(tree_sitter_rust.language()))

    def scan(source):
        tree = parser.parse(source.encode())
        if tree.root_node.has_error:
            return None
        guards = {}
        assignments = Counter()
        pending = [(tree.root_node, (), None)]
        while pending:
            node, scope, function = pending.pop()
            if node.type in {"mod_item", "trait_item", "impl_item", "function_item"}:
                identity = tuple(part.text for field in ("name", "type", "trait")
                                 if (part := node.child_by_field_name(field)) is not None)
                scope = (*scope, (node.type, identity))
                function = None
            if node.type == "function_item":
                name = node.child_by_field_name("name")
                function = name.text.decode()
                guards.setdefault(scope, Counter())
            if node.type == "block" and function is not None:
                attributes = []
                for child in node.named_children:
                    if child.type in {"line_comment", "block_comment"}:
                        continue
                    if child.type == "attribute_item":
                        attr = child.named_children[0]
                        label = attr.named_children[0]
                        if label.text == b"cfg":
                            key = re.sub(rb'"[^"\\]*(?:\\.[^"\\]*)*"|\s+',
                                         lambda match: match[0] if match[0].startswith(b'"') else b"",
                                         attr.text)
                            attributes.append(key)
                        continue
                    if child.type in {"expression_statement", "let_declaration"}:
                        guards[scope].update(attributes)
                        expr = child.named_children[0] if child.named_children else None
                        if expr and expr.type in {"assignment_expression", "compound_assignment_expr"}:
                            for attr in attributes:
                                assignments[(scope, function, attr, child.text)] += 1
                    attributes.clear()
            pending.extend((child, scope, function) for child in node.named_children)
        return guards, assignments

    previous, current = scan(original), scan(candidate)
    if previous is None or current is None:
        return []
    old_guards, old_assignments = previous
    new_guards, new_assignments = current
    issues = [f"{name}: #[{attr.decode()}] directly annotates an assignment."
              for _, name, attr, _ in new_assignments - old_assignments]
    if preserve:
        for scope, guards in old_guards.items():
            if scope in new_guards:
                name = scope[-1][1][0].decode()
                issues.extend(f"{name}: lost {count} statement guard(s) #[{attr.decode()}]."
                              for attr, count in (guards - new_guards[scope]).items())
    return issues
    return None
