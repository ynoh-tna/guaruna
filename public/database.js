/* =========================================================
   Guaruna — GPX database (compact list view)
   Talks to /api on the same origin. Robust against an
   offline API: responses are read as text and JSON-parsed
   in a try/catch (a non-JSON/HTML response never throws a
   raw "JSON.parse" error). User text -> textContent (no XSS).
   ========================================================= */
(function () {
  'use strict';

  var root = document.getElementById('gpx-db');
  if (!root) return;

  var list = root.querySelector('#db-grid');
  var statusEl = root.querySelector('#db-status');
  var pager = root.querySelector('#db-pager');
  var search = root.querySelector('#db-search');
  var addBtn = root.querySelector('#db-add-btn');

  var modal = root.querySelector('#db-modal');
  var form = root.querySelector('#db-form');
  var nameInput = root.querySelector('#db-name');
  var fileInput = root.querySelector('#db-file');
  var formErr = root.querySelector('#db-form-error');
  var submitBtn = root.querySelector('#db-submit');

  var state = { q: '', page: 1 };
  var debounce;

  // Admin: open /gpx-database?admin=YOUR_TOKEN to enable delete buttons.
  // (?admin=off clears it.) Kept in sessionStorage for this tab only;
  // sent as the X-Admin-Token header on DELETE.
  var adminToken = (function () {
    try {
      var m = location.search.match(/[?&]admin=([^&]*)/);
      if (m) {
        var v = decodeURIComponent(m[1]);
        if (!v || v === 'off') sessionStorage.removeItem('guaruna-admin');
        else sessionStorage.setItem('guaruna-admin', v);
        history.replaceState({}, '', location.pathname);
      }
      return sessionStorage.getItem('guaruna-admin');
    } catch (e) { return null; }
  })();

  var ROUTE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18 Q 9 8 13 14 T 20 6"/><circle cx="4" cy="18" r="1.5" fill="#fff"/><circle cx="20" cy="6" r="1.5" fill="#fff"/></svg>';
  var PIN_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  var DL_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>';
  var DEL_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- API helper: never throws on non-JSON ----
  function api(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { ok: r.ok, status: r.status, data: data };
      });
    }, function () { return { ok: false, status: 0, data: null }; });
  }

  function clearStatus() { statusEl.innerHTML = ''; statusEl.classList.add('is-hidden'); }

  function showSkeletons() {
    clearStatus();
    pager.innerHTML = '';
    list.innerHTML = '';
    for (var i = 0; i < 6; i++) {
      var s = el('div', 'route-row skeleton');
      s.innerHTML = '<span class="sk-dot"></span><div class="sk-main"><div class="sk-line"></div><div class="sk-line short"></div></div><div class="sk-btn"></div>';
      list.appendChild(s);
    }
  }

  function showMessage(icon, title, sub, actionLabel, actionFn) {
    list.innerHTML = '';
    pager.innerHTML = '';
    statusEl.classList.remove('is-hidden');
    statusEl.innerHTML = '';
    var box = el('div', 'db-empty');
    var ic = el('div', 'db-empty-icon'); ic.innerHTML = icon; box.appendChild(ic);
    box.appendChild(el('h3', null, title));
    if (sub) box.appendChild(el('p', null, sub));
    if (actionLabel) {
      var b = el('button', 'btn btn-primary', actionLabel);
      b.type = 'button';
      b.addEventListener('click', actionFn);
      box.appendChild(b);
    }
    statusEl.appendChild(box);
  }

  function load() {
    showSkeletons();
    api('/api/routes?q=' + encodeURIComponent(state.q) + '&page=' + state.page).then(function (res) {
      if (!res.ok || !res.data || !Array.isArray(res.data.items)) {
        showMessage(
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l22 22"/><path d="M16.7 16.7A11 11 0 0 1 5 13"/><path d="M2 8.8A16 16 0 0 1 8 5.6"/><path d="M12 4c3.7 0 7 1.3 9.6 3.4"/><path d="M12 20h.01"/></svg>',
          'Route database unavailable',
          'The database service is offline right now. Please try again later.',
          'Retry', function () { load(); });
        return;
      }
      var data = res.data;
      if (!data.items.length) {
        if (state.q) showMessage(PIN_SVG, 'No matches', 'No routes match “' + state.q + '”.', 'Add a route', openModal);
        else showMessage(ROUTE_SVG.replace(/#fff/g, 'currentColor'), 'No routes yet', 'Be the first to share a GPX route.', 'Add a route', openModal);
        return;
      }
      clearStatus();
      list.innerHTML = '';
      data.items.forEach(function (it) { list.appendChild(row(it)); });
      renderPager(data);
    });
  }

  function row(it) {
    var viewUrl = '/gpx-analyzer?gpx=' + it.url
      + '&name=' + encodeURIComponent(it.name)
      + (it.location ? '&country=' + encodeURIComponent(it.location) : '');
    var r = el('div', 'route-row');

    var ic = el('span', 'route-row-icon');
    ic.innerHTML = it.thumb
      ? '<svg class="route-thumb" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"><path d="' + it.thumb + '" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : ROUTE_SVG;
    r.appendChild(ic);

    var main = el('div', 'route-row-main');
    var name = el('a', 'route-row-name', it.name); name.href = viewUrl;
    main.appendChild(name);

    var meta = el('div', 'route-row-meta');
    if (it.location) {
      var loc = el('span', 'rm-loc'); loc.innerHTML = PIN_SVG;
      loc.appendChild(document.createTextNode(' ' + it.location));
      meta.appendChild(loc);
      meta.appendChild(el('span', 'rm-sep', '·'));
    }
    meta.appendChild(el('span', 'rm-stat', it.distance_km + ' km'));
    meta.appendChild(el('span', 'rm-sep', '·'));
    meta.appendChild(el('span', 'rm-stat', '+' + it.elevation_gain + ' m'));
    main.appendChild(meta);
    r.appendChild(main);

    var actions = el('div', 'route-row-actions');
    var view = el('a', 'btn btn-primary btn-sm', 'View'); view.href = viewUrl;
    var dl = el('a', 'btn btn-ghost btn-sm btn-icon'); dl.href = it.url;
    dl.setAttribute('download', ''); dl.title = 'Download GPX'; dl.setAttribute('aria-label', 'Download GPX');
    dl.innerHTML = DL_SVG;
    actions.appendChild(view); actions.appendChild(dl);
    if (adminToken) {
      var del = el('button', 'btn btn-ghost btn-sm btn-icon route-del');
      del.type = 'button'; del.title = 'Delete (admin)'; del.setAttribute('aria-label', 'Delete route');
      del.innerHTML = DEL_SVG;
      del.addEventListener('click', function () { removeRoute(it); });
      actions.appendChild(del);
    }
    r.appendChild(actions);
    return r;
  }

  function removeRoute(it) {
    if (!window.confirm('Delete “' + it.name + '”? This cannot be undone.')) return;
    api('/api/routes/' + encodeURIComponent(it.id), { method: 'DELETE', headers: { 'X-Admin-Token': adminToken } }).then(function (res) {
      if (res.ok) { load(); }
      else if (res.status === 403) { window.alert('Admin token rejected. Reopen the page with ?admin=YOUR_TOKEN.'); }
      else { window.alert((res.data && res.data.detail) || 'Delete failed.'); }
    });
  }

  function renderPager(data) {
    pager.innerHTML = '';
    if (data.pages <= 1) {
      pager.appendChild(el('span', 'pager-info', data.total + ' route' + (data.total === 1 ? '' : 's')));
      return;
    }
    var prev = el('button', 'btn btn-ghost btn-sm', '← Prev');
    prev.type = 'button'; prev.disabled = data.page <= 1;
    prev.addEventListener('click', function () { state.page = data.page - 1; load(); scrollTop(); });
    var next = el('button', 'btn btn-ghost btn-sm', 'Next →');
    next.type = 'button'; next.disabled = data.page >= data.pages;
    next.addEventListener('click', function () { state.page = data.page + 1; load(); scrollTop(); });
    pager.appendChild(prev);
    pager.appendChild(el('span', 'pager-info', 'Page ' + data.page + ' of ' + data.pages + ' · ' + data.total + ' routes'));
    pager.appendChild(next);
  }

  function scrollTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }

  search.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () { state.q = search.value.trim(); state.page = 1; load(); }, 300);
  });

  // ---- add modal ----
  function openModal() { modal.classList.remove('is-hidden'); formErr.classList.add('is-hidden'); document.body.style.overflow = 'hidden'; nameInput.focus(); }
  function closeModal() { modal.classList.add('is-hidden'); document.body.style.overflow = ''; form.reset(); formErr.classList.add('is-hidden'); }

  addBtn.addEventListener('click', openModal);
  if (adminToken) {
    var badge = el('span', 'admin-badge', 'Admin mode');
    addBtn.parentNode.insertBefore(badge, addBtn);
  }
  modal.addEventListener('click', function (e) { if (e.target === modal || e.target.hasAttribute('data-close')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.classList.contains('is-hidden')) closeModal(); });

  // Reverse-geocode a few points of the track to a country list (OpenStreetMap
  // Nominatim). Best effort: returns '' on any failure and never blocks the upload.
  function detectCountries(file) {
    return new Promise(function (resolve) {
      var done = false;
      var guard = setTimeout(function () { if (!done) { done = true; resolve(''); } }, 9000);
      function finish(v) { if (!done) { done = true; clearTimeout(guard); resolve(v); } }
      var reader = new FileReader();
      reader.onerror = function () { finish(''); };
      reader.onload = function () {
        try {
          var doc = new DOMParser().parseFromString(String(reader.result), 'application/xml');
          var nodes = doc.getElementsByTagName('trkpt');
          if (!nodes.length) nodes = doc.getElementsByTagName('rtept');
          var pts = [];
          for (var i = 0; i < nodes.length; i++) {
            var la = parseFloat(nodes[i].getAttribute('lat')), lo = parseFloat(nodes[i].getAttribute('lon'));
            if (isFinite(la) && isFinite(lo)) pts.push([la, lo]);
          }
          if (!pts.length) return finish('');
          var picks = [0, Math.floor(pts.length / 3), Math.floor(2 * pts.length / 3), pts.length - 1]
            .filter(function (v, idx, a) { return a.indexOf(v) === idx; });
          var calls = picks.map(function (i) {
            var p = pts[i];
            return fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=3&accept-language=en&lat=' + p[0] + '&lon=' + p[1])
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (j) { return (j && j.address && j.address.country) ? j.address.country : null; })
              .catch(function () { return null; });
          });
          Promise.all(calls).then(function (rs) {
            var seen = {}, out = [];
            rs.forEach(function (c) { if (c && !seen[c]) { seen[c] = 1; out.push(c); } });
            finish(out.join(', '));
          });
        } catch (e) { finish(''); }
      };
      reader.readAsText(file);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    formErr.classList.add('is-hidden');
    var name = nameInput.value.trim();
    var file = fileInput.files[0];
    if (!name) return showErr('Please enter a name.');
    if (!file) return showErr('Please choose a .gpx file.');
    if (!/\.gpx$/i.test(file.name)) return showErr('The file must be a .gpx file.');
    if (file.size > 10 * 1024 * 1024) return showErr('File too large (max 10 MB).');

    submitBtn.disabled = true; submitBtn.textContent = 'Reading location…';
    detectCountries(file).then(function (countries) {
      var fd = new FormData();
      fd.append('name', name); fd.append('file', file);
      if (countries) fd.append('location', countries);
      submitBtn.textContent = 'Uploading…';
      return api('/api/routes', { method: 'POST', body: fd });
    }).then(function (res) {
      if (!res.ok) {
        showErr((res.data && res.data.detail) ? res.data.detail
          : (res.status === 0 ? 'Could not reach the server.' : 'Upload failed. Please try again.'));
        return;
      }
      closeModal();
      search.value = ''; state.q = ''; state.page = 1; load();
    }).finally(function () { submitBtn.disabled = false; submitBtn.textContent = 'Add route'; });
  });

  function showErr(msg) { formErr.textContent = msg; formErr.classList.remove('is-hidden'); }

  load();
})();
