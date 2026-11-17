"use strict";

const $ = id => document.getElementById(id);
const taskSelect = $("task");
const modeSelect = $("mode");
const detail = $("detail");
const formalProperties = {
  "branch-identity": "相同输入返回同一侧",
  "slice-range": "相同输入返回同一切片范围，或都没有结果（None）"
};
const formalAgentCases = {
  "formal-agent-choice-correct": "分支提取 · 正确",
  "formal-agent-choice-boundary-error": "分支提取 · 边界错误",
  "formal-agent-slice-correct": "切片提取 · 正确",
  "formal-agent-slice-boundary-error": "切片提取 · 起点错误",
  "formal-agent-slice-unsupported": "切片提取 · 未建模写法",
  "formal-agent-slice-repair": "切片提取 · Z3 反例返工"
};
const formalOutcomes = {unsat: "建模范围内等价", sat: "找到具体反例",
  unsupported: "未能证明 · 超出支持范围", unknown: "求解未得出结论"};
const sliceResult = range => range ? `[${range.start}, ${range.end})` : "无结果";
const methodDemos = {
  "method-refactor-extract": {name: "提取方法 · 账单费用", goal: "把服务费的计算提取成 service_fee 函数，保持金额和取整规则。"},
  "method-refactor-inline": {name: "内联方法 · 参数只执行一次", goal: "在调用处展开 double 并删除旧函数，保证 next() 只执行一次。"},
  "method-refactor-move": {name: "移动方法 · 折扣计算", goal: "把折扣方法从 Order 迁到 Pricing，并更新调用，保持原来的公开接口和金额。"}
};
const methodEntries = [...document.querySelectorAll("[data-method-task]")];
const stageNames = {
  accepted: "通过", baseline: "原版验证失败", candidate: "候选验证失败",
  review: "审查未通过", expected_edit: "未满足任务要求", error: "运行错误",
  timeout: "运行超时", formal: "形式化验证未通过", proposal: "候选编辑无效",
  differential: "差分验证未通过", performance: "性能回退超限"
};
const taskNames = {
  "hard-borrowed_nth": "提取 · 保留边权重的借用",
  "hard-short_hash": "提取 · 短输入的提前返回",
  "hard-edge_back": "内联 · 迭代器只后移一次",
  "hard-bulk_hash": "内联 · 游标依次读取两个字",
  "hard-backoff_move": "移动 · 跨 crate 保留退避状态",
  "hard-queue_move": "移动 · 跨 crate 保留满队列语义",
  ...formalAgentCases,
  ...Object.fromEntries(Object.entries(methodDemos).map(([id, demo]) => [id, demo.name])),
  "z3-loop-demo": "Z3 反例修订演示",
  custom: "自定义 Rust 仓库",
  "local-extract-good": "局部函数提取 · 正确补丁",
  "local-extract-bad": "局部函数提取 · 算术偏差",
  "crossbeam-adaptive": "Crossbeam · 无界接收退避",
  "formal-choice": "借用分支提取 · SMT 与差分",
  "list-recv-good": "Crossbeam · 无界接收退避",
  "differential-correct": "差分验证 · 正确提取",
  "differential-boundary-error": "差分验证 · 边界错误",
  "performance-optimized": "性能门禁 · 消除 Vec 复制",
  "performance-regression": "性能门禁 · 冗余遍历",
  "crossbeam-expert-team": "Crossbeam · 无界接收退避",
  "clone-vec": "消除 Vec 复制", "clone-string": "消除 String 复制",
  "cross-slice": "跨文件切片借用", "cross-text": "跨文件字符串借用",
  "extract-prefix": "提取前缀处理函数", "extract-choice": "提取借用分支函数",
  "upstream-hash-short-input": "rustc-hash · 提取短输入处理",
  "upstream-threadpool-barrier": "scoped-threadpool · 提取屏障等待",
  "correct": "固定正确补丁", "boundary-error": "固定边界错误补丁",
  "repair-single": "反例修订 · 单 Agent", "repair-multi": "反例修订 · 多 Agent",
  "crossbeam-backoff": "Crossbeam · 跨 crate 退避逻辑",
  "smt-good": "SMT · 正确补丁", "smt-bad": "SMT · 边界错误",
  "borrow-good": "跨文件借用 · 正确补丁", "borrow-bad": "跨文件借用 · 切片范围错误",
  "barrier-good": "线程池屏障 · 正确补丁", "barrier-bad": "线程池屏障 · 提前返回"
};
const modeName = mode => ({team: "多专家协作", adaptive: "按需协作", multi: "提案与专项审查", single: "单 Agent",
  offline: "固定补丁", reference: "参考补丁复验"}[mode] ?? mode);
