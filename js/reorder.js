/* reorder.js — Reihenfolge von Inhalts-Karten im Türchen-Editor ändern.
 *
 * Zwei Wege, beide führen auf dieselbe Rechnung:
 *   1. Ziehen am Greifpunkt (⠿) — mit Maus UND Finger, über Pointer-Events.
 *      Bewusst NICHT die HTML5-Drag-&-Drop-API: die kennt auf dem iPhone kein
 *      Touch-Ziehen. Während des Ziehens werden die anderen Karten per
 *      transform verschoben, damit eine Lücke aufgeht — im DOM passiert erst
 *      beim Loslassen etwas (ein einziges onMove).
 *   2. Die ▲▼-Knöpfe in app.js — die rufen `move()` direkt auf. Sie sind der
 *      Weg für Tastatur/Screenreader und der Notausgang, falls das Ziehen im
 *      scrollenden Dialog hakt.
 *
 * `move(arr, from, to)` ist reine Logik ohne DOM und wird von test_router.js
 * direkt ausgeführt. Wird von index.html (echte App) UND von
 * inhalte-vorschau.html geladen, damit die Vorschau dasselbe Ziehen zeigt.
 */
window.AKReorder = (function () {
  'use strict';

  /** Abstand zum Rand des Scrollbereichs, ab dem beim Ziehen mitgescrollt wird.
   *  Nötig, weil der Türchen-Dialog (.modal-card, overflow:auto) bei mehreren
   *  Inhalten höher als der Bildschirm ist — ohne Mitscrollen käme man nicht an
   *  Position 1, wenn Karte 5 unten aus dem Bild hängt. */
  const EDGE = 52;
  const SCROLL_MAX = 16;   // px pro Frame

  /** Element an Position `from` nach Position `to` schieben (verschieben, nicht
   *  tauschen — die Karten dazwischen rutschen einen Platz weiter).
   *  Mutiert `arr` und gibt es zurück. `to` wird auf gültige Grenzen geklemmt,
   *  damit „nach oben" auf Platz 1 und „nach unten" auf dem letzten Platz
   *  einfach nichts tun statt aus dem Array zu laufen. */
  function move(arr, from, to) {
    if (!Array.isArray(arr)) return arr;
    const n = arr.length;
    if (!(from >= 0 && from < n)) return arr;
    const t = Math.max(0, Math.min(n - 1, to));
    if (t === from) return arr;
    arr.splice(t, 0, arr.splice(from, 1)[0]);
    return arr;
  }

  /** Nächster scrollender Vorfahr (der Dialog). null = niemand scrollt. */
  function scrollParent(node) {
    for (let e = node && node.parentElement; e; e = e.parentElement) {
      const ov = getComputedStyle(e).overflowY;
      if ((ov === 'auto' || ov === 'scroll') && e.scrollHeight > e.clientHeight + 1) return e;
    }
    return null;
  }

  /** Ziehen aktivieren. `list` ist der Container der Karten.
   *  opts = { itemSelector, handleSelector, scrollEl, onMove(from,to), onStart, onEnd }
   *  Der pointerdown-Listener hängt am Container selbst (Delegation) — später
   *  hinzugefügte Karten sind damit automatisch ziehbar, und mit dem Dialog
   *  verschwindet der Listener.
   *  Rückgabe: { destroy() }. */
  function attach(list, opts) {
    const o = opts || {};
    const itemSel = o.itemSelector || '.item-card';
    const handleSel = o.handleSelector || '.item-drag';
    const onMove = typeof o.onMove === 'function' ? o.onMove : function () {};
    let drag = null;

    function items() {
      return Array.prototype.filter.call(list.children, function (n) { return n.matches(itemSel); });
    }

    function onDown(ev) {
      if (drag) return;
      if (ev.button > 0) return;                       // nur linke Maustaste
      const handle = ev.target.closest && ev.target.closest(handleSel);
      if (!handle || !list.contains(handle)) return;
      const item = handle.closest(itemSel);
      if (!item) return;
      const nodes = items();
      const from = nodes.indexOf(item);
      if (from < 0 || nodes.length < 2) return;        // eine Karte allein: nichts zu ordnen

      ev.preventDefault();                             // kein Markieren, kein Wisch-Scrollen
      const rects = nodes.map(function (n) { return n.getBoundingClientRect(); });
      const tops = rects.map(function (r) { return r.top; });
      // Höhe eines „Platzes" = Abstand zweier Karten (Höhe + Rand). Um genau so
      // viel rücken die übersprungenen Karten zur Seite.
      const slot = from < nodes.length - 1 ? tops[from + 1] - tops[from]
                 : from > 0 ? tops[from] - tops[from - 1]
                 : rects[from].height;
      const scrollEl = o.scrollEl || scrollParent(list);

      drag = {
        handle: handle, item: item, nodes: nodes, rects: rects, tops: tops, slot: slot,
        from: from, to: from,
        startY: ev.clientY, pointerY: ev.clientY,
        scrollEl: scrollEl, startScroll: scrollEl ? scrollEl.scrollTop : 0,
        vel: 0, raf: 0,
      };
      list.classList.add('reordering');
      item.classList.add('dragging');
      // Pointer-Capture: der Finger/Zeiger darf den Greifpunkt verlassen, die
      // Events kommen weiter an (sonst reißt das Ziehen bei schneller Bewegung ab).
      try { handle.setPointerCapture(ev.pointerId); } catch (_) { /* egal */ }
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
      if (o.onStart) o.onStart(from);
      render();
    }

    function onPointerMove(ev) {
      if (!drag) return;
      ev.preventDefault();
      drag.pointerY = ev.clientY;
      autoScroll();
      render();
    }

    /** Verschiebung der gezogenen Karte gegenüber ihrer Ausgangslage.
     *  Der Scroll-Anteil muss mit hinein: die Rechtecke wurden vor dem
     *  Mitscrollen vermessen, sonst sitzt die Karte nach dem Scrollen versetzt
     *  unter dem Finger und die Zielposition wäre falsch. */
    function offset() {
      const scrolled = drag.scrollEl ? drag.scrollEl.scrollTop - drag.startScroll : 0;
      return (drag.pointerY - drag.startY) + scrolled;
    }

    function render() {
      const d = offset();
      const n = drag.nodes.length;
      const top = drag.tops[drag.from] + d;
      const bottom = top + drag.rects[drag.from].height;
      // Zielposition: die gezogene Karte übernimmt den Platz, sobald sie die
      // Mitte des Nachbarn überschritten hat.
      let to = drag.from;
      while (to > 0 && top < drag.tops[to - 1] + drag.rects[to - 1].height / 2) to--;
      while (to < n - 1 && bottom > drag.tops[to + 1] + drag.rects[to + 1].height / 2) to++;
      drag.to = to;

      drag.item.style.transform = 'translateY(' + d.toFixed(1) + 'px)';
      for (let i = 0; i < n; i++) {
        if (i === drag.from) continue;
        let shift = 0;
        if (to > drag.from && i > drag.from && i <= to) shift = -drag.slot;
        else if (to < drag.from && i >= to && i < drag.from) shift = drag.slot;
        drag.nodes[i].style.transform = shift ? 'translateY(' + shift.toFixed(1) + 'px)' : '';
      }
    }

    function autoScroll() {
      const el = drag.scrollEl;
      if (!el) return;
      const r = el.getBoundingClientRect();
      let v = 0;
      if (drag.pointerY < r.top + EDGE) v = -Math.min(SCROLL_MAX, (r.top + EDGE - drag.pointerY) / 3);
      else if (drag.pointerY > r.bottom - EDGE) v = Math.min(SCROLL_MAX, (drag.pointerY - (r.bottom - EDGE)) / 3);
      drag.vel = v;
      if (v && !drag.raf) drag.raf = requestAnimationFrame(tick);
    }

    function tick() {
      if (!drag) return;
      drag.raf = 0;
      if (!drag.vel) return;
      const el = drag.scrollEl;
      const before = el.scrollTop;
      el.scrollTop = before + drag.vel;
      if (el.scrollTop === before) return;             // Ende erreicht → nicht weiter drehen
      render();
      drag.raf = requestAnimationFrame(tick);
    }

    function onPointerUp(ev) {
      if (!drag) return;
      const d = drag;
      drag = null;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      if (d.raf) cancelAnimationFrame(d.raf);
      try { if (ev && ev.pointerId != null) d.handle.releasePointerCapture(ev.pointerId); } catch (_) { /* egal */ }
      // Transforms ohne Nachlauf lösen: unmittelbar danach hängt der Aufrufer die
      // Karten in der neuen Reihenfolge um. Liefe die transform-Transition dabei
      // noch, glitte jede Karte von ihrem neuen Platz sichtbar wieder zurück.
      d.nodes.forEach(function (n) { n.style.transition = 'none'; n.style.transform = ''; });
      d.item.classList.remove('dragging');
      list.classList.remove('reordering');
      // Erst hier wird wirklich umsortiert — ein Aufruf pro Ziehen.
      if (d.to !== d.from) onMove(d.from, d.to);
      if (o.onEnd) o.onEnd(d.from, d.to);
      // ab dem nächsten Frame wieder animieren (▲▼ sollen weiter gleiten)
      requestAnimationFrame(function () {
        d.nodes.forEach(function (n) { n.style.transition = ''; });
      });
    }

    list.addEventListener('pointerdown', onDown);
    return {
      destroy: function () {
        list.removeEventListener('pointerdown', onDown);
        if (drag) onPointerUp(null);
      },
    };
  }

  return { move: move, attach: attach, scrollParent: scrollParent, EDGE: EDGE, SCROLL_MAX: SCROLL_MAX };
})();
