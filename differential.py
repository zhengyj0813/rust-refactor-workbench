"""Compare observations from identical deterministic Rust fuzz harness runs."""


def differential_cases(payload):
    if (not isinstance(payload, dict) or type(payload.get("seed")) is not int
            or not isinstance(payload.get("cases"), list) or not payload["cases"]):
        raise ValueError("differential harness must return a seed and non-empty cases")
    if any(not isinstance(case, dict) or "input" not in case or "output" not in case
           for case in payload["cases"]):
        raise ValueError("differential cases need input and output")
    return payload


def compare_observations(old, new):
    if old is None and new is None:
        return None
    if old is None or new is None:
        return {"status": "input_mismatch", "reason": "Missing observations from one version"}
    original, candidate = old["cases"], new["cases"]
    if old["seed"] != new["seed"] or [case["input"] for case in original] != [
        case["input"] for case in candidate
    ]:
        return {"status": "input_mismatch", "reason": "Harnesses did not use the same inputs"}
    mismatches = [{"input": before["input"], "baseline": before["output"],
                   "candidate": after["output"]}
                  for before, after in zip(original, candidate)
                  if before["output"] != after["output"]]
    return {"status": "different" if mismatches else "match", "seed": old["seed"],
            "cases": len(original), "mismatch_count": len(mismatches), "mismatches": mismatches[:5]}