const roleName = role => ({lifetime: "生命周期", concurrency: "并发", performance: "性能"}[role] ?? role);
let data = {tasks: [], runs: []};
let active;
let view = "patch";
let fileIndex = 0;
let busy = false;

function node(tag, content, className) {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  if (className) element.className = className;
  return element;
}

function appendFormalEvidence(box, proof) {
  box.append(node("p", formalOutcomes[proof.status] ?? proof.status));
  const specification = proof.specification;
  if (specification) {
    box.append(node("p", formalProperties[specification.property] ?? specification.property));
    if (specification.reason) box.append(node("p", specification.reason));
  }
  if (proof.contract) {
    box.append(node("p", `${proof.contract} · ${proof.usize_bits} 位 usize · ${proof.solver}`));
  }
  if (proof.expressions) {
    box.append(node("pre", `原版 ${proof.expressions.baseline}\n候选 ${proof.expressions.candidate}`));
  }
  const witness = proof.counterexample;
  if (witness?.input_len !== undefined) {
    box.append(node("p", `输入长度 ${witness.input_len} · 起点 ${witness.start} · 终点 ${witness.end}`),
      node("p", `原版返回 ${sliceResult(witness.baseline_return)}，候选返回 ${sliceResult(witness.candidate_return)}`));
  } else if (witness?.left_len !== undefined) {
    const side = value => ({left: "左边", right: "右边"})[value] ?? value;
    box.append(node("p", `左边长度 ${witness.left_len} · 阈值 ${witness.threshold}`),
      node("p", `原版返回${side(witness.baseline_return)}，候选返回${side(witness.candidate_return)}`));
  }
  if (proof.reason) box.append(node("p", proof.reason));
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

function showPage(evaluation) {
  stopStoryPlayback();
  $("work").hidden = evaluation;
  $("evaluation").hidden = !evaluation;
  $("patches").hidden = true;
  $("process").hidden = true;
  $("work-tab").setAttribute("aria-pressed", String(!evaluation));
  $("eval-tab").setAttribute("aria-pressed", String(evaluation));
  $("patch-tab").setAttribute("aria-pressed", "false");
  $("process-tab").setAttribute("aria-pressed", "false");
}

const patchStates = {ready: "待应用", applied: "已应用", rolled_back: "已回滚", changed: "仓库版本已变化"};
let patchVersion;
let patchRequest = 0;
let patchBusy = false;

function renderPatchVersion() {
  const info = $("patch-info");
  info.replaceChildren();
  const version = patchVersion?.version;
  const state = patchVersion?.state;
  const ready = state === "ready" || state === "rolled_back";
  $("patch-check").disabled = patchBusy || !ready;
  $("patch-apply").disabled = patchBusy || !ready;
  $("patch-rollback").disabled = patchBusy || state !== "applied";
  $("patch-evidence").disabled = patchBusy || !version;
  if (!version) return;
  info.append(node("p", `${patchStates[state]} · ${version.goal}`),
    node("p", version.root), node("p", Object.keys(version.files).join(" · ")));
  if (version.base_commit) info.append(node("p", `Git 基准 ${version.base_commit.slice(0, 12)}`));
  for (const event of version.events) {
    info.append(node("p", `${event.action === "apply" ? "应用" : "回滚"} · ${new Date(event.at).toLocaleString()}`));
  }
}

async function loadPatchVersion() {
  const request = ++patchRequest;
  const id = $("patch-list").value;
  patchVersion = undefined;
  renderPatchVersion();
  if (!id) return;
  try {
    const result = await api(`/api/patches/${id}`);
    if (request !== patchRequest) return;
    patchVersion = result;
    renderPatchVersion();
  } catch (error) {
    if (request === patchRequest) $("patch-status").textContent = error.message;
  }
}

async function showPatches(id) {
  stopStoryPlayback();
  $("work").hidden = $("evaluation").hidden = true;
  $("patches").hidden = false;
  $("process").hidden = true;
  $("work-tab").setAttribute("aria-pressed", "false");
  $("eval-tab").setAttribute("aria-pressed", "false");
  $("patch-tab").setAttribute("aria-pressed", "true");
  $("process-tab").setAttribute("aria-pressed", "false");
  $("patch-status").textContent = "";
  try {
    const versions = await api("/api/patches");
    const list = $("patch-list");
    list.replaceChildren(...versions.map(version => {
      const option = node("option", `${new Date(version.created_at).toLocaleString()} · ${version.goal}`);
      option.value = version.id;
      return option;
    }));
    if (id && versions.some(version => version.id === id)) list.value = id;
    if (!versions.length) $("patch-status").textContent = "暂无已保存的补丁版本";
    await loadPatchVersion();
  } catch (error) {
    $("patch-status").textContent = error.message;
  }
}

async function runPatchAction(action) {
  if (patchBusy || !patchVersion) return;
  patchBusy = $("patch-list").disabled = true;
  renderPatchVersion();
  try {
    await api(`/api/patches/${$("patch-list").value}`, {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({action})
    });
    $("patch-status").textContent = {check: "源码快照匹配，Git 应用检查通过",
      apply: "已应用到所示仓库", rollback: "已恢复补丁前的文件内容"}[action];
  } catch (error) {
    $("patch-status").textContent = error.message;
  } finally {
    patchBusy = $("patch-list").disabled = false;
    await loadPatchVersion();
  }
}

function showRun(row, preferredView) {
  active = row;
  fileIndex = 0;
  view = row?.mode === "adaptive" && row.report?.attempts?.length ? "collaboration" :
    row?.report?.differential ? "differential" : row?.report?.benchmark?.max_regression_percent !== undefined ? "bench" :
    row?.report?.collaboration ? "collaboration" : row?.report?.formal ? "formal" : row?.stage === "review" ? "reviews" :
    ["baseline", "candidate", "error", "timeout"].includes(row?.stage) ? "checks" : "patch";
  if (preferredView) view = preferredView;
  render();
}

function render() {
  const report = active?.report ?? {};
  $("result-title").textContent = active ? stageNames[active.stage] : "补丁审查";
  $("result-source").textContent = active ? [
    taskNames[active.task] ?? active.task,
    active.trial ? `历史记录 · 第 ${active.trial} 轮` : "本次运行",
    modeName(active.mode),
    Number.isFinite(active.elapsed_seconds) ? `${active.elapsed_seconds.toFixed(2)} 秒` : ""
  ].filter(Boolean).join(" · ") : "";
  $("export").disabled = active?.stage !== "accepted" || !report.patch;
  $("manage-patch").hidden = !active?.patch_version;
  for (const button of $("details").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }

  const checks = [...(report.baseline_checks ?? []), ...(report.checks ?? [])];
  const reviews = report.reviews ?? [];
  const states = [
    report.candidate_sha256 || reviews.length ? "ok" : "",
    reviews.length ? (reviews.every(review => review.decision === "approve") ? "ok" : "fail") : "",
    checks.length ? (checks.every(check => check.ok) ? "ok" : "fail") : "",
    active ? (active.stage === "accepted" ? "ok" : "fail") : ""
  ];
  const labels = [active?.mode === "team" ? "任务拆分与专家提案" : "生成提案",
    active?.mode === "single" ? "单 Agent · 无独立审查" : "专项审查",
    "Docker 验证", "补丁验收"];
  if (report.formal) {
    labels.splice(-1, 0, "Z3 形式化验证");
    states.splice(-1, 0, report.formal.status === "unsat" ? "ok" : "fail");
  }
  $("steps").replaceChildren(...labels.map((label, index) =>
    node("li", (states[index] === "ok" ? "✓  " : states[index] === "fail" ? "×  " : "○  ") + label, states[index])));

  detail.replaceChildren();
  if (view === "patch") renderPatch(report.patch);
  if (view === "collaboration" && active?.mode === "adaptive") {
    for (const attempt of report.attempts ?? []) {
      const section = node("details", undefined, "log");
      section.open = true;
      section.append(node("summary", `第 ${attempt.attempt} 次候选 · ${attempt.accepted ? "通过" : "未通过"}`));
      const plan = attempt.expert_plan ?? [];
      if (!plan.length) section.append(node("p", "未命中专家条件，直接验证"));
      for (const step of plan) {
        const review = attempt.reviews?.find(item => item.role === step.role);
        const signals = step.reasons.map(reason => reason.signal).join("、");
        section.append(node("p", `${roleName(step.role)}专家 · 选择依据 ${signals}`),
          node("p", step.constraint));
        if (step.depends_on.length) section.append(node("p", `参考前序审查 ${step.depends_on.map(roleName).join("、")}`));
        if (review) section.append(node("p", `${review.decision === "approve" ? "通过" : "拒绝"} · ${review.reason}`));
      }
      if (attempt.repair_owner) section.append(node("p", `修订负责 ${attempt.repair_owner === "proposer" ?
        "提案 Agent" : roleName(attempt.repair_owner) + "专家"}`));
      detail.append(section);
    }
  }
  if (view === "collaboration" && report.collaboration) {
    const team = report.collaboration;
    const outcomes = team.outcomes ?? [];
    if (Array.isArray(team.plan?.steps)) {
      for (const step of team.plan.steps) {
        const result = outcomes.find(item => item.role === step.role);
        const section = node("details", undefined, "log");
        section.open = true;
        section.append(node("summary", `${roleName(step.role)}专家 · ${result?.edits?.length ?? 0} 项编辑`),
          node("p", step.goal));
        if (step.depends_on?.length) section.append(node("p", `依赖 ${step.depends_on.map(roleName).join("、")}`));
        if (Array.isArray(step.files) && step.files.length) section.append(node("p", step.files.join(" · ")));
        if (result?.reason) section.append(node("p", result.reason));
        detail.append(section);
      }
    }
    if (team.merge) detail.append(node("p", team.merge.method === "reconciled" ?
      `已协调编辑 · ${team.merge.reason}` : "已合并互不重叠的编辑"));
    for (const conflict of team.conflicts ?? []) {
      detail.append(node("p", `${roleName(conflict.role)} · ${conflict.path} · ${conflict.reason}`));
    }
    if (report.proposal_error) detail.append(node("p", report.proposal_error));
  }
  if (view === "reviews") {
    for (const review of reviews) detail.append(node("p", `${review.decision === "approve" ? "通过" : "拒绝"} · ${review.reason ?? ""}`));
  }
  if (view === "checks") {
    for (const [label, group] of [["原版", report.baseline_checks], ["候选", report.checks]]) {
      for (const check of group ?? []) {
        const log = node("details", undefined, "log");
        log.open = !check.ok;
        log.append(node("summary", `${check.ok ? "✓" : "×"} ${label} · cargo ${check.command.join(" ")}`),
          node("pre", check.output));
        detail.append(log);
      }
    }
    if (active?.stderr) detail.append(node("pre", active.stderr));
  }
  if (view === "bench" && report.benchmark) {
    const benchmark = report.benchmark;
    detail.append(node("p", benchmark.behavior_matches ? "重构前后校验和一致" : "校验和存在差异"));
    if (benchmark.max_regression_percent !== undefined) {
      const failures = benchmark.regressions ?? [];
      detail.append(node("p", `最大允许回退 ${benchmark.max_regression_percent}% · ${failures.length ?
        `超限输入 ${failures.map(size => size + " B").join("、")}` : "各输入规模均未超限"}`));
    }
    const table = node("table");
    const heading = node("tr");
    for (const label of ["输入大小", "原版中位数", "候选中位数", "加速比"]) heading.append(node("th", label));
    table.append(heading);
    for (const row of benchmark.comparisons) {
      const line = node("tr");
      for (const value of [`${row.bytes} B`, `${row.baseline_median_ns} ns`,
        `${row.candidate_median_ns} ns`, `${row.speedup.toFixed(2)}×`]) line.append(node("td", value));
      table.append(line);
    }
    detail.append(table);
  }
  if (view === "differential" && report.differential) {
    const result = report.differential;
    detail.append(node("p", result.reason ??
      `种子 ${result.seed} · ${result.cases} 组输入 · ${result.mismatch_count} 处行为差异`));
    for (const mismatch of result.mismatches ?? []) {
      detail.append(node("pre", JSON.stringify(mismatch, null, 2)));
    }
  }
  if (view === "formal") {
    for (const attempt of report.attempts ?? []) {
      const proof = attempt.formal;
      const section = node("details", undefined, "log");
      section.open = true;
      section.append(node("summary", `第 ${attempt.attempt} 版 · ${formalOutcomes[proof?.status] ?? "未运行 SMT"}`));
      if (proof) appendFormalEvidence(section, proof);
      for (const review of attempt.reviews ?? []) {
        section.append(node("p", `${review.decision} · ${review.reason}`));
      }
      if (attempt.proposal_error) section.append(node("p", attempt.proposal_error));
      const edits = node("details", undefined, "log");
      edits.append(node("summary", "候选编辑"), node("pre", JSON.stringify(attempt.proposal.edits, null, 2)));
      section.append(edits);
      detail.append(section);
    }
    if (report.semantic) {
      const semantics = node("details", undefined, "log");
      semantics.append(node("summary", "共享 AST 和 MIR"),
        node("pre", JSON.stringify(report.semantic.syntax, null, 2)),
        node("pre", report.semantic.mir));
      detail.append(semantics);
    }
  }
  if (!detail.childElementCount) detail.append(node("p", "这次运行没有此项记录。", "empty"));
}

function patchComparison(patch = "") {
  const lines = patch.split(/\r?\n/);
  const files = [];
  let file, hunk, beforeLine, afterLine, beforeLeft = 0, afterLeft = 0;
  let removed = [], added = [];

  function flush() {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      const before = removed[i] ?? null;
      const after = added[i] ?? null;
      if (before && after) {
        after.kind = "edit";
        if (removed.length === added.length) before.kind = "edit";
      }
      hunk.rows.push({before, after});
    }
    removed = [];
    added = [];
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!beforeLeft && !afterLeft && line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      flush();
      const oldPath = line.slice(4).split("\t")[0];
      const newPath = lines[++index].slice(4).split("\t")[0];
      const path = newPath === "/dev/null" ? oldPath : newPath;
      file = {path: path.replace(/^[ab]\//, "").replace(/ \(revised\)$/, ""), hunks: []};
      files.push(file);
      hunk = undefined;
      continue;
    }
    const range = file && /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (range) {
      flush();
      hunk = {rows: []};
      file.hunks.push(hunk);
      [beforeLine, beforeLeft, afterLine, afterLeft] = range.slice(1).map(value => Number(value ?? 1));
    } else if (hunk && (beforeLeft || afterLeft)) {
      const text = line.slice(1);
      if (line.startsWith("-") && beforeLeft > 0) {
        removed.push({text, number: beforeLine++, kind: "del"});
        beforeLeft--;
      } else if (line.startsWith("+") && afterLeft > 0) {
        added.push({text, number: afterLine++, kind: "add"});
        afterLeft--;
      } else if (line.startsWith(" ") && beforeLeft > 0 && afterLeft > 0) {
        flush();
        hunk.rows.push({before: {text, number: beforeLine++, kind: "context"},
                        after: {text, number: afterLine++, kind: "context"}});
        beforeLeft--;
        afterLeft--;
      }
    }
  }
  flush();
  return files.filter(item => item.hunks.some(part => part.rows.length));
}

function renderPatch(patch, {container = detail, task = active?.task, beforeTitle = "重构前",
                             afterTitle = "重构后", fragment = false, files = patchComparison(patch)} = {}) {
  if (!patch) return;
  const raw = node("details", undefined, "log diff-raw");
  raw.append(node("summary", fragment ? "查看提案片段差异" : "查看原始 diff"), node("pre", patch));
  if (!files.length) {
    raw.open = true;
    container.append(raw);
    return;
  }

  const list = node("div", undefined, "files");
  const layout = node("div", undefined, "diff-layout");
  function showFile(selectedIndex) {
    list.replaceChildren();
    files.forEach((file, index) => {
      const button = node("button", file.path);
      button.setAttribute("aria-pressed", String(index === selectedIndex));
      button.onclick = () => {
        if (container === detail) fileIndex = index;
        showFile(index);
      };
      list.append(button);
    });
    const selected = files[selectedIndex] ?? files[0];
    const comparison = node("div", undefined, "diff-comparison");
    comparison.append(node("p", "− 删除　 ~ 改动　 + 新增 · " +
      (fragment ? "仅显示提案中的代码片段" : "仅显示补丁涉及的代码片段"), "diff-note"));
    const rem17 = task === "rem-17" && beforeTitle === "重构前" &&
      selected.path === "git-config/src/file/resolve_includes.rs";
    for (const {rows} of selected.hunks) {
      const pair = node("div", undefined, "diff-pair");
      const hasCall = rows.some(row => row.after?.kind !== "context" &&
        row.after?.text.includes("include_paths.extend(extract_include_path("));
      const hasHelper = rows.some(row => row.after?.kind === "add" &&
        row.after.text.startsWith("fn extract_include_path"));
      for (const [side, title] of [["before", beforeTitle], ["after", afterTitle]]) {
        const panel = node("section", undefined, "diff-side");
        panel.setAttribute("aria-label", title);
        panel.append(node("h3", title));
        if (rem17 && hasCall) {
          panel.append(node("p", side === "before" ? "原函数查找配置段并收集路径。" :
            "原函数调用新函数，再把返回的路径追加到总列表。", "diff-note"));
        } else if (rem17 && hasHelper) {
          panel.append(node("p", side === "before" ? "这里原先没有独立的路径提取函数。" :
            "新增函数查找配置段，找到就返回路径，找不到就返回空列表。", "diff-note"));
        }
        const code = node("pre");
        for (const row of rows) {
          const line = row[side];
          const mark = line && ({add: "+", del: "−", edit: "~", context: " "})[line.kind];
          const number = line && !fragment ? String(line.number).padStart(4) + " " : "";
          const text = line ? `${number}${mark} ${line.text}` : " ";
          code.append(node("span", text, `diff-row ${line?.kind ?? "diff-gap"}`));
        }
        panel.append(code);
        pair.append(panel);
      }
      comparison.append(pair);
    }
    layout.replaceChildren(list, comparison);
  }
  showFile(container === detail ? fileIndex : 0);
  container.append(layout, raw);
}

function selectHistory() {
  $("custom-fields").hidden = taskSelect.value !== "custom";
  $("review-domain").closest("label").hidden = !["multi", "team"].includes(modeSelect.value);
  const task = data.tasks.find(task => task.id === taskSelect.value);
  const method = methodDemos[task?.id];
  for (const entry of methodEntries) {
    entry.setAttribute("aria-pressed", String(entry.dataset.methodTask === taskSelect.value));
  }
  const formal = task?.formal === "agent";
  $("goal").textContent = formal ?
    "载入样例补丁，运行 Docker 测试，然后由验证 Agent 选择规约并调用 Z3。" +
      (task.repairs ? "如果找到反例，DeepSeek 会根据反例修订一次。" : "") :
    method?.goal ?? task?.goal ?? "";
  $("run").textContent = formal ? "运行验证 Agent" : "运行重构";
  $("status").textContent = "";
  showRun(data.runs.findLast(row => row.task === taskSelect.value && row.mode === modeSelect.value));
}

function renderEvaluation() {
  $("metrics").replaceChildren();
  $("rows").replaceChildren();
  const dataset = $("dataset").value;
  if (data.report_errors?.[dataset]) {
    $("metrics").append(node("p", data.report_errors[dataset], "empty"));
    return;
  }
  const rows = data[dataset] ?? [];
  const hardReview = dataset === "hard_review_audit";
  const methodComparison = ["method_comparison", "inline_iterator", "adaptive_methods", "adaptive_holdout", "hard_cases"].includes(dataset);
  const modes = ({
    expert_team: ["team"], rem_expanded: ["team"], method_comparison: ["single", "team"],
    inline_iterator: ["single", "team"], adaptive_methods: ["single", "team", "adaptive"],
    adaptive_holdout: ["single", "team", "adaptive"],
    hard_cases: ["single", "team", "adaptive"],
    hard_review_audit: ["single", "multi", "adaptive", "team"],
    release: ["reference", "single", "multi", "team"],
    adaptive: ["single", "multi", "adaptive"], adaptive_crossbeam: ["adaptive"]
  })[dataset] ?? ["single", "multi"];
  for (const mode of ["formal", "validation"].includes(dataset) ? [] : modes) {
    const runs = rows.filter(row => row.mode === mode);
    const accepted = runs.filter(row => row.stage === "accepted").length;
    const times = runs.map(row => row.elapsed_seconds).filter(Number.isFinite).sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    const median = times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
    const recorded = runs.filter(row => Number.isFinite(row.report?.model_calls) ||
      row.report?.candidate_sha256 || row.report?.reviews?.length);
    const calls = recorded.reduce((sum, row) => sum + (row.report.model_calls ?? (1 + (row.report.reviews?.length ?? 0))), 0);
    const card = node("div", undefined, "panel metric");
    const good = runs.filter(row => row.seed_valid === true);
    const headline = hardReview ? `${good.filter(row => row.stage === "accepted").length} / ${good.length} 正确补丁通过` :
      `${accepted} / ${runs.length} 通过`;
    card.append(node("h2", modeName(mode)), node("strong", headline),
      node("p", `耗时中位数 ${Number.isFinite(median) ? median.toFixed(2) + " 秒" : "—"} · 已记录模型调用 ${calls} 次`));
    if (methodComparison) {
      const first = runs.filter(row => row.stage === "accepted" && row.report?.attempts?.length === 1).length;
      card.append(node("p", `首次通过 ${first} · 返修后通过 ${accepted - first} · 其他结果 ${runs.length - accepted}`));
    }
    const breakdown = data[`${dataset}_summary`]?.[mode];
    if (breakdown) {
      const duration = value => Number.isFinite(value) ? `${value.toFixed(1)} 秒` : "—";
      card.append(node("p", `阶段用时中位数 · 模型 ${duration(breakdown.median_model_seconds)} · Docker ${duration(breakdown.median_docker_seconds)}`));
    }
    const ablation = data[`${dataset}_metrics`]?.[mode];
    const release = dataset === "release" ? data.release_summary?.[mode] : undefined;
    if (release) card.append(node("p", `模型 ${release.model_seconds.toFixed(1)} 秒 · Docker 验证 ${release.docker_seconds.toFixed(1)} 秒`));
    if (ablation) {
      card.append(node("p", `提前拦截 ${ablation.early_rejected_bad}/${ablation.bad_seeds} · 误拒 ${ablation.false_rejected_good}/${ablation.good_seeds}`),
        node("p", `错误种子最终通过 ${ablation.bad_seed_final_accepts}/${ablation.bad_seeds} · Docker 调用 ${ablation.docker_runs} 次`));
      if (dataset === "workspace_ablation") {
        card.append(node("p", `模型审查 ${ablation.review_seconds.toFixed(1)} 秒 · Docker 验证 ${ablation.docker_seconds.toFixed(1)} 秒`));
      }
      if (hardReview) {
        const total = times.reduce((sum, seconds) => sum + seconds, 0);
        card.append(node("p", `总耗时 ${total.toFixed(1)} 秒 · 审查 ${ablation.review_seconds.toFixed(1)} 秒 · Docker ${ablation.docker_seconds.toFixed(1)} 秒`));
      }
    }
    $("metrics").append(card);
  }
  if (dataset === "release" && data.release_human_baseline?.status === "not_collected") {
    $("metrics").append(node("p", "人工基线待采集。参考补丁仅记录验证时间。", "empty"));
  }
  if (dataset === "hard_cases") {
    const first = rows.find(row => row.task === "hard-borrowed_nth" && row.stage === "accepted" &&
      row.report?.attempts?.length === 1);
    const repaired = data.hard_seed?.find(row => row.stage === "accepted" && row.report?.attempts?.length > 1);
    for (const [row, label] of [[first, "播放首次通过"], [repaired, "播放拦截和返修"]]) {
      if (row?.process_id) {
        const button = node("button", label);
        button.onclick = () => openProcess(row.process_id);
        $("metrics").append(button);
      }
    }
  }
  if (hardReview) {
    const stopped = rows.find(row => row.seed_valid === false && row.stage === "review" &&
      row.report?.attempts?.[0]?.reviews?.some(review => review.decision === "reject"));
    const direct = stopped && rows.find(row => row.task === stopped.task && row.mode === "single" &&
      row.stage === "candidate");
    if (stopped && direct) {
      for (const [row, title] of [[direct, "播放 Docker 拦截"], [stopped, "播放专家提前拦截"]]) {
        const button = node("button", title);
        button.onclick = () => openProcess(row.process_id);
        $("metrics").append(button);
      }
    }
  }
  for (const row of rows) {
    const tr = node("tr");
    let outcome = stageNames[row.stage];
    if (dataset === "rem_expanded" || methodComparison) {
      outcome = row.stage === "accepted" ? ((row.report?.attempts?.length ?? 0) > 1 ? "返修后通过" : "首次通过") :
        ({baseline: "原版基线阻塞", pending: "待完成", error: "执行错误", timeout: "执行超时"})[row.stage] ??
        "候选未通过";
    }
    if (hardReview) {
      outcome = ({accepted: "测试通过", review: "专家提前拒绝", candidate: "Docker 拒绝"})[row.stage] ?? outcome;
    }
    const title = hardReview ? `${taskNames[row.task.replace(/-(correct|wrong)$/, "")] ?? row.task} · ${row.seed_valid ? "正确补丁" : "错误补丁"}` :
      taskNames[row.task] ?? row.task;
    for (const value of [title, row.trial ?? "—", modeName(row.mode),
      outcome, Number.isFinite(row.elapsed_seconds) ? `${row.elapsed_seconds.toFixed(2)} 秒` : "—"]) {
      tr.append(node("td", value));
    }
    const cell = node("td");
    const button = node("button", "查看");
    button.disabled = row.stage === "pending";
    button.onclick = () => {
      if ((dataset === "rem_expanded" || methodComparison || hardReview) && row.process_id) {
        openProcess(row.process_id);
        return;
      }
      if (dataset === "rem_expanded" && row.log && !row.report) {
        $("metrics").append(node("p", "基线日志 · " + row.log));
        return;
      }
      if (data.tasks.some(task => task.id === row.task)) {
        taskSelect.value = row.task;
        modeSelect.value = row.mode;
        selectHistory();
      }
      showRun(row);
      showPage(false);
    };
    cell.append(button);
    tr.append(cell);
    $("rows").append(tr);
  }
}

$("work-tab").onclick = () => showPage(false);
$("eval-tab").onclick = () => showPage(true);
$("patch-tab").onclick = () => showPatches();
$("manage-patch").onclick = () => showPatches(active.patch_version);
$("patch-list").onchange = () => {
  $("patch-status").textContent = "";
  loadPatchVersion();
};
$("patch-check").onclick = () => runPatchAction("check");
$("patch-apply").onclick = () => runPatchAction("apply");
$("patch-rollback").onclick = () => runPatchAction("rollback");
$("patch-evidence").onclick = () => {
  showRun({...patchVersion.version.row, patch_version: $("patch-list").value});
  showPage(false);
};
$("dataset").onchange = renderEvaluation;
taskSelect.onchange = () => {
  if (data.tasks.some(task => task.id === taskSelect.value && task.formal === "agent")) {
    modeSelect.value = "single";
  }
  selectHistory();
};
modeSelect.onchange = selectHistory;
for (const entry of methodEntries) {
  entry.onclick = () => {
    if (busy) return;
    taskSelect.value = entry.dataset.methodTask;
    taskSelect.onchange();
    $("run").focus();
  };
}
$("details").onclick = event => {
  if (event.target.dataset.view) {
    view = event.target.dataset.view;
    render();
  }
};
$("export").onclick = () => {
  const url = URL.createObjectURL(new Blob([active.report.patch], {type: "text/x-diff"}));
  const link = node("a");
  link.href = url;
  link.download = `${active.task}-${active.mode}.patch`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("run-form").onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const request = {task: taskSelect.value, mode: modeSelect.value};
  if (request.task === "custom") {
    request.custom = {
      crate: $("crate-path").value.trim(),
      files: $("source-paths").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
      goal: $("custom-goal").value.trim(),
      packages: $("package-names").value.split(",").map(value => value.trim()).filter(Boolean),
      domain: $("review-domain").value,
      differential: $("run-differential").checked,
      max_regression_percent: $("max-regression").value === "" ? null : $("max-regression").valueAsNumber
    };
  }
  busy = taskSelect.disabled = modeSelect.disabled = $("custom-fields").disabled = $("run").disabled = true;
  methodEntries.forEach(entry => { entry.disabled = true; });
  showRun(undefined);
  $("status").textContent = "正在运行。可在 Agent 运行过程查看各阶段。";
  try {
    const {id} = await api("/api/jobs", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(request)
    });
    openProcess(id);
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const job = await api(`/api/jobs/${id}`);
      if (job.error) throw new Error(job.error);
      if (job.result) {
        $("status").textContent = job.result.patch_version_error ??
          `运行结束 · ${stageNames[job.result.stage]}`;
        showRun(job.result);
        break;
      }
    }
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
    busy = taskSelect.disabled = modeSelect.disabled = $("custom-fields").disabled = $("run").disabled = false;
    methodEntries.forEach(entry => { entry.disabled = !data.tasks.some(task => task.id === entry.dataset.methodTask); });
  }
};

api("/api/data").then(result => {
  data = result;
  const formal = node("optgroup");
  formal.label = "验证 Agent · Z3";
  for (const task of data.tasks) {
    const option = node("option", taskNames[task.id] ?? task.id);
    option.value = task.id;
    (task.formal === "agent" ? formal : taskSelect).append(option);
  }
  if (formal.childElementCount) taskSelect.append(formal);
  methodEntries.forEach(entry => { entry.disabled = !data.tasks.some(task => task.id === entry.dataset.methodTask); });
  taskSelect.value = location.hash === "#formal-agent" &&
    data.tasks.some(task => task.id === "formal-agent-slice-repair") ?
    "formal-agent-slice-repair" : location.hash === "#method-refactors" &&
    data.tasks.some(task => task.id === "method-refactor-extract") ? "method-refactor-extract" : "cross-slice";
  taskSelect.onchange();
  if (location.hash === "#hard-cases" || location.hash === "#hard-review") {
    $("dataset").value = location.hash === "#hard-review" ? "hard_review_audit" : "hard_cases";
    showPage(true);
  }
  renderEvaluation();
  $("run").disabled = false;
}).catch(error => { $("status").textContent = error.message; });
