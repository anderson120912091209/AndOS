import time
from playwright.sync_api import sync_playwright
URL="http://localhost:8787"; OUT="/Users/andersonchen/conductor/workspaces/andos/denver/.context"
def states(page):
    r=page.request.get(f"{URL}/api/tasks").json()["tasks"]
    agents=[t for t in r if t["kind"]=="agent"]
    run=[t for t in agents if t["status"]=="running"]
    q=[t for t in agents if t["status"] in ("queued","claimed")]
    done=[t for t in agents if t["status"]=="done"]
    return run,q,done
with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    pg=b.new_page(viewport={"width":1480,"height":940},device_scale_factor=2)
    pg.goto(URL,wait_until="networkidle"); time.sleep(1.2)
    # wait for a live mix: >=1 running AND (>=1 queued OR >=1 done)
    for _ in range(60):
        run,q,done=states(pg)
        if run and (q or done): break
        time.sleep(0.3)
    time.sleep(0.4)
    pg.screenshot(path=f"{OUT}/feed-live.png",full_page=True)
    print("live:",len(run),"running",len(q),"queued",len(done),"done")
    # hero: scroll a running card into view, viewport shot
    try:
        card=pg.get_by_text("Working",exact=False).first
        card.scroll_into_view_if_needed(); time.sleep(0.4)
        pg.screenshot(path=f"{OUT}/hero.png",full_page=False)
        print("saved hero.png")
    except Exception as e:
        print("hero skip",e)
    # wait for all agents done
    for _ in range(80):
        run,q,done=states(pg)
        if not run and not q and done: break
        time.sleep(0.4)
    pg.scroll_into_view_if_needed if False else None
    pg.evaluate("window.scrollTo(0,0)"); time.sleep(0.4)
    pg.screenshot(path=f"{OUT}/feed-final.png",full_page=True)
    print("final done")
    b.close()
