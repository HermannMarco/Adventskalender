/* app.js — Adventskalender: Router, Editor-View, User-View.
 * Verschlüsselung über window.AKCrypto (crypto.js). Der abgeleitete
 * AES-Schlüssel lebt nur im Speicher (state.key) — kein Persistieren.
 */
(function () {
  'use strict';

  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const storage = firebase.storage();

  const DAYS = 24;
  const DEFAULT_BG = 'Hintergrund.png';   // Fallback-Hintergrund (Weihnachtsdorf)
  const TYPES = [
    { id: 'text',    label: '✍️ Spruch/Text' },
    { id: 'image',   label: '🖼️ Bild' },
    { id: 'video',   label: '🎬 Video' },
    { id: 'file',    label: '📎 Datei' },
    { id: 'voucher', label: '🎟️ Gutschein' },
  ];

  const state = {
    calId: null,     // aktiver Kalender
    key: null,       // abgeleiteter CryptoKey (nur im Speicher)
    cal: null,       // Kalender-Dokumentdaten
    preview: false,  // Bearbeiter-Vorschau (Datums-Lock aus)
  };

  /** Normalisiert ein Türchen-Dokument auf eine Inhalts-Liste.
   *  Rückwärtskompatibel zum alten Einzel-Item-Schema
   *  {type,payload,storagePath,fileMeta,caption}. */
  function doorItems(data) {
    if (!data) return [];
    if (Array.isArray(data.items)) return data.items;
    if (data.type) return [{
      type: data.type,
      payload: data.payload || null,
      storagePath: data.storagePath || null,
      fileMeta: data.fileMeta || null,
      caption: data.caption || null,
    }];
    return [];
  }

  // ---- DOM-Helfer ---------------------------------------------------------
  const $ = sel => document.querySelector(sel);
  const view = () => $('#view');

  function el(tag, opts = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, v);
    }
    (Array.isArray(kids) ? kids : [kids]).forEach(k => {
      if (k == null) return;
      e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    });
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function mount(node) {
    document.body.classList.remove('stage-mode');  // Vollbild-Kalender nur in der Nutzer-Ansicht
    document.body.classList.remove('door-open');   // Schnee-Pause zurücksetzen
    const v = view(); clear(v); v.appendChild(node);
  }

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function openModal(node) {
    const b = $('#modalBody'); clear(b); b.appendChild(node);
    $('#modal').classList.remove('hidden');
  }
  function closeModal() {
    $('#modal').classList.add('hidden');
    clear($('#modalBody'));
  }
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  function setTopActions(nodes) {
    const bar = $('#topActions'); clear(bar);
    (nodes || []).forEach(n => bar.appendChild(n));
  }
  $('#brandHome').addEventListener('click', () => {
    // zurück je nach Kontext: Bearbeiter -> Kalenderliste, sonst neu laden
    if (params().has('edit') && auth.currentUser) { state.calId = null; state.key = null; renderCalendarList(); }
    else location.href = 'index.html';
  });

  // ---- Router -------------------------------------------------------------
  function params() { return new URLSearchParams(location.search); }

  function route() {
    const p = params();
    if (p.has('cal')) { rememberLastCal(p.get('cal')); return renderUserView(p.get('cal')); }
    if (p.has('edit')) return renderEditorGate();
    // Als PWA installiert startet die App immer auf start_url ('./') — der
    // '?cal=<id>'-Teil des Einladungslinks fehlt dann. Deshalb den zuletzt
    // geöffneten Kalender wiederherstellen, statt auf der Landing zu stranden.
    const last = lastCal();
    if (last) return openCalendar(last);
    return renderLanding();
  }

  /** Kalender öffnen und die Adresse mitziehen, damit Neuladen ihn behält. */
  function openCalendar(calId) {
    rememberLastCal(calId);
    try { history.replaceState({}, '', 'index.html?cal=' + encodeURIComponent(calId)); } catch (_) { /* egal */ }
    return renderUserView(calId);
  }

  /** Holt die Kalender-ID aus einem eingefügten Einladungslink — oder nimmt eine
   *  direkt eingegebene ID. Toleriert Leerzeichen und Text um den Link herum. */
  function extractCalId(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const m = s.match(/[?&]cal=([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{4,}$/.test(s)) return s;      // direkt eingegebene ID
    return null;
  }

  function renderLanding() {
    setTopActions([]);
    const inp = el('input', {
      type: 'text', placeholder: 'https://…/Adventskalender/?cal=…',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    });
    const err = el('div', { class: 'error' });
    const open = () => {
      const id = extractCalId(inp.value);
      if (!id) {
        err.textContent = 'Darin steckt keine Kalender-ID. Am einfachsten den kompletten Einladungslink einfügen.';
        return;
      }
      err.textContent = '';
      openCalendar(id);
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });

    mount(el('div', { class: 'panel center' }, [
      el('h2', { text: '🎄 Adventskalender' }),
      el('p', { class: 'sub', text: 'Verschlüsselte Türchen voller Überraschungen.' }),
      el('div', { class: 'stack' }, [
        el('p', { class: 'hint', text: 'Du hast einen Einladungslink erhalten? Öffne ihn direkt — er enthält deinen Kalender. Das Passwort bekommst du separat.' }),
        el('p', { class: 'hint', text: 'Die App vom Startbildschirm geöffnet und hier gelandet? Dann füge einmalig deinen Einladungslink ein — danach startet die App direkt im Kalender.' }),
        el('label', { class: 'field' }, [el('span', { text: 'Einladungslink oder Kalender-ID' }), inp]),
        el('button', { class: 'btn', text: '🎄 Kalender öffnen', onclick: open }),
        err,
        el('button', { class: 'btn secondary', onclick: () => location.href = 'index.html?edit', text: 'Als Bearbeiter anmelden' }),
      ]),
    ]));
  }

  // ============================================================
  //  EDITOR
  // ============================================================
  function renderEditorGate() {
    setTopActions([]);
    auth.onAuthStateChanged(user => {
      if (user) renderCalendarList();
      else renderLogin();
    });
  }

  function renderLogin() {
    const email = el('input', { type: 'email', placeholder: 'E-Mail', autocomplete: 'username' });
    const pw = el('input', { type: 'password', placeholder: 'Passwort', autocomplete: 'current-password' });
    const err = el('div', { class: 'error' });
    const submit = () => {
      err.textContent = '';
      auth.signInWithEmailAndPassword(email.value.trim(), pw.value)
        .catch(e => err.textContent = mapAuthError(e));
    };
    pw.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    mount(el('div', { class: 'panel' }, [
      el('h2', { text: 'Bearbeiter-Login' }),
      el('p', { class: 'sub', text: 'Anmeldung für das Befüllen der Kalender.' }),
      el('label', { class: 'field' }, [el('span', { text: 'E-Mail' }), email]),
      el('label', { class: 'field' }, [el('span', { text: 'Passwort' }), pw]),
      el('button', { class: 'btn', onclick: submit, text: 'Anmelden' }),
      err,
    ]));
  }

  function mapAuthError(e) {
    const m = (e && e.code) || '';
    if (m.includes('invalid-credential') || m.includes('wrong-password') || m.includes('user-not-found'))
      return 'E-Mail oder Passwort falsch.';
    if (m.includes('too-many-requests')) return 'Zu viele Versuche. Später erneut probieren.';
    return 'Anmeldung fehlgeschlagen: ' + (e.message || m);
  }

  async function renderCalendarList() {
    setTopActions([
      el('button', { class: 'btn small ghost', text: 'Abmelden', onclick: () => auth.signOut().then(renderLogin) }),
    ]);
    mount(el('div', { class: 'spinner', text: 'Lade Kalender…' }));
    let snap;
    try {
      snap = await db.collection('calendars').where('ownerUid', '==', auth.currentUser.uid).get();
    } catch (e) { mount(errorPanel('Kalender konnten nicht geladen werden.', e)); return; }

    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''));

    const list = el('div', { class: 'cal-list' });
    list.appendChild(el('div', { class: 'row between' }, [
      el('h2', { text: 'Meine Kalender', style: 'color:#fff;margin:0;' }),
      el('button', { class: 'btn', text: '+ Neuer Kalender', onclick: showCreateCalendar }),
    ]));

    if (!items.length) {
      list.appendChild(el('p', { class: 'hint', style: 'color:#cfe;', text: 'Noch keine Kalender. Lege den ersten an.' }));
    }
    items.forEach(c => {
      list.appendChild(el('div', { class: 'cal-item' }, [
        el('div', {}, [
          el('h3', { text: c.title || '(ohne Titel)' }),
          el('div', { class: 'meta', text: `Jahr ${c.lock?.year ?? '—'} · ${c.lock?.enabled ? 'Datums-Lock an' : 'immer offen'}` }),
        ]),
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn small', text: 'Befüllen', onclick: () => openCalendarEditor(c) }),
          el('button', { class: 'btn small secondary', text: 'Teilen', onclick: () => showShare(c) }),
          el('button', { class: 'btn small danger', text: 'Löschen', onclick: () => confirmDeleteCalendar(c) }),
        ]),
      ]));
    });
    mount(list);
  }

  function errorPanel(msg, e) {
    console.error(e);
    return el('div', { class: 'panel' }, [
      el('h2', { text: 'Fehler' }),
      el('p', { class: 'sub', text: msg }),
      e ? el('p', { class: 'hint', text: String(e.message || e) }) : null,
    ]);
  }

  // ---- Kalender anlegen ---------------------------------------------------
  function showCreateCalendar() {
    const title = el('input', { type: 'text', placeholder: 'z. B. Für Oma' });
    const year = el('input', { type: 'number', value: String(new Date().getFullYear()), min: '2020', max: '2100' });
    const lock = el('input', { type: 'checkbox' }); lock.checked = true;
    const pw = el('input', { type: 'password', placeholder: 'E2E-Passwort', autocomplete: 'new-password' });
    const pw2 = el('input', { type: 'password', placeholder: 'Passwort wiederholen', autocomplete: 'new-password' });
    const hintInp = el('input', { type: 'text', placeholder: 'optional, z. B. „unser Hochzeitsdatum"' });
    const err = el('div', { class: 'error' });

    const save = async () => {
      err.textContent = '';
      if (!title.value.trim()) return err.textContent = 'Bitte einen Titel angeben.';
      if (pw.value.length < 6) return err.textContent = 'Passwort mind. 6 Zeichen.';
      if (pw.value !== pw2.value) return err.textContent = 'Passwörter stimmen nicht überein.';
      try {
        const salt = AKCrypto.newSalt();
        const key = await AKCrypto.deriveKey(pw.value, salt);
        const verifier = await AKCrypto.makeVerifier(key);
        const ref = await db.collection('calendars').add({
          ownerUid: auth.currentUser.uid,
          title: title.value.trim(),
          kdf: { salt, iterations: AKCrypto.KDF_ITERATIONS, hash: AKCrypto.KDF_HASH },
          verifier,
          passwordHint: hintInp.value.trim() || null,
          lock: { enabled: lock.checked, year: parseInt(year.value, 10) || new Date().getFullYear() },
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        closeModal();
        toast('Kalender angelegt.');
        openCalendarEditor({ id: ref.id, title: title.value.trim(), kdf: { salt }, lock: { enabled: lock.checked, year: parseInt(year.value, 10) } }, key);
      } catch (e) { err.textContent = 'Anlegen fehlgeschlagen: ' + (e.message || e); }
    };

    openModal(el('div', {}, [
      el('h2', { text: 'Neuer Kalender' }),
      el('label', { class: 'field' }, [el('span', { text: 'Titel (bleibt unverschlüsselt als Label)' }), title]),
      el('label', { class: 'field' }, [el('span', { text: 'Jahr' }), year]),
      el('label', { class: 'field row' }, [lock, el('span', { text: ' Türchen erst am jeweiligen Dezembertag öffnen', style: 'margin:0;' })]),
      el('label', { class: 'field' }, [el('span', { text: 'E2E-Passwort (getrennt an den Empfänger geben!)' }), pw]),
      el('label', { class: 'field' }, [el('span', { text: 'Passwort wiederholen' }), pw2]),
      el('label', { class: 'field' }, [el('span', { text: 'Passwort-Hinweis (unverschlüsselt, optional)' }), hintInp]),
      el('p', { class: 'hint', text: '⚠️ Ohne Passwort sind die Inhalte unwiederbringlich. Es wird nirgends gespeichert.' }),
      el('button', { class: 'btn', text: 'Anlegen', onclick: save }),
      err,
    ]));
  }

  function confirmDeleteCalendar(c) {
    openModal(el('div', {}, [
      el('h2', { text: 'Kalender löschen?' }),
      el('p', { class: 'sub', text: `„${c.title}" und alle Türchen werden entfernt. Das kann nicht rückgängig gemacht werden.` }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn danger', text: 'Endgültig löschen', onclick: async () => {
          try {
            const doors = await db.collection('calendars').doc(c.id).collection('doors').get();
            // alle Storage-Pfade einsammeln (neues items[]- UND altes Einzel-Schema)
            const paths = [];
            doors.docs.forEach(d => doorItems(d.data()).forEach(it => { if (it.storagePath) paths.push(it.storagePath); }));
            if (c.background && c.background.storagePath) paths.push(c.background.storagePath);
            await Promise.all(doors.docs.map(d => d.ref.delete()));
            await Promise.all(paths.map(p => storage.ref(p).delete().catch(() => {})));  // best effort
            await db.collection('calendars').doc(c.id).delete();
            closeModal(); toast('Kalender gelöscht.'); renderCalendarList();
          } catch (e) { toast('Löschen fehlgeschlagen: ' + (e.message || e)); }
        }}),
        el('button', { class: 'btn secondary', text: 'Abbrechen', onclick: closeModal }),
      ]),
    ]));
  }

  // ---- Teilen -------------------------------------------------------------
  function shareUrl(calId) {
    return location.origin + location.pathname.replace(/index\.html$/, '') + 'index.html?cal=' + calId;
  }
  function showShare(c) {
    const url = shareUrl(c.id);
    const inp = el('input', { type: 'text', value: url, readonly: 'readonly' });
    openModal(el('div', {}, [
      el('h2', { text: 'Kalender teilen' }),
      el('p', { class: 'sub', text: 'Diesen Link an den Empfänger senden — das Passwort bitte separat (z. B. persönlich).' }),
      el('label', { class: 'field' }, [el('span', { text: 'Link' }), inp]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', text: 'Link kopieren', onclick: () => { inp.select(); navigator.clipboard?.writeText(url); toast('Link kopiert.'); } }),
      ]),
      c.passwordHint ? el('p', { class: 'hint mt', text: 'Passwort-Hinweis: ' + c.passwordHint }) : null,
    ]));
  }

  // ---- Kalender-Editor: Passwort + Türchen-Übersicht ----------------------
  async function openCalendarEditor(c, keyMaybe) {
    state.calId = c.id;
    // vollständiges Doc laden (für kdf/verifier/lock)
    try {
      const doc = await db.collection('calendars').doc(c.id).get();
      state.cal = { id: c.id, ...doc.data() };
    } catch (e) { mount(errorPanel('Kalender nicht ladbar.', e)); return; }

    if (keyMaybe) { state.key = keyMaybe; return renderDoorsOverview(); }
    promptPassword(state.cal, async (key) => { state.key = key; renderDoorsOverview(); }, { editor: true });
  }

  function rememberKey(calId) { return 'ak_pw_' + calId; }

  // Zuletzt geöffneter Kalender — damit die installierte PWA (die immer auf
  // start_url startet, also ohne '?cal=<id>') wieder im Kalender landet.
  const LAST_CAL_KEY = 'ak_last_cal';
  function rememberLastCal(calId) { try { localStorage.setItem(LAST_CAL_KEY, calId); } catch (_) { /* Privatmodus */ } }
  function lastCal() { try { return localStorage.getItem(LAST_CAL_KEY); } catch (_) { return null; } }
  function forgetLastCal() { try { localStorage.removeItem(LAST_CAL_KEY); } catch (_) { /* egal */ } }

  /** Passwort-Dialog (Editor & User). onOk(key) bei korrektem Passwort.
   *  Für die Nutzer-Ansicht (nicht Editor) kann das Passwort auf dem Gerät
   *  gemerkt werden → kein tägliches Neu-Eingeben. */
  function promptPassword(cal, onOk, opts = {}) {
    const pw = el('input', { type: 'password', placeholder: 'Passwort', autocomplete: 'current-password' });
    const err = el('div', { class: 'error' });
    const btn = el('button', { class: 'btn', text: 'Öffnen' });
    const remember = el('input', { type: 'checkbox' });
    if (!opts.editor) remember.checked = true;   // Nutzer: standardmäßig merken
    const go = async () => {
      err.textContent = ''; btn.disabled = true; btn.textContent = 'Prüfe…';
      try {
        const key = await AKCrypto.deriveKey(pw.value, cal.kdf.salt, cal.kdf.iterations);
        const ok = await AKCrypto.checkVerifier(key, cal.verifier);
        if (!ok) { err.textContent = 'Falsches Passwort.'; btn.disabled = false; btn.textContent = 'Öffnen'; return; }
        if (!opts.editor) {
          if (remember.checked) localStorage.setItem(rememberKey(cal.id), pw.value);
          else localStorage.removeItem(rememberKey(cal.id));
        }
        closeModal(); onOk(key);
      } catch (e) { err.textContent = 'Fehler: ' + (e.message || e); btn.disabled = false; btn.textContent = 'Öffnen'; }
    };
    btn.addEventListener('click', go);
    pw.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    const body = el('div', {}, [
      el('h2', { text: opts.editor ? 'Kalender entsperren' : '🎄 ' + (cal.title || 'Adventskalender') }),
      el('p', { class: 'sub', text: opts.editor ? 'E2E-Passwort dieses Kalenders eingeben.' : 'Bitte das Passwort eingeben, das du erhalten hast.' }),
      el('label', { class: 'field' }, [el('span', { text: 'Passwort' }), pw]),
      cal.passwordHint ? el('p', { class: 'hint', text: 'Hinweis: ' + cal.passwordHint }) : null,
      opts.editor ? null : el('label', { class: 'field row' }, [remember, el('span', { text: ' Auf diesem Gerät angemeldet bleiben', style: 'margin:0;' })]),
      btn, err,
      // Notausgang: sonst führt der gemerkte Kalender die installierte PWA
      // immer wieder hierher, ohne Weg zur Startseite (anderer Link, falscher Kalender).
      opts.editor ? null : el('button', {
        class: 'btn secondary small', text: 'Anderen Kalender öffnen',
        onclick: () => { forgetLastCal(); location.href = 'index.html'; },
      }),
    ]);
    openModal(body);
    setTimeout(() => pw.focus(), 50);
  }

  async function renderDoorsOverview() {
    const c = state.cal;
    setTopActions([
      el('button', { class: 'btn small', text: '👁 Vorschau', onclick: () => { state.preview = true; renderUserGrid(); } }),
      el('button', { class: 'btn small secondary', text: '🎨 Hintergrund', onclick: () => showBackgroundDialog(c) }),
      el('button', { class: 'btn small secondary', text: 'Teilen', onclick: () => showShare(c) }),
      el('button', { class: 'btn small ghost', text: '← Kalender', onclick: () => { state.calId = null; state.key = null; renderCalendarList(); } }),
    ]);
    mount(el('div', { class: 'spinner', text: 'Lade Türchen…' }));
    let doorMap = {};
    try {
      const snap = await db.collection('calendars').doc(c.id).collection('doors').get();
      snap.docs.forEach(d => doorMap[d.id] = d.data());
    } catch (e) { mount(errorPanel('Türchen nicht ladbar.', e)); return; }

    const head = el('div', { class: 'cal-head' }, [
      el('h1', { text: c.title || 'Adventskalender' }),
      el('p', { text: `Jahr ${c.lock?.year} · Klicke ein Türchen zum Befüllen` }),
    ]);
    const grid = el('div', { class: 'grid' });
    for (let d = 1; d <= DAYS; d++) {
      const items = doorItems(doorMap[String(d)]);
      const filled = items.length > 0;
      let label = 'leer';
      if (items.length === 1) label = TYPES.find(t => t.id === items[0].type)?.label.replace(/^\S+\s/, '') || items[0].type;
      else if (items.length > 1) label = items.length + ' Inhalte';
      grid.appendChild(el('button', {
        class: 'door edit ' + (filled ? '' : 'empty'),
        onclick: () => openDoorEditor(d, doorMap[String(d)]),
      }, [
        el('span', { class: 'num', text: String(d) }),
        el('span', { class: 'state', text: label }),
      ]));
    }
    mount(el('div', {}, [head, grid]));
  }

  // ---- Hintergrundbild je Kalender ---------------------------------------
  /** Liefert eine Bild-URL für die Bühne: eigenes (entschlüsseltes) Bild des
   *  Kalenders oder den Standard-Hintergrund als Fallback. */
  async function loadBackgroundUrl(cal) {
    const bg = cal && cal.background;
    if (bg && bg.storagePath) {
      try {
        const meta = await AKCrypto.decryptJSON(state.key, bg.fileMeta);
        const url = await storage.ref(bg.storagePath).getDownloadURL();
        const buf = await (await fetch(url)).arrayBuffer();
        const blob = await AKCrypto.decryptBlob(state.key, buf, meta.mime);
        return URL.createObjectURL(blob);
      } catch (e) { console.error('Hintergrund konnte nicht geladen werden:', e); }
    }
    return DEFAULT_BG;
  }

  function showBackgroundDialog(cal) {
    const hasCustom = !!(cal.background && cal.background.storagePath);
    const fileInput = el('input', { type: 'file', accept: 'image/*' });
    const err = el('div', { class: 'error' });
    const status = el('p', { class: 'hint', text: hasCustom ? '✔️ Eigenes Hintergrundbild ist aktiv.' : 'Aktuell wird der Standard-Hintergrund verwendet.' });

    const saveBtn = el('button', { class: 'btn', text: 'Bild speichern' });
    saveBtn.addEventListener('click', async () => {
      err.textContent = '';
      const file = fileInput.files[0];
      if (!file) { err.textContent = 'Bitte ein Bild auswählen.'; return; }
      saveBtn.disabled = true; saveBtn.textContent = 'Verschlüssele & lade hoch…';
      try {
        const blob = await AKCrypto.encryptFileToBlob(state.key, file);
        const path = `calendars/${cal.id}/_bg/${cryptoRandomId()}.bin`;
        await storage.ref(path).put(blob);
        const fileMeta = await AKCrypto.encryptJSON(state.key, { filename: file.name, mime: file.type || 'image/jpeg', size: file.size });
        const oldPath = cal.background && cal.background.storagePath;
        await db.collection('calendars').doc(cal.id).update({ background: { storagePath: path, fileMeta } });
        if (oldPath && oldPath !== path) storage.ref(oldPath).delete().catch(() => {});
        cal.background = { storagePath: path, fileMeta };
        if (state.cal && state.cal.id === cal.id) state.cal.background = cal.background;
        closeModal(); toast('Hintergrundbild gespeichert.');
      } catch (e) {
        err.textContent = 'Fehlgeschlagen: ' + (e.message || e);
        saveBtn.disabled = false; saveBtn.textContent = 'Bild speichern';
      }
    });

    const resetBtn = hasCustom ? el('button', { class: 'btn secondary', text: 'Auf Standard zurücksetzen', onclick: async () => {
      try {
        const oldPath = cal.background && cal.background.storagePath;
        await db.collection('calendars').doc(cal.id).update({ background: firebase.firestore.FieldValue.delete() });
        if (oldPath) storage.ref(oldPath).delete().catch(() => {});
        cal.background = null;
        if (state.cal && state.cal.id === cal.id) state.cal.background = null;
        closeModal(); toast('Standard-Hintergrund wiederhergestellt.');
      } catch (e) { err.textContent = 'Zurücksetzen fehlgeschlagen: ' + (e.message || e); }
    }}) : null;

    openModal(el('div', {}, [
      el('h2', { text: 'Hintergrundbild' }),
      el('p', { class: 'sub', text: 'Eigenes Bild für die Kalenderbühne (verschlüsselt gespeichert). Ohne eigenes Bild wird der Standard-Hintergrund genutzt.' }),
      status,
      el('label', { class: 'field' }, [el('span', { text: 'Bild auswählen' }), fileInput]),
      el('div', { class: 'row mt' }, [saveBtn, resetBtn]),
      err,
    ]));
  }

  // ---- Türchen-Editor (mehrere Inhalte je Türchen) ------------------------
  function openDoorEditor(day, existing) {
    const err = el('div', { class: 'error' });
    const list = el('div', { class: 'item-list' });   // Container für Inhalts-Karten
    const cards = [];                                  // aktive Karten-Controller

    const existingItems = doorItems(existing);
    // alte Storage-Pfade merken → verwaiste Dateien beim Speichern löschen
    const oldPaths = existingItems.map(it => it.storagePath).filter(Boolean);

    function renumber() { cards.forEach((c, i) => c.setIndex(i + 1)); }
    function addCard(item) {
      const card = makeItemCard(item || null, () => {
        const i = cards.indexOf(card);
        if (i >= 0) cards.splice(i, 1);
        card.root.remove();
        renumber();
      });
      cards.push(card);
      list.appendChild(card.root);
      renumber();
    }

    // vorhandene Inhalte als Karten anlegen — sonst eine leere Startkarte
    if (existingItems.length) existingItems.forEach(addCard);
    else addCard(null);

    const addBtn = el('button', { class: 'btn add-item', text: '➕ Weiteren Inhalt hinzufügen', onclick: () => addCard(null) });
    const saveBtn = el('button', { class: 'btn', text: 'Speichern' });
    saveBtn.addEventListener('click', save);

    async function save() {
      err.textContent = ''; saveBtn.disabled = true; saveBtn.textContent = 'Speichere…';
      try {
        const ref = db.collection('calendars').doc(state.calId).collection('doors').doc(String(day));
        const items = [];
        for (let i = 0; i < cards.length; i++) {
          saveBtn.textContent = `Speichere Inhalt ${i + 1}/${cards.length}…`;
          items.push(await cards[i].collect(day));   // wirft bei ungültiger Eingabe
        }

        if (!items.length) {
          // keine Inhalte übrig → Türchen komplett leeren
          await Promise.all(oldPaths.map(p => storage.ref(p).delete().catch(() => {})));
          await ref.delete().catch(() => {});
          closeModal(); toast(`Türchen ${day} geleert.`); renderDoorsOverview(); return;
        }

        await ref.set({ items, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        // verwaiste Storage-Dateien entfernen (alte Pfade, die nicht mehr referenziert werden)
        const newPaths = new Set(items.map(it => it.storagePath).filter(Boolean));
        await Promise.all(oldPaths.filter(p => !newPaths.has(p)).map(p => storage.ref(p).delete().catch(() => {})));
        closeModal(); toast(`Türchen ${day} gespeichert.`); renderDoorsOverview();
      } catch (e) {
        err.textContent = e.message || String(e);
        saveBtn.disabled = false; saveBtn.textContent = 'Speichern';
      }
    }

    const delBtn = existingItems.length ? el('button', { class: 'btn secondary', text: 'Türchen leeren', onclick: async () => {
      try {
        await Promise.all(oldPaths.map(p => storage.ref(p).delete().catch(() => {})));
        await db.collection('calendars').doc(state.calId).collection('doors').doc(String(day)).delete();
        closeModal(); toast(`Türchen ${day} geleert.`); renderDoorsOverview();
      } catch (e) { err.textContent = 'Löschen fehlgeschlagen: ' + (e.message || e); }
    }}) : null;

    openModal(el('div', {}, [
      el('h2', { text: `Türchen ${day} befüllen` }),
      el('p', { class: 'sub', text: 'Mehrere Inhalte möglich — Bilder, Videos, Sprüche, Dateien oder Gutscheine. Sie werden in dieser Reihenfolge angezeigt.' }),
      list,
      el('div', { class: 'row' }, [addBtn]),
      el('p', { class: 'hint', text: 'Tipp: Für ein zweites Bild/Video/… oben auf „Weiteren Inhalt hinzufügen" klicken.' }),
      el('div', { class: 'row mt' }, [saveBtn, delBtn]),
      err,
    ]));
  }

  /** Baut eine Editor-Karte für genau einen Türchen-Inhalt.
   *  `existing` = normalisiertes Item oder null. `onRemove` entfernt die Karte.
   *  Rückgabe: { root, setIndex(n), collect(day) -> item }. */
  function makeItemCard(existing, onRemove) {
    let curType = existing?.type || 'text';

    const title = el('span', { class: 'item-title' });
    const removeBtn = el('button', { class: 'item-remove', 'aria-label': 'Inhalt entfernen', text: '×', onclick: onRemove });
    const pills = el('div', { class: 'type-pills' });
    const fields = el('div', {});
    const caption = el('textarea', { placeholder: 'Begleittext zu diesem Inhalt (optional)' });

    const textArea = el('textarea', { placeholder: 'Dein Text / Spruch…' });
    const voucherDesc = el('input', { type: 'text', placeholder: 'Beschreibung, z. B. „Gutschein für ein Abendessen"' });
    const voucherCode = el('input', { type: 'text', placeholder: 'Code (optional), z. B. XMAS-2026' });
    const fileInput = el('input', { type: 'file' });
    const fileNote = el('p', { class: 'hint' });

    // Hat dieses Item bereits eine gespeicherte Datei desselben Typs?
    const hasStored = () => !!(existing && existing.type === curType && existing.storagePath);

    function renderFields() {
      clear(fields);
      if (curType === 'text') {
        fields.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Text' }), textArea]));
      } else if (curType === 'voucher') {
        fields.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Beschreibung' }), voucherDesc]));
        fields.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Code' }), voucherCode]));
      } else {
        const accept = curType === 'image' ? 'image/*' : curType === 'video' ? 'video/*' : '*/*';
        fileInput.setAttribute('accept', accept);
        fields.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Datei auswählen' }), fileInput]));
        if (hasStored()) { fileNote.textContent = 'Bereits gespeichert. Neue Datei wählen, um zu ersetzen.'; fields.appendChild(fileNote); }
      }
    }

    TYPES.forEach(t => {
      const pill = el('button', {
        class: 'type' + (t.id === curType ? ' active' : ''),
        text: t.label,
        onclick: () => { curType = t.id; [...pills.children].forEach(b => b.classList.remove('active')); pill.classList.add('active'); renderFields(); },
      });
      pills.appendChild(pill);
    });

    // vorhandene Werte vorbelegen (entschlüsseln)
    (async () => {
      try {
        if (existing?.caption) caption.value = (await AKCrypto.decryptJSON(state.key, existing.caption)).text || '';
        if (existing?.type === 'text' && existing.payload) textArea.value = (await AKCrypto.decryptJSON(state.key, existing.payload)).text || '';
        if (existing?.type === 'voucher' && existing.payload) {
          const v = await AKCrypto.decryptJSON(state.key, existing.payload);
          voucherDesc.value = v.description || ''; voucherCode.value = v.code || '';
        }
      } catch (_) { /* ignorieren, Felder bleiben leer */ }
    })();

    renderFields();

    const root = el('div', { class: 'item-card' }, [
      el('div', { class: 'item-head' }, [title, removeBtn]),
      pills, fields,
      el('label', { class: 'field' }, [el('span', { text: 'Begleittext (optional)' }), caption]),
    ]);

    async function collect(day) {
      const item = { type: curType };
      item.caption = caption.value.trim() ? await AKCrypto.encryptJSON(state.key, { text: caption.value.trim() }) : null;
      if (curType === 'text') {
        if (!textArea.value.trim()) throw new Error(`${title.textContent}: Bitte Text eingeben.`);
        item.payload = await AKCrypto.encryptJSON(state.key, { text: textArea.value });
        item.storagePath = null; item.fileMeta = null;
      } else if (curType === 'voucher') {
        if (!voucherDesc.value.trim() && !voucherCode.value.trim()) throw new Error(`${title.textContent}: Bitte Beschreibung oder Code eingeben.`);
        item.payload = await AKCrypto.encryptJSON(state.key, { description: voucherDesc.value, code: voucherCode.value });
        item.storagePath = null; item.fileMeta = null;
      } else {
        const file = fileInput.files[0];
        if (file) {
          const blob = await AKCrypto.encryptFileToBlob(state.key, file);
          const path = `calendars/${state.calId}/${day}/${cryptoRandomId()}.bin`;
          await storage.ref(path).put(blob);
          item.storagePath = path;
          item.fileMeta = await AKCrypto.encryptJSON(state.key, { filename: file.name, mime: file.type || 'application/octet-stream', size: file.size });
          item.payload = null;
        } else if (hasStored()) {
          item.storagePath = existing.storagePath; item.fileMeta = existing.fileMeta; item.payload = null;
        } else {
          throw new Error(`${title.textContent}: Bitte eine Datei auswählen.`);
        }
      }
      return item;
    }

    return {
      root,
      setIndex(n) { title.textContent = 'Inhalt ' + n; },
      collect,
    };
  }

  function cryptoRandomId() {
    return AKCrypto.bytesToB64(crypto.getRandomValues(new Uint8Array(9))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || String(Date.now());
  }

  // ============================================================
  //  USER-VIEW
  // ============================================================
  async function renderUserView(calId) {
    state.calId = calId;
    setTopActions([]);
    mount(el('div', { class: 'spinner', text: 'Lade Kalender…' }));
    let cal;
    try {
      const doc = await db.collection('calendars').doc(calId).get();
      if (!doc.exists) {
        // Merker löschen, sonst startet die installierte PWA dauerhaft in diesen
        // Fehler (gelöschter Kalender = Sackgasse ohne Weg zur Startseite).
        forgetLastCal();
        const panel = errorPanel('Dieser Kalender existiert nicht (mehr).');
        panel.appendChild(el('button', {
          class: 'btn secondary', text: 'Zur Startseite',
          onclick: () => location.href = 'index.html',
        }));
        mount(panel);
        return;
      }
      cal = { id: calId, ...doc.data() };
    } catch (e) { mount(errorPanel('Kalender konnte nicht geladen werden.', e)); return; }
    state.cal = cal;

    // Auto-Entsperren, falls Passwort auf diesem Gerät gemerkt wurde
    const saved = localStorage.getItem(rememberKey(calId));
    if (saved) {
      try {
        const key = await AKCrypto.deriveKey(saved, cal.kdf.salt, cal.kdf.iterations);
        if (await AKCrypto.checkVerifier(key, cal.verifier)) { state.key = key; return renderUserGrid(); }
      } catch (_) { /* fällt auf Passwort-Abfrage zurück */ }
      localStorage.removeItem(rememberKey(calId));   // ungültig (z. B. Passwort geändert)
    }

    promptPassword(cal, async (key) => { state.key = key; renderUserGrid(); });
  }

  function doorOpenable(day) {
    if (state.preview) return true;            // Bearbeiter-Vorschau: Datums-Lock aus
    const lock = state.cal.lock || {};
    if (!lock.enabled) return true;
    const now = new Date();
    const unlock = new Date(lock.year, 11, day, 0, 0, 0, 0); // Dezember = Monat 11
    return now >= unlock;
  }

  function openedKey() { return 'ak_opened_' + state.calId; }
  function getOpened() { try { return JSON.parse(localStorage.getItem(openedKey()) || '[]'); } catch { return []; } }
  function markOpened(day) {
    const s = new Set(getOpened()); s.add(day);
    localStorage.setItem(openedKey(), JSON.stringify([...s]));
  }

  // ---- Bühnen-Layout: 24 Türen gleichmäßig + deterministisch verteilt ----
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Liefert für Tag 1..24 eine Position {x,y} in % auf der Bühne.
   *  6×4-Raster (gleichmäßig) + kleiner, stabiler Jitter + fester Scatter der Nummern. */
  function doorLayout(calId) {
    const cols = 6, rows = 4;
    const xa = 8, xb = 92, ya = 10, yb = 90;
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      cells.push({
        x: xa + (c + 0.5) * (xb - xa) / cols,
        y: ya + (r + 0.5) * (yb - ya) / rows,
      });
    }
    const rnd = mulberry32(hashStr(calId || 'adventskalender'));
    cells.forEach(cell => {
      cell.x += (rnd() * 2 - 1) * 2.0;   // ±2,0 % horizontal
      cell.y += (rnd() * 2 - 1) * 1.6;   // ±1,6 % vertikal
    });
    const order = cells.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {          // Fisher-Yates (seed-stabil)
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const map = {};
    for (let d = 1; d <= DAYS; d++) map[d] = cells[order[d - 1]];
    return map;
  }

  /** Baut die Holztür-Fassade (Rahmen + Innenraum + Türblatt mit Zahl & Knauf). */
  function buildDoorFace(day) {
    return el('div', { class: 'door-face' }, [
      el('div', { class: 'door-frame' }),
      el('div', { class: 'door-interior' }),
      el('div', { class: 'door-leaf' }, [
        el('div', { class: 'door-plate' }, [el('span', { text: String(day) })]),
        el('div', { class: 'door-knob' }),
      ]),
    ]);
  }

  function shakeDoor(elm) {
    elm.classList.remove('shake');
    void elm.offsetWidth;                 // Reflow erzwingen, damit Animation neu startet
    elm.classList.add('shake');
    setTimeout(() => elm.classList.remove('shake'), 500);
  }

  async function renderUserGrid() {
    const c = state.cal;
    setTopActions([]);
    mount(el('div', { class: 'spinner', text: 'Lade Türchen…' }));
    let doorMap = {};
    try {
      const snap = await db.collection('calendars').doc(c.id).collection('doors').get();
      snap.docs.forEach(d => doorMap[d.id] = d.data());
    } catch (e) { mount(errorPanel('Türchen nicht ladbar.', e)); return; }

    const opened = new Set(getOpened());

    const stage = el('div', { class: 'calendar-stage' });
    const bgUrl = await loadBackgroundUrl(c);
    stage.style.backgroundImage = `url('${bgUrl}')`;
    const layout = doorLayout(c.id);

    for (let d = 1; d <= DAYS; d++) {
      const data = doorMap[String(d)];
      const canOpen = doorOpenable(d);
      const pos = layout[d];
      const cls = ['wdoor'];
      if (!canOpen) cls.push('locked');
      else if (data) cls.push('openable');
      if (opened.has(d)) cls.push('opened');

      const btn = el('button', { class: cls.join(' '), 'aria-label': `Türchen ${d}` });
      btn.style.left = pos.x + '%';
      btn.style.top = pos.y + '%';
      btn.appendChild(buildDoorFace(d));
      if (!canOpen) btn.appendChild(el('span', { class: 'door-badge', text: '🔒' }));
      else if (opened.has(d)) btn.appendChild(el('span', { class: 'door-badge', text: '✓' }));

      if (canOpen && data) btn.addEventListener('click', () => openDay(d, data, btn));
      else if (!canOpen) btn.addEventListener('click', () => { shakeDoor(btn); toast(`Türchen ${d} öffnet am ${d}. Dezember ${c.lock.year}.`); });
      else btn.addEventListener('click', () => { shakeDoor(btn); toast('Dieses Türchen ist noch leer.'); });

      stage.appendChild(btn);
    }

    stage.appendChild(AKSnow.build());   // Schnee zuletzt → liegt vor den Türen (pointer-events: none)

    const screen = el('div', { class: 'stage-screen' }, [el('div', { class: 'stage-wrap' }, [stage])]);
    if (state.preview) {
      screen.appendChild(el('button', {
        class: 'stage-exit', text: '← Bearbeiten',
        onclick: () => { state.preview = false; renderDoorsOverview(); },
      }));
    } else {
      // dezenter Sperren-Button: gemerktes Passwort entfernen & neu abfragen
      screen.appendChild(el('button', {
        class: 'stage-lock', 'aria-label': 'Sperren', title: 'Sperren', text: '🔒',
        onclick: () => { localStorage.removeItem(rememberKey(c.id)); state.key = null; renderUserView(c.id); },
      }));
    }
    mount(screen);
    document.body.classList.add('stage-mode');   // Vollbild aktivieren
    tryLockLandscape();                           // best effort (Android/PWA)
  }

  /** Versucht, das Display ins Querformat zu sperren. Funktioniert nur im
   *  Vollbild/installierter PWA (Android); iOS & normale Browser ignorieren es
   *  — dort greift der CSS-Drehen-Hinweis (#rotateHint). */
  function tryLockLandscape() {
    try {
      const o = screen.orientation;
      if (o && typeof o.lock === 'function') o.lock('landscape').catch(() => {});
    } catch (_) { /* nicht unterstützt */ }
  }

  /** Rendert einen Inhalt in `wrap` und fängt Fehler lokal ab (CORS-Hinweis). */
  async function safeRenderItem(item, wrap) {
    try {
      await renderItem(item, wrap);
    } catch (e) {
      console.error('Türchen-Inhalt fehlgeschlagen:', e);
      const msg = String(e && (e.message || e));
      const looksCors = e instanceof TypeError || /fetch|Failed to fetch|CORS|NetworkError|Load failed/i.test(msg);
      clear(wrap);
      wrap.appendChild(el('div', { class: 'caption', text: looksCors
        ? '⚠️ Datei konnte nicht geladen werden (vermutlich CORS am Storage-Bucket).'
        : 'Konnte nicht entschlüsselt/geladen werden.' }));
      wrap.appendChild(el('div', { class: 'spin', text: msg }));
    }
  }

  /** Entschlüsselt & rendert die Inhalte des Türchens in `box`.
   *  Ein Inhalt → direkt; mehrere → Galerie (Pfeile, Punkte, Wischen). */
  async function renderDayContent(day, data, box) {
    const items = doorItems(data);
    clear(box);
    if (!items.length) return;

    if (items.length === 1) {
      const wrap = el('div', { class: 'door-item' });
      box.appendChild(wrap);
      await safeRenderItem(items[0], wrap);
      return;
    }

    // ----- Galerie -----
    box.classList.add('gallery');
    const slidesWrap = el('div', { class: 'gal-slides' });
    const dots = el('div', { class: 'gal-dots' });
    const slideEls = [];

    items.forEach((item, i) => {
      const slide = el('div', { class: 'gal-slide' + (i === 0 ? ' active' : '') });
      const inner = el('div', { class: 'door-item' });
      slide.appendChild(inner);
      slidesWrap.appendChild(slide);
      slideEls.push(slide);
      safeRenderItem(item, inner);   // parallel entschlüsseln
      const dot = el('button', { class: 'gal-dot' + (i === 0 ? ' active' : ''), 'aria-label': `Inhalt ${i + 1}`, onclick: () => show(i) });
      dots.appendChild(dot);
    });

    let cur = 0;
    function show(i) {
      cur = (i + items.length) % items.length;
      slideEls.forEach((s, idx) => {
        s.classList.toggle('active', idx === cur);
        if (idx !== cur) s.querySelectorAll('video').forEach(v => v.pause());
      });
      [...dots.children].forEach((d, idx) => d.classList.toggle('active', idx === cur));
    }

    const prev = el('button', { class: 'gal-arrow prev', 'aria-label': 'Zurück', text: '‹',
      onclick: (e) => { e.stopPropagation(); show(cur - 1); } });
    const next = el('button', { class: 'gal-arrow next', 'aria-label': 'Weiter', text: '›',
      onclick: (e) => { e.stopPropagation(); show(cur + 1); } });

    // Wisch-Geste (Touch)
    let sx = null;
    slidesWrap.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    slidesWrap.addEventListener('touchend', e => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx; sx = null;
      if (Math.abs(dx) > 40) show(dx < 0 ? cur + 1 : cur - 1);
    }, { passive: true });

    box.appendChild(slidesWrap);
    box.appendChild(prev);
    box.appendChild(next);
    box.appendChild(dots);
    show(0);
  }

  /** Rendert einen einzelnen Inhalt (Text/Gutschein/Bild/Video/Datei) in `wrap`. */
  async function renderItem(item, wrap) {
    if (item.type === 'text') {
      const t = (await AKCrypto.decryptJSON(state.key, item.payload)).text || '';
      wrap.appendChild(el('p', { class: 'caption', text: t }));
    } else if (item.type === 'voucher') {
      const v = await AKCrypto.decryptJSON(state.key, item.payload);
      wrap.appendChild(el('div', { class: 'voucher' }, [
        el('div', { text: '🎟️ Gutschein' }),
        v.description ? el('div', { class: 'mt', text: v.description }) : null,
        v.code ? el('div', { class: 'code', text: v.code }) : null,
      ]));
    } else {
      const meta = await AKCrypto.decryptJSON(state.key, item.fileMeta);
      const url = await storage.ref(item.storagePath).getDownloadURL();
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      const blob = await AKCrypto.decryptBlob(state.key, buf, meta.mime);
      const objUrl = URL.createObjectURL(blob);
      if (item.type === 'image') {
        wrap.appendChild(el('img', { src: objUrl, alt: meta.filename || '' }));
      } else if (item.type === 'video') {
        wrap.appendChild(el('video', { src: objUrl, controls: 'controls', playsinline: 'playsinline' }));
      } else {
        wrap.appendChild(el('div', { class: 'stack' }, [
          el('div', { text: '📎 ' + (meta.filename || 'Datei') }),
          el('a', { class: 'btn dl', href: objUrl, download: meta.filename || 'datei', text: 'Herunterladen' }),
        ]));
      }
    }
    if (item.caption) {
      const cap = (await AKCrypto.decryptJSON(state.key, item.caption)).text || '';
      if (cap) wrap.appendChild(el('p', { class: 'caption', text: cap }));
    }
  }

  /** Türchen öffnen: Zoom auf die Tür → Türblatt schwingt nach innen auf →
   *  goldener Schimmer → entschlüsselter Inhalt wird sichtbar. */
  async function openDay(day, data, srcEl) {
    markOpened(day);
    document.body.classList.add('door-open');    // Schneefall ausblenden + pausieren
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const overlay = el('div', { class: 'door-overlay' });
    const closeBtn = el('button', { class: 'ov-close', 'aria-label': 'Schließen', text: '×' });
    const sd = el('div', { class: 'stage-door' });
    const face = buildDoorFace(day);
    sd.appendChild(face);
    const interior = face.querySelector('.door-interior');
    const glow = el('div', { class: 'door-glow' });
    const contentBox = el('div', { class: 'door-content' }, [el('div', { class: 'spin', text: 'Entschlüssele…' })]);
    interior.appendChild(glow);
    interior.appendChild(contentBox);
    overlay.appendChild(closeBtn);
    overlay.appendChild(sd);
    document.body.appendChild(overlay);

    // Zielbox (zentriert) festlegen
    const vw = window.innerWidth, vh = window.innerHeight;
    const targetW = Math.min(360, vw * 0.82, (vh * 0.82) * 3 / 4);
    const targetH = targetW * 4 / 3;
    const targetLeft = (vw - targetW) / 2, targetTop = (vh - targetH) / 2;
    sd.style.width = targetW + 'px';
    sd.style.height = targetH + 'px';
    sd.style.left = targetLeft + 'px';
    sd.style.top = targetTop + 'px';

    // FLIP: Startzustand = exakt über der angetippten Kachel
    const r = srcEl ? srcEl.getBoundingClientRect() : { left: targetLeft, top: targetTop, width: targetW };
    const scale = r.width / targetW;
    if (!reduce) sd.style.transform = `translate(${r.left - targetLeft}px, ${r.top - targetTop}px) scale(${scale})`;

    // Inhalt parallel entschlüsseln
    const contentReady = renderDayContent(day, data, contentBox)
      .catch(e => {
        console.error('Türchen-Inhalt fehlgeschlagen:', e);
        const msg = String(e && (e.message || e));
        const looksCors = e instanceof TypeError || /fetch|Failed to fetch|CORS|NetworkError|Load failed/i.test(msg);
        clear(contentBox);
        contentBox.appendChild(el('div', { class: 'caption', text: looksCors
          ? '⚠️ Datei konnte nicht geladen werden (vermutlich CORS am Storage-Bucket).'
          : 'Konnte nicht entschlüsselt/geladen werden.' }));
        contentBox.appendChild(el('div', { class: 'spin', text: msg }));
      });

    // Aufräumen / Schließen
    const cleanup = () => {
      overlay.classList.remove('dim');
      document.body.classList.remove('door-open');   // Schnee wieder fallen lassen
      document.removeEventListener('keydown', onKey);
      setTimeout(() => overlay.remove(), 420);
    };
    const onKey = e => { if (e.key === 'Escape') cleanup(); };
    document.addEventListener('keydown', onKey);
    closeBtn.addEventListener('click', cleanup);
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });

    const leaf = sd.querySelector('.door-leaf');
    const start = () => {
      overlay.classList.add('dim');
      if (reduce) {
        sd.classList.add('open', 'lit');
        contentReady.finally(() => sd.classList.add('reveal'));
        return;
      }
      sd.style.transform = '';                       // Phase 1: heranzoomen
      const afterZoom = e => {
        if (e.target !== sd || e.propertyName !== 'transform') return;
        sd.removeEventListener('transitionend', afterZoom);
        sd.classList.add('open');                    // Phase 2: Türblatt öffnet nach innen
        const afterOpen = ev => {
          if (ev.target !== leaf || ev.propertyName !== 'transform') return;
          leaf.removeEventListener('transitionend', afterOpen);
          sd.classList.add('lit');                   // Phase 3: goldener Schimmer
          contentReady.finally(() => sd.classList.add('reveal')); // Phase 4: Inhalt
        };
        leaf.addEventListener('transitionend', afterOpen);
      };
      sd.addEventListener('transitionend', afterZoom);
    };
    requestAnimationFrame(() => requestAnimationFrame(start));

    // Kachel als geöffnet markieren
    if (srcEl) {
      srcEl.classList.add('opened');
      const b = srcEl.querySelector('.door-badge');
      if (b) b.textContent = '✓';
      else srcEl.appendChild(el('span', { class: 'door-badge', text: '✓' }));
    }
  }

  // ---- Service Worker -----------------------------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // Start
  route();
})();
