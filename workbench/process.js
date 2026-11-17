"use strict";

const phaseLabels = {
  task: "启动任务", model: "模型调用", candidate: "候选补丁", routing: "选择专家",
  review: "专家审查", preflight: "编译前检查", baseline: "原版 Docker 验证", validation: "候选 Docker 验证",
  "formal-plan": "验证 Agent 选择规约", formal: "Z3 等价检查", differential: "差分验证", benchmark: "性能验证",
  feedback: "分配修订", repair: "修订差异", contract: "离线行为测试", result: "运行结果"
};
const statusLabels = {started: "进行中", passed: "完成", failed: "未通过"};
const upstreamRoutingTasks = {
  "routing-hash-finish": "rustc-hash 函数提取",
  "routing-threadpool-barrier": "scoped-threadpool 线程等待",
  "routing-code-hash-finish": "rustc-hash 函数提取 · 新规则",
  "routing-code-threadpool-barrier": "scoped-threadpool 线程等待 · 新规则"
};
const upstreamRoutingTitle = task => upstreamRoutingTasks[task?.replace(/-\d+$/, "")];
const mixedReviewCases = {
  "crossbeam-review-correct-branch": {name: "正确 · 两分支", valid: true},
  "crossbeam-review-correct-early-return": {name: "正确 · 提前返回", valid: true},
  "crossbeam-review-bad-backoff": {name: "错误 · 退避返回值"},
  "crossbeam-review-bad-timeout": {name: "错误 · 超时返回值"},
  "crossbeam-review-bad-wakeup": {name: "错误 · 唤醒接收者"}
};
const mixedCheckExplanations = {
  "crossbeam-review-bad-timeout": {
    test: "expired_receive_deadline_reports_timeout",
    title: "发现超时返回值错误",
    explanation: "通道仍然连接，接收的截止时间已过。原版会返回「超时」，初始补丁却返回了「通道已断开」。",
    matchesReview: reason => /RecvTimeoutError::Disconnected/.test(reason) &&
      /RecvTimeoutError::Timeout/.test(reason)
  },
  "crossbeam-review-bad-wakeup": {
    test: "sending_wakes_a_waiting_receiver",
    title: "发现接收者可能收不到唤醒通知",
    explanation: "发送者已经放入消息，但这份补丁移除了通知等待接收者的步骤。",
    matchesReview: reason => /receivers\.notify|receiver.*wak|wak.*receiv/i.test(reason)
  }
};
let processId;
let processData;
let processEventIndex;
let processRequest = 0;
let processRepairs;
let processTask;
let storyStep;
let storyFollow = false;
let storyTimer;

function stopStoryPlayback() {
  clearTimeout(storyTimer);
  storyTimer = undefined;
}

function selectProcessView(view) {
  stopStoryPlayback();
  $("process-story").hidden = view !== "story";
  $("process-technical").hidden = view !== "technical";
  $("process-story-tab").setAttribute("aria-pressed", String(view === "story"));
  $("process-evidence-tab").setAttribute("aria-pressed", String(view === "technical"));
  if (view === "story" && processData) {
    renderProcessStory(processData.events, processData.result);
  }
}

async function openProcess(id, step) {
  const request = ++processRequest;
  $("work").hidden = $("evaluation").hidden = $("patches").hidden = true;
  $("process").hidden = false;
  for (const tab of ["work", "eval", "patch", "process"]) {
    $(tab + "-tab").setAttribute("aria-pressed", String(tab === "process"));
  }
  processData = undefined;
  processEventIndex = undefined;
  storyStep = step;
  storyFollow = false;
  selectProcessView("story");
  $("process-goal").textContent = "";
  $("process-events").replaceChildren();
  $("process-story").replaceChildren();
  $("process-evidence").replaceChildren();
  $("process-evidence-title").textContent = "阶段证据";
  $("process-evidence-time").textContent = "";
  $("process-result").disabled = true;
  $("process-status").textContent = "正在读取运行记录";
  try {
    const entries = await api("/api/process");
    if (request !== processRequest || $("process").hidden) return;
    processId = id ?? processId ?? entries[0].id;
    $("process-runs").replaceChildren(...entries.map(entry => {
      const mixed = mixedReviewCases[entry.task];
      const routingTitle = upstreamRoutingTitle(entry.task);
      const title = methodDemos[entry.task]?.name ??
        (formalAgentCases[entry.task] ? "验证 Agent · " + formalAgentCases[entry.task] :
        routingTitle ? routingTitle + (entry.repairs ? " · 同提案对照" : " · 生成提案") :
        mixed ? "Crossbeam 混合评测 · " + mixed.name :
        {"crossbeam-backoff": "Crossbeam 有界通道",
          "crossbeam-backoff-repair": "Crossbeam 有界通道返工"}[entry.task]);
      const hardName = taskNames[entry.task?.replace(/-(correct|wrong)$/, "")];
      const label = formalAgentCases[entry.task] || methodDemos[entry.task] ? title :
        entry.task?.startsWith("hard-") ? `${hardName ?? entry.task} · ${modeName(entry.mode)}` :
        entry.task === "holdout-inline-fxhasher-write-u128" ?
          `rustc-hash 内联 · ${modeName(entry.mode)} · 第 ${entry.trial} 轮` :
          title ? `${title} · ${modeName(entry.mode)} · 第 ${entry.trial} 轮` : entry.goal;
      const option = node("option", label);
      option.value = entry.id;
      return option;
    }));
    $("process-runs").value = processId;
    const selected = entries.find(entry => entry.id === processId);
    processTask = selected?.task;
    const boundaryDemo = processId === "z3-example" || selected?.task === "z3-loop-demo" ||
      selected?.goal.startsWith("Extract pick into private choose.");
    const routingTitle = upstreamRoutingTitle(processTask);
    $("process-goal").textContent = methodDemos[processTask]?.goal ?? (processTask?.startsWith("hard-") ?
      taskNames[processTask.replace(/-(correct|wrong)$/, "")] : formalAgentCases[processTask] ?
      "让验证 Agent 选择规约，检查提取函数前后的行为是否一致。" : routingTitle ?
      (processTask.includes("hash-finish") ?
        "把哈希的最后一步提取成小函数，保持原有输出。" :
        "提取等待工作线程的逻辑，保持原有顺序，即使有线程报错也要等齐所有结果。") :
      mixedReviewCases[processTask] ?
      "Crossbeam 混合评测 · " + mixedReviewCases[processTask].name + "。同一份补丁分别交给两种验收流程。" :
      processTask === "crossbeam-backoff-repair" ?
      "从同一份带错的补丁出发，找出退避逻辑的问题并修正，最多返工一次。" :
      processTask === "crossbeam-backoff" ?
      "把有界通道发送和接收时重复的等待逻辑提取到共用函数，保持超时、唤醒和消息交付行为。" :
      boundaryDemo ? "把选左边还是右边的规则拆成一个独立函数，保持选择结果一致。" : selected?.goal ?? "");
    processRepairs = selected?.repairs;
    await refreshProcess(request);
  } catch (error) {
    if (request === processRequest) $("process-status").textContent = error.message;
  }
}

