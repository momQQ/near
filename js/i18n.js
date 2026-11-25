/* =====================================================
   NEAR — языки интерфейса: русский (основной) и казахский (бета)
   Перевод работает по словарю: русская строка интерфейса → казахская.
   Пользовательский текст (публикации, комментарии, сообщения, имена)
   не переводится: такие блоки помечены translate="no".
   ===================================================== */
(function () {
  const KEY = "near_lang";
  let lang = "ru";
  try { lang = localStorage.getItem(KEY) || ((navigator.language || "").toLowerCase().startsWith("kk") ? "kz" : "ru"); } catch (e) {}
  if (lang !== "kz") lang = "ru";

  // казахский словарь — отдельным файлом, только если выбран казахский язык
  if (lang === "kz" && !window.NEAR_KZ) {
    const min = !!document.querySelector('script[src*="i18n.min.js"]');
    document.write('<script src="js/i18n-kz' + (min ? ".min" : "") + '.js"><\/script>');
  }
  const D = () => window.NEAR_KZ || { KZ: {}, RX: [] };
  function tr(s) {
    if (lang !== "kz" || !s) return s;
    const k = s.trim(); if (!k) return s;
    const { KZ, RX } = D();
    let v = KZ[k];
    if (v === undefined) for (const [re, rep] of RX) { if (re.test(k)) { v = k.replace(re, rep); break; } }
    if (v === undefined) return s;
    return s.replace(k, v);
  }
  const ATTRS = ["placeholder", "title", "aria-label"];
  const skip = (n) => { const el = n.nodeType === 1 ? n : n.parentElement; return !el || !!el.closest('[translate="no"],script,style,textarea'); };
  function applyNode(n) {
    if (n.nodeType === 3) { if (!skip(n)) { const v = tr(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; } return; }
    if (n.nodeType !== 1 || skip(n)) return;
    ATTRS.forEach((a) => { const v = n.getAttribute(a); if (v) { const t = tr(v); if (t !== v) n.setAttribute(a, t); } });
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let x; while ((x = w.nextNode())) {
      if (x.nodeType === 3) { if (!skip(x)) { const v = tr(x.nodeValue); if (v !== x.nodeValue) x.nodeValue = v; } }
      else if (!skip(x)) ATTRS.forEach((a) => { const v = x.getAttribute(a); if (v) { const t = tr(v); if (t !== v) x.setAttribute(a, t); } });
    }
  }
  let mo = null;
  function observe() {
    if (mo || lang !== "kz" || !("MutationObserver" in window)) return;
    applyNode(document.body);
    mo = new MutationObserver((list) => list.forEach((m) => {
      if (m.type === "characterData") applyNode(m.target);
      else if (m.type === "attributes") applyNode(m.target);
      else m.addedNodes.forEach(applyNode);
    }));
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  window.NEAR_I18N = {
    get lang() { return lang; },
    locale: () => (lang === "kz" ? "kk-KZ" : "ru-RU"),
    t: tr,
    setLang(l) { try { localStorage.setItem(KEY, l === "kz" ? "kz" : "ru"); } catch (e) {} location.reload(); },
    start() { document.documentElement.lang = lang === "kz" ? "kk" : "ru"; observe(); },
    size: () => Object.keys(D().KZ).length
  };
})();
