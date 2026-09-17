"""Browser flow test for openclaw-provider-manager.

Exercises the INTERACTIVE paths that curl-based API tests cannot reach:
list -> add modal -> discover (error + success) -> manual add -> save
-> edit -> test connection (redacted key / supplied key) -> delete.
Also covers the actionable repair path: a redacted key makes "refresh models"
return 401, which must be explained (not echoed) and paired with a one-click
way to enroll the key in the vault — rendered INSIDE the dialog, because the
dialog overlay covers the page-level alert entirely.

WHY THIS EXISTS (two reasons, both learned the hard way):
1. A TypeError in the frontend (variable shadowing in setGwStatus) made the page
   render nothing while every API-level curl check passed. Frontend code must be
   verified by actually running it in a browser.
2. `config.get` never returns a stored API key — it yields the redaction
   sentinel. A probe without the key therefore gets a 401, which must NOT be
   presented as a configuration error. This test locks that distinction in:
     - key stored but redacted -> warn tone, "未验证", no 错误 line
     - key supplied by hand    -> ok tone, "鉴权：通过"
   The mock upstream REQUIRES a Bearer token, so both paths are exercised.

Usage: python check_flow.py <base-url> [mock-bind-host] [mock-advertise-host]
The advertise host matters when the server runs in another container: it must be
an address that container can reach (not 127.0.0.1).
Exit 0 = all passed. Creates and removes a throwaway provider named `uitest`.
"""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8891"
BIND = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
ADVERTISE = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1"

PROVIDER = "uitest"
TOKEN = "test-key-123"
# `image-1` matches the non-chat regex in app.js, so it must be listed but NOT
# auto-selected.
MOCK_MODELS = ["alpha", "beta", "image-1"]