async function refreshProcess(request) {
  if (request !== processRequest || $("process").hidden) return;
  try {
    const data = await api("/api/process/" + processId);
    if (request !== processRequest || $("process").hidden) return;
    if (!processData) storyFollow = !data.result;
    if (data.events.length !== processData?.events.length || Boolean(data.result) !== Boolean(processData?.result)) {
      processData = data;
      renderProcess();
    }
    if (!data.result) setTimeout(() => refreshProcess(request), 1000);
  } catch (error) {
    if (request === processRequest) $("process-status").textContent = error.message;
  }
}

function renderProcess() {
  const {events, result} = processData;
  const latest = events.at(-1);
  const selected = processEventIndex ?? events.length - 1;
  $("process-result").disabled = !result?.report;
  const status = result ?
    (result.stage === "accepted" ? "验收通过" : "运行结束 · 未通过") :
    (latest ? "正在运行 · 候选 " + latest.attempt : "正在等待执行");
  $("process-status").textContent = latest && Number.isInteger(processRepairs) && !result ?
    status + " · 剩余修订 " + Math.max(0, processRepairs - latest.attempt + 1) + " 次" : status;
  const timeline = $("process-events");
  timeline.replaceChildren();
  let attempt;
  events.forEach((event, index) => {
    if (event.attempt !== attempt) {
      attempt = event.attempt;
      timeline.append(node("h3", "候选 " + attempt));
    }
    const button = node("button", processPhase(event), "process-event");
    button.append(node("span", statusLabels[event.status] ?? event.status, "event-" + event.status));
    button.setAttribute("aria-pressed", String(index === selected));
    button.onclick = () => {
      processEventIndex = index;
      renderProcess();
    };
    timeline.append(button);
  });
  renderProcessEvidence(events[selected], events, result);
  renderProcessStory(events, result);
}

function processPhase(event) {
  const role = event.details.role;
  if (event.stage === "model") {
    const labels = {plan: "协调 Agent 拆分任务", reconcile: "协调 Agent 合并提案",
      lifetime: "生命周期专家", concurrency: "并发专家", performance: "性能专家",
      proposal: "生成提案", repair: "AI 修订", review: "审查专家", "formal-plan": "验证 Agent"};
    return labels[role] ?? phaseLabels.model;
  }
  return phaseLabels[event.stage] ?? event.stage;
}

