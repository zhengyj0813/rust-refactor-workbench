"""Serve the Rust refactoring workbench on loopback."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from math import isfinite
from pathlib import Path
import re
import subprocess
from threading import Lock
from uuid import uuid4

from evaluate_suite import ROOT, TASKS, run
from patch_chain import (
    checkout_commit, load_version, patch_action, prepare_version, save_version,
    version_path, version_state,
)
from process_trace import append_event, historical_events, read_events


ASSETS = {
    "/": ("index.html", "text/html"),
    "/app.js": ("app.js", "text/javascript"),
    "/process.js": ("process.js", "text/javascript"),
    "/style.css": ("style.css", "text/css"),
}


def custom_task(payload):
    crate = payload.get("crate")
    if not isinstance(crate, str) or not Path(crate).is_absolute():
        raise ValueError("请输入本机 Rust 仓库的绝对路径")
    root = Path(crate).resolve()
    if not (root / "Cargo.toml").is_file():
        raise ValueError("所选目录中没有 Cargo.toml")
    goal = payload.get("goal")
    if not isinstance(goal, str) or not goal.strip():
        raise ValueError("请填写重构目标")
    names = payload.get("files")
    if not isinstance(names, list) or not names:
        raise ValueError("请填写至少一个 Rust 源文件")
    files = []
    for name in names:
        if not isinstance(name, str) or Path(name).anchor:
            raise ValueError("请使用相对于仓库的 Rust 文件路径")
        source = (root / name).resolve()
        if (not source.is_relative_to(root) or source.suffix != ".rs" or not source.is_file()
                or "src" not in source.relative_to(root).parts[:-1]):
            raise ValueError(f"请选择仓库内 src 目录中的 Rust 文件：{name}")
        relative = source.relative_to(root).as_posix()
        if relative not in files:
            files.append(relative)
    domain = payload.get("domain", "lifetime")
    if domain not in ("lifetime", "concurrency"):
        raise ValueError("请选择有效的审查专家")
    packages = payload.get("packages", [])
    if not isinstance(packages, list) or any(
            not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_-]*", name)
            for name in packages):
        raise ValueError("请输入有效的 Cargo 包名")
    differential = payload.get("differential", False)
    limit = payload.get("max_regression_percent")
    if type(differential) is not bool or (limit is not None and
            (type(limit) not in (int, float) or not isfinite(limit) or limit < 0)):
        raise ValueError("性能回归阈值必须是非负数")
    if (differential or limit is not None) and len(packages) > 1:
        raise ValueError("运行验证样例时请选择一个 Cargo 包")
    task = {"id": "custom", "crate": str(root), "files": files, "goal": goal.strip(),
            "packages": packages, "review_domain": domain, "repairs": 1, "expected": {},
            "differential": differential}
    if limit is not None:
        task.update(benchmark=True, max_regression_percent=limit)
    return task


def load_tasks():
    tasks = {item["id"]: item for item in json.loads(TASKS.read_text(encoding="utf-8"))}
    tasks["z3-loop-demo"] = {
        "id": "z3-loop-demo", "crate": "evaluation/formal-choice", "files": ["src/lib.rs"],
        "goal": ("Extract pick into private choose. Keep argument names, order, explicit lifetimes "
                 "and branch structure from the supplied proposal. Correct the comparison to preserve behavior."),
        "proposal": "evaluation/formal-choice/boundary-error.json", "review_seed": False,
        "formal": "borrow-selection-v2", "repairs": 1, "expected": {},
    }
    for filename in ("formal-agent.json", "method-refactors.json"):
        manifest = ROOT / "evaluation" / filename
        if manifest.is_file():
            tasks.update((item["id"], item) for item in json.loads(manifest.read_text(encoding="utf-8")))
    return tasks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    tasks = load_tasks()
    latest = {}
    executor = ThreadPoolExecutor(max_workers=1)
    store = ROOT / ".workbench-patches"
    run_store = ROOT / ".workbench-runs"
    patch_lock = Lock()

    def run_job(job_id, task, mode):
        custom = task["id"] == "custom"
        root = Path(task["crate"])
        base_commit = None
        version_error = None
        if custom:
            try:
                base_commit = checkout_commit(root)
            except (OSError, subprocess.TimeoutExpired) as exc:
                version_error = str(exc)
        folder = run_store / job_id
        events = folder / "events.jsonl"
        append_event(events, "task", "started", details={"goal": task["goal"]})
        try:
            row = run(task, mode, events=events)
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            append_event(events, "result", "failed", details={"error": str(exc)})
            save_version(folder / "result.json", {"stage": "error", "stderr": str(exc)})
            raise
        if custom and row["stage"] == "accepted":
            if version_error is not None:
                row["patch_version_error"] = version_error
            else:
                try:
                    version = prepare_version(root, row, task["files"], base_commit=base_commit)
                    version["goal"] = task["goal"]
                    with patch_lock:
                        save_version(version_path(store, job_id), version)
                    row["patch_version"] = job_id
                except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
                    row["patch_version_error"] = str(exc)
        attempts = row.get("report", {}).get("attempts", [])
        append_event(events, "result", "passed" if row["stage"] == "accepted" else "failed",
                     attempt=attempts[-1]["attempt"] if attempts else 1,
                     details={"stage": row["stage"], "error": row.get("stderr")})
        save_version(folder / "result.json", row)
        return row

    class Handler(BaseHTTPRequestHandler):
        def send_body(self, status, kind, data):
            self.send_response(status)
            self.send_header("Content-Type", f"{kind}; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; object-src 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(data)

        def json(self, status, payload):
            self.send_body(status, "application/json", json.dumps(payload).encode())

        def allowed_host(self):
            return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

        def do_GET(self):
            if not self.allowed_host():
                return self.json(403, {"error": "请使用本机工作台地址"})
            if self.path in ASSETS:
                file, kind = ASSETS[self.path]
                return self.send_body(200, kind, (ROOT / "workbench" / file).read_bytes())
            if self.path == "/api/process":
                entries = [{"id": "z3-example", "goal": "Z3 反例驱动修订 · 历史回放"}]
                for file in sorted(run_store.glob("*/task.json"), key=lambda p: p.stat().st_mtime,
                                   reverse=True):
                    entries.append(load_version(file))
                return self.json(200, entries)
            if self.path.startswith("/api/process/"):
                job_id = self.path.rsplit("/", 1)[-1]
                if job_id == "z3-example":
                    report = json.loads((ROOT / "reports/formal-repair-multi.json")
                                        .read_text(encoding="utf-8-sig"))
                    return self.json(200, {"events": historical_events(report),
                                           "result": {"task": "repair-multi", "mode": "multi",
                                                      "stage": "accepted", "report": report}})
                folder = run_store / job_id
                if not re.fullmatch(r"[a-f0-9]{32}", job_id) or not (folder / "task.json").is_file():
                    return self.json(404, {"error": "运行记录不存在"})
                result = folder / "result.json"
                return self.json(200, {"events": read_events(folder / "events.jsonl"),
                                       "result": load_version(result) if result.is_file() else None})
            if self.path == "/api/patches":
                history = []
                with patch_lock:
                    for path in store.glob("*.json"):
                        try:
                            version = load_version(path)
                            history.append({"id": path.stem, "root": version["root"],
                                            "created_at": version["created_at"], "goal": version["goal"]})
                        except (ValueError, OSError, KeyError):
                            continue
                return self.json(200, sorted(history, key=lambda item: item["created_at"], reverse=True))
            if self.path.startswith("/api/patches/"):
                try:
                    with patch_lock:
                        version = load_version(version_path(store, self.path.rsplit("/", 1)[-1]))
                        state = version_state(version)
                except (ValueError, OSError):
                    return self.json(404, {"error": "补丁版本不存在"})
                return self.json(200, {"version": version, "state": state})
            if self.path == "/api/data":
                report = ROOT / "reports" / "evaluation.json"
                try:
                    runs = json.loads(report.read_text(encoding="utf-8"))["runs"]
                except FileNotFoundError:
                    runs = []
                except (ValueError, KeyError):
                    return self.json(503, {"error": "评测报告暂时不可读"})
                root = ROOT / "reports"
                repositories = root / "repository-evaluation.json"
                repository_runs = (json.loads(repositories.read_text(encoding="utf-8"))["runs"]
                                   if repositories.is_file() else [])
                additional = {}
                report_errors = {}
                expanded = []
                for case in (3, 4, 5, 6, 9, 27):
                    path = root / f"rem-{case}-expanded.json"
                    if path.is_file():
                        try:
                            expanded.extend(json.loads(path.read_text(encoding="utf-8-sig"))["runs"])
                        except (ValueError, KeyError, OSError):
                            report_errors["rem_expanded"] = f"暂时无法读取 {path.name}"
                    else:
                        expanded.append({"task": f"rem-{case}", "mode": "team", "stage": "pending"})
                additional["rem_expanded"] = expanded
                for name, filename in (("adaptive_holdout", "dataset-pilot-adaptive-holdout.json"),
                                       ("hard_cases", "dataset-pilot-hard-cases.json"),
                                       ("hard_seed", "dataset-pilot-hard-seed.json"),
                                       ("hard_review_audit", "dataset-pilot-hard-review-audit.json"),
                                       ("adaptive_methods", "dataset-pilot-adaptive-methods.json"),
                                       ("inline_iterator", "dataset-pilot-inline-iterator-comparison.json"),
                                       ("method_comparison", "dataset-pilot-method-comparison.json"),
                                       ("ablation", "ablation.json"),
                                       ("workspace", "workspace-evaluation.json"),
                                       ("workspace_ablation", "workspace-ablation.json"),
                                       ("adaptive", "adaptive-ablation.json"),
                                       ("adaptive_crossbeam", "adaptive-crossbeam.json"),
                                       ("release", "release-evaluation.json")):
                    path = root / filename
                    if path.is_file():
                        try:
                            dataset = json.loads(path.read_text(encoding="utf-8-sig"))
                            additional[name] = dataset["runs"]
                            if name in {"adaptive_methods", "adaptive_holdout", "hard_cases"}:
                                additional[f"{name}_summary"] = dataset["summary"]
                            if "ablation" in dataset:
                                additional[f"{name}_metrics"] = dataset["ablation"]
                            if name == "release":
                                additional["release_summary"] = dataset["summary"]
                                additional["release_human_baseline"] = dataset["human_baseline"]
                        except (ValueError, KeyError):
                            report_errors[name] = f"暂时无法读取 {filename}"
                formal_runs = []
                for name in ("correct", "boundary-error", "repair-single", "repair-multi"):
                    path = root / f"formal-{name}.json"
                    if path.is_file():
                        proof = json.loads(path.read_text(encoding="utf-8-sig"))
                        formal_runs.append({"task": name, "mode": proof["agent_mode"],
                                            "elapsed_seconds": proof["elapsed_seconds"],
                                            "stage": "accepted" if proof["accepted"] else "formal",
                                            "report": proof})
                team_path = root / "crossbeam-expert-team.json"
                if team_path.is_file():
                    try:
                        team = json.loads(team_path.read_text(encoding="utf-8-sig"))
                        additional["expert_team"] = [{"task": "crossbeam-expert-team", "mode": "team",
                                                       "elapsed_seconds": team["elapsed_seconds"],
                                                       "stage": "accepted" if team["accepted"] else "candidate",
                                                       "report": team}]
                    except (ValueError, KeyError):
                        report_errors["expert_team"] = "暂时无法读取专家协作报告"
                validation_runs = []
                for name in ("differential-correct", "differential-boundary-error",
                             "performance-optimized", "performance-regression"):
                    path = root / f"{name}.json"
                    if path.is_file():
                        try:
                            result = json.loads(path.read_text(encoding="utf-8-sig"))
                            validation_runs.append({
                                "task": name, "mode": "offline",
                                "elapsed_seconds": result["elapsed_seconds"],
                                "stage": "accepted" if result["accepted"] else name.split("-")[0],
                                "report": result,
                            })
                        except (ValueError, KeyError):
                            report_errors["validation"] = f"暂时无法读取 {path.name}"
                return self.json(200, {"tasks": list(tasks.values()), "runs": runs,
                                       "repositories": repository_runs, "formal": formal_runs,
                                       "validation": validation_runs,
                                       "report_errors": report_errors,
                                       **additional})
            if self.path.startswith("/api/jobs/"):
                with self.server.job_lock:
                    if self.path.rsplit("/", 1)[-1] != latest.get("id"):
                        return self.json(404, {"error": "任务不存在"})
                    response = {key: value for key, value in latest.items() if key != "future"}
                    future = latest["future"]
                    if future.done():
                        try:
                            response["result"] = future.result()
                        except subprocess.TimeoutExpired:
                            response["error"] = "运行超时"
                        except Exception:
                            response["error"] = "无法执行任务，请检查本地 Python 和 Docker"
                return self.json(200, response)
            self.json(404, {"error": "页面不存在"})

        def do_POST(self):
            if (not self.allowed_host()
                    or self.headers.get("Origin") != f"http://{self.headers.get('Host')}"
                    or self.headers.get_content_type() != "application/json"):
                return self.json(403, {"error": "仅接受工作台发起的请求"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 16384:
                    raise ValueError
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError
                if self.path.startswith("/api/patches/"):
                    return self.update_patch(payload)
                if self.path != "/api/jobs":
                    return self.json(404, {"error": "页面不存在"})
                task = (custom_task(payload["custom"]) if isinstance(payload.get("custom"), dict)
                        else tasks[payload["task"]])
                mode = payload["mode"]
                if mode not in ("single", "multi", "team", "adaptive"):
                    raise ValueError
            except ValueError as exc:
                return self.json(400, {"error": str(exc) or "无效的任务或 Agent 模式"})
            except (OSError, KeyError, TypeError):
                return self.json(400, {"error": "无效的任务或 Agent 模式"})
            with self.server.job_lock:
                if latest and not latest["future"].done():
                    return self.json(409, {"error": "已有任务在运行"})
                job_id = uuid4().hex
                save_version(run_store / job_id / "task.json",
                             {"id": job_id, "task": task["id"], "goal": task["goal"], "mode": mode,
                              "repairs": task.get("repairs", 0)})
                latest.update(id=job_id, task=task["id"], mode=mode,
                              future=executor.submit(run_job, job_id, task, mode))
            self.json(202, {"id": job_id})

        def update_patch(self, payload):
            try:
                with self.server.job_lock:
                    if latest and not latest["future"].done():
                        return self.json(409, {"error": "请等待当前重构任务完成"})
                    with patch_lock:
                        path = version_path(store, self.path.rsplit("/", 1)[-1])
                        version = load_version(path)
                        result = patch_action(version, payload.get("action"))
                        if payload["action"] != "check":
                            save_version(path, version)
            except FileNotFoundError:
                return self.json(404, {"error": "补丁版本不存在或 Git 不可用"})
            except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
                return self.json(409, {"error": str(exc)})
            return self.json(200, result)

    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        server.job_lock = Lock()
        print(f"http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            executor.shutdown(wait=False)


if __name__ == "__main__":
    main()
