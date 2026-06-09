/* =========================================================
   Guaruna — GPX database: route detail drawer + souvenir widgets
   Attaches to window.GDB. Shared helpers (api, fmt, icons, miniMap,
   openLightbox, afterJournalChange, adminToken) are provided by
   database.js and resolved at call time. User text -> textContent.
   ========================================================= */
(function () {
  'use strict';
  var GDB = (window.GDB = window.GDB || {});

  // ---- constants shared across the app ----
  GDB.FEELINGS = ['easy', 'strong', 'tough', 'epic', 'meh'];
  var FEELING_LABELS = { easy: '😌 Easy', strong: '💪 Strong', tough: '🥵 Tough', epic: '🤩 Epic', meh: '😐 Meh' };
  var TYPE_LABELS = { run: 'Run', trail: 'Trail', bike: 'Bike', hike: 'Hike', walk: 'Walk', other: 'Other' };
  GDB.feelingLabel = function (f) { return FEELING_LABELS[f] || ''; };
  GDB.typeLabel = function (t) { return TYPE_LABELS[t] || 'Other'; };

  var IC = {
    pin: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    dl: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>',
    view: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>'
  };

  // ---- small DOM helper (XSS-safe text) ----
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(u, o) { return GDB.api(u, o); }

  // ---- star rating widget ----
  GDB.makeStars = function (initial) {
    var wrap = el('div', 'star-rating');
    var value = initial || 0;
    var btns = [];
    function paint() { btns.forEach(function (b, i) { b.classList.toggle('on', i < value); }); }
    for (var i = 0; i < 5; i++) {
      (function (idx) {
        var b = el('button', null, '★'); b.type = 'button'; b.setAttribute('aria-label', (idx + 1) + ' stars');
        b.addEventListener('click', function () { value = (value === idx + 1) ? 0 : idx + 1; paint(); });
        btns.push(b); wrap.appendChild(b);
      })(i);
    }
    paint();
    return { el: wrap, get: function () { return value; }, set: function (v) { value = v || 0; paint(); } };
  };

  // ---- feeling / mood chips ----
  GDB.makeMoodChips = function (initial) {
    var wrap = el('div', 'mood-chips');
    var value = initial || '';
    var chips = [];
    function paint() { chips.forEach(function (c) { c.classList.toggle('on', c.dataset.f === value); }); }
    GDB.FEELINGS.forEach(function (f) {
      var c = el('button', 'mood-chip', FEELING_LABELS[f]); c.type = 'button'; c.dataset.f = f;
      c.addEventListener('click', function () { value = (value === f) ? '' : f; paint(); });
      chips.push(c); wrap.appendChild(c);
    });
    paint();
    return { el: wrap, get: function () { return value; }, set: function (v) { value = v || ''; paint(); } };
  };

  // ---- local (pre-upload) photo picker ----
  function makePhotoPicker() {
    var wrap = el('div', 'photo-gallery');
    var files = [];
    var input = el('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.style.display = 'none';
    var add = el('button', 'photo-add', '+'); add.type = 'button'; add.title = 'Add photos';
    add.addEventListener('click', function () { input.click(); });
    function render() {
      wrap.querySelectorAll('.photo-thumb').forEach(function (n) { n.remove(); });
      files.forEach(function (f, i) {
        var t = el('div', 'photo-thumb');
        var img = el('img'); img.src = URL.createObjectURL(f); img.alt = f.name || 'photo'; t.appendChild(img);
        var del = el('button', 'photo-del', '×'); del.type = 'button'; del.title = 'Remove';
        del.addEventListener('click', function () { files.splice(i, 1); render(); });
        t.appendChild(del);
        wrap.insertBefore(t, add);
      });
    }
    input.addEventListener('change', function () {
      for (var i = 0; i < input.files.length; i++) { if (files.length < 8) files.push(input.files[i]); }
      input.value = ''; render();
    });
    wrap.appendChild(add); wrap.appendChild(input);
    return { el: wrap, files: function () { return files.slice(); }, clear: function () { files = []; render(); } };
  }

  // ---- souvenir editor (date, stars, mood, note, tags, optional photos) ----
  GDB.buildSouvenir = function (container, opts) {
    opts = opts || {};
    container.innerHTML = '';
    var init = opts.initial || {};

    var row = el('div', 'sv-row');
    var fDate = el('div', 'field');
    fDate.appendChild(el('label', null, 'Date'));
    var date = el('input', 'input'); date.type = 'date'; date.value = init.date || GDB.today();
    fDate.appendChild(date);
    var fRate = el('div', 'field');
    fRate.appendChild(el('label', null, 'Rating'));
    var stars = GDB.makeStars(init.rating || 0); fRate.appendChild(stars.el);
    row.appendChild(fDate); row.appendChild(fRate);
    container.appendChild(row);

    var fFeel = el('div', 'field'); fFeel.appendChild(el('label', null, 'How did it feel?'));
    var mood = GDB.makeMoodChips(init.feeling || ''); fFeel.appendChild(mood.el); container.appendChild(fFeel);

    var fNote = el('div', 'field'); fNote.appendChild(el('label', null, 'Note'));
    var note = el('textarea', 'input'); note.maxLength = 2000; note.placeholder = 'How was it? Conditions, highlights…';
    if (init.note) note.value = init.note; fNote.appendChild(note); container.appendChild(fNote);

    var fTags = el('div', 'field'); fTags.appendChild(el('label', null, 'Tags (comma separated)'));
    var tags = el('input', 'input'); tags.placeholder = 'trail, morning, with friends';
    if (init.tags && init.tags.length) tags.value = init.tags.join(', '); fTags.appendChild(tags); container.appendChild(fTags);

    var picker = null;
    if (opts.withPhotos) {
      var fPh = el('div', 'field'); fPh.appendChild(el('label', null, 'Photos'));
      picker = makePhotoPicker(); fPh.appendChild(picker.el); container.appendChild(fPh);
    }

    return {
      read: function () {
        return { date: date.value, rating: stars.get(), feeling: mood.get(), note: note.value, tags: tags.value };
      },
      files: function () { return picker ? picker.files() : []; },
      clear: function () { date.value = GDB.today(); stars.set(0); mood.set(''); note.value = ''; tags.value = ''; if (picker) picker.clear(); }
    };
  };

  // ---- existing-photo gallery (view + add + delete) ----
  GDB.photoGallery = function (outing, opts) {
    opts = opts || {};
    var wrap = el('div', 'photo-gallery');
    function thumb(p) {
      var t = el('div', 'photo-thumb');
      var img = el('img'); img.loading = 'lazy'; img.src = p.thumb || p.url; img.alt = 'Outing photo';
      img.addEventListener('click', function () { GDB.openLightbox(p.url); });
      t.appendChild(img);
      if (GDB.adminToken) {
        var del = el('button', 'photo-del', '×'); del.type = 'button'; del.title = 'Delete photo (admin)';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!window.confirm('Delete this photo?')) return;
          api('/api/photos/' + encodeURIComponent(p.id), { method: 'DELETE', headers: { 'X-Admin-Token': GDB.adminToken } })
            .then(function (res) { if (res.ok) { t.remove(); if (opts.onChange) opts.onChange(); } });
        });
        t.appendChild(del);
      }
      return t;
    }
    (outing.photos || []).forEach(function (p) { wrap.appendChild(thumb(p)); });

    if (opts.canAdd !== false) {
      var input = el('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.style.display = 'none';
      var add = el('button', 'photo-add', '+'); add.type = 'button'; add.title = 'Add photos';
      add.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function () {
        var fs = Array.prototype.slice.call(input.files); input.value = '';
        add.classList.add('photo-uploading');
        GDB.uploadPhotos(outing.id, fs).then(function (added) {
          add.classList.remove('photo-uploading');
          added.forEach(function (p) { wrap.insertBefore(thumb(p), add); });
          if (added.length && opts.onChange) opts.onChange();
        });
      });
      wrap.appendChild(add); wrap.appendChild(input);
    }
    return wrap;
  };

  // upload a list of File objects to an outing, sequentially; resolves with created photo items
  GDB.uploadPhotos = function (outingId, files) {
    var out = [];
    return files.reduce(function (chain, f) {
      return chain.then(function () {
        var fd = new FormData(); fd.append('file', f);
        return api('/api/outings/' + encodeURIComponent(outingId) + '/photos', { method: 'POST', body: fd })
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

  // ---- metric cell ----
  function metric(k, v) { var m = el('div', 'metric'); m.appendChild(el('div', 'k', k)); m.appendChild(el('div', 'v', v)); return m; }

  // ---- a souvenir card inside the detail drawer ----
  function souvenirCard(o, onChange) {
    var card = el('div', 'gpx-card'); card.style.marginBottom = '12px';
    var head = el('div', 'rd-section-title');
    head.appendChild(el('span', null, GDB.fmtDate(o.date)));
    var right = el('span');
    if (o.rating) { var st = el('span', 'rr-stars'); st.textContent = '★'.repeat(o.rating) + '☆'.repeat(5 - o.rating); right.appendChild(st); }
    head.appendChild(right);
    card.appendChild(head);
    var meta = el('div', 'te-meta');
    if (o.feeling) meta.appendChild(el('span', null, GDB.feelingLabel(o.feeling)));
    card.appendChild(meta);
    if (o.note) { var n = el('div', 'te-note', o.note); card.appendChild(n); }
    if (o.tags && o.tags.length) {
      var tg = el('div', 'te-tags'); o.tags.forEach(function (t) { tg.appendChild(el('span', 'te-tag', t)); }); card.appendChild(tg);
    }
    card.appendChild(GDB.photoGallery(o, { canAdd: true, onChange: onChange }));
    if (GDB.adminToken) {
      var del = el('button', 'btn btn-ghost btn-sm', 'Delete outing'); del.type = 'button'; del.style.marginTop = '10px';
      del.addEventListener('click', function () {
        if (!window.confirm('Delete this outing and its photos?')) return;
        api('/api/outings/' + encodeURIComponent(o.id), { method: 'DELETE', headers: { 'X-Admin-Token': GDB.adminToken } })
          .then(function (res) { if (res.ok) { card.remove(); if (onChange) onChange(); GDB.afterJournalChange(); } });
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
    // fetch full detail + outings
    Promise.all([
      api('/api/routes/' + encodeURIComponent(route.id)),
      api('/api/routes/' + encodeURIComponent(route.id) + '/outings')
    ]).then(function (r) {
      var full = (r[0] && r[0].ok && r[0].data) ? r[0].data : route;
      var outings = (r[1] && r[1].ok && r[1].data && r[1].data.items) ? r[1].data.items : [];
      render(full, full, outings);
    });
  }

  function render(route, full, outings) {
    panel.innerHTML = '';

    // head
    var head = el('div', 'rd-head');
    var title = el('div', 'rd-title');
    title.appendChild(el('h2', null, route.name || 'Route'));
    if (route.location) { var loc = el('span', 'rd-loc'); loc.innerHTML = IC.pin; loc.appendChild(document.createTextNode(' ' + route.location)); title.appendChild(loc); }
    head.appendChild(title);
    var close1 = el('button', 'rd-close', '×'); close1.type = 'button'; close1.setAttribute('aria-label', 'Close');
    close1.addEventListener('click', close); head.appendChild(close1);
    panel.appendChild(head);

    var body = el('div', 'rd-body');
    panel.appendChild(body);

    // map
    var mapwrap = el('div', 'gpx-mapwrap');
    var mapholder = el('div', 'gpx-map'); mapholder.id = 'rd-map'; mapwrap.appendChild(mapholder);
    body.appendChild(mapwrap);
    var poly = (full && full.polyline_full && full.polyline_full.length) ? full.polyline_full : route.polyline;
    var done = GDB.isDone(route.id);
    setTimeout(function () { if (detailMap) { try { detailMap.remove(); } catch (e) {} } detailMap = GDB.miniMap(mapholder, poly, done ? '#11C29B' : '#2F6BFF'); }, 30);

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

    // souvenirs
    var st = el('div', 'rd-section-title');
    st.appendChild(el('span', null, 'Souvenirs & history'));
    if (outings && outings.length) st.appendChild(el('span', 'rr-diff', outings.length + ' outing' + (outings.length === 1 ? '' : 's')));
    body.appendChild(st);

    var listWrap = el('div');
    body.appendChild(listWrap);
    function refreshOutings() {
      api('/api/routes/' + encodeURIComponent(route.id) + '/outings').then(function (res) {
        var items = (res && res.ok && res.data && res.data.items) ? res.data.items : [];
        listWrap.innerHTML = '';
        items.forEach(function (o) { listWrap.appendChild(souvenirCard(o, refreshOutings)); });
      });
    }
    (outings || []).forEach(function (o) { listWrap.appendChild(souvenirCard(o, refreshOutings)); });

    // "log an outing" form
    var formCard = el('div', 'gpx-card');
    formCard.appendChild(el('div', 'rd-section-title', 'I did this — log an outing'));
    var souvBox = el('div'); formCard.appendChild(souvBox);
    var souv = GDB.buildSouvenir(souvBox, { withPhotos: true });
    var save = el('button', 'btn btn-primary btn-block', 'Save to my history'); save.type = 'button'; save.style.marginTop = '6px';
    save.addEventListener('click', function () {
      save.disabled = true; save.textContent = 'Saving…';
      var f = souv.read();
      var fd = new FormData();
      fd.append('route_id', route.id); fd.append('date', f.date); fd.append('rating', String(f.rating || 0));
      fd.append('feeling', f.feeling || ''); fd.append('note', f.note || ''); fd.append('tags', f.tags || '');
      api('/api/outings', { method: 'POST', body: fd }).then(function (res) {
        if (!res.ok || !res.data) { save.disabled = false; save.textContent = 'Save to my history'; window.alert((res.data && res.data.detail) || 'Could not save.'); return; }
        var oid = res.data.id;
        return GDB.uploadPhotos(oid, souv.files()).then(function () {
          souv.clear(); save.disabled = false; save.textContent = 'Save to my history';
          refreshOutings(); GDB.afterJournalChange();
          if (detailMap) { /* recolor route as done */ }
        });
      });
    });
    formCard.appendChild(save);
    body.appendChild(formCard);
  }

  GDB.Detail = { open: open, close: close };

  // overlay scrim + Esc close (wired once DOM is ready)
  function wire() {
    overlay = document.getElementById('route-detail');
    if (!overlay) return;
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && !overlay.classList.contains('is-hidden')) close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
