/* =========================================================
   Guaruna — GPX database: route detail drawer
   Mini-map + elevation profile + stats + community photos
   (each photo carries a pseudo + a note, e.g. access / parking / place).
   Attaches to window.GDB. Shared helpers (api, el, miniMap, openLightbox,
   fmtDuration, adminToken, refresh) come from database.js, resolved at call
   time. User text -> textContent (no XSS).
   ========================================================= */
(function () {
  'use strict';
  var GDB = (window.GDB = window.GDB || {});

  var TYPE_LABELS = { run: 'Run', trail: 'Trail', bike: 'Bike', hike: 'Hike', walk: 'Walk', other: 'Other' };
  GDB.typeLabel = function (t) { return TYPE_LABELS[t] || 'Other'; };

  var IC = {
    pin: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    dl: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>',
    view: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
    cam: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'
  };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(u, o) { return GDB.api(u, o); }

  function getPseudo() { try { return localStorage.getItem('guaruna-pseudo') || ''; } catch (e) { return ''; } }
  function setPseudo(v) { try { localStorage.setItem('guaruna-pseudo', v); } catch (e) {} }

  // upload a list of File objects to a route's photos (pseudo + note apply to the batch)
  GDB.uploadRoutePhotos = function (rid, files, pseudo, note) {
    var out = [];
    return files.reduce(function (chain, f) {
      return chain.then(function () {
        var fd = new FormData(); fd.append('file', f); fd.append('pseudo', pseudo || ''); fd.append('note', note || '');
        return api('/api/routes/' + encodeURIComponent(rid) + '/photos', { method: 'POST', body: fd })
          .then(function (res) { if (res.ok && res.data) out.push(res.data); });
      });
    }, Promise.resolve()).then(function () { return out; });
  };

  // ---- elevation profile (from [[dist_km, ele_m], ...]) ----
  function renderProfile(holder, profile) {
    if (!profile || profile.length < 2) { holder.classList.add('is-hidden'); return; }
    var totalKm = profile[profile.length - 1][0] || 0;
    var es = profile.map(function (p) { return p[1]; });
    var minE = Math.min.apply(null, es), maxE = Math.max.apply(null, es), range = (maxE - minE) || 1;
    var W = 720, H = 200, mL = 42, mR = 12, mT = 12, mB = 24;
    var x0 = mL, plotW = W - mL - mR, yTop = mT, yBot = H - mB, plotH = yBot - yTop;
    function sx(d) { return x0 + (totalKm ? d / totalKm : 0) * plotW; }
    function sy(e) { return yBot - ((e - minE) / range) * plotH; }
    var line = '', area = '';
    profile.forEach(function (p, j) {
      var x = sx(p[0]), y = sy(p[1]);
      line += (j === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      area += (j === 0 ? 'M' + x.toFixed(1) + ' ' + yBot + ' L' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    });
    area += 'L' + sx(profile[profile.length - 1][0]).toFixed(1) + ' ' + yBot + ' Z';
    var grid = '';
    for (var t = 0; t <= 3; t++) {
      var val = minE + range * t / 3, gy = sy(val);
      grid += '<line x1="' + x0 + '" y1="' + gy.toFixed(1) + '" x2="' + (W - mR) + '" y2="' + gy.toFixed(1) + '" class="ax-grid"/>';
      grid += '<text x="' + (x0 - 7) + '" y="' + (gy + 4).toFixed(1) + '" class="ax-lbl ax-y">' + Math.round(val) + '</text>';
    }
    var xax = '';
    for (var k = 0; k <= 4; k++) {
      var km = totalKm * k / 4, xx = sx(km);
      xax += '<text x="' + xx.toFixed(1) + '" y="' + (yBot + 17) + '" class="ax-lbl ax-x">' + (totalKm >= 10 ? Math.round(km) : km.toFixed(1)) + '</text>';
    }
    holder.innerHTML =
      '<svg class="gpx-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Elevation profile">' +
      '<defs><linearGradient id="eleFillD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2F6BFF" stop-opacity="0.3"/><stop offset="1" stop-color="#2F6BFF" stop-opacity="0"/></linearGradient></defs>' +
      grid + '<path d="' + area + '" fill="url(#eleFillD)"/>' +
      '<path d="' + line + '" fill="none" stroke="#2F6BFF" stroke-width="2.2" stroke-linejoin="round"/>' +
      xax + '<text x="8" y="15" class="ax-lbl ax-unit">m</text></svg>';
    holder.classList.remove('is-hidden');
  }

  function metric(k, v) { var m = el('div', 'metric'); m.appendChild(el('div', 'k', k)); m.appendChild(el('div', 'v', v)); return m; }

  // ---- a community photo card (image + pseudo + note) ----
  function photoCard(p, onChange) {
    var card = el('div', 'photo-card');
    var th = el('div', 'photo-thumb');
    var img = el('img'); img.loading = 'lazy'; img.src = p.thumb || p.url; img.alt = p.note || 'Route photo';
    img.addEventListener('click', function () { GDB.openLightbox(p.url); });
    th.appendChild(img); card.appendChild(th);
    var meta = el('div', 'pc-meta');
    meta.appendChild(el('div', 'pc-pseudo', p.pseudo || 'Anonyme'));
    if (p.note) meta.appendChild(el('div', 'pc-note', p.note));
    card.appendChild(meta);
    if (GDB.adminToken) {
      var del = el('button', 'photo-del pc-del', '×'); del.type = 'button'; del.title = 'Delete photo (admin)';
      del.addEventListener('click', function () {
        if (!window.confirm('Delete this photo?')) return;
        api('/api/photos/' + encodeURIComponent(p.id), { method: 'DELETE', headers: { 'X-Admin-Token': GDB.adminToken } })
          .then(function (res) { if (res.ok) { card.remove(); if (onChange) onChange(); } });
      });
      card.appendChild(del);
    }
    return card;
  }

  // ========================================================
  // Detail drawer
  // ========================================================
  var overlay, panel, detailMap;

  function close() {
    if (detailMap) { try { detailMap.remove(); } catch (e) {} detailMap = null; }
    if (overlay) overlay.classList.add('is-hidden');
    document.body.style.overflow = '';
  }

  function open(route) {
    overlay = document.getElementById('route-detail');
    panel = document.getElementById('route-detail-panel');
    if (!overlay || !panel) return;
    overlay.classList.remove('is-hidden');
    document.body.style.overflow = 'hidden';
    panel.scrollTop = 0;
    render(route, route); // quick paint with the list item's fields
    api('/api/routes/' + encodeURIComponent(route.id)).then(function (r) {
      var full = (r && r.ok && r.data) ? r.data : route;
      render(full, full);
    });
  }

  function render(route, full) {
    panel.innerHTML = '';

    var head = el('div', 'rd-head');
    var title = el('div', 'rd-title');
    title.appendChild(el('h2', null, route.name || 'Route'));
    if (route.location) { var loc = el('span', 'rd-loc'); loc.innerHTML = IC.pin; loc.appendChild(document.createTextNode(' ' + route.location)); title.appendChild(loc); }
    head.appendChild(title);
    var closeBtn = el('button', 'rd-close', '×'); closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', close); head.appendChild(closeBtn);
    panel.appendChild(head);

    var body = el('div', 'rd-body');
    panel.appendChild(body);

    // map
    var mapwrap = el('div', 'gpx-mapwrap');
    var mapholder = el('div', 'gpx-map'); mapholder.id = 'rd-map'; mapwrap.appendChild(mapholder);
    body.appendChild(mapwrap);
    var poly = (full && full.polyline_full && full.polyline_full.length) ? full.polyline_full : route.polyline;
    setTimeout(function () { if (detailMap) { try { detailMap.remove(); } catch (e) {} } detailMap = GDB.miniMap(mapholder, poly, '#2F6BFF'); }, 30);

    // actions
    var actions = el('div', 'rd-actions');
    var viewUrl = '/gpx-analyzer?gpx=' + route.url + '&name=' + encodeURIComponent(route.name || '') + (route.location ? '&country=' + encodeURIComponent(route.location) : '');
    var view = el('a', 'btn btn-primary btn-sm'); view.href = viewUrl; view.innerHTML = IC.view + ' Open in viewer'; actions.appendChild(view);
    var dl = el('a', 'btn btn-ghost btn-sm'); dl.href = route.url; dl.setAttribute('download', ''); dl.innerHTML = IC.dl + ' Download'; actions.appendChild(dl);
    body.appendChild(actions);

    // stats
    var sb = el('div', 'gpx-statbar rd-statbar');
    sb.appendChild(metric('Distance', (route.distance_km != null ? route.distance_km : '—') + ' km'));
    sb.appendChild(metric('Elev. gain', '+' + (route.elevation_gain || 0) + ' m'));
    sb.appendChild(metric('Elev. loss', '−' + ((full && full.elevation_loss) || route.elevation_loss || 0) + ' m'));
    sb.appendChild(metric('Duration', GDB.fmtDuration((full && full.duration_s) || route.duration_s)));
    sb.appendChild(metric('Difficulty', 'Lv ' + ((full && full.difficulty) || route.difficulty || 1)));
    sb.appendChild(metric('Activity', GDB.typeLabel((full && full.activity_type) || route.activity_type)));
    body.appendChild(sb);

    // elevation profile
    if (full && full.profile && full.profile.length > 1) {
      body.appendChild(el('div', 'rd-section-title', 'Elevation'));
      var prof = el('div', 'rd-profile gpx-card'); body.appendChild(prof); renderProfile(prof, full.profile);
    }

    // ---- photos & info ----
    var st = el('div', 'rd-section-title');
    st.appendChild(el('span', null, 'Photos & info'));
    var countLbl = el('span', 'rr-diff', ''); st.appendChild(countLbl);
    body.appendChild(st);

    var hint = el('p', 'muted'); hint.style.fontSize = '.85rem'; hint.style.margin = '-4px 0 12px';
    hint.textContent = 'Share a photo and add the access point, parking, the trailhead address or any tip.';
    body.appendChild(hint);

    var gallery = el('div', 'photo-cards');
    body.appendChild(gallery);

    function refreshPhotos() {
      api('/api/routes/' + encodeURIComponent(route.id) + '/photos').then(function (res) {
        var items = (res && res.ok && res.data && res.data.items) ? res.data.items : [];
        gallery.innerHTML = '';
        countLbl.textContent = items.length ? (items.length + ' photo' + (items.length === 1 ? '' : 's')) : '';
        if (!items.length) { gallery.appendChild(el('p', 'muted', 'No photos yet — be the first to add one.')); }
        else items.forEach(function (p) { gallery.appendChild(photoCard(p, function () { refreshPhotos(); if (GDB.refresh) GDB.refresh(); })); });
      });
    }
    refreshPhotos();

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
    var choose = el('button', 'btn btn-ghost btn-sm', ''); choose.type = 'button'; choose.innerHTML = IC.cam + ' Choose photo(s)';
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
      GDB.uploadRoutePhotos(route.id, picked, pseudo.value.trim(), note.value).then(function (added) {
        picked = []; input.value = ''; chosen.textContent = ''; note.value = '';
        add.textContent = 'Add';
        if (!added.length) window.alert('Upload failed (image too large or unsupported?).');
        refreshPhotos(); if (GDB.refresh) GDB.refresh();
      });
    });
    bar.appendChild(choose); bar.appendChild(chosen); bar.appendChild(add);
    form.appendChild(input); form.appendChild(bar);
    body.appendChild(form);
  }

  GDB.Detail = { open: open, close: close };

  function wire() {
    overlay = document.getElementById('route-detail');
    if (!overlay) return;
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && !overlay.classList.contains('is-hidden')) close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
