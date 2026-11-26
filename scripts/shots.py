#!/usr/bin/env python3
"""Drive Chromium to capture Relay screenshots against an already-running server."""
import sys, time
from playwright.sync_api import sync_playwright

URL = "http://localhost:8787"
OUT = "/Users/andersonchen/conductor/workspaces/andos/denver/.context"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1480, "height": 940}, device_scale_factor=2)
        page.goto(URL, wait_until="networkidle")
        time.sleep(2.0)  # let fonts + first events settle

        # --- Shot 1: live feed (agents mid-run) ---
        time.sleep(4.0)
        page.screenshot(path=f"{OUT}/feed-live.png", full_page=True)
        print("saved feed-live.png")

        # --- Shot 2: Voice HUD open with live routing preview ---
        box = page.get_by_placeholder("Say it").first
        box.click()
        page.keyboard.type("find me a quiet hotel in kyoto with a garden and book two nights", delay=18)
        time.sleep(1.2)  # panel + preview animate in
        page.screenshot(path=f"{OUT}/voice-hud.png", full_page=False)
        print("saved voice-hud.png")

        # clear the input so it doesn't overlay the final shot
        if sys.platform == "darwin":
            page.keyboard.press("Meta+A")
        else:
            page.keyboard.press("Control+A")
        page.keyboard.press("Backspace")
        page.keyboard.press("Escape")
        page.mouse.click(740, 300)

        # --- Shot 3: everything completed ---
        time.sleep(16.0)
        page.mouse.click(740, 300)
        time.sleep(0.5)
        page.screenshot(path=f"{OUT}/feed-final.png", full_page=True)
        print("saved feed-final.png")

        browser.close()


if __name__ == "__main__":
    main()
