// The phone's composer parts shared by the conversation (conversation.ts) and the « Nouveau workspace » form (launch.ts): attachments
// (« + », file picker, tray, paste) and the skills `/` menu. ONE source, injected as a self-contained factory into both scripts (they
// load independently). Contract classes: conv-file, conv-attach, conv-atts, conv-att[data-kind], conv-att-x, conv-ac, ac-row[data-name].

import { MOBILE_ATTACH_MAX_BODY, MOBILE_ATTACH_MAX_COUNT } from '../shared/acces-mobile-conversation.ts';
import { filterSlashItems, slashQuery } from '../shared/slash-menu.ts';

/** A JS expression: `(function (el, auth) { … })` → `{ attachments(opts), slashMenu(ta, url), ATTACH_BODY }`. */
export const COMPOSER_KIT_JS = `(function (el, auth) {
  // The \`/\` menu's prefix test + filter (shared/slash-menu.ts — the desktop composer's own, unit-tested).
  var slashQuery = (${slashQuery.toString()});
  var filterSlash = (${filterSlashItems.toString()});
  var ATTACH_MAX = ${MOBILE_ATTACH_MAX_COUNT}, ATTACH_BODY = ${MOBILE_ATTACH_MAX_BODY}, IMG_EDGE = 1568;
  var API_IMG = { 'image/png': 1, 'image/jpeg': 1, 'image/gif': 1, 'image/webp': 1 };
  function readDataUrl(file) { return new Promise(function (ok, ko) { var r = new FileReader(); r.onload = function () { ok(String(r.result || '')); }; r.onerror = function () { ko(r.error); }; r.readAsDataURL(file); }); }
  function splitDataUrl(u) { var m = /^data:([^;,]+)[^,]*;base64,(.*)$/.exec(u); return m ? { mediaType: m[1], dataBase64: m[2] } : null; }
  // One phone file → an attachment. A picture is redrawn to ≤ IMG_EDGE px as JPEG (the API scales anything bigger down anyway,
  // and a phone photo would cost megabytes on the uplink); one already small and in an API type goes as is; a PDF goes as is.
  function prepareFile(file) {
    var type = file.type || '';
    if (type === 'application/pdf') return readDataUrl(file).then(function (u) { var d = splitDataUrl(u); if (!d) throw new Error('read'); return { mediaType: 'application/pdf', dataBase64: d.dataBase64, url: '', name: file.name || 'document.pdf', kind: 'pdf' }; });
    if (type.indexOf('image/') !== 0) return Promise.reject(new Error('type'));
    return readDataUrl(file).then(function (u) {
      return new Promise(function (ok, ko) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, IMG_EDGE / Math.max(w, h)), d = splitDataUrl(u);
          if (k === 1 && API_IMG[type] && file.size <= 3500000 && d) return ok({ mediaType: type, dataBase64: d.dataBase64, url: u, name: file.name || 'image', kind: 'image' });
          var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
          var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
          var out = c.toDataURL('image/jpeg', 0.88), o = splitDataUrl(out);
          if (!o) return ko(new Error('encode'));
          ok({ mediaType: 'image/jpeg', dataBase64: o.dataBase64, url: out, name: file.name || 'image', kind: 'image' });
        };
        img.onerror = function () { ko(new Error('decode')); };
        img.src = u;
      });
    });
  }

  // Images + PDFs (Lucas 2026-10-12): the « + » opens the picker (Photos / camera / Fichiers on iOS), a file pasted in the field is
  // attached too (pasted text stays text). opts: say(text) shows an error ('' clears), onChange() after any change, onBusy(bool).
  function attachments(opts) {
    var file = el('input', 'conv-file'); file.type = 'file'; file.multiple = true; file.accept = 'image/*,application/pdf'; file.hidden = true;
    var add = el('button', 'conv-attach att', '+'); add.type = 'button'; add.setAttribute('aria-label', 'Joindre une image ou un PDF');
    var tray = el('div', 'conv-atts atts'); tray.hidden = true;
    var list = [], reading = 0;
    function draw() {
      tray.textContent = ''; tray.hidden = !list.length;
      list.forEach(function (a, i) {
        var t = el('div', 'conv-att att-' + a.kind); t.dataset.kind = a.kind;
        if (a.kind === 'image') { var im = el('img'); im.src = a.url; im.alt = a.name; t.appendChild(im); }
        else t.appendChild(el('span', 'att-pdf', 'PDF · ' + a.name));
        var x = el('button', 'conv-att-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Retirer ' + a.name);
        x.addEventListener('click', function () { list.splice(i, 1); draw(); opts.onChange(); });
        t.appendChild(x); tray.appendChild(t);
      });
    }
    function addFiles(files) {
      files = Array.prototype.slice.call(files || []);
      if (!files.length) return;
      opts.say('');
      var room = Math.max(0, ATTACH_MAX - list.length);
      if (files.length > room) { opts.say('Au plus ' + ATTACH_MAX + ' pièces jointes.'); files = files.slice(0, room); }
      if (!files.length) return;
      if (!reading++) opts.onBusy(true);
      Promise.all(files.map(function (f) {
        return prepareFile(f).then(null, function (e) { return { error: e && e.message === 'type' ? 'Seuls les images et les PDF passent.' : 'Fichier illisible : ' + (f.name || '?') }; });
      })).then(function (res) {
        res.forEach(function (r) { if (r.error) opts.say(r.error); else if (list.length < ATTACH_MAX) list.push(r); });
        if (!--reading) opts.onBusy(false);
        draw(); opts.onChange();
      });
    }
    add.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () { addFiles(file.files); file.value = ''; });
    return {
      file: file, add: add, tray: tray,
      count: function () { return list.length; },
      busy: function () { return reading > 0; },
      clear: function () { list = []; draw(); },
      // What rides beside the text: { mediaType, dataBase64 } only.
      payload: function () { return list.map(function (a) { return { mediaType: a.mediaType, dataBase64: a.dataBase64 }; }); },
      disable: function (on) { add.disabled = !!on; },
      watch: function (ta) {
        ta.addEventListener('paste', function (ev) {
          var cd = ev.clipboardData; if (!cd) return;
          var files = Array.prototype.slice.call(cd.files || []);
          if (!files.length && cd.items) Array.prototype.forEach.call(cd.items, function (it) { if (it.kind === 'file') { var f = it.getAsFile(); if (f) files.push(f); } });
          if (!files.length) return;
          if (!cd.getData('text/plain')) ev.preventDefault();
          addFiles(files);
        });
      },
    };
  }

  // The skills autocomplete: the desktop's \`/\` menu. url() = where the list comes from (null ⇒ no menu yet). The list is re-fetched
  // each time the menu opens (a skill added since shows); the last list stays shown while it loads; an older, slower answer never
  // wins. A tap fills \`/<name> \`. reset() forgets the list (another source: the launch form's repo changed).
  function slashMenu(ta, url) {
    var ac = el('div', 'conv-ac ac'); ac.hidden = true; ac.setAttribute('role', 'listbox');
    var items = null, gen = 0, wasOpen = false;
    function draw() {
      var q = slashQuery(ta.value), src = q === null ? null : url();
      if (q === null || !src) { ac.hidden = true; wasOpen = false; return; }
      if (!wasOpen) {
        wasOpen = true;
        var g = ++gen;
        fetch(src, { headers: auth(), cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (res) { if (g !== gen) return; items = res && res.ok && Array.isArray(res.items) ? res.items : (items || []); draw(); })
          .catch(function () { if (g === gen && !items) { items = []; draw(); } });
      }
      var rows = filterSlash(items || [], q, 8);
      ac.textContent = '';
      ac.hidden = !rows.length;
      rows.forEach(function (it) {
        var b = el('button', 'ac-row'); b.type = 'button'; b.dataset.name = it.name; b.setAttribute('role', 'option');
        b.appendChild(el('span', 'ac-name', '/' + it.name));
        if (it.description) b.appendChild(el('span', 'ac-desc', it.description));
        b.addEventListener('click', function () {
          ta.value = '/' + it.name + ' '; ac.hidden = true; ta.focus(); ta.dispatchEvent(new Event('input'));
        });
        ac.appendChild(b);
      });
    }
    return { el: ac, draw: draw, reset: function () { items = null; wasOpen = false; gen++; draw(); } };
  }

  return { attachments: attachments, slashMenu: slashMenu, ATTACH_BODY: ATTACH_BODY };
})`;
