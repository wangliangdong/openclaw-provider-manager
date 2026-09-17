#!/usr/bin/env python3
"""Build the provider-manager image and (re)deploy its container.

Runs from inside the gateway container, driving the Docker Engine API over
/var/run/docker.sock. Builds from an *in-memory* tar context, so no host
filesystem access is required.

Usage:
    python3 scripts/deploy.py build          # build image only
    python3 scripts/deploy.py deploy         # create/replace the container
    python3 scripts/deploy.py up             # build + deploy
    python3 scripts/deploy.py status
"""
import base64
import io
import json
import os
import socket
import sys
import tarfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from dk import jrequest, request, raw_post, _read_response, pull_image  # noqa: E402

PROJECT = Path(__file__).resolve().parent.parent
IMAGE_TAG = os.environ.get("PM_IMAGE", "openclaw-provider-manager:0.1.0")
CONTAINER = "openclaw-provider-manager"
NETWORK = os.environ.get("PM_NETWORK", "openclaw-net")
HOST_PORT = int(os.environ.get("PM_HOST_PORT", "8891"))

# Persistent vault lives under the gateway's mounted config dir, so it survives
# a container rebuild (the manager itself mounts nothing else). The master key
# is kept BESIDE the data dir, never inside it: a backup or sync of `data/`
# alone then yields only ciphertext.
VAULT_ROOT = Path(os.environ.get("PM_VAULT_ROOT", "/home/node/.openclaw/provider-manager"))
VAULT_DATA = VAULT_ROOT / "data"
VAULT_KEY_FILE = VAULT_ROOT / "vault.key"

CONTEXT_FILES = ["package.json", "server.js", "Dockerfile"]
CONTEXT_DIRS = ["lib", "public"]

# Never bake credentials into the image; all of these are injected at runtime.
ENV_PASSTHROUGH = ["OPENCLAW_GATEWAY_URL", "PM_ADMIN_TOKEN", "PM_PORT", "PM_BIND"]


def build_context() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for rel in CONTEXT_FILES:
            p = PROJECT / rel
            if p.is_file():
                tar.add(p, arcname=rel)
        for d in CONTEXT_DIRS:
            base = PROJECT / d
            if not base.is_dir():
                continue
            for p in sorted(base.rglob("*")):
                if p.is_file() and "__pycache__" not in p.parts:
                    tar.add(p, arcname=str(p.relative_to(PROJECT)))
    return buf.getvalue()


def build() -> bool:
    ctx = build_context()
    # Sanity-check the context before spending a build cycle on it.
    with tarfile.open(fileobj=io.BytesIO(ctx)) as tf:
        names = sorted(m.name for m in tf.getmembers() if m.isfile())
    print(f"[build] context={len(ctx)} bytes files={names}")
    for required in ("Dockerfile", "server.js", "lib/gateway.js", "public/index.html"):
        if required not in names:
            print(f"[build] ABORT: {required} missing from build context")
            return False
    with tarfile.open(fileobj=io.BytesIO(ctx)) as tf:
        dockerfile = tf.extractfile("Dockerfile").read().decode()
    for required in ("lib/", "public/", "server.js"):
        if required not in dockerfile:
            print(f"[build] ABORT: Dockerfile does not COPY {required}")
            return False

    started = time.time()
    st, _hdrs, raw = raw_post(f"/build?t={IMAGE_TAG}&dockerfile=Dockerfile&forcerm=0", ctx)
    print(f"[build] http={st} elapsed={time.time() - started:.1f}s")

    image_id = None
    errors = []
    tail = []
    for line in raw.split(b"\r\n"):
        line = line.strip()
        if not line.startswith(b"{"):
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("stream"):
            text = obj["stream"].rstrip()
            if text:
                tail.append(text)
                tail[:] = tail[-6:]
        if obj.get("error"):
            errors.append(obj["error"])
        if obj.get("errorDetail"):
            errors.append(obj["errorDetail"].get("message", ""))
        if obj.get("aux", {}).get("ID"):
            image_id = obj["aux"]["ID"]

    if errors:
        print("[build] FAILED")
        for e in errors[:5]:
            print("   ", str(e)[:500])
        return False
    if not image_id:
        print("[build] no image id returned; tail:", " | ".join(x[:120] for x in tail))
        return False
    print(f"[build] OK image={image_id}")
    return True


def gateway_env():
    """Resolve the Gateway URL + token for the new container."""
    # Prefer the shared compose network alias so the link survives IP changes.
    url = os.environ.get("PM_GATEWAY_URL") or os.environ.get("OPENCLAW_GATEWAY_URL") or "http://openclaw-gateway:18789"
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
    if not token:
        try:
            cfg = json.loads(Path("/home/node/.openclaw/openclaw.json").read_text())
            token = cfg.get("gateway", {}).get("auth", {}).get("token", "")
        except Exception as exc:
            print(f"[warn] could not read gateway token: {exc}")
    return url, token


def host_path_for(container_path: Path):
    """Translate a path inside THIS container into its path on the host.

    WHY THIS IS NOT OPTIONAL: container creation goes through docker.sock, and
    the Engine resolves `Binds` sources against the HOST filesystem. Passing a
    path that is only valid inside this container (e.g. under a bind mount)
    makes Docker silently create an empty directory on the host instead of
    reusing ours — the vault would look fine until the first rebuild, then come
    back empty. So we map our path through this container's own mount table.
    """
    target = str(container_path.resolve())
    try:
        name = socket.gethostname()
        st, info = jrequest("GET", f"/containers/{name}/json")
        if st >= 400:
            return None
    except Exception:
        return None
    best = None
    for m in info.get("Mounts") or []:
        if m.get("Type") != "bind":
            continue
        dest = (m.get("Destination") or "").rstrip("/")
        if dest and (target == dest or target.startswith(dest + "/")):
            if best is None or len(dest) > len(best.get("Destination", "").rstrip("/")):
                best = m
    if not best:
        return None
    dest = best["Destination"].rstrip("/")
    rel = target[len(dest):].lstrip("/")
    return str(Path(best["Source"]) / rel) if rel else best["Source"]