function renderProcessStory(events, result) {
  const story = $("process-story");
  story.replaceChildren();
  const find = predicate => events.findIndex(predicate);
  const first = find(event => event.stage === "candidate" && event.status === "passed");
  const cards = [];
  const mixed = mixedReviewCases[processTask];
  const remTrial = /^rem-(16|17|40)$/.test(processTask ?? "");
  const seeded = processTask === "crossbeam-backoff-repair" || Boolean(mixed);
  const crossbeam = seeded || processTask === "crossbeam-backoff";
  const routingTrial = Boolean(upstreamRoutingTitle(processTask));
  const formalTrial = Boolean(formalAgentCases[processTask]);
  const cfgInline = processTask === "holdout-inline-fxhasher-write-u128";
  const hardCase = processTask?.startsWith("hard-");
  const auditCase = hardCase && /-(correct|wrong)$/.test(processTask);
  const hardSeed = processTask === "hard-edge_back" && first >= 0 &&
    !events.slice(0, first).some(event => event.stage === "model");

  function card(phase, title, description, index, label, handoff) {
    const section = node("section", undefined, "panel story-card");
    section.append(node("h2", title), node("p", description));
    if (index >= 0) {
      const button = node("button", label);
      button.onclick = () => {
        processEventIndex = index;
        selectProcessView("technical");
        renderProcess();
      };
      section.append(button);
    }
    if (handoff) {
      const [sender, message, recipient, feedback] = handoff;
      const flow = node("div", undefined, "story-handoff" + (feedback ? " is-feedback" : ""));
      const transfer = node("div", undefined, "story-transfer");
      const track = node("span", undefined, "story-track");
      track.setAttribute("aria-hidden", "true");
      track.append(node("span", undefined, "story-packet"));
      transfer.append(node("span", message), track);
      flow.append(node("strong", sender), transfer, node("strong", recipient));
      section.insertBefore(flow, section.children[2] ?? null);
    }
    cards.push({phase, section});
    return section;
  }

  const collaboration = result?.report?.collaboration;
  const modelStep = role => find(event => event.stage === "model" && event.status === "passed" &&
    event.details.role === role);
  const assignments = collaboration?.plan?.steps;
  if (Array.isArray(assignments) && assignments.length) {
    const index = modelStep("plan");
    const section = card("拆分任务", "协调 Agent 分配工作", "规划先确定专家的顺序和各自负责的文件。",
      index, "查看分工和依赖", ["协调 Agent", "分配子任务", "专家"]);
    const list = node("ol");
    for (const step of assignments) {
      if (step?.role) list.append(node("li", roleName(step.role) + "专家"));
    }
    section.insertBefore(list, section.querySelector("button"));
  }
  for (const outcome of collaboration?.outcomes ?? []) {
    const index = modelStep(outcome.role);
    const expert = roleName(outcome.role) + "专家";
    const paths = [...new Set(outcome.edits.map(edit => edit.path))];
    const section = card(expert, expert + (paths.length ? "提出修改" : "给出审查意见"),
      paths.length ? `建议修改 ${paths.length} 个文件，供协调 Agent 汇总。` : "该专家完成了检查，本轮提交的是意见。",
      index, "查看专家意见和修改", [expert, paths.length ? "提交修改" : "提交意见", "协调 Agent"]);
    if (paths.length) {
      const list = node("ul", undefined, "story-paths");
      for (const path of paths) list.append(node("li", path));
      section.insertBefore(list, section.querySelector("button"));
    }
  }

  if (first < 0 && !cards.length) {
    card("准备", "准备第一版修改", result ? "这次运行在生成方案前结束。技术证据里可以查看原因。" :
      "工具正在读取任务并准备第一版修改。", events.length - 1, "查看当前阶段");
    story.append(cards[0].section);
    return;
  }
  if (first >= 0) {
    const edits = events[first].details.proposal?.edits ?? [];
    const fileCount = new Set(edits.map(edit => edit.path)).size;
    const merge = collaboration?.merge?.method;
    const description = merge === "reconciled" && collaboration.conflicts?.length ?
      "专家的修改有重叠，协调 Agent 处理后提交统一的修改方案。" :
      merge === "reconciled" ? "协调 Agent 根据专家意见整理出一份修改方案。" :
      fileCount ? `第一版方案涉及 ${fileCount} 个文件，接下来交给工具检查。` :
      "工具拿到了第一版方案，接下来检查它是否符合任务要求。";
    if (auditCase) {
      card("载入补丁", "载入同一份待验收补丁",
        "四种审查模式收到的是同一份代码改动。审查结果和 Docker 测试各自有记录。",
        first, "查看待验补丁", ["固定补丁", "提交候选", "验收流程"]);
    } else if (hardSeed) {
      card("载入补丁", "载入会跳过一条边的补丁",
        "这份改动可以编译。接下来独立测试会从图的前后交替取边，核对拿到的边和剩余数量。",
        first, "查看初始补丁", ["固定补丁", "提交第一版修改", "行为测试"]);
    } else if (cfgInline && !events.slice(0, first).some(event => event.stage === "model")) {
      card("载入补丁", "载入带有编译错误的内联补丁",
        "第一版把函数调用展开成赋值语句。工具用这份固定补丁复现之前遇到的错误。",
        first, "查看初始补丁", ["固定补丁", "提交第一版修改", "编译器"]);
    } else if (formalTrial) {
      card("载入补丁", "读取待验证的补丁",
        "工具先在 Docker 里编译并运行测试，再请验证 Agent 选出要比较的性质。",
        first, "查看初始补丁");
    } else if (routingTrial && !events.some(event => event.stage === "model" && event.details.role === "proposal")) {
      card("载入同一提案", "读取 DeepSeek 生成的初始补丁",
        "直接验证、固定专家审查和按需审查使用同一份初始补丁。",
        first, "查看初始补丁", ["初始补丁", "交给当前流程", "验收流程"]);
    } else if (seeded) {
      card("载入补丁", "两种模式从同一份补丁开始",
        mixed?.valid ? "这份正确补丁已通过独立测试，用来观察专家会不会误拒。" :
        mixed ? "这份补丁带有一种已由独立测试确认的错误。" :
        "这份补丁已经提取了共用函数。实验在退避逻辑中预设了一处错误。",
        first, "查看初始补丁", ["固定补丁", "提交第一版修改", "验收流程"]);
    } else {
      card(merge ? "合并提案" : "提出修改", merge ? "汇总专家的修改" : "准备第一版修改",
        description, first, "查看第一版修改", [merge ? "协调 Agent" : "AI", "提交第一版修改", "检查工具"]);
    }
  }

  const attempts = [...new Set(events.map(event => event.attempt))];
  const failureStages = ["review", "preflight", "baseline", "validation", "formal", "differential", "benchmark", "model", "candidate"];
  for (const attempt of attempts) {
    const formatRetry = find(event => event.attempt === attempt && event.stage === "model" &&
      event.status === "failed" && event.details.will_retry_json);
    if (formatRetry >= 0) {
      const recovered = events.slice(formatRetry + 1).some(event => event.attempt === attempt &&
        event.stage === "model" && event.status === "passed" && event.details.json_retry);
      card("格式重试", recovered ? "模型重新生成了有效 JSON" : "模型输出格式错误",
        "系统只重试这一次模型调用，候选补丁的返修预算单独计算。",
        formatRetry, "查看格式错误");
    }
    if (formalTrial) {
      const planned = find(event => event.attempt === attempt && event.stage === "formal-plan" &&
        event.status === "passed");
      if (planned >= 0) {
        const property = formalProperties[events[planned].details.property];
        card(attempt === 1 ? "选择规约" : "沿用规约", "验证 Agent 确定检查范围",
          property + "。程序分别从原版和候选版提取表达式，由 Z3 比较。",
          planned, "查看规约和选择理由");
      }
      const proved = find(event => event.attempt === attempt && event.stage === "formal" &&
        event.details.status === "unsat");
      if (proved >= 0) {
        card(attempt === 1 ? "Z3 检查通过" : "Z3 复检通过",
          `Z3 未发现第 ${attempt} 版的行为差异`,
          "在这项规约和建模范围内，找不到让原版和候选版给出不同结果的输入。",
          proved, "查看两版表达式和求解结果");
      }
    }
    const routed = find(event => event.attempt === attempt && event.stage === "routing" &&
      event.status === "passed" && (routingTrial || event.details.basis));
    if (routed >= 0) {
      const plan = events[routed].details.plan;
      const fixed = events[routed].details.basis === "fixed";
      const experts = plan.map(step => roleName(step.role) + "专家").join("、");
      card(experts ? "选择专家" : "跳过专家审查", fixed ? "固定专家依次检查" :
        experts ? "按改动内容请专家审查" : "直接运行验证",
        fixed ? `按固定顺序请${experts}；发现具体问题后停止后续审查。` :
        experts ? `这版补丁命中了审查规则，由${experts}检查相关改动。` :
          "路由规则没有匹配到需要专门审查的信号，流程直接运行验收测试。",
        routed, "查看路由依据");
    }
    if (crossbeam || routingTrial) {
      const reviewed = find(event => event.attempt === attempt && event.stage === "review" &&
        event.status === "passed");
      if (reviewed >= 0) {
        card("专家审查", `审查专家同意第 ${attempt} 版进入测试`,
          "审查专家检查了代码修改，下一步由 Docker 执行编译和测试。",
          reviewed, "查看审查意见");
      }
    }
    const failure = find(event => event.attempt === attempt && event.status === "failed" &&
      failureStages.includes(event.stage) && !event.details.will_retry_json && !(formalTrial && event.stage === "model" &&
        event.details.role === "formal-plan"));
    if (crossbeam || routingTrial || hardCase || (cfgInline && attempt === 1)) {
      const checked = events.findLastIndex(event => event.attempt === attempt &&
        event.stage === "validation" && event.status !== "started");
      if (checked >= 0 && events[checked].status === "passed") {
        card("编译和测试", `第 ${attempt} 版通过编译和测试`,
          hardCase ? "Docker 编译了候选补丁，并运行这个难例的独立行为测试。" :
          cfgInline ? "Docker 编译了内联补丁，并运行 rustc-hash 的测试。" :
          routingTrial ? (processTask.includes("hash-finish") ?
            "Docker 完成编译和测试，并对比了原版与候选版的哈希输出。" :
            "Docker 完成编译和测试，包括工作线程全部完成以及线程池能否复用。") :
          mixed ? "Docker 测试检查了退避、超时、唤醒和消息交付。" :
          seeded ? "Docker 运行了退避契约测试，对比原版和修订版的返回值与等待状态。" :
            "Docker 检查了相关 Rust 包，也运行了覆盖有界通道超时、唤醒和消息交付的测试。",
          checked, "查看编译和测试日志");
      }
    }
    if (failure < 0) continue;
    const issue = events[failure];
    const cfgError = cfgInline && issue.stage === "validation" &&
      issue.details.checks?.some(check => !check.ok &&
        check.output?.includes("attributes on expressions are experimental"));
    const feedback = issue.next_attempt || events.some(event =>
      event.attempt === attempt && event.stage === "feedback");
    const sender = issue.stage === "review" ? (seeded ? "并发专家" : "审查专家") :
      formalTrial && issue.stage === "formal" ? "Z3" : "检查工具";
    const handoff = feedback ? [sender, "把问题交回 AI", "AI", true] : undefined;
    const counterexample = issue.details.counterexample;
    const checkFailed = name => issue.stage === "validation" && issue.details.checks?.some(check =>
      !check.ok && check.output.includes(name + " ... FAILED"));
    const backoffMismatch = seeded && checkFailed("matches_original_backoff_step_and_completion");
    const edgeSkip = hardSeed && checkFailed("back_advances_once_and_interleaves_with_front");
    const behavior = mixedCheckExplanations[processTask];
    const observedMismatch = attempt === 1 && behavior && (checkFailed(behavior.test) ||
      (issue.stage === "review" && behavior.matchesReview(issue.details.reason ?? "")));
    const backoffReview = seeded && issue.stage === "review" &&
      /snooze/i.test(issue.details.reason) && /false/i.test(issue.details.reason) &&
      /break|exit/i.test(issue.details.reason);
    if (counterexample) {
      const slice = counterexample.input_len !== undefined;
      const length = counterexample.left_len;
      const threshold = counterexample.threshold;
      const section = card("发现问题", slice ? `第 ${attempt} 版取错了切片` : `第 ${attempt} 版在边界情况选错了`,
        slice ? "Z3 找到了一组输入，让原版和候选版返回不同的范围或结果。" :
          `工具找到一个具体例子：左边长度是 ${length}，门槛也是 ${threshold}。同样的输入得到了不同结果。`,
        failure, "查看工具找到的例子", handoff);
      const comparison = node("div", undefined, "story-comparison");
      const choice = slice ? sliceResult : side => ({left: "选左边", right: "选右边"})[side] ?? side;
      const input = node("div", undefined, "story-input");
      const values = slice ? [["输入长度", counterexample.input_len], ["起点", counterexample.start],
        ["终点", counterexample.end]] : [["左边长度", length], ["选择门槛", threshold]];
      for (const [label, value] of values) {
        const metric = node("div", undefined, "story-metric");
        metric.append(node("span", label), node("strong", value));
        input.append(metric);
      }
      if (!slice && length === threshold) input.insertBefore(node("span", "＝", "story-equals"), input.lastElementChild);
      for (const [label, side] of [["原来的结果", counterexample.baseline_return],
                                  [`第 ${attempt} 版的结果`, counterexample.candidate_return]]) {
        const outcome = node("div", undefined, "story-outcome");
        outcome.append(node("span", label), node("strong", choice(side)));
        comparison.append(outcome);
      }
      section.insertBefore(input, section.lastElementChild);
      section.insertBefore(comparison, section.lastElementChild);
    } else if (formalTrial && issue.stage === "formal") {
      card("未能证明", issue.details.status === "unsupported" ? "这版写法超出验证范围" : "求解未能得出结论",
        "这次没有得到等价证明。打开技术证据可查看原因。", failure, "查看原因", handoff);
    } else if (mixed?.valid && attempt === 1 && issue.stage === "review") {
      card("误拒正确补丁", "专家拒绝了已通过独立测试的补丁",
        "这份初始补丁在预检中通过。专家给出了拒绝理由，工作台保留了这条意见。",
        failure, "查看审查意见", handoff);
    } else if (auditCase && issue.stage === "review") {
      card("专家提前拒绝", "专家在启动 Docker 前拒绝补丁",
        "这轮审查已给出拒绝理由。打开技术证据可核对专家引用的具体改动。",
        failure, "查看审查理由", handoff);
    } else if (auditCase && issue.stage === "validation") {
      card("Docker 拦截", "独立测试拒绝了候选补丁",
        "Docker 运行原版和候选的同一项测试。候选的结果触发断言。",
        failure, "查看失败断言", handoff);
    } else if (edgeSkip) {
      card("测试拦截", "测试发现取边时跳过了一个元素",
        "从图尾第一次取边应得到最后一条边。内联补丁推进了两次，独立测试据此拒绝了候选。",
        failure, "查看失败断言", handoff);
    } else if (issue.stage === "preflight") {
      card("编译前检查", "检查发现条件编译写法有误",
        "工具在运行 Docker 之前检查了候选补丁的 Rust 语法树，并把有问题的语句和条件交给 Agent。",
        failure, "查看检查依据", handoff);
    } else if (cfgError) {
      card("编译失败", "编译器拒绝了带条件的赋值",
        "两处赋值只应在 32 位环境参与编译。展开函数后，原来的条件标记直接压在赋值语句上，稳定版 Rust 拒绝这种写法。",
        failure, "查看编译错误", handoff);
    } else if (backoffMismatch || backoffReview) {
      card("发现问题", (backoffReview ? "并发专家" : "测试") + "发现等待循环会提前退出",
        "通道仍需等待时，原版会再等一次。第一版的共用函数返回 false，让等待循环提前退出。",
        failure, backoffReview ? "查看审查意见" : "查看失败的测试", handoff);
    } else if (observedMismatch) {
      const reviewed = issue.stage === "review";
      card("发现问题", (reviewed ? "并发专家" : "测试") + behavior.title, behavior.explanation,
        failure, reviewed ? "查看审查意见" : "查看失败的测试", handoff);
    } else {
      const explanations = {
        review: "负责审查的专家发现了一个问题，指出了修改可能改变的行为。",
        baseline: "原有版本未通过基础检查，本次无法继续比较。",
        validation: "自动检查发现这版修改没有满足测试要求。",
        formal: "工具无法确认这一版在规则所覆盖的所有输入上保持原来的行为。",
        differential: "给原版和修改版同样的输入，两边结果出现了差异。",
        benchmark: "测量结果显示修改超出了允许的性能回退范围。",
        model: "模型调用出现错误，技术证据里保留了报错。",
        candidate: "这一版修改无法正确应用到源文件。"
      };
      card("发现问题", `第 ${attempt} 轮发现问题`, explanations[issue.stage], failure, "查看问题证据", handoff);
    }
    const repair = find(event => event.attempt === attempt + 1 && event.stage === "repair");
    if (repair >= 0) {
      const diff = events[repair].details.diff ?? "";
      const fixedBoundary = counterexample?.left_len !== undefined && /^\+[^+].*>=/m.test(diff);
      const changedReturn = seeded && /^-\s*false;?\r?\n\+\s*true;?$/m.test(diff);
      const cfgBlock = (cfgError || issue.stage === "preflight") && events.some(event => event.stage === "feedback" &&
        event.attempt === attempt && event.details.guidance);
      const section = card("AI 修订", `AI 根据反馈修改第 ${attempt + 1} 版`, cfgBlock ?
        "编译反馈提示把两处赋值各自放进一个代码块，再把原有条件标记放在块上。检查工具会编译并测试修订版。" :
        edgeSkip ? "Agent 根据断言调整了内联后的取边逻辑。工具重新核对第一次取到的边和剩余数量。" :
        fixedBoundary ?
        "AI 把规则改回「达到门槛也选左边」。这样长度刚好等于门槛时，也会选左边。" :
        changedReturn ? "修订把共用函数里的返回值从 false 改为 true，让等待循环可以继续。" :
        "AI 收到上一轮的问题后提出了新的修改，工具会重新执行检查。", repair, "查看这次怎么改",
        ["AI", "提交修订版", "检查工具"]);
      if (fixedBoundary) {
        const rules = node("div", undefined, "story-comparison");
        const before = node("div", undefined, "story-outcome");
        before.append(node("span", "第一版规则"), node("strong", "超过门槛才选左边"));
        const after = node("div", undefined, "story-outcome");
        after.append(node("span", "修订后规则"), node("strong", "达到门槛就选左边"));
        rules.append(before, after);
        section.insertBefore(rules, section.lastElementChild);
      }
    }
  }

  const contract = events.findLastIndex(event => event.stage === "contract");
  if (contract >= 0) {
    const verified = events[contract].status === "passed";
    const details = events[contract].details;
    card("离线行为验证", verified ? "原版和补丁通过同一套行为测试" : "离线行为测试未通过",
      details.description ?? "用模拟客户端启动 Rocket，并发出首页、余额查询、状态根和非法地址请求。",
      contract, details.runs?.length === 3 ? "查看三组行为测试" : "查看两版行为测试");
  }
  const final = events.findLastIndex(event => event.stage === "result");
  if (result?.stage === "accepted") {
    const repaired = events.some(event => event.stage === "repair");
    const coverage = cargoEvidence(result.report?.checks);
    const description = contract >= 0 ?
      (processTask === "rem-40" ?
        "查看最终补丁和离线行为测试记录。上游余额查询测试仍标记为跳过。" :
        "查看最终补丁和专项行为测试记录。") :
      remTrial && coverage.ignored ?
      `编译通过，${coverage.ignored} 项测试跳过。打开验收证据可以查看具体覆盖范围。` :
      "这份修改通过了本任务要求的检查，可以查看并导出补丁。";
    card("验收通过", repaired ? "重新检查通过" : "第一版检查通过",
      description, final, "查看验收证据",
      ["检查工具", "确认通过", "补丁"]);
  } else if (result) {
    card("未通过", "任务结束，这份修改未通过", "最后一次检查的结果已经保存，可查看具体原因。", final, "查看最终结果");
  } else if (["提出修改", "载入补丁"].includes(cards.at(-1).phase) && first < events.length - 1) {
    card("检查中", "检查正在进行", "完成后，这里会显示检查结果或下一轮修订。", events.length - 1, "查看当前阶段");
  }
  const current = Math.min(storyStep ?? (storyFollow ? cards.length - 1 : 0), cards.length - 1);
  const steps = node("nav", undefined, "story-flow");
  steps.setAttribute("aria-label", "运行过程步骤");
  const go = index => {
    stopStoryPlayback();
    storyStep = index;
    renderProcessStory(events, result);
    story.querySelectorAll(".story-step")[index]?.focus();
  };
  cards.forEach(({phase}, index) => {
    const button = node("button", phase, "story-step");
    if (index === current) button.setAttribute("aria-current", "step");
    button.onclick = () => go(index);
    steps.append(button);
  });
  const controls = node("div", undefined, "story-navigation");
  const back = node("button", "上一步");
  const next = node("button", "下一步", "primary");
  back.disabled = current === 0;
  next.disabled = current === cards.length - 1;
  back.onclick = () => go(current - 1);
  next.onclick = () => go(current + 1);
  controls.append(back, node("span", `${current + 1} / ${cards.length}`), next);
  story.append(steps, cards[current].section, controls);

  if (result && cards.length > 1) {
    const playback = node("div", undefined, "story-playback");
    const last = current === cards.length - 1;
    const playing = storyTimer !== undefined;
    const play = node("button", playing ? "暂停" : last ? "重播" : current ? "继续播放" : "播放讲解",
      "primary");
    play.onclick = () => {
      if (playing) {
        stopStoryPlayback();
        renderProcessStory(events, result);
      } else {
        if (last) storyStep = 0;
        scheduleNext(last ? 0 : current);
      }
      story.querySelector(".story-playback button")?.focus();
    };
    playback.append(play, node("span", "历史回放 · 每步约 3 秒"));
    story.prepend(playback);
  } else if (!result) {
    story.prepend(node("p", storyStep === undefined ? "实时运行 · 随执行记录更新" :
      "实时运行 · 正在查看所选步骤", "story-live"));
  }

  function scheduleNext(index) {
    storyTimer = setTimeout(() => {
      storyTimer = undefined;
      if ($("process").hidden || story.hidden) return;
      storyStep = index + 1;
      const restoreFocus = document.activeElement === story.querySelector(".story-playback button");
      if (storyStep < cards.length - 1) scheduleNext(storyStep);
      else renderProcessStory(events, result);
      if (restoreFocus) story.querySelector(".story-playback button")?.focus();
    }, 3000);
    renderProcessStory(events, result);
  }
}

