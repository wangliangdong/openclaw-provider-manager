"""Browser check for openclaw-provider-manager.

Loads the page, captures console errors / page errors, and reports whether the
provider list actually rendered. This is the test that was MISSING: every
earlier "end-to-end" check used curl against the API, which never executes the
frontend JS — which is exactly why a TypeError in setGwStatus() went unnoticed.

Usage: python check_ui.py <base-url>
Exit code 0 only if providers rendered and no page error occurred.
"""

import sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8891"

console_msgs = []
page_errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.on("console", lambda m: console_msgs.append((m.type, m.text)))
    page.on("pageerror", lambda e: page_errors.append(str(e)))

    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(1200)

    status_text = page.inner_text("#gwStatusText").strip()
    # The static markup declares this id; it must survive status updates.
    label_kept = page.locator("#gwStatusText").count() == 1
    cards = page.locator("#providerList .card")
    card_count = cards.count()
    empty_hidden = page.locator("#empty").is_hidden()
    alert_hidden = page.locator("#alert").is_hidden()
    alert_text = "" if alert_hidden else page.inner_text("#alert").strip()

    print(f"base              : {BASE}")
    print(f"#gwStatusText     : {status_text!r} (element kept: {label_kept})")
    print(f"provider cards    : {card_count}")
    print(f"#empty hidden     : {empty_hidden}")
    print(f"#alert visible    : {not alert_hidden}  {alert_text!r}")
    print(f"console errors    : {[t for t in console_msgs if t[0] in ('error',)]}")
    print(f"page errors       : {page_errors}")

    if card_count:
        first = cards.first.inner_text().splitlines()
        print(f"first card        : {first[:4]}")
        print(f"model tags        : {page.locator('#providerList .tag').count()}")

    ok = card_count > 0 and not page_errors and label_kept
    print(f"\nRESULT: {'PASS' if ok else 'FAIL'}")
    browser.close()

sys.exit(0 if ok else 1)
