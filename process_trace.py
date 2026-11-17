"""Persist live refactoring events and replay evidence from saved reports."""
from datetime import datetime, timezone
from difflib import unified_diff
import json


def append_event(path, stage, status, *, attempt=1, details=None, next_attempt=None):
    if path is None:
        return
    event = {"stage": stage, "status": status, "attempt": attempt,
             "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
             "details": details or {}}
    if next_attempt is not None:
        event["next_attempt"] = next_attempt
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event) + "\n")


def read_events(path):
    if not path.is_file():
        return []
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            # A reader can observe the final line before a writer flushes it.
            break
    return events


def project_edits(edits, sources):
    """Apply ordered, exact replacements to an in-memory source snapshot."""
    projected = {}
    for edit in edits:
        path = edit["path"]
        text = projected.get(path, sources[path]).replace("\r\n", "\n")
        anchor = edit["before"].replace("\r\n", "\n")
        if not anchor or text.count(anchor) != 1:
            raise ValueError("ambiguous edit")
        projected[path] = text.replace(anchor, edit["after"].replace("\r\n", "\n"), 1)
    return projected


def revision_diff(before, after, sources=None):
    """Show changes in replacement snippets that have the same source anchor."""
    old = {(edit["path"], edit["before"]): edit["after"] for edit in before.get("edits", [])}
    new = {(edit["path"], edit["before"]): edit["after"] for edit in after.get("edits", [])}
    if sources is not None:
        try:
            previous = project_edits(before["edits"], sources)
            revised = project_edits(after["edits"], sources)
            paths = sorted(previous.keys() | revised.keys())
            old = {(path, ""): previous.get(path, sources[path]) for path in paths}
            new = {(path, ""): revised.get(path, sources[path]) for path in paths}
        except (KeyError, TypeError, ValueError):
            pass
    if old.keys() != new.keys():
        return ""
    return "".join("".join(unified_diff(old[key].splitlines(keepends=True),
                                       new[key].splitlines(keepends=True),
                                       f"{key[0]} (previous)", f"{key[0]} (revised)"))
                   for key in old)


def historical_events(report):
    events = []
    attempts = report.get("attempts", [])

    def add(stage, status, attempt, details, next_attempt=None):
        event = {"stage": stage, "status": status, "attempt": attempt,
                 "details": details, "at": None}
        if next_attempt is not None:
            event["next_attempt"] = next_attempt
        events.append(event)

    for index, item in enumerate(attempts):
        number = item["attempt"]
        next_attempt = attempts[index + 1]["attempt"] if index + 1 < len(attempts) else None
        if index:
            previous = attempts[index - 1]["proposal"]
            add("repair", "passed", number,
                {"diff": revision_diff(previous, item["proposal"]), "proposal": item["proposal"],
                 "owner": attempts[index - 1].get("repair_owner")})
        else:
            add("candidate", "passed", number, {"proposal": item["proposal"]})
        if "expert_plan" in item:
            add("routing", "passed", number, {"plan": item["expert_plan"]})
        for review in item.get("reviews", []):
            approved = review.get("decision") == "approve"
            add("review", "passed" if approved else "failed", number, review,
                None if approved else next_attempt)
        for key, stage in (("baseline_checks", "baseline"), ("checks", "validation")):
            if checks := item.get(key):
                passed = all(check["ok"] for check in checks)
                add(stage, "passed" if passed else "failed", number, {"checks": checks},
                    None if passed else next_attempt)
        for stage, passed in (("formal", lambda value: value["status"] == "unsat"),
                              ("differential", lambda value: value["status"] == "match"),
                              ("benchmark", lambda value: value["behavior_matches"] and not value.get("regressions"))):
            if evidence := item.get(stage):
                ok = passed(evidence)
                add(stage, "passed" if ok else "failed", number, evidence, None if ok else next_attempt)
        if item.get("proposal_error"):
            add("candidate", "failed", number, {"error": item["proposal_error"]}, next_attempt)
    add("result", "passed" if report["accepted"] else "failed",
        attempts[-1]["attempt"] if attempts else 1, {})
    return events