class MockUpstream(BaseHTTPRequestHandler):
    """OpenAI-style /models that requires `Authorization: Bearer <TOKEN>`."""

    def do_GET(self):
        if not self.path.rstrip("/").endswith("/models"):
            self.send_response(404)
            self.end_headers()
            return
        auth = self.headers.get("authorization") or ""
        if auth != f"Bearer {TOKEN}":
            body = json.dumps({"error": {"message": "invalid api key"}}).encode()
            self.send_response(401)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = json.dumps({"data": [{"id": m} for m in MOCK_MODELS]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


mock = ThreadingHTTPServer((BIND, 0), MockUpstream)
MOCK_URL = f"http://{ADVERTISE}:{mock.server_address[1]}/v1"
threading.Thread(target=mock.serve_forever, daemon=True).start()

results = []


def check(name, cond, info=""):
    results.append((name, bool(cond), info))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}  {info}")


def wait_alert(page, timeout=25):
    """Return (text, class) as soon as a non-empty message appears.

    Checks ALL containers. Messages raised while a dialog is open go to
    #modalNotice / #loginNotice, because those fixed overlays cover the
    page-level #alert completely. 'ok' alerts auto-hide after 4s, so polling
    beats a fixed sleep.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        for sel in ("#modalNotice", "#loginNotice", "#alert"):
            loc = page.locator(sel)
            if not loc.is_hidden():
                txt = loc.inner_text().strip()
                if txt:
                    return txt, (page.get_attribute(sel, "class") or "")
        page.wait_for_timeout(150)
    return "", ""


def vault_ids(page):
    """Provider ids currently in the server-side vault."""
    return page.evaluate(
        "async () => ((await (await fetch('/api/vault')).json()).entries || []).map(e => e.id)"
    )


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    js_errors = []
    net_notes = []
    page.on("pageerror", lambda e: js_errors.append(str(e)))
    page.on(
        "console",
        lambda m: net_notes.append(m.text) if m.type == "error" else None,
    )

    store = {"respond": ""}

    def on_dialog(d):
        if d.type == "prompt":
            d.accept(store["respond"] or "")
        else:
            d.accept()

    page.on("dialog", on_dialog)

    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(900)
    check("provider list rendered", page.locator("#providerList .card").count() >= 1,
          f"cards={page.locator('#providerList .card').count()} mock={MOCK_URL}")

    # --- add modal ----------------------------------------------------------
    page.click("#btnAdd")
    page.wait_for_timeout(300)
    check("add modal opens", not page.locator("#modal").is_hidden())
    page.fill("#fId", PROVIDER)

    # --- discover ERROR path (dead host) ------------------------------------
    page.fill("#fBaseUrl", "http://127.0.0.1:9/v1")
    page.click("#btnDiscover")
    page.wait_for_timeout(2500)
    t, _ = wait_alert(page, 8)
    check("discover failure shown", "获取模型失败" in t, f"{t[:50]!r}")
    check("add-mode failure is visible inside the dialog",
          not page.locator("#modalNotice").is_hidden(),
          "the page-level #alert is covered by the overlay")
    check("add-mode failure offers no vault fix (nothing stored yet)",
          page.locator("#modalNotice button").count() == 0)

    # --- discover SUCCESS path (mock requires the token) --------------------
    page.fill("#fBaseUrl", MOCK_URL)
    page.fill("#fApiKey", TOKEN)
    page.click("#btnDiscover")
    page.wait_for_timeout(2000)
    hint = page.inner_text("#discoverHint").strip()
    check("discover reports model count", "3" in hint, f"hint={hint!r}")

    boxes = page.locator("#modelsList input[type=checkbox]")
    labels = page.locator("#modelsList label")
    n = boxes.count()
    checked = [labels.nth(i).inner_text().strip() for i in range(n) if boxes.nth(i).is_checked()]
    check("all upstream models listed", n == 3, f"count={n}")
    check("chat models auto-selected",
          all(any(x in c for c in checked) for x in ("alpha", "beta")), f"checked={checked}")
    check("non-chat model NOT auto-selected",
          not any("image-1" in c for c in checked), f"checked={checked}")

    # --- manual model add ---------------------------------------------------
    page.fill("#fManualModel", "manual-1")
    page.click("#btnManualAdd")
    page.wait_for_timeout(300)
    check("manual model added", page.locator("#modelsList input[type=checkbox]").count() == 4,
          f"count={page.locator('#modelsList input[type=checkbox]').count()}")

    # --- save ---------------------------------------------------------------
    page.click("#btnSave")
    page.wait_for_timeout(2000)
    t, _ = wait_alert(page, 10)
    check("save reports success", "已保存" in t, f"{t[:60]!r}")
    page.wait_for_timeout(600)
    heads = page.locator("#providerList .card h3").all_inner_texts()
    check("new provider appears in list", PROVIDER in heads, f"{heads}")
    check("stored key shows redacted badge",
          "已脱敏" in page.locator("#providerList .card", has_text=PROVIDER).inner_text())

    # --- edit round-trip ----------------------------------------------------
    page.locator("#providerList .card", has_text=PROVIDER).locator("button", has_text="编辑").click()
    page.wait_for_timeout(800)
    check("edit prefills id", page.input_value("#fId") == PROVIDER, f"{page.input_value('#fId')!r}")
    check("edit loads stored models", page.locator("#modelsList input[type=checkbox]").count() == 3,
          f"count={page.locator('#modelsList input[type=checkbox]').count()}")
    page.click("#btnCancel")
    page.wait_for_timeout(300)
    check("cancel closes modal", page.locator("#modal").is_hidden())

    # --- test connection: stored key is redacted -> warn, not error ---------
    store["respond"] = ""
    page.locator("#providerList .card", has_text=PROVIDER).locator("button", has_text="测试连接").click()
    t, cls = wait_alert(page, 30)
    check("redacted key: warn tone (not error)", "warn" in cls, f"class={cls!r}")
    check("redacted key: says auth not verified", "未验证" in t, f"{t[:70]!r}")
    check("redacted key: no misleading 错误 line", "错误：" not in t)

    # --- test connection: user supplies the key -> ok + authenticated -------
    store["respond"] = TOKEN
    page.locator("#providerList .card", has_text=PROVIDER).locator("button", has_text="测试连接").click()
    t, cls = wait_alert(page, 30)
    check("supplied key: ok tone", "ok" in cls, f"class={cls!r}")
    check("supplied key: authenticated + model count",
          "鉴权：通过" in t and "3 个" in t, f"{t[:80]!r}")

    # --- encrypted vault: opt in, then refresh WITHOUT re-typing the key ----
    # This is the whole point of the vault: config.get redacts the stored key,
    # so without it an existing provider can never refresh its model list.
    # Skipped when the server runs without PM_VAULT_KEY.
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(900)
    vault_ok = page.evaluate("() => state.vaultEnabled")
    if not vault_ok:
        check("vault: available", False, "server started without PM_VAULT_KEY")
    else:
        check("vault: available", True)

        # --- actionable repair: a redacted key makes refresh 401, offer the fix
        # The upstream's "invalid key" text describes a request that carried NO
        # key at all, so it must not be echoed as if the key were rejected. The
        # UI has to explain that and hand the user the one-click fix.
        page.locator("#providerList .card", has_text=PROVIDER).locator(
            "button", has_text="刷新模型").click()
        page.wait_for_timeout(2500)
        t, cls = wait_alert(page, 15)
        check("redacted refresh: explains the key is redacted, not rejected",
              "脱敏" in t and "并非密钥本身失效" in t, f"{t[:90]!r}")
        check("redacted refresh: warning tone", "warn" in cls, f"class={cls!r}")
        fix = page.locator("#modalNotice button", has_text="加密保存此密钥")
        check("redacted refresh: offers a one-click fix", fix.count() == 1)
        if fix.count():
            fix.click()
            page.wait_for_timeout(400)
            check("fix button ticks the vault opt-in", page.is_checked("#fRememberKey"))
            check("fix button focuses the key field",
                  page.evaluate("() => document.activeElement && document.activeElement.id") == "fApiKey")
        page.click("#btnCancel")
        page.wait_for_timeout(300)

        # Opt in while editing: tick the box and save with the key.
        page.locator("#providerList .card", has_text=PROVIDER).locator("button", has_text="编辑").click()
        page.wait_for_timeout(700)
        check("vault: control shown in editor", not page.locator("#vaultBlock").is_hidden())
        page.fill("#fApiKey", TOKEN)
        page.check("#fRememberKey")
        page.click("#btnSave")
        page.wait_for_timeout(2200)
        t, _ = wait_alert(page, 12)
        check("vault: save reports the key was stored", "密钥已加密存入密钥库" in t, f"{t[:70]!r}")

        # Now the actual win: refresh models with NO key typed anywhere.
        store["respond"] = ""   # any prompt at this point is a failure
        page.locator("#providerList .card", has_text=PROVIDER).locator("button", has_text="刷新模型").click()
        page.wait_for_timeout(2500)
        hint = page.inner_text("#discoverHint").strip()
        check("vault: refresh works without re-typing the key", "找到 3 个模型" in hint, f"hint={hint!r}")
        check("vault: refresh used the vault key", "密钥库" in hint, f"hint={hint!r}")
        page.click("#btnCancel")
        page.wait_for_timeout(300)

        # Test connection must also succeed via the vault, not ask for a key.
        store["respond"] = ""
        page.locator("#providerList .card", has_text=PROVIDER).locator("button", has_text="测试连接").click()
        t, cls = wait_alert(page, 30)
        check("vault: test connection authenticates via vault", "ok" in cls and "鉴权：通过" in t, f"{t[:70]!r}")
        check("vault: test connection did not prompt", store["respond"] == "")

        # Forget removes it, and we fall back to the redacted state.
        page.locator("#providerList .card", has_text=PROVIDER).locator("button", has_text="编辑").click()
        page.wait_for_timeout(700)
        check("vault: forget button visible when stored", not page.locator("#btnForgetKey").is_hidden())
        page.click("#btnForgetKey")
        page.wait_for_timeout(1200)
        check("vault: forget button hidden after removal", page.locator("#btnForgetKey").is_hidden())

        # Re-enroll, so the delete below actually exercises vault cleanup.
        # Otherwise the entry is already gone and the delete proves nothing.
        page.fill("#fApiKey", TOKEN)
        page.check("#fRememberKey")
        page.click("#btnSave")
        page.wait_for_timeout(2200)
        t, _ = wait_alert(page, 12)
        check("vault: re-enrolled before delete", "密钥已加密存入密钥库" in t, f"{t[:70]!r}")
        check("vault: entry present before delete", PROVIDER in vault_ids(page), f"{vault_ids(page)}")

    # --- delete -------------------------------------------------------------
    # Deleting a provider must also drop its vault copy: once it is gone from
    # config, discovery can never use that entry again, so a survivor is dead
    # weight that piles up unnoticed (exactly how a stale key lingered here).
    page.locator("#providerList .card", has_text=PROVIDER).locator("button", has_text="删除").click()
    page.wait_for_timeout(2200)
    t, cls = wait_alert(page, 12)
    check("provider deleted", PROVIDER not in page.locator("#providerList .card h3").all_inner_texts())
    if vault_ok:
        check("delete also clears the vault copy",
              "密钥库中的密钥已一并移除" in t, f"{t[:80]!r}")
        check("vault no longer lists the provider",
              PROVIDER not in vault_ids(page), f"{vault_ids(page)}")

    check("no uncaught JS errors", not js_errors, f"{js_errors[:2]}")

    print(f"\n  (network notes: {len(net_notes)} failed HTTP responses — expected for the dead-host case)")
    print(f"\nRESULT: {sum(1 for _, c, _ in results if c)}/{len(results)} passed")
    ok = all(c for _, c, _ in results)
    browser.close()

mock.shutdown()
sys.exit(0 if ok else 1)
