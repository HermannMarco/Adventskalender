/* fly.js — „Kamera-Anflug" auf ein Türchen (Phase 0 der Öffnungs-Animation).
 *
 * Idee: Bevor sich die Tür öffnet, zoomt die GANZE Bühne (Hintergrundbild +
 * Nachbartüren) auf die angetippte Tür zu — es wirkt, als flöge man auf sie zu.
 * Umgesetzt mit einem einzigen CSS-Transform auf .calendar-stage:
 *
 *   transform-origin: <x>% <y>%   → der Skalier-Mittelpunkt IST die Tür,
 *                                   sie bleibt beim Zoomen an ihrem Ort
 *   transform: translate(dx,dy) scale(s)
 *                                 → dieselbe Tür wandert zusätzlich in die
 *                                   Bildmitte (dx/dy), dahin fliegt man
 *
 * Die Animation selbst macht die `transition` auf .calendar-stage in
 * css/app.css — hier wird nur gerechnet und gesetzt (keine Render-Loop).
 *
 * Wird von index.html (echte App) UND von anflug-vorschau.html geladen, damit
 * die Vorschau garantiert denselben Anflug zeigt wie die App.
 */
window.AKFly = (function () {
  'use strict';

  /** Dauer des Anflugs. MUSS zur transition-Dauer von .calendar-stage in
   *  css/app.css passen — test_router.js vergleicht beide Werte.
   *  Vom User in anflug-vorschau.html gewählt (03.09.2026): 1300 ms. */
  const DURATION_MS = 1300;

  /** Wie groß die Tür am Ende des Anflugs sein soll — als Anteil der Zielbox,
   *  in die sie danach per FLIP weiterwächst. Vom User gewählt (03.09.2026):
   *  0.85 = „stark", man ist am Ende fast heran, die letzte Strecke läuft mit
   *  abdunkelndem Hintergrund. Bewusst < 1: bei 1.0 müsste das Hintergrundbild
   *  noch weiter hochskaliert werden und wird sichtbar unscharf.
   *  Praktisch bremst auf dem Handy ohnehin MAX_SCALE (siehe unten). */
  const AIM = 0.85;

  const MIN_SCALE = 2.0;    // darunter merkt man den Anflug kaum
  /** Obergrenze. 03.09.2026 von 4.6 auf 5.5 erhöht, weil AIM = 0.85 („stark")
   *  auf dem iPhone sonst an der Grenze hängen bleibt und dort schwächer wirkt
   *  als auf dem PC, an dem der User den Wert ausgesucht hat. Zwei Dinge
   *  begrenzen nach oben: das Hintergrundbild (1536×1024) wird beim Zoomen
   *  weich, und die Bühne muss als Textur in den Grafikspeicher passen —
   *  iPhone quer landet bei 5.23× ≈ 9 Megapixel, das ist unkritisch.
   *  test_router.js hält beide Schranken fest. */
  const MAX_SCALE = 5.5;

  /** Stärke des abdunkelnden Tunnel-Rands während des Anflugs. Gestaltet wird
   *  er in css/app.css (--fly-dim); der Wert steht hier nur, damit die
   *  Vorschauseite denselben Ausgangswert anzeigt — test_router.js vergleicht
   *  beide, damit sie nicht auseinanderlaufen. */
  const DIM_DEFAULT = 0.85;

  /** Position der Tür in Prozent der Bühne. Die Türen werden in app.js über
   *  style.left/top in % gesetzt (doorLayout) — genau das Format, das
   *  transform-origin braucht, und stabil bei Größenänderung. */
  function doorPct(doorEl) {
    const x = parseFloat(doorEl.style.left);
    const y = parseFloat(doorEl.style.top);
    return { x: Number.isFinite(x) ? x : 50, y: Number.isFinite(y) ? y : 50 };
  }

  /** Zoomfaktor: so weit heran, dass die Tür ~aim der Zielbox füllt.
   *  `aim` nur für die Vorschauseite (Vergleich verschiedener Stärken). */
  function scaleFor(doorW, targetW, aim) {
    const a = Number.isFinite(aim) ? aim : AIM;
    if (!doorW || !targetW) return MIN_SCALE;
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, (targetW * a) / doorW));
  }

  /** Zielbox der geöffneten Tür (zentriert, Seitenverhältnis 3:4).
   *  Steht hier und nicht in app.js, weil der Anflugfaktor sich auf genau
   *  diese Breite bezieht — App und Vorschau rechnen so mit denselben Maßen.
   *  Faktoren bewusst wie am 01.09.2026 abgestimmt (Querformat unverändert). */
  function targetBox(vw, vh) {
    const w = Math.min(420, vw * 0.9, (vh * 0.82) * 3 / 4);
    const h = w * 4 / 3;
    return { w: w, h: h, left: (vw - w) / 2, top: (vh - h) / 2 };
  }

  /** Reine Rechnung (ohne DOM): liefert transform-origin + transform, die die
   *  Tür bei (xPct,yPct) in die Mitte der Bühne holen und um `scale` zoomen.
   *  Annahme: die Bühne füllt in der Nutzer-Ansicht den Viewport
   *  (.stage-screen ist position:fixed inset:0) — Bühnenmitte = Bildmitte. */
  function transformFor(o) {
    const dx = o.stageW * (0.5 - o.xPct / 100);
    const dy = o.stageH * (0.5 - o.yPct / 100);
    return {
      origin: o.xPct.toFixed(2) + '% ' + o.yPct.toFixed(2) + '%',
      transform: 'translate(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px) scale(' + o.scale.toFixed(3) + ')',
      dx: dx, dy: dy,
    };
  }

  /** Transform auf die Bühne schreiben (auch zum Neuberechnen beim Drehen). */
  function apply(stage, doorEl, scale) {
    const p = doorPct(doorEl);
    const t = transformFor({
      xPct: p.x, yPct: p.y,
      stageW: stage.offsetWidth, stageH: stage.offsetHeight,   // Layoutmaße, vom Transform unbeeinflusst
      scale: scale,
    });
    stage.style.transformOrigin = t.origin;
    stage.style.transform = t.transform;
    return t;
  }

  /** Startet den Anflug. `targetW` = Breite der Tür-Zielbox in px.
   *  `opts` = { aim, durationMs } — nur die Vorschauseite setzt das, die App
   *  nimmt die Werte von hier bzw. aus css/app.css.
   *  Rückgabe: { scale, done: Promise, reapply() } — `done` erfüllt, wenn der
   *  Anflug sitzt; `reapply()` rechnet nach einem Drehen/Resize neu. */
  function flyTo(stage, doorEl, targetW, opts) {
    if (!stage || !doorEl) return { scale: 1, done: Promise.resolve(), reapply: function () {} };
    const o = opts || {};
    const dur = Number.isFinite(o.durationMs) ? o.durationMs : DURATION_MS;
    if (Number.isFinite(o.durationMs)) stage.style.transitionDuration = o.durationMs + 'ms';

    const scale = scaleFor(doorEl.getBoundingClientRect().width, targetW, o.aim);
    document.body.classList.add('door-flying');
    apply(stage, doorEl, scale);

    const done = new Promise(function (resolve) {
      let fired = false;
      const finish = function (e) {
        // transitionend blubbert auch von den Türen herauf (die haben eigene
        // transform-Transitions) → nur das Transform der Bühne selbst zählt.
        if (e && (e.target !== stage || e.propertyName !== 'transform')) return;
        if (fired) return;
        fired = true;
        stage.removeEventListener('transitionend', finish);
        clearTimeout(timer);
        resolve();
      };
      stage.addEventListener('transitionend', finish);
      // Sicherheitsnetz: fällt die Transition aus (Hintergrund-Tab, reduzierte
      // Bewegung, unterdrücktes Event), darf das Türchen nicht hängen bleiben.
      const timer = setTimeout(finish, dur + 250);
    });

    return { scale: scale, done: done, reapply: function () { return apply(stage, doorEl, scale); } };
  }

  /** Zurückfliegen: Transform lösen (die transition animiert zurück).
   *  transform-origin bleibt bewusst stehen — würde man ihn sofort
   *  zurücksetzen, springt die Bühne statt zu gleiten. */
  function reset(stage) {
    document.body.classList.remove('door-flying');
    if (stage) stage.style.transform = '';
  }

  return {
    flyTo: flyTo, reset: reset, apply: apply,
    transformFor: transformFor, scaleFor: scaleFor, doorPct: doorPct, targetBox: targetBox,
    DURATION_MS: DURATION_MS, AIM: AIM, MIN_SCALE: MIN_SCALE, MAX_SCALE: MAX_SCALE,
    DIM_DEFAULT: DIM_DEFAULT,
  };
})();
