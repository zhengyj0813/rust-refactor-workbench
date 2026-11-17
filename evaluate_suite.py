"""Run identical fixture tasks with single and multi agent review policies."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
from statistics import mean, median
import subprocess
import sys
from time import perf_counter
from uuid import uuid4

from patch_chain import save_version
from process_trace import append_event, project_edits


ROOT = Path(__file__).resolve().parent
TASKS = ROOT / "evaluation" / "tasks.json"


def missing_edits(patch, expected, *, removed=False):
    lines_by_path = {}
    header, marker = ("--- a/", "-") if removed else ("+++ b/", "+")
    current = None
    for line in patch.splitlines():
        if line.startswith(header):
            current = line[6:]
            lines_by_path[current] = []
        elif current is not None and line.startswith(marker):
            lines_by_path[current].append(line[1:])
    return [path for path, patterns in expected.items()
            if not all(re.search(pattern, "\n".join(lines_by_path.get(path, []))) for pattern in patterns)]


def missing_source_patterns(sources, expected):
    return [path for path, patterns in expected.items()
            if not all(re.search(pattern, sources.get(path, "")) for pattern in patterns)]


def run(task, mode, *, events=None):
    primary, *other = task["files"]
    command = [sys.executable, "refactor.py", "--agents", mode, f"--goal={task['goal']}"]
    for name in other:
        command.extend(("--edit-source", name))
    if task.get("benchmark"):
        command.append("--benchmark")
    if task.get("differential"):
        command.append("--differential")
    if task.get("proposal"):
        command.extend(("--proposal", task["proposal"]))
        if task.get("review_seed", True):
            command.append("--review-seed")
        if mode == "team" and task.get("fixed_seed_panel"):
            command.append("--fixed-seed-panel")
    if events is not None:
        command.extend(("--events", str(events)))
    for package in task.get("packages", []):
        command.extend(("--package", package))
    if task.get("git_links"):
        command.append("--workspace-git-links")
    for key, option in (("formal", "--formal"), ("repairs", "--repairs"),
                        ("review_domain", "--review-domain"), ("contract_test", "--contract-test"),
                        ("max_regression_percent", "--max-regression-percent")):
        if key in task:
            command.extend((option, str(task[key])))
    command.extend(("--", task["crate"], primary))
    started = perf_counter()
    proc = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=1500)
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        report = {}
    if report.get("accepted"):
        missing = missing_edits(report["patch"], task["expected"])
        missing.extend(missing_edits(report["patch"], task.get("expected_removed", {}), removed=True))
        if expected_source := task.get("expected_source"):
            crate = ROOT / task["crate"]
            sources = {name: (crate / name).read_bytes().decode("utf-8") for name in task["files"]}
            edits = report["attempts"][-1]["proposal"]["edits"]
            candidate = {**sources, **project_edits(edits, sources)}
            missing.extend(missing_source_patterns(candidate, expected_source))
        missing = sorted(set(missing))
        stage = "expected_edit" if missing else "accepted"
        report["missing_expected_edits"] = missing
    elif report.get("baseline_checks") and not all(c["ok"] for c in report["baseline_checks"]):
        stage = "baseline"
    elif report.get("formal", {}).get("status") in {"sat", "unknown", "unsupported"}:
        stage = "formal"
    elif report.get("differential", {}).get("status") in {"different", "input_mismatch"}:
        stage = "differential"
    elif report.get("benchmark", {}).get("regressions"):
        stage = "performance"
    elif report.get("preflight"):
        stage = "preflight"
    elif report.get("checks"):
        stage = "candidate"
    elif report.get("reviews"):
        stage = "review"
    elif report.get("proposal_error"):
        stage = "proposal"
    else:
        stage = "error"
    return {"task": task["id"], "mode": mode, "stage": stage, "exit_code": proc.returncode,
            "elapsed_seconds": perf_counter() - started, "stderr": proc.stderr, "report": report}


def ablation_metrics(rows, tasks):
    labels = {task["id"]: task["seed_valid"] for task in tasks}
    metrics = {}
    for mode in dict.fromkeys(row["mode"] for row in rows):
        group = [row for row in rows if row["mode"] == mode]
        first = [(labels[row["task"]], row["report"]["attempts"][0])
                 for row in group if row.get("report", {}).get("attempts")]
        reviews = [(valid, attempt) for valid, attempt in first
                   if any(review.get("decision") != "approve" for review in attempt.get("reviews", []))
                   and not attempt.get("checks") and not attempt.get("baseline_checks")]
        times = [row["elapsed_seconds"] for row in group if "elapsed_seconds" in row]
        metrics[mode] = {
            "early_rejected_bad": sum(not valid for valid, _ in reviews),
            "bad_seeds": sum(not valid for valid, _ in first),
            "false_rejected_good": sum(valid for valid, _ in reviews),
            "good_seeds": sum(valid for valid, _ in first),
            "bad_seed_final_accepts": sum(not labels[row["task"]] and row["stage"] == "accepted"
                                          for row in group),
            "docker_runs": sum(len(attempt.get("baseline_checks", [])) + len(attempt.get("checks", []))
                               for row in group for attempt in row.get("report", {}).get("attempts", [])),
            "model_calls": sum(row.get("report", {}).get("model_calls", 0) for row in group),
            "docker_seconds": sum(check.get("elapsed_seconds", 0) for row in group
                                  for attempt in row.get("report", {}).get("attempts", [])
                                  for key in ("baseline_checks", "checks")
                                  for check in attempt.get(key, [])),
            "review_seconds": sum(call["seconds"] for row in group
                                  for call in row.get("report", {}).get("model_timings", [])
                                  if call["stage"] == "review"),
            "median_seconds": median(times) if times else None,
        }
    return metrics


def paired_cost(rows, tasks):
    labels = {task["id"]: task["seed_valid"] for task in tasks}
    pairs = {}
    for row in rows:
        if row["mode"] in ("single", "multi") and "elapsed_seconds" in row:
            pair = pairs.setdefault((row["trial"], row["task"]), {})
            pair[row["mode"]] = row
    deltas = {True: [], False: []}
    for (_, task), pair in pairs.items():
        if pair.keys() == {"single", "multi"} and all(
                row["stage"] == "accepted" for row in pair.values()):
            deltas[labels[task]].append(pair["multi"]["elapsed_seconds"]
                                        - pair["single"]["elapsed_seconds"])
    good = mean(deltas[True]) if deltas[True] else None
    bad = mean(deltas[False]) if deltas[False] else None
    threshold = good / (good - bad) if good is not None and bad is not None and good > 0 > bad else None
    return {"good_pairs": len(deltas[True]), "bad_pairs": len(deltas[False]),
            "good_mean_multi_minus_single_seconds": good,
            "bad_mean_multi_minus_single_seconds": bad,
            "illustrative_break_even_bad_fraction": threshold}


def run_trial(task, mode, trial, record_process):
    events = None
    if record_process:
        run_id = uuid4().hex
        folder = ROOT / ".workbench-runs" / run_id
        save_version(folder / "task.json", {
            "id": run_id, "task": task["id"], "goal": task["goal"], "mode": mode,
            "repairs": task.get("repairs", 0), "trial": trial,
        })
        events = folder / "events.jsonl"
        append_event(events, "task", "started", details={"goal": task["goal"]})
    started = perf_counter()
    try:
        row = run(task, mode, events=events)
    except (OSError, subprocess.TimeoutExpired) as exc:
        row = {"task": task["id"], "mode": mode,
               "stage": "timeout" if isinstance(exc, subprocess.TimeoutExpired) else "error",
               "elapsed_seconds": perf_counter() - started, "stderr": str(exc)}
    row = {"trial": trial, **row}
    if record_process:
        row["process_id"] = run_id
        attempts = row.get("report", {}).get("attempts", [])
        append_event(events, "result", "passed" if row["stage"] == "accepted" else "failed",
                     attempt=attempts[-1]["attempt"] if attempts else 1,
                     details={"stage": row["stage"], "error": row.get("stderr")})
        save_version(folder / "result.json", row)
    return row


def with_acceptance(tasks, acceptance):
    runner_fields = {"expected", "expected_removed", "expected_source", "packages", "contract_test",
                     "benchmark", "differential", "formal", "max_regression_percent"}
    return [{**task, **{key: value for key, value in acceptance[task["id"]].items()
                       if key in runner_fields}}
            for task in tasks]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", action="append", help="select task ID; defaults to all")
    parser.add_argument("--manifest", type=Path, default=TASKS)
    parser.add_argument("--acceptance", type=Path, help="load private acceptance rules by task ID")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--mode", action="append", choices=("single", "multi", "team", "adaptive"))
    parser.add_argument("--record-process", action="store_true", help="save workbench replay for each run")
    parser.add_argument("--output", type=Path, default=ROOT / "reports" / "evaluation.json")
    args = parser.parse_args()
    tasks = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
    if args.task:
        known = {task["id"] for task in tasks}
        if unknown := set(args.task) - known:
            parser.error(f"unknown task IDs: {', '.join(sorted(unknown))}")
        tasks = [task for task in tasks if task["id"] in args.task]
    if args.acceptance:
        acceptance = json.loads(args.acceptance.read_text(encoding="utf-8-sig"))
        tasks = with_acceptance(tasks, acceptance)
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    rows = []
    selected_modes = tuple(dict.fromkeys(args.mode or ("single", "multi")))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for index in range(args.repeat):
        modes = selected_modes if index % 2 == 0 else selected_modes[::-1]
        for task in tasks:
            for mode in modes:
                row = run_trial(task, mode, index + 1, args.record_process)
                rows.append(row)
                summary = {mode: dict(Counter(row["stage"] for row in rows if row["mode"] == mode))
                           for mode in selected_modes}
                output = {"summary": summary, "runs": rows}
                if all("seed_valid" in task for task in tasks):
                    output["ablation"] = ablation_metrics(rows, tasks)
                    output["paired_cost"] = paired_cost(rows, tasks)
                args.output.write_text(json.dumps(output, indent=2)
                                       + "\n", encoding="utf-8")
                print(f"{task['id']} {mode} {row['stage']}", flush=True)
    print(json.dumps(summary), flush=True)
    return int(any(row["stage"] in {"error", "baseline", "timeout"} for row in rows))


if __name__ == "__main__":
    raise SystemExit(main())
