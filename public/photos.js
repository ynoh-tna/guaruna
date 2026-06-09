/* =========================================================
   Guaruna — community photos for a route (shared module)
   Used by the GPX database detail panel AND the GPX viewer.
   GuPhotos.mount(container, routeId, {onChange}) renders the gallery
   + an add form (pseudo + note + image). Self-contained: own helpers
   and lightbox, reuses the site CSS. User text -> textContent (no XSS).
   On a standalone page, drop an element with id="route-photos" and the
   route id is taken from ?rid= (or derived from ?gpx=).
   ========================================================= */
(function () {
  'use strict';
  var GP = (window.GuPhotos = window.GuPhotos || {});

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) { var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = null; } return { ok: r.ok, status: r.status, data: d }; });
    }, function () { return { ok: false, status: 0, data: null }; });
  }
  function adminTok() { try { return sessionStorage.getItem('guaruna-admin'); } catch (e) { return null; } }
  function getPseudo() { try { return localStorage.getItem('guaruna-pseudo') || ''; } catch (e) { return ''; } }
  function setPseudo(v) { try { localStorage.setItem('guaruna-pseudo', v); } catch (e) {} }

  // Enable admin on any page via ?admin=TOKEN (?admin=off to clear). Kept per-tab in
  // sessionStorage; only the 'admin' param is stripped from the URL (gpx/rid stay).
  (function captureAdmin() {
    try {
      var m = location.search.match(/[?&]admin=([^&]*)/);
      if (!m) return;
      var v = decodeURIComponent(m[1]);
      if (!v || v === 'off') sessionStorage.removeItem('guaruna-admin'); else sessionStorage.setItem('guaruna-admin', v);
      var p = new URLSearchParams(location.search); p.delete('admin');
      var qs = p.toString();
      history.replaceState({}, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) {}
  })();

  var CAM = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

  // ---- self-contained lightbox ----
  var lb, lbImg;
  function ensureLb() {
    if (lb) return;
    lb = el('div', 'lightbox is-hidden');
    var c = el('button', 'lightbox-close', '×'); c.type = 'button'; c.setAttribute('aria-label', 'Close');
    lbImg = el('img'); lbImg.alt = 'Photo';
    lb.appendChild(c); lb.appendChild(lbImg); document.body.appendChild(lb);
    c.addEventListener('click', hideLb);
    lb.addEventListener('click', function (e) { if (e.target === lb) hideLb(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && lb && !lb.classList.contains('is-hidden')) hideLb(); });
  }
  function showLb(url) { ensureLb(); lbImg.src = url; lb.classList.remove('is-hidden'); document.body.style.overflow = 'hidden'; }
  function hideLb() { if (!lb) return; lb.classList.add('is-hidden'); lbImg.src = ''; document.body.style.overflow = ''; }

  function uploadAll(rid, files, pseudo, note) {
    var out = [];
    return files.reduce(function (chain, f) {
      return chain.then(function () {
        var fd = new FormData(); fd.append('file', f); fd.append('pseudo', pseudo || ''); fd.append('note', note || '');
        return api('/api/routes/' + encodeURIComponent(rid) + '/photos', { method: 'POST', body: fd })
          .then(function (r) { if (r.ok && r.data) out.push(r.data); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  function card(p, onChange) {
    var c = el('div', 'photo-card');
    var th = el('div', 'photo-thumb');
    var img = el('img'); img.loading = 'lazy'; img.src = p.thumb || p.url; img.alt = p.note || 'Route photo';
    img.addEventListener('click', function () { showLb(p.url); });
    th.appendChild(img); c.appendChild(th);
    var meta = el('div', 'pc-meta');
    meta.appendChild(el('div', 'pc-pseudo', p.pseudo || 'Anonyme'));
    if (p.note) meta.appendChild(el('div', 'pc-note', p.note));
    c.appendChild(meta);
    var tok = adminTok();
    if (tok) {
      var del = el('button', 'photo-del pc-del', '×'); del.type = 'button'; del.title = 'Delete photo (admin)';
      del.addEventListener('click', function () {
        if (!window.confirm('Delete this photo?')) return;
        api('/api/photos/' + encodeURIComponent(p.id), { method: 'DELETE', headers: { 'X-Admin-Token': tok } })
          .then(function (r) { if (r.ok) { c.remove(); if (onChange) onChange(); } });
      });
      c.appendChild(del);
    }
    return c;
  }

  GP.mount = function (container, routeId, opts) {
    opts = opts || {};
    if (!container || !routeId) return null;
    container.innerHTML = '';
    container.classList.remove('is-hidden');

    var title = el('div', 'rd-section-title');
    title.appendChild(el('span', null, 'Photos & info'));
    var count = el('span', 'rr-diff', ''); title.appendChild(count);
    container.appendChild(title);

    var hint = el('p', 'muted'); hint.style.fontSize = '.85rem'; hint.style.margin = '-4px 0 12px';
    hint.textContent = 'Share a photo and add the access point, parking, the trailhead address or any tip.';
    container.appendChild(hint);

    var gallery = el('div', 'photo-cards'); container.appendChild(gallery);

    function refresh() {
      api('/api/routes/' + encodeURIComponent(routeId) + '/photos').then(function (res) {
        var items = (res && res.ok && res.data && res.data.items) ? res.data.items : [];
        gallery.innerHTML = '';
        count.textContent = items.length ? (items.length + ' photo' + (items.length === 1 ? '' : 's')) : '';
        if (!items.length) gallery.appendChild(el('p', 'muted', 'No photos yet — be the first to add one.'));
        else items.forEach(function (p) { gallery.appendChild(card(p, function () { refresh(); })); });
        if (opts.onChange) opts.onChange(items.length);
      });
    }

    // add form
    var form = el('div', 'photo-add-form');
    var fp = el('div', 'field'); fp.appendChild(el('label', null, 'Your name / pseudo'));
    var pseudo = el('input', 'input'); pseudo.type = 'text'; pseudo.maxLength = 40; pseudo.placeholder = 'e.g. Alex'; pseudo.value = getPseudo();
    fp.appendChild(pseudo); form.appendChild(fp);
    var fn = el('div', 'field'); fn.appendChild(el('label', null, 'Note (place, access, parking, tip…)'));
    var note = el('textarea', 'input'); note.maxLength = 600; note.placeholder = 'e.g. Park at the lake car park, trail starts behind the kiosk.';
    fn.appendChild(note); form.appendChild(fn);

    var picked = [];
    var input = el('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.style.display = 'none';
    var bar = el('div', 'photo-add-bar');
    var choose = el('button', 'btn btn-ghost btn-sm', ''); choose.type = 'button'; choose.innerHTML = CAM + ' Choose photo(s)';
    var chosen = el('span', 'muted'); chosen.style.fontSize = '.85rem';
    var add = el('button', 'btn btn-primary btn-sm', 'Add'); add.type = 'button'; add.disabled = true;
    choose.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      picked = Array.prototype.slice.call(input.files).slice(0, 8);
      chosen.textContent = picked.length ? (picked.length + ' selected') : '';
      add.disabled = !picked.length;
    });
    add.addEventListener('click', function () {
      if (!picked.length) return;
      setPseudo(pseudo.value.trim());
      add.disabled = true; add.textContent = 'Uploading…';
      uploadAll(routeId, picked, pseudo.value.trim(), note.value).then(function (added) {
        picked = []; input.value = ''; chosen.textContent = ''; note.value = ''; add.textContent = 'Add';
        if (!added.length) window.alert('Upload failed (image too large or unsupported?).');
        refresh();
      });
    });
    bar.appendChild(choose); bar.appendChild(chosen); bar.appendChild(add);
    form.appendChild(input); form.appendChild(bar);
    container.appendChild(form);

    refresh();
    return { refresh: refresh };
  };

  // ---- auto-init on a standalone page (e.g. the GPX viewer) ----
  function resolveAndMount() {
    var host = document.getElementById('route-photos');
    if (!host) return;
    var u; try { u = new URLSearchParams(location.search); } catch (e) { return; }
    var rid = u.get('rid');
    if (rid) { GP.mount(host, rid, {}); return; }
    var gpx = u.get('gpx');
    if (!gpx) return;
    var m = gpx.match(/\/routes\/(?:uploads\/)?([^\/?#]+)\.gpx$/i);
    if (!m) return;
    var cand = m[1];
    api('/api/routes/' + encodeURIComponent(cand)).then(function (r) { if (r.ok && r.data) GP.mount(host, cand, {}); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolveAndMount);
  else resolveAndMount();
})();
