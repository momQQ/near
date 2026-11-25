# NEAR: быстрый UI smoke-тест в демо-режиме (ТЗ v14.6, раздел 63).
# Нужно: pip install playwright && playwright install chromium; сервер: python3 -m http.server 8766 (из копии с ENV: "demo")
# Карта (MapLibre) и стиль заменяются заглушкой — тест не зависит от интернета.
import asyncio, sys
from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8766/app.html"
STUB = """window.maplibregl={Map:class{constructor(o){this.c={lng:o.center[0],lat:o.center[1]};this.h={};this.touchZoomRotate={disableRotation(){}};setTimeout(()=>{(this.h.load||[]).forEach(f=>f());(this.h.moveend||[]).forEach(f=>f())},30)}
on(e,a,b){(this.h[e]=this.h[e]||[]).push(b||a);return this}once(e,f){return this.on(e,f)}off(){}getCenter(){return this.c}getZoom(){return 16}jumpTo(){}easeTo(){}flyTo(){}resize(){}addSource(){}getSource(){return{setData(){}}}
addLayer(){}getLayer(){}setLayoutProperty(){}setPaintProperty(){}setFilter(){}getBounds(){const c=this.c;return{getNorth:()=>c.lat+.01,getSouth:()=>c.lat-.01,getEast:()=>c.lng+.01,getWest:()=>c.lng-.01,contains:()=>true}}
setStyle(){}isStyleLoaded(){return true}addControl(){}queryRenderedFeatures(){return[]}querySourceFeatures(){return[]}getCanvas(){return{style:{}}}fitBounds(){}},Marker:class{setLngLat(){return this}addTo(){return this}remove(){}},NavigationControl:class{}};"""
CHECKS = []
def ok(name, cond): CHECKS.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, geolocation={"latitude": 43.2389, "longitude": 76.8897}, permissions=["geolocation"])
        await ctx.route("https://unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body="" if r.request.url.endswith(".css") else STUB))
        await ctx.route("https://tiles.openfreemap.org/**", lambda r: r.fulfill(status=200, content_type="application/json", body='{"version":8,"sources":{},"layers":[]}'))
        pg = await ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(URL); await pg.wait_for_timeout(1500)
        await pg.evaluate("localStorage.setItem('near_onboarded','1')"); await pg.reload(); await pg.wait_for_timeout(1500)
        ok("лента открывается без входа", await pg.is_visible("#v-feed"))
        await pg.click("#plusBtn"); await pg.wait_for_timeout(400)
        ok("гость при нажатии + видит вход", await pg.is_visible("#f-login"))
        await pg.click("#f-login [data-auth=signup]")
        await pg.fill("#suNick", "Smoke_01"); await pg.fill("#suPw", "Almaty2026"); await pg.fill("#suEmail", "smoke@mail.kz")
        await pg.check("#f-signup [name=rules]"); await pg.click("#f-signup [type=submit]"); await pg.wait_for_timeout(1200)
        if await pg.is_visible("#f-complete"):
            await pg.fill("#cpNick", "Smoke_01"); await pg.wait_for_timeout(700); await pg.click("#f-complete [type=submit]"); await pg.wait_for_timeout(1000)
        ok("регистрация: ник + пароль + почта, без возврата на первый шаг", not await pg.is_visible("#f-signup"))
        await pg.keyboard.press("Escape")
        await pg.click("#plusBtn"); await pg.wait_for_timeout(400)
        ok("меню 'Что создать?' открывается", await pg.is_visible("[data-group=incident]"))
        await pg.click("[data-group=incident]"); await pg.wait_for_timeout(500)
        ok("нижнее меню и шапка скрыты в форме", not await pg.is_visible(".tabbar") and not await pg.is_visible(".app-top"))
        await pg.click("#mItype [data-mv=dtp]"); await pg.fill("#crText", "Smoke: ДТП на Абая, правая полоса занята")
        await pg.click("#crHere"); await pg.wait_for_timeout(500)
        await pg.click("#pubBtn"); await pg.wait_for_timeout(500)
        ok("перед публикацией показывается предпросмотр", await pg.is_visible("#pvOk"))
        await pg.click("#pvOk"); await pg.wait_for_timeout(1800)
        ok("публикация появилась в ленте", "Smoke: ДТП" in await pg.inner_text("#posts"))
        ok("в карточке есть тип происшествия", "ДТП" in await pg.inner_text("#posts .mchips"))
        # чаты: городская комната, отправка, маска
        await pg.click('.tb[data-v="v-chats"]'); await pg.wait_for_timeout(700)
        ok("чаты: городской и районные", "Алматы — общий чат" in await pg.inner_text("#chBody"))
        ok("личных диалогов и друзей нет", not await pg.is_visible("text=Друзья"))
        await pg.click("#chBody [data-room]"); await pg.wait_for_timeout(700)
        if await pg.is_visible("[data-rjoin]"): await pg.click("[data-rjoin]"); await pg.wait_for_timeout(500)
        await pg.fill("#msgIn", "Привет соседям, блять"); await pg.click("#sendBtn"); await pg.wait_for_timeout(800)
        ok("сообщение отправлено, мат скрыт", "б****" in (await pg.inner_text("#roomMsgs")).lower())
        await pg.click("#sv-room [data-back]"); await pg.wait_for_timeout(400)
        # встречи
        await pg.click('.tb[data-v="v-feed"]'); await pg.wait_for_timeout(400)
        await pg.click('#quick [data-open="sv-meets"]'); await pg.wait_for_timeout(800)
        ok("встречи рядом: список", await pg.locator("#mtList [data-meet]").count() >= 1)
        await pg.click("#mtList [data-meet]"); await pg.wait_for_timeout(700)
        ok("карточка встречи: таймер и места", "До начала" in await pg.inner_text("#mtBody") and "участник" in await pg.inner_text("#mtBody"))
        ok("нет ошибок JavaScript", not errs)
        if errs: print(errs[:5])
        await b.close()
    sys.exit(0 if all(c for _, c in CHECKS) else 1)

asyncio.run(main())