function candidateFragments(proposal) {
  const fragments = [];
  for (const edit of proposal?.edits ?? []) {
    const before = edit.before.split(/\r?\n/);
    const after = edit.after.split(/\r?\n/);
    while (before.length && after.length && before[0] === after[0]) {
      before.shift();
      after.shift();
    }
    while (before.length && after.length && before.at(-1) === after.at(-1)) {
      before.pop();
      after.pop();
    }
    if (before.length || after.length) fragments.push({path: edit.path, before, after});
  }
  return fragments;
}

function appendCandidateFragments(box, proposal, attempt) {
  const fragments = candidateFragments(proposal);
  if (!fragments.length) return;
  const patch = fragments.map(({path, before, after}) => [
    `--- a/${path}`, `+++ b/${path}`, `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map(line => "-" + line), ...after.map(line => "+" + line)
  ].join("\n")).join("\n");
  const mergedFiles = new Map();
  for (const file of patchComparison(patch)) {
    const existing = mergedFiles.get(file.path);
    if (existing) existing.hunks.push(...file.hunks);
    else mergedFiles.set(file.path, file);
  }
  renderPatch(patch, {container: box, task: processTask, fragment: true,
                      beforeTitle: "原代码片段", afterTitle: `候选 ${attempt} 片段`,
                      files: [...mergedFiles.values()]});
}

function cargoEvidence(checks) {
  const summary = {passed: 0, failed: 0, ignored: 0, ignoredTests: [], hasTestSummary: false};
  for (const check of checks ?? []) {
    const output = check.output ?? "";
    if (check.command?.[0] === "test") {
      for (const match of output.matchAll(/^test result:.*? (\d+) passed; (\d+) failed; (\d+) ignored;/gm)) {
        summary.hasTestSummary = true;
        summary.passed += Number(match[1]);
        summary.failed += Number(match[2]);
        summary.ignored += Number(match[3]);
      }
      for (const match of output.matchAll(/^test (.+?) \.\.\. ignored(?:,.*)?\r?$/gm)) {
        summary.ignoredTests.push(match[1]);
      }
    }
    if (!summary.diagnostic) {
      const match = /^(error(?:\[E\d+\])?:[^\r\n]*)\r?\n\s*--> ([^\r\n]+)\r?\n((?:(?:[ \t]*\d*[ \t]*\|)[^\r\n]*\r?\n?)*)/m.exec(output);
      if (match) summary.diagnostic = {message: match[1], location: match[2], excerpt: match[3].trimEnd()};
    }
  }
  return summary;
}

function appendCargoEvidence(box, evidence, task, hasContract = false) {
  if (!evidence.hasTestSummary) return;
  const {passed, failed, ignored, ignoredTests} = evidence;
  const section = node("section", undefined, "process-compile-note");
  section.append(node("h3", "测试覆盖"),
    node("p", `${passed} 项通过 · ${failed} 项失败 · ${ignored} 项跳过`));
  if (ignoredTests.length) {
    const list = node("ul");
    for (const name of ignoredTests) list.append(node("li", name));
    section.append(list);
  }
  if (task === "rem-40" && ignoredTests.some(name => name.endsWith("given_normal_conditions_when_query_balance_then_ok"))) {
    section.append(node("p", hasContract ?
      "上游余额查询接口测试被跳过。离线行为测试的结果见「离线行为验证」。" :
      "余额查询接口测试被跳过，本次运行没有验证服务启动后的接口行为。"));
  } else if (ignored) {
    section.append(node("p", "本次运行未覆盖跳过的测试。"));
  }
  box.append(section);
}

function renderProcessEvidence(event, events, result) {
  const box = $("process-evidence");
  box.replaceChildren();
  $("process-evidence-title").textContent = event ? processPhase(event) : "阶段证据";
  $("process-evidence-time").textContent = event ?
    (event.at ? new Date(event.at).toLocaleTimeString() : "阶段时间未记录") : "";
  if (!event) return;
  const info = event.details;
  const proposal = events.findLast(item => item.attempt === event.attempt &&
    ["candidate", "repair"].includes(item.stage) && item.status === "passed")?.details.proposal;
  if (event.stage === "candidate" && event.status === "passed") {
    appendCandidateFragments(box, info.proposal, event.attempt);
  }
  const failedCheck = ["baseline", "validation"].includes(event.stage) && event.status === "failed";
  const evidence = cargoEvidence(info.checks);
  if (failedCheck && evidence.diagnostic) {
    const {message, location, excerpt} = evidence.diagnostic;
    const explanation = node("section", undefined, "process-compile-note");
    explanation.append(node("h3", "编译器诊断"), node("p", message), node("code", location));
    if (excerpt) explanation.append(node("pre", excerpt));
    if (processTask === "rem-17" && message.includes("E0412") && message.includes("crate::parser")) {
      explanation.append(node("p", "SectionId 实际位于 crate::file。"));
    }
    box.append(explanation);
  }
  if (event.stage === "validation" && failedCheck) {
    appendCandidateFragments(box, proposal, event.attempt);
  }
  const collaboration = result?.report?.collaboration;
  const expertEvidence = event.stage === "model" && event.status === "passed" && collaboration ?
    (info.role === "plan" ? collaboration.plan :
      collaboration.outcomes?.find(outcome => outcome.role === info.role)) :
    undefined;
  if (event.stage === "routing" && Array.isArray(info.plan)) {
    const basis = {
      "rust-code": "根据实际增删的 Rust 代码行、任务目标和验收配置选择专家。代码匹配排除了注释和字面量。",
      "changed-text": "本次使用增删文本作为依据。源码解析未能完整提供代码信息。",
      "replacement-fragments": "本次使用替换片段作为依据，片段位置未映射到源文件。",
      fixed: "按固定顺序审查同一候选。检测到明确的错误后停止后续审查。"
    };
    if (basis[info.basis]) box.append(node("p", basis[info.basis]));
    if (!info.plan.length) box.append(node("p", "未触发专家审查，直接执行验收测试。"));
    for (const step of info.plan) {
      box.append(node("h3", roleName(step.role) + "专家"));
      if (info.basis === "fixed") continue;
      const list = node("ul", undefined, "story-paths");
      for (const reason of step.reasons ?? []) {
        const item = node("li");
        const source = {goal: "任务目标", edit: "代码改动", validation: "验收配置"}[reason.source];
        const side = {added: "新增", removed: "删除"}[reason.side];
        const location = reason.path ? reason.path + (reason.line ? ":" + reason.line : "") : source;
        item.append(node("span", [side, location, reason.signal].filter(Boolean).join(" · ")));
        if (reason.code) item.append(node("br"), node("code", reason.code));
        list.append(item);
      }
      box.append(list);
    }
  } else if (event.stage === "formal-plan") {
    if (info.property) box.append(node("p", formalProperties[info.property] ?? info.property));
    if (info.reason) box.append(node("p", info.reason));
  } else if (event.stage === "formal" && info.status) {
    appendFormalEvidence(box, info);
  } else if (expertEvidence) {
    box.append(node("pre", JSON.stringify(expertEvidence, null, 2)));
  } else if (event.stage === "candidate" && event.status === "passed" && collaboration?.merge) {
    box.append(node("pre", JSON.stringify({
      merge: collaboration.merge, conflicts: collaboration.conflicts, proposal: info.proposal
    }, null, 2)));
  } else if (event.stage === "contract") {
    box.append(node("p", info.description ??
      "原版和补丁分别运行同一个测试。测试在断网容器内使用模拟 Ethereum 和 StarkNet 客户端。"));
    for (const run of info.runs ?? []) {
      const log = node("details", undefined, "log");
      log.open = true;
      const label = run.label ?? ({baseline: "论文原版", candidate: "Agent 补丁",
                     "wrong-boundary": "错误补丁（> 改成 >=）"}[run.variant] ?? run.variant);
      const status = run.expected_rejection ? " · 如预期被拒绝" : run.passed ? " · 通过" : " · 失败";
      log.append(node("summary", label + status),
        node("pre", run.output));
      if (run.patch) {
        const diff = node("details", undefined, "log");
        diff.append(node("summary", "查看这组补丁"));
        renderPatch(run.patch, {container: diff, task: processTask});
        log.append(diff);
      }
      box.append(log);
    }
  } else if (info.checks) {
    appendCargoEvidence(box, evidence, processTask);
    for (const check of info.checks) {
      const log = node("details", undefined, "log");
      log.open = !check.ok;
      log.append(node("summary", (check.ok ? "✓ " : "× ") + "cargo " + check.command.join(" ")),
        node("pre", check.output));
      box.append(log);
    }
  } else if (info.diff) {
    if (processTask === "rem-17" && info.diff.includes("crate::parser::SectionId") &&
        info.diff.includes("crate::file::SectionId")) {
      box.append(node("p", "Agent 将 SectionId 的类型路径改到了正确的模块。"));
    }
    renderPatch(info.diff, {container: box, task: processTask,
      beforeTitle: `候选 ${event.attempt - 1}`, afterTitle: `候选 ${event.attempt}`});
  } else if (event.stage === "repair" && proposal) {
    appendCandidateFragments(box, proposal, event.attempt);
  } else if (event.stage === "result" && result?.report?.patch) {
    box.append(node("p", result.stage === "accepted" ?
      "验收通过。打开运行结果可导出补丁。" :
      "候选通过了运行检查，但未满足任务的补丁要求。"));
    if (result.stage === "accepted") {
      appendCargoEvidence(box, cargoEvidence(result.report.checks), processTask,
        events.some(item => item.stage === "contract"));
      if (processTask === "rem-16" && result.report.checks?.some(check => check.command.includes("rem_16_contract"))) {
        box.append(node("p", "本次运行使用独立契约测试。上游全套测试中，无效十六进制输入有一项已知基线失败。"));
      }
      if (processTask === "rem-17" && processId === "6bb249683a22457c8f55c5c01d3cbc7b") {
        box.append(node("p", "独立复核的完整包测试通过 169 项，本次返修过程的测试日志见候选验证事件。"));
      }
      renderPatch(result.report.patch, {container: box, task: processTask});
    } else {
      box.append(node("pre", (result.report.missing_expected_edits ?? []).join("\n")));
    }
  } else if (event.stage === "result" && result?.report?.proposal_error) {
    box.append(node("p", result.report.proposal_error));
  } else if (Object.keys(info).length) {
    box.append(node("pre", JSON.stringify(info, null, 2)));
  } else {
    box.append(node("p", event.status === "started" ? "等待此阶段完成" : statusLabels[event.status]));
  }
  const followUp = events.find(item => item.attempt === event.attempt && item.stage === "feedback");
  const next = event.next_attempt ?? (event.status === "failed" ? followUp?.next_attempt : undefined);
  if (next) {
    const target = events.findIndex(item => item.attempt === next && item.stage === "repair");
    if (target >= 0) {
      const jump = node("button", "跳到候选 " + next + " 的修订");
      jump.onclick = () => {
        processEventIndex = target;
        renderProcess();
      };
      box.append(jump);
    }
  }
}

$("process-tab").onclick = () => openProcess();
$("process-story-tab").onclick = () => selectProcessView("story");
$("process-evidence-tab").onclick = () => selectProcessView("technical");
$("process-runs").onchange = () => openProcess($("process-runs").value);
$("process-result").onclick = () => {
  if (processData?.result?.report) {
    showRun(processData.result, processData.result.report.patch ? "patch" : undefined);
    showPage(false);
  }
};
const processLink = /^#process\/(z3-example|[a-f0-9]{32})(?:\/([1-9]\d*))?$/.exec(location.hash);
if (processLink) openProcess(processLink[1], processLink[2] ? Number(processLink[2]) - 1 : undefined);
