/* snow.js — leichter Schneefall über der Kalender-Bühne.
 * Rein CSS-animiert (keine Render-Loop): je Flocke werden Größe, Deckkraft,
 * Fallzeit und Seitwärts-Drift als CSS-Variablen/Inline-Styles gesetzt, die
 * Animation selbst läuft in css/app.css (@keyframes flake-fall / flake-sway).
 *
 * Wird von index.html (echte App) UND von schnee-vorschau.html geladen, damit
 * die Vorschau garantiert denselben Schnee zeigt wie die App.
 */
window.AKSnow = (function () {
  'use strict';

  /** Vom User in der Vorschau gewählte Dichte (16.07./01.09.2026: 90 Flocken). */
  const DEFAULT_COUNT = 90;

  /** Baut die Schnee-Schicht. `count` = Anzahl Flocken (ohne Angabe: DEFAULT_COUNT).
   *  Rückgabe: <div class="snow-layer"> zum Einhängen in .calendar-stage. */
  function build(count) {
    const n = Number.isFinite(count) ? count : DEFAULT_COUNT;
    const layer = document.createElement('div');
    layer.className = 'snow-layer';
    layer.setAttribute('aria-hidden', 'true');

    for (let i = 0; i < n; i++) {
      const size = 2 + Math.random() * 4.5;      // 2–6,5 px: feine Flocken
      const fall = 12 + Math.random() * 14;      // 12–26 s: langsam = „leicht"
      const f = document.createElement('div');
      f.className = 'flake';
      f.style.left = (Math.random() * 100).toFixed(2) + '%';
      f.style.setProperty('--size', size.toFixed(1) + 'px');
      f.style.setProperty('--op', (0.35 + Math.random() * 0.45).toFixed(2));
      f.style.setProperty('--blur', size < 3.2 ? '0.7px' : '0px');   // kleine Flocken = „weiter weg"
      f.style.setProperty('--sway', (6 + Math.random() * 16).toFixed(0) + 'px');
      f.style.setProperty('--sway-dur', (2.5 + Math.random() * 3.5).toFixed(1) + 's');
      f.style.animationDuration = fall.toFixed(1) + 's';
      // Negatives Delay: die Flocken sind sofort über die ganze Höhe verteilt,
      // es „regnet" nicht erst sichtbar von oben ein.
      f.style.animationDelay = (-Math.random() * fall).toFixed(1) + 's';
      layer.appendChild(f);
    }
    return layer;
  }

  return { build: build, DEFAULT_COUNT: DEFAULT_COUNT };
})();
