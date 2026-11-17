"""Source-bound equivalence checks for supported Rust refactoring shapes."""
import re


PARAMS = r"\(left:&'astr,right:&'astr,threshold:usize\)->&'astr"
BRANCH = r"ifleft\.len\(\)(>=|>)threshold\{left\}else\{right\}"
BASE = re.compile(r"pubfnpick<'a>" + PARAMS + r"\{" + BRANCH + r"\}")
WRAPPER = r"pubfnpick<'a>" + PARAMS + r"\{choose\(left,right,threshold\)\}"
HELPER = r"fnchoose<'a>" + PARAMS + r"\{" + BRANCH + r"\}"
EXTRACTED = re.compile(WRAPPER + HELPER)
ANNOTATED_HELPER = r"(?:#\[inline\])?" + HELPER
EXTRACTED_V2 = re.compile(WRAPPER + ANNOTATED_HELPER + "|" + ANNOTATED_HELPER + WRAPPER)
SLICE_PARAMS = r"\(input:&\[u8\],start:usize,end:usize\)->Option<&\[u8\]>"
SLICE_BODY = r"\{input\.get\((start|end|0)\.\.(start|end|0)\)\}"
SLICE_BASE = re.compile(r"pubfnwindow" + SLICE_PARAMS + SLICE_BODY)
SLICE_WRAPPER = r"pubfnwindow" + SLICE_PARAMS + r"\{slice_window\(input,start,end\)\}"
SLICE_HELPER = r"(?:#\[inline\])?fnslice_window" + SLICE_PARAMS + SLICE_BODY
SLICE_EXTRACTED = re.compile(SLICE_WRAPPER + SLICE_HELPER + "|" + SLICE_HELPER + SLICE_WRAPPER)
AGENT_PROPERTIES = {
    "branch-identity": "Compare which input is returned by pick on identical lengths and threshold.",
    "slice-range": "Compare None or the same half-open slice endpoints for identical inputs.",
}


def witness_model(solver, *preferred):
    from z3 import sat

    model = solver.model()
    solver.push()
    solver.add(*preferred)
    if solver.check() == sat:
        model = solver.model()
    solver.pop()
    return model


def branch_equivalence(original, candidate, *, allow_reordered=False):
    """Check branch identity for every 64-bit usize length and threshold."""
    from z3 import BitVecs, Solver, UGE, UGT, is_true, sat, unsat

    old = BASE.fullmatch(re.sub(r"\s+", "", original))
    pattern = EXTRACTED_V2 if allow_reordered else EXTRACTED
    new = pattern.fullmatch(re.sub(r"\s+", "", candidate))
    result = {"contract": "borrow-selection-v2" if allow_reordered else "borrow-selection-v1",
              "solver": "Z3", "usize_bits": 64, "property": AGENT_PROPERTIES["branch-identity"]}
    if old is None or new is None:
        return {**result, "status": "unsupported",
                "reason": "Expected pick to delegate to choose with unchanged parameters "
                          "and choose to return the left or right input by length comparison."}
    length, threshold = BitVecs("left_len threshold", 64)
    predicates = {">=": UGE, ">": UGT}
    old_selects_left = predicates[old[1]](length, threshold)
    new_operator = next(operator for operator in new.groups() if operator is not None)
    new_selects_left = predicates[new_operator](length, threshold)
    solver = Solver()
    solver.set(timeout=3000)
    solver.add(old_selects_left != new_selects_left)
    result["operators"] = {"baseline": old[1], "candidate": new_operator}
    result["expressions"] = {key: f"left.len() {operator} threshold"
                             for key, operator in result["operators"].items()}
    answer = solver.check()
    if answer == unsat:
        return {**result, "status": "unsat"}
    if answer == sat:
        model = witness_model(solver, length == 1, threshold == 1)
        return {**result, "status": "sat", "counterexample": {
            "left_len": model.eval(length, model_completion=True).as_long(),
            "threshold": model.eval(threshold, model_completion=True).as_long(),
            "baseline_return": "left" if is_true(model.eval(old_selects_left, model_completion=True)) else "right",
            "candidate_return": "left" if is_true(model.eval(new_selects_left, model_completion=True)) else "right",
        }}
    return {**result, "status": "unknown", "reason": solver.reason_unknown()}


def slice_equivalence(original, candidate):
    """Compare checked half-open ranges in the supported slice extraction shape."""
    from z3 import And, BitVecs, BitVecVal, Or, Solver, ULE, is_true, sat, unsat

    result = {"contract": "slice-range-v1", "solver": "Z3", "usize_bits": 64,
              "property": AGENT_PROPERTIES["slice-range"]}
    old = SLICE_BASE.fullmatch(re.sub(r"\s+", "", original))
    new = SLICE_EXTRACTED.fullmatch(re.sub(r"\s+", "", candidate))
    if old is None or new is None:
        return {**result, "status": "unsupported",
                "reason": "Expected window to delegate unchanged arguments to slice_window and use "
                          "input.get with half-open endpoints selected from start, end, or zero."}
    length, start, end = BitVecs("input_len start end", 64)
    values = {"start": start, "end": end, "0": BitVecVal(0, 64)}
    endpoints = {"baseline": old.groups(), "candidate": tuple(item for item in new.groups() if item is not None)}
    result["expressions"] = {key: f"input.get({lower}..{upper})" for key, (lower, upper) in endpoints.items()}

    def range_model(side):
        lower, upper = (values[term] for term in endpoints[side])
        return lower, upper, And(ULE(lower, upper), ULE(upper, length))

    old_start, old_end, old_valid = range_model("baseline")
    new_start, new_end, new_valid = range_model("candidate")
    solver = Solver()
    solver.set(timeout=3000)
    solver.add(ULE(length, (1 << 63) - 1))
    solver.add(Or(old_valid != new_valid,
                  And(old_valid, new_valid, Or(old_start != new_start, old_end != new_end))))
    answer = solver.check()
    if answer == unsat:
        return {**result, "status": "unsat"}
    if answer == sat:
        model = witness_model(solver, length == 4, start == 1, end == 3)

        def number(value):
            return model.eval(value, model_completion=True).as_long()

        def interval(lower, upper, valid):
            if is_true(model.eval(valid, model_completion=True)):
                return {"start": number(lower), "end": number(upper)}
            return None

        return {**result, "status": "sat", "counterexample": {
            "input_len": number(length), "start": number(start), "end": number(end),
            "baseline_return": interval(old_start, old_end, old_valid),
            "candidate_return": interval(new_start, new_end, new_valid),
        }}
    return {**result, "status": "unknown", "reason": solver.reason_unknown()}


def valid_agent_selection(selection):
    return (isinstance(selection, dict) and set(selection) == {"property", "reason"}
            and isinstance(selection["property"], str) and selection["property"] in AGENT_PROPERTIES
            and isinstance(selection["reason"], str) and bool(selection["reason"].strip()))


def check_agent_contract(selection, original, candidate):
    if not valid_agent_selection(selection):
        return {"status": "unsupported", "reason": "The verification agent did not select a supported property."}
    if selection["property"] == "branch-identity":
        result = branch_equivalence(original, candidate, allow_reordered=True)
    else:
        result = slice_equivalence(original, candidate)
    return {**result, "specification": selection}
