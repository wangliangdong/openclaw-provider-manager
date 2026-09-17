#!/usr/bin/env python3
"""Import provider API keys from openclaw.json into the manager's encrypted vault.

WHY THE MANAGER CANNOT DO THIS ITSELF
The manager container deliberately does NOT mount openclaw.json. If it did,
anything that reached port 8891 — or the container, if it were compromised —
could read EVERY provider's plaintext key, instead of only the ones the owner
chose to store. Keeping the config out of the manager's reach is the whole
point of the opt-in vault.

So the import runs from HERE (the gateway container, which legitimately owns the
config) and pushes only the keys asked for, over the manager's write-only API.

    python3 scripts/import_keys.py --list                 # what is available
    python3 scripts/import_keys.py --dry-run              # preview, store nothing
    python3 scripts/import_keys.py                        # import all providers
    python3 scripts/import_keys.py example custom        # just these

Secrets are never printed — only lengths and outcomes.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_CONFIG = os.path.expanduser("~/.openclaw/openclaw.json")
DEFAULT_URL = os.environ.get("PM_URL", "http://127.0.0.1:8891")

# A provider whose key is this sentinel has no usable key stored in config.
REDACTED = "__OPENCLAW_REDACTED__"


def load_providers(config_path):
    try:
        cfg = json.loads(Path(config_path).read_text())
    except FileNotFoundError:
        sys.exit(f"找不到配置文件：{config_path}")
    except json.JSONDecodeError as exc:
        sys.exit(f"配置文件不是合法 JSON：{exc}")
    return (cfg.get("models") or {}).get("providers") or {}


def usable_key(entry):
    """Return the plaintext key, or None when there is nothing usable.

    We only read `apiKey` — never `env`-style indirection or OAuth material,
    which this tool has no business copying.
    """
    key = entry.get("apiKey")
    if not isinstance(key, str) or not key.strip():
        return None
    if key == REDACTED:
        return None
    return key.strip()


def api(url, path, method="GET", body=None, timeout=60):
    req = urllib.request.Request(
        url.rstrip("/") + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"} if body is not None else {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {}
    except urllib.error.URLError as e:
        sys.exit(f"无法连接 manager（{url}）：{e.reason}\n用 --url 指定，例如 --url http://<manager-ip>:8891")


def main():
    ap = argparse.ArgumentParser(description="把 openclaw.json 中的 provider 密钥导入加密密钥库")
    ap.add_argument("providers", nargs="*", help="要导入的 provider id（默认：全部）")
    ap.add_argument("--url", default=DEFAULT_URL, help=f"manager 地址（默认 {DEFAULT_URL}）")
    ap.add_argument("--config", default=DEFAULT_CONFIG, help="openclaw.json 路径")
    ap.add_argument("--dry-run", action="store_true", help="只预览，不写入")
    ap.add_argument("--list", action="store_true", help="列出可导入的 provider 后退出")
    args = ap.parse_args()

    url = args.url
    providers = load_providers(args.config)

    # Report vault state first: if the server has no master key, every write
    # below will fail and the user should know that before, not after.
    st, v = api(url, "/api/vault")
    if not v.get("enabled"):
        sys.exit(f"密钥库未启用（{v.get('reason') or '未知原因'}）——服务端缺少 PM_VAULT_KEY。")
    already = {e["id"] for e in v.get("entries") or []}

    targets = args.providers or list(providers)
    unknown = [p for p in targets if p not in providers]
    if unknown:
        sys.exit(f"配置中不存在这些 provider：{', '.join(unknown)}")

    print(f"manager: {url}")
    print(f"密钥库已启用；当前已存 {len(already)} 个：{', '.join(sorted(already)) or '（无）'}")
    print()

    if args.list:
        for pid in sorted(providers):
            key = usable_key(providers[pid])
            state = "已在密钥库" if pid in already else ("可导入" if key else "无可用密钥")
            size = f"{len(key)} 字符" if key else "—"
            print(f"  {pid:14s} {state:10s} {size}")
        return

    imported, skipped, failed = [], [], []
    for pid in targets:
        entry = providers[pid]
        key = usable_key(entry)
        if not key:
            skipped.append((pid, "配置中没有明文密钥"))
            continue
        if args.dry_run:
            print(f"  [预演] {pid:14s} 将导入（{len(key)} 字符）")
            imported.append(pid)
            continue
        st, r = api(url, "/api/vault", "POST", {"id": pid, "apiKey": key})
        if st == 200 and r.get("ok"):
            imported.append(pid)
            print(f"  ✓ {pid:14s} 已加密存入密钥库（{len(key)} 字符）")
        else:
            failed.append((pid, r.get("error") or f"HTTP {st}"))
            print(f"  ✗ {pid:14s} 失败：{r.get('error') or f'HTTP {st}'}")

    print()
    print(f"结果：导入 {len(imported)}，跳过 {len(skipped)}，失败 {len(failed)}"
          + ("（预演，未写入）" if args.dry_run else ""))
    for pid, why in skipped:
        print(f"  跳过 {pid}：{why}")
    for pid, why in failed:
        print(f"  失败 {pid}：{why}")

    if imported and not args.dry_run:
        print()
        print("提示：现在可以在 UI 里直接对这些 provider 点「刷新模型」，无需再输入密钥。")

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
