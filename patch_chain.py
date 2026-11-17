"""Persist verified patch versions and apply them only to matching files."""
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess


def git(root, *args, patch=None):
    return subprocess.run(["git", "-c", "core.autocrlf=false", "-c", "core.eol=lf", *args], cwd=root,
                          input=patch.encode("utf-8") if patch is not None else None,
                          capture_output=True, timeout=30)


def checkout_commit(root):
    result = git(root, "rev-parse", "--verify", "HEAD")
    return result.stdout.decode("ascii").strip() if result.returncode == 0 else None


def source_path(root, name):
    path = root / name
    if not path.is_relative_to(root) or path.resolve() != path or not path.is_file():
        raise ValueError(f"源文件已不存在或路径已改变：{name}")
    return path


def prepare_version(root, row, editable, *, base_commit=None):
    report = row["report"]
    patch = report["patch"]
    files = report.get("file_versions", {})
    if (row["stage"] != "accepted" or not report["accepted"] or not files
            or not set(files).issubset(editable)
            or sha256(patch.encode()).hexdigest() != report["candidate_sha256"]):
        raise ValueError("补丁缺少完整的验收或文件版本记录")
    result = git(root, "apply", "--no-index", "--numstat", "-z", patch=patch)
    paths = {line.split(b"\t", 2)[-1].decode("utf-8")
             for line in result.stdout.split(b"\0") if line}
    if result.returncode or paths != set(files):
        raise ValueError("Git 识别的补丁范围与验证记录不一致")
    return {"root": str(root), "base_commit": base_commit, "editable": editable,
            "created_at": now(), "files": files, "row": row, "events": []}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def version_state(version):
    root = Path(version["root"])
    try:
        if checkout_commit(root) != version["base_commit"]:
            return "changed"
        current = {name: sha256(source_path(root, name).read_bytes()).hexdigest()
                   for name in version["files"]}
    except (ValueError, OSError, subprocess.TimeoutExpired):
        return "changed"
    if all(current[name] == expected["after"] for name, expected in version["files"].items()):
        return "applied"
    if all(current[name] == expected["before"] for name, expected in version["files"].items()):
        return "rolled_back" if version["events"] and version["events"][-1]["action"] == "rollback" else "ready"
    return "changed"


def patch_action(version, action):
    if action not in ("check", "apply", "rollback"):
        raise ValueError("未知的补丁操作")
    state = version_state(version)
    reverse = action == "rollback"
    if (reverse and state != "applied") or (not reverse and state not in ("ready", "rolled_back")):
        raise ValueError("当前文件版本不匹配。为保留后续修改，已停止操作。")
    root = Path(version["root"])
    report = version["row"]["report"]
    if not reverse and (expected := report.get("base_sources_sha256")):
        sources = {name: source_path(root, name).read_bytes().decode("utf-8")
                   for name in version["editable"]}
        if sha256(json.dumps(sources, sort_keys=True).encode()).hexdigest() != expected:
            raise ValueError("所选源码与验证时的快照不一致")
    patch = report["patch"]
    if sha256(patch.encode()).hexdigest() != report["candidate_sha256"]:
        raise ValueError("补丁内容和验收记录不一致")
    args = ["apply", "--no-index", "--whitespace=nowarn"]
    if reverse:
        args.append("--reverse")
    checked = git(root, *args, "--check", patch=patch)
    if checked.returncode:
        raise ValueError(checked.stderr.decode("utf-8", errors="replace").strip())
    if action == "check":
        return {"state": state}
    result = git(root, *args, patch=patch)
    if result.returncode:
        raise ValueError(result.stderr.decode("utf-8", errors="replace").strip())
    version["events"].append({"action": action, "at": now()})
    expected_state = "rolled_back" if reverse else "applied"
    if version_state(version) != expected_state:
        raise ValueError("Git 操作完成，但实际文件版本与预期不一致")
    return {"state": expected_state}


def version_path(store, version_id):
    if not re.fullmatch(r"[a-f0-9]{32}", version_id):
        raise ValueError("无效的补丁版本")
    return store / f"{version_id}.json"


def save_version(path, version):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(".tmp")
    pending.write_text(json.dumps(version, ensure_ascii=False), encoding="utf-8")
    pending.replace(path)


def load_version(path):
    return json.loads(path.read_text(encoding="utf-8"))