def ensure_vault():
    """Create the vault dir + master key if absent, and return (host_dir, key).

    The key survives redeploys, so stored secrets stay decryptable.
    """
    VAULT_DATA.mkdir(parents=True, exist_ok=True)
    try:
        VAULT_DATA.chmod(0o700)
    except OSError:
        pass

    key = ""
    if VAULT_KEY_FILE.exists():
        key = VAULT_KEY_FILE.read_text().strip()
    if not key:
        key = base64.b64encode(os.urandom(32)).decode()
        VAULT_KEY_FILE.write_text(key + "\n")
        try:
            VAULT_KEY_FILE.chmod(0o600)
        except OSError:
            pass
        print(f"[vault] generated new master key at {VAULT_KEY_FILE}")

    host_data = host_path_for(VAULT_DATA)
    if not host_data:
        print(f"[vault] WARN: could not map {VAULT_DATA} to a host path via mounts;")
        print("[vault]       the vault will NOT persist across rebuilds. Set PM_VAULT_ROOT")
        print("[vault]       to a directory backed by a known host bind mount.")
    return host_data, key


def stop_remove(name):
    st, info = jrequest("GET", f"/containers/{name}/json")
    if st >= 400:
        return False
    running = info.get("State", {}).get("Running")
    if running:
        print(f"[deploy] stopping {name}")
        jrequest("POST", f"/containers/{name}/stop?t=10")
        for _ in range(30):
            if not jrequest("GET", f"/containers/{name}/json")[1].get("State", {}).get("Running"):
                break
            time.sleep(1)
    print(f"[deploy] removing {name}")
    jrequest("DELETE", f"/containers/{name}?force=1")
    return True


def deploy():
    url, token = gateway_env()
    if not token:
        print("[deploy] ERROR: gateway token not found")
        return False

    env = [f"OPENCLAW_GATEWAY_URL={url}", f"OPENCLAW_GATEWAY_TOKEN={token}"]
    for key in ENV_PASSTHROUGH:
        if key in ("OPENCLAW_GATEWAY_URL",):
            continue
        if os.environ.get(key):
            env.append(f"{key}={os.environ[key]}")
    env.append(f"PM_HOST_PORT={HOST_PORT}")

    # Encrypted key store: ciphertext on a persistent volume, master key via env
    # (the key file itself is never mounted into the container).
    host_vault, vault_key = ensure_vault()
    env.append("PM_VAULT_DIR=/data")
    env.append(f"PM_VAULT_KEY={vault_key}")

    host_config = {
        "PortBindings": {"8891/tcp": [{"HostPort": str(HOST_PORT)}]},
        "RestartPolicy": {"Name": "unless-stopped"},
        "NetworkMode": NETWORK,
        "LogConfig": {"Type": "json-file", "Config": {"max-size": "10m", "max-file": "3"}},
    }
    if host_vault:
        host_config["Binds"] = [f"{host_vault}:/data:rw"]
        print(f"[vault] data {host_vault} -> /data (persistent)")

    cfg = {
        "Image": IMAGE_TAG,
        "Env": env,
        "ExposedPorts": {"8891/tcp": {}},
        "Labels": {"openclaw.provider-manager": "1"},
        "HostConfig": host_config,
    }

    stop_remove(CONTAINER)
    st, created = jrequest("POST", f"/containers/create?name={CONTAINER}", cfg)
    if st >= 400:
        print("[deploy] create failed:", json.dumps(created)[:600])
        return False
    cid = created["Id"]
    st, _ = jrequest("POST", f"/containers/{cid}/start")
    if st >= 400:
        print("[deploy] start failed:", st)
        return False
    print(f"[deploy] started {CONTAINER} ({cid[:12]}) on {NETWORK} host_port={HOST_PORT}")
    print(f"[deploy] gateway_url={url}")
    return True


def status():
    st, info = jrequest("GET", f"/containers/{CONTAINER}/json")
    if st >= 400:
        print("not deployed")
        return
    state = info.get("State", {})
    print(f"{CONTAINER}: running={state.get('Running')} status={state.get('Status')} "
          f"health={state.get('Health', {}).get('Status')} restarts={info.get('RestartCount')}")
    nets = list((info.get("NetworkSettings", {}).get("Networks") or {}).keys())
    print("  networks:", nets)
    _s, _h, logs = request("GET", f"/containers/{CONTAINER}/logs?stdout=1&stderr=1&tail=25", None, 30)
    out = bytearray()
    i = 0
    while i + 8 <= len(logs):
        size = int.from_bytes(logs[i + 4:i + 8], "big")
        out += logs[i + 8:i + 8 + size]
        i += 8 + size
    print("  logs:\n" + (out.decode(errors="replace") or "(empty)"))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "build":
        sys.exit(0 if build() else 1)
    if cmd == "deploy":
        sys.exit(0 if deploy() else 1)
    if cmd == "up":
        sys.exit(0 if build() and deploy() else 1)
    if cmd == "status":
        status()
        sys.exit(0)
    if cmd == "pull":
        ok, log = pull_image(sys.argv[2])
        print("OK" if ok else "FAIL", log)
        sys.exit(0 if ok else 1)
    print(__doc__)
