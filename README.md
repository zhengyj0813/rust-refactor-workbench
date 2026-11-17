# Rust 智能重构工作台

在本机给 Rust 代码生成、审查和验证重构补丁。工作台提供提取方法、内联方法和移动方法样例，也支持指定自定义 crate 和允许编辑的文件。你可以在页面查看补丁差异、编译和测试结果，以及失败后每一轮怎样修订。

## 本机启动

先安装 Python 3.11 或更新版本和 Docker Desktop，启动 Linux 容器引擎。下载仓库后，在项目根目录打开 PowerShell。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-formal.txt
docker pull rust:1.85
.\.venv\Scripts\python.exe workbench.py
```

打开 [本机工作台](http://127.0.0.1:8765/)。服务监听本机回环地址。历史评测、回放和固定补丁复验可使用本地数据。

## 运行一次固定补丁

```powershell
.\.venv\Scripts\python.exe refactor.py --agents single --proposal examples/clone/proposal.json examples/clone src/lib.rs
```

示例将 Vec 参数改为借用，保留原有计算行为。Docker 使用离线 Cargo 检查并测试。成功时输出 JSON，其中 `accepted` 为 `true`。

## 让 DeepSeek 生成补丁

在启动工作台的 PowerShell 中设置 `DEEPSEEK_API_KEY`。如果密钥已保存在 Windows 用户环境变量中，可以读取到当前会话。

```powershell
$env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
.\.venv\Scripts\python.exe workbench.py
```

在页面选择样例，或选择「自定义 Rust 仓库」并提供 crate 的绝对路径、可编辑文件和重构目标。自定义仓库需要准备好 Docker 中可离线解析的 Cargo 依赖。模型生成与审查会把任务目标和选定的源码发送给配置的 DeepSeek API。使用自定义仓库前，请确认这些源码可以发送给所配置的服务。

## 演示与结果

- [服务费提取回放](http://127.0.0.1:8765/#process/58606942329041dab76cf8adb6915617)展示代码从原函数移入私有 helper，并通过 Docker 验收。
- [petgraph 拦截和返修回放](http://127.0.0.1:8765/#process/090f1102d58348abbfb310a067b35c91)保留了真实的拦截、修订和复检阶段。公开回放保留测试断言和结论，省略上游源码及候选补丁。
- [实验结果](docs/实验结果.md)收录 28 个场景的摘要、18 次生成评测和 48 次补丁审查对照。
