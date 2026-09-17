#!/usr/bin/env python3
"""Minimal Docker Engine API client over /var/run/docker.sock (stdlib only).

The gateway container has no docker CLI and no sudo, so all container work goes
through the socket. Usage as a module or via the CLI at the bottom.
"""
import json
import socket
import sys

SOCK = "/var/run/docker.sock"


def _connect(timeout):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(SOCK)
    return s


def _read_response(s, timeout=None):
    """Read one HTTP response, handling both content-length and chunked."""
    if timeout is not None:
        s.settimeout(timeout)
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    if b"\r\n\r\n" not in buf:
        return 0, {}, b""
    head, rest = buf.split(b"\r\n\r\n", 1)
    lines = head.split(b"\r\n")
    status = int(lines[0].split()[1])
    headers = {}
    for line in lines[1:]:
        if b":" in line:
            k, v = line.split(b":", 1)
            headers[k.decode().strip().lower()] = v.decode().strip()

    if headers.get("transfer-encoding", "").lower() == "chunked":
        out = b""
        cur = rest
        while True:
            while b"\r\n" not in cur:
                c = s.recv(65536)
                if not c:
                    return status, headers, out
                cur += c
            size_line, cur = cur.split(b"\r\n", 1)
            size = int(size_line.split(b";")[0], 16)
            if size == 0:
                break
            while len(cur) < size + 2:
                c = s.recv(65536)
                if not c:
                    break
                cur += c
            out += cur[:size]
            cur = cur[size + 2:]
        return status, headers, out

    length = int(headers.get("content-length", "0") or 0)
    body = rest
    while len(body) < length:
        c = s.recv(65536)
        if not c:
            break
        body += c
    return status, headers, body[:length]


def request(method, path, body=None, timeout=120, stream=False):
    """Perform one request. Returns (status, headers, body_bytes).

    With stream=True the raw socket is returned instead so the caller can
    consume a long-lived stream (image pulls, logs, exec output).
    """
    s = _connect(timeout)
    headers = {"Host": "localhost", "Content-Type": "application/json"}
    data = b""
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Length"] = str(len(data))
    req = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers.items()) + "\r\n"
    s.sendall(req.encode() + data)
    if stream:
        return s
    try:
        return _read_response(s, timeout)
    finally:
        s.close()


def raw_post(path, data, content_type="application/x-tar", timeout=1800):
    """POST a raw binary body (used for /build with a tar context)."""
    s = _connect(timeout)
    head = (f"POST {path} HTTP/1.1\r\nHost: localhost\r\n"
            f"Content-Type: {content_type}\r\nContent-Length: {len(data)}\r\n\r\n")
    s.sendall(head.encode() + data)
    try:
        return _read_response(s, timeout)
    finally:
        s.close()


def jrequest(method, path, body=None, timeout=120):
    status, _headers, raw = request(method, path, body, timeout)
    try:
        return status, json.loads(raw)
    except Exception:
        return status, raw


def pull_image(ref, timeout=1800):
    """Pull an image, blocking until the stream ends. Returns (ok, tail_log)."""
    if ":" in ref.split("/")[-1]:
        from_image, tag = ref.rsplit(":", 1)
    else:
        from_image, tag = ref, "latest"
    s = request("POST", f"/images/create?fromImage={from_image}&tag={tag}", None, timeout, stream=True)
    lines = []
    try:
        buf = b""
        while True:
            try:
                chunk = s.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                break
            buf += chunk
            while b"\r\n" in buf:
                line, buf = buf.split(b"\r\n", 1)
                line = line.strip()
                if not line or line.startswith(b"HTTP/"):
                    continue
                if line.startswith(b"{"):
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    if obj.get("error"):
                        return False, obj["error"]
                    st = obj.get("status", "")
                    if st:
                        lines.append(st)
                        lines[:] = lines[-6:]
    finally:
        s.close()
    return True, "; ".join(lines[-3:])


def run_once(image, cmd, env=None, binds=None, name=None, workdir=None, timeout=600):
    """Create+start a one-off container and collect its output."""
    import time
    cfg = {
        "Image": image,
        "Cmd": cmd,
        "Env": env or [],
        "AttachStdout": True,
        "AttachStderr": True,
        "Tty": False,
        "WorkingDir": workdir or "",
        "HostConfig": {
            "Binds": binds or [],
            "AutoRemove": False,
            "NetworkMode": "bridge",
        },
    }
    path = f"/containers/create?name={name}" if name else "/containers/create"
    status, created = jrequest("POST", path, cfg)
    if status >= 400:
        return status, created
    cid = created["Id"]
    jrequest("POST", f"/containers/{cid}/start")
    # Stream logs until exit.
    s = request("GET", f"/containers/{cid}/logs?stdout=1&stderr=1&follow=0", None, timeout, stream=True)
    _st, _h, raw = _read_response(s, timeout)
    s.close()
    # Docker multiplexes streams with an 8-byte header when Tty=false.
    out = bytearray()
    i = 0
    while i + 8 <= len(raw):
        size = int.from_bytes(raw[i + 4:i + 8], "big")
        out += raw[i + 8:i + 8 + size]
        i += 8 + size
    if not out:
        out = raw
    code = jrequest("GET", f"/containers/{cid}/json")[1].get("State", {}).get("ExitCode")
    return code, out.decode("utf-8", errors="replace")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "pull":
        ok, log = pull_image(sys.argv[2])
        print("OK" if ok else "FAIL", log)
        sys.exit(0 if ok else 1)
    if cmd == "ps":
        _s, data = jrequest("GET", "/containers/json?all=1")
        for c in data:
            print(c["Id"][:12], c["Names"], c["Image"][:50], c["State"])
        sys.exit(0)
    print("usage: dk.py pull <image> | dk.py ps")
