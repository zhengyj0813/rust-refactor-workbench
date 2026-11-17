"""Read-only Rust reference discovery using rust-analyzer's LSP."""
import json
import os
from pathlib import Path
from queue import Empty, Queue
import shutil
import subprocess
from threading import Thread
from time import monotonic, sleep
from urllib.parse import urlsplit
from urllib.request import url2pathname


def read_messages(stream, inbox):
    try:
        while header := stream.readline():
            headers = {}
            while header.strip():
                name, value = header.decode("ascii").split(":", 1)
                headers[name.lower()] = value.strip()
                header = stream.readline()
            message = stream.read(int(headers["content-length"]))
            inbox.put(json.loads(message))
    finally:
        inbox.put(None)


def references(root, source, line, column):
    """Return crate-local reference ranges, using one-based UTF-16 coordinates."""
    if min(line, column) < 1:
        raise ValueError("reference coordinates must be positive")
    env = {key: value for key, value in os.environ.items()
           if key.upper() != "DEEPSEEK_API_KEY"}
    env["PATH"] = str(Path.home() / ".cargo" / "bin") + os.pathsep + env.get("PATH", "")
    env["CARGO_NET_OFFLINE"] = "true"
    executable = shutil.which("rust-analyzer", path=env["PATH"])
    if executable is None:
        raise ValueError("rust-analyzer executable not found")
    with subprocess.Popen([executable], cwd=root, env=env, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE,
                          stderr=None if os.getenv("RA_LOG") else subprocess.DEVNULL) as proc:
        inbox = Queue()
        reader = Thread(target=read_messages, args=(proc.stdout, inbox), daemon=True)
        reader.start()
        deadline = monotonic() + 35
        uri = source.as_uri()
        if os.name == "nt":
            # rust-analyzer's VFS resolves document URIs with lowercase drive letters.
            uri = uri[:8] + uri[8:9].lower() + uri[9:]

        def send(**payload):
            data = json.dumps({"jsonrpc": "2.0", **payload}).encode()
            proc.stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode() + data)
            proc.stdin.flush()

        def request(ident, method, **params):
            send(id=ident, method=method, params=params)
            while monotonic() < deadline:
                try:
                    msg = inbox.get(timeout=max(0, deadline - monotonic()))
                except Empty:
                    break
                if msg is None:
                    raise ValueError("rust-analyzer stopped before replying")
                if "method" in msg and "id" in msg:
                    if msg["method"] == "workspace/configuration":
                        result = [None] * len(msg.get("params", {}).get("items", []))
                    else:
                        result = None
                    send(id=msg["id"], result=result)
                elif msg.get("id") == ident:
                    if "error" in msg:
                        if msg["error"].get("code") in (-32800, -32801):
                            return None
                        raise ValueError(f"rust-analyzer request failed: {msg['error']}")
                    return msg.get("result")
            raise ValueError("rust-analyzer did not respond before timeout")

        try:
            request(1, "initialize", rootUri=root.as_uri(), capabilities={},
                    workspaceFolders=[{"uri": root.as_uri(), "name": root.name}],
                    initializationOptions={"checkOnSave": False, "cargo": {
                        "buildScripts": {"enable": False}}, "procMacro": {"enable": False}})
            send(method="initialized", params={})
            send(method="textDocument/didOpen", params={"textDocument": {
                "uri": uri, "languageId": "rust", "version": 1,
                "text": source.read_bytes().decode("utf-8")}})
            for ident in range(2, 122):
                hits = request(ident, "textDocument/references",
                               textDocument={"uri": uri},
                               position={"line": line - 1, "character": column - 1},
                               context={"includeDeclaration": False})
                if hits:
                    locations = []
                    for hit in hits:
                        uri = urlsplit(hit["uri"])
                        if uri.scheme != "file" or uri.netloc:
                            continue
                        path = Path(url2pathname(uri.path)).resolve()
                        if path.is_relative_to(root) and path.suffix == ".rs":
                            locations.append({"path": path.relative_to(root).as_posix(),
                                              "range": hit["range"]})
                    return locations
                sleep(0.25)
            return []
        finally:
            proc.kill()
            proc.wait()
            reader.join(timeout=1)
