/* =========================================================
   Guaruna — GPX database: explorer + journal orchestrator
   Talks to /api on the same origin. Robust against an offline
   API (responses read as text, JSON-parsed in try/catch).
   User text -> textContent (no XSS). Map: Leaflet (optional;
   falls back to a list-only experience if absent).
   ========================================================= */
(function () {
  'use strict';

  var root = document.getElementById('gpx-db');
  if (!root) return;
  var GDB = (window.GDB = window.GDB || {});

  // ---------- DOM refs ----------
  var listEl = root.querySelector('#db-grid');
  var statusEl = root.querySelector('#db-status');
  var pager = root.querySelector('#db-pager');
  var countEl = root.querySelector('#explore-count');
  var search = root.querySelector('#db-search');
  var addBtn = root.querySelector('#db-add-btn');

  var placeInput = root.querySelector('#place-search');
  var placeResults = root.querySelector('#place-results');
  var nearBtn = root.querySelector('#btn-near');
  var searchAreaBtn = root.querySelector('#btn-search-area');
  var mapFallback = root.querySelector('#map-fallback');

  var filterToggle = root.querySelector('#filter-toggle');
  var filterPanel = root.querySelector('#filter-panel');
  var filterCount = root.querySelector('#filter-count');
  var sortSelect = root.querySelector('#sort-select');
  var fDistMin = root.querySelector('#f-dist-min');
  var fDistMax = root.querySelector('#f-dist-max');
  var fElevMin = root.querySelector('#f-elev-min');
  var fElevMax = root.querySelector('#f-elev-max');
  var typeChips = root.querySelector('#type-chips');
  var surpriseBtn = root.querySelector('#btn-surprise');
  var clearBtn = root.querySelector('#btn-clear');

  var segs = root.querySelectorAll('.db-segment');
  var viewExplore = root.querySelector('#view-explore');
  var viewJournal = root.querySelector('#view-journal');

  var jStats = root.querySelector('#journal-stats');
  var jStatus = root.querySelector('#journal-status');
  var jTimeline = root.querySelector('#journal-timeline');
  var jPager = root.querySelector('#journal-pager');

  var lightbox = root.querySelector('#lightbox');
  var lightboxImg = root.querySelector('#lightbox-img');
  var lightboxClose = root.querySelector('#lightbox-close');

  var modal = root.querySelector('#db-modal');
  var form = root.querySelector('#db-form');
  var nameInput = root.querySelector('#db-name');
  var fileInput = root.querySelector('#db-file');
  var typeInput = root.querySelector('#db-type');
  var souvToggle = root.querySelector('#db-souvenir-toggle');
  var souvBox = root.querySelector('#db-souv');
  var formErr = root.querySelector('#db-form-error');
  var submitBtn = root.querySelector('#db-submit');

  // ---------- shared icons ----------
  var ROUTE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18 Q 9 8 13 14 T 20 6"/><circle cx="4" cy="18" r="1.5" fill="#fff"/><circle cx="20" cy="6" r="1.5" fill="#fff"/></svg>';
  var PIN_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  var DL_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>';
  var DEL_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
  var DONE_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

  // ---------- helpers (exposed) ----------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  GDB.el = el;

  GDB.api = function (url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = null; try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { ok: r.ok, status: r.status, data: data };
      });
    }, function () { return { ok: false, status: 0, data: null }; });
  };
  var api = GDB.api;

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  GDB.fmtDuration = function (s) { if (!s || s <= 0) return '—'; var m = Math.round(s / 60); if (m < 60) return m + ' min'; var h = Math.floor(m / 60), mm = m % 60; return h + 'h' + (mm < 10 ? '0' : '') + mm; };
  GDB.fmtDate = function (d) { if (!d) return ''; var p = String(d).slice(0, 10).split('-'); if (p.length < 3) return d; return parseInt(p[2], 10) + ' ' + MON[(parseInt(p[1], 10) - 1) || 0] + ' ' + p[0]; };
  GDB.today = function () { var d = new Date(), m = d.getMonth() + 1, day = d.getDate(); return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day; };

  GDB.miniMap = function (holder, latlngs, color) {
    if (typeof L === 'undefined' || !holder || !latlngs || latlngs.length < 2) return null;
    var map = L.map(holder, { scrollWheelZoom: false, preferCanvas: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    var line = L.polyline(latlngs, { color: color || '#2F6BFF', weight: 4, opacity: 0.95 }).addTo(map);
    L.circleMarker(latlngs[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#11C29B', fillOpacity: 1 }).addTo(map);
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#FF5C39', fillOpacity: 1 }).addTo(map);
    try { map.fitBounds(line.getBounds(), { padding: [24, 24] }); } catch (e) {}
    setTimeout(function () { map.invalidateSize(); }, 80);
    return map;
  };

  GDB.openLightbox = function (url) { if (!lightbox) return; lightboxImg.src = url; lightbox.classList.remove('is-hidden'); document.body.style.overflow = 'hidden'; };
  function closeLightbox() { lightbox.classList.add('is-hidden'); lightboxImg.src = ''; if (modal.classList.contains('is-hidden') && (!document.getElementById('route-detail') || document.getElementById('route-detail').classList.contains('is-hidden'))) document.body.style.overflow = ''; }
  if (lightbox) {
    lightboxClose.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', function (e) { if (e.target === lightbox) closeLightbox(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !lightbox.classList.contains('is-hidden')) closeLightbox(); });
  }

  // ---------- admin token ----------
  var adminToken = (function () {
    try {
      var m = location.search.match(/[?&]admin=([^&]*)/);
      if (m) {
        var v = decodeURIComponent(m[1]);
        if (!v || v === 'off') sessionStorage.removeItem('guaruna-admin'); else sessionStorage.setItem('guaruna-admin', v);
        history.replaceState({}, '', location.pathname);
      }
      return sessionStorage.getItem('guaruna-admin');
    } catch (e) { return null; }
  })();
  GDB.adminToken = adminToken;

  // ---------- state ----------
  var state = {
    seg: 'explore', q: '', bbox: null, near: null,
    distMin: null, distMax: null, elevMin: null, elevMax: null,
    type: '', sort: 'newest', page: 1,
    autoSearch: !(window.matchMedia && window.matchMedia('(max-width: 900px)').matches)
  };
  var doneRouteIds = {};
  GDB.isDone = function (id) { return !!doneRouteIds[id]; };

  var routesById = {};      // id -> { item, layer, row }
  var debounce, placeDebounce;

  // ========================================================
  // Map
  // ========================================================
  var exploreMap = null, routesLayer = null, hlLayer = null, suppressMove = false, didInitialFit = false;

  function initMap() {
    if (typeof L === 'undefined') { if (mapFallback) mapFallback.classList.remove('is-hidden'); return; }
    exploreMap = L.map('explore-map', { scrollWheelZoom: true, preferCanvas: true, worldCopyJump: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(exploreMap);
    exploreMap.setView([46, 6], 4);
    routesLayer = L.layerGroup().addTo(exploreMap);
    hlLayer = L.layerGroup().addTo(exploreMap);
    exploreMap.on('moveend', function () {
      if (suppressMove) { suppressMove = false; return; }
      state.bbox = currentBbox();
      if (state.autoSearch) { state.page = 1; load(); }
      else if (searchAreaBtn) searchAreaBtn.classList.remove('is-hidden');
    });
  }
  function currentBbox() { var b = exploreMap.getBounds(); return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]; }

  function highlight(id, on) {
    var rec = routesById[id]; if (!rec) return;
    if (rec.row) rec.row.classList.toggle('is-active', on);
    if (!rec.layer || !hlLayer) return;
    hlLayer.clearLayers();
    if (on) {
      L.polyline(rec.item.polyline, { color: GDB.isDone(id) ? '#0c8f73' : '#1E4FD0', weight: 5, opacity: 1 }).addTo(hlLayer);
    }
  }

  function drawTraces(items) {
    if (!routesLayer) return;
    routesLayer.clearLayers(); if (hlLayer) hlLayer.clearLayers();
    var all = [];
    items.forEach(function (it) {
      if (!it.polyline || it.polyline.length < 2) return;
      var line = L.polyline(it.polyline, { color: GDB.isDone(it.id) ? '#11C29B' : '#2F6BFF', weight: 3, opacity: 0.55 });
      line.on('mouseover', function () { highlight(it.id, true); });
      line.on('mouseout', function () { highlight(it.id, false); });
      line.on('click', function () { GDB.Detail.open(it); });
      routesLayer.addLayer(line);
      if (routesById[it.id]) routesById[it.id].layer = line; else routesById[it.id] = { item: it, layer: line, row: null };
      all.push(line);
    });
    if (!didInitialFit && !state.bbox && all.length && exploreMap) {
      try { var grp = L.featureGroup(all); suppressMove = true; exploreMap.fitBounds(grp.getBounds(), { padding: [30, 30] }); } catch (e) {}
      didInitialFit = true;
    }
  }

  // ========================================================
  // Explorer list
  // ========================================================
  function clearStatus() { statusEl.innerHTML = ''; statusEl.classList.add('is-hidden'); }

  function showSkeletons() {
    clearStatus(); pager.innerHTML = ''; listEl.innerHTML = '';
    for (var i = 0; i < 6; i++) {
      var s = el('div', 'route-row skeleton');
      s.innerHTML = '<span class="sk-dot"></span><div class="sk-main"><div class="sk-line"></div><div class="sk-line short"></div></div><div class="sk-btn"></div>';
      listEl.appendChild(s);
    }
  }
  function showMessage(icon, title, sub, actionLabel, actionFn) {
    listEl.innerHTML = ''; pager.innerHTML = ''; countEl.textContent = '';
    statusEl.classList.remove('is-hidden'); statusEl.innerHTML = '';
    var box = el('div', 'db-empty');
    var ic = el('div', 'db-empty-icon'); ic.innerHTML = icon; box.appendChild(ic);
    box.appendChild(el('h3', null, title));
    if (sub) box.appendChild(el('p', null, sub));
    if (actionLabel) { var b = el('button', 'btn btn-primary', actionLabel); b.type = 'button'; b.addEventListener('click', actionFn); box.appendChild(b); }
    statusEl.appendChild(box);
  }

  function routeCard(it) {
    var r = el('div', 'route-row clickable');
    var ic = el('span', 'route-row-icon');
    ic.innerHTML = it.thumb
      ? '<svg class="route-thumb" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"><path d="' + it.thumb + '" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : ROUTE_SVG;
    r.appendChild(ic);

    var main = el('div', 'route-row-main');
    var nameWrap = el('div'); nameWrap.style.display = 'flex'; nameWrap.style.alignItems = 'center'; nameWrap.style.flexWrap = 'wrap';
    var name = el('span', 'route-row-name', it.name);
    nameWrap.appendChild(name);
    var badges = el('span', 'rr-badges');
    if (GDB.isDone(it.id)) { var done = el('span', 'rr-done'); done.innerHTML = DONE_SVG; done.appendChild(document.createTextNode(' Done')); badges.appendChild(done); }
    nameWrap.appendChild(badges);
    main.appendChild(nameWrap);

    var meta = el('div', 'route-row-meta');
    if (it.location) { var loc = el('span', 'rm-loc'); loc.innerHTML = PIN_SVG; loc.appendChild(document.createTextNode(' ' + it.location)); meta.appendChild(loc); meta.appendChild(el('span', 'rm-sep', '·')); }
    meta.appendChild(el('span', 'rm-stat', it.distance_km + ' km'));
    meta.appendChild(el('span', 'rm-sep', '·'));
    meta.appendChild(el('span', 'rm-stat', '+' + it.elevation_gain + ' m'));
    if (it.activity_type && it.activity_type !== 'other') { meta.appendChild(el('span', 'rm-sep', '·')); meta.appendChild(el('span', 'rr-type', GDB.typeLabel(it.activity_type))); }
    if (it.distance_from_km != null) { meta.appendChild(el('span', 'rm-sep', '·')); meta.appendChild(el('span', 'rm-stat', '~' + it.distance_from_km + ' km away')); }
    main.appendChild(meta);
    r.appendChild(main);

    var actions = el('div', 'route-row-actions');
    var dl = el('a', 'btn btn-ghost btn-sm btn-icon'); dl.href = it.url; dl.setAttribute('download', ''); dl.title = 'Download GPX'; dl.setAttribute('aria-label', 'Download GPX'); dl.innerHTML = DL_SVG;
    dl.addEventListener('click', function (e) { e.stopPropagation(); });
    actions.appendChild(dl);
    if (adminToken) {
      var del = el('button', 'btn btn-ghost btn-sm btn-icon route-del'); del.type = 'button'; del.title = 'Delete (admin)'; del.setAttribute('aria-label', 'Delete route'); del.innerHTML = DEL_SVG;
      del.addEventListener('click', function (e) { e.stopPropagation(); removeRoute(it); });
      actions.appendChild(del);
    }
    r.appendChild(actions);

    r.addEventListener('click', function () { GDB.Detail.open(it); });
    r.addEventListener('mouseenter', function () { highlight(it.id, true); });
    r.addEventListener('mouseleave', function () { highlight(it.id, false); });
    return r;
  }

  function render(data) {
    clearStatus(); listEl.innerHTML = ''; routesById = {};
    data.items.forEach(function (it) { routesById[it.id] = { item: it, layer: null, row: null }; });
    if (!data.items.length) {
      drawTraces([]);
      if (state.q || state.type || state.distMin || state.distMax || state.elevMin || state.elevMax)
        showMessage(PIN_SVG, 'No matches here', 'Try widening the map, clearing filters, or searching another place.', 'Clear filters', clearFilters);
      else showMessage(ROUTE_SVG.replace(/#fff/g, 'currentColor'), 'No routes yet', 'Be the first to add a GPX route.', 'Add a route', openModal);
      return;
    }
    data.items.forEach(function (it) { var row = routeCard(it); routesById[it.id].row = row; listEl.appendChild(row); });
    drawTraces(data.items);
    renderPager(data);
    var inArea = (state.bbox && state.sort !== 'nearest');
    countEl.textContent = data.total + ' route' + (data.total === 1 ? '' : 's') + (inArea ? ' in this area' : '');
  }

  function showOffline() {
    showMessage('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l22 22"/><path d="M16.7 16.7A11 11 0 0 1 5 13"/><path d="M2 8.8A16 16 0 0 1 8 5.6"/><path d="M12 4c3.7 0 7 1.3 9.6 3.4"/><path d="M12 20h.01"/></svg>',
      'Route database unavailable', 'The database service is offline right now. Please try again later.', 'Retry', function () { load(); });
  }

  function buildQuery() {
    var p = [];
    function add(k, v) { if (v !== null && v !== undefined && v !== '') p.push(k + '=' + encodeURIComponent(v)); }
    add('q', state.q); add('sort', state.sort); add('type', state.type); add('page', state.page);
    add('dist_min', state.distMin); add('dist_max', state.distMax);
    add('elev_min', state.elevMin); add('elev_max', state.elevMax);
    if (state.sort === 'nearest') {
      var near = state.near || (exploreMap ? [exploreMap.getCenter().lat, exploreMap.getCenter().lng] : null);
      if (near) {
        add('near', Number(near[0]).toFixed(6) + ',' + Number(near[1]).toFixed(6));
        if (exploreMap) { try { add('radius_km', Math.max(5, Math.round(exploreMap.getCenter().distanceTo(exploreMap.getBounds().getNorthEast()) / 1000))); } catch (e) {} }
      }
    } else if (state.bbox) {
      add('minLat', state.bbox[0]); add('minLon', state.bbox[1]); add('maxLat', state.bbox[2]); add('maxLon', state.bbox[3]);
    }
    return '/api/routes?' + p.join('&');
  }

  function load() {
    if (searchAreaBtn) searchAreaBtn.classList.add('is-hidden');
    showSkeletons();
    api(buildQuery()).then(function (res) {
      if (!res.ok || !res.data || !Array.isArray(res.data.items)) { showOffline(); return; }
      render(res.data);
    });
  }

  function removeRoute(it) {
    if (!window.confirm('Delete “' + it.name + '”? This also removes its outings. This cannot be undone.')) return;
    api('/api/routes/' + encodeURIComponent(it.id), { method: 'DELETE', headers: { 'X-Admin-Token': adminToken } }).then(function (res) {
      if (res.ok) { GDB.afterJournalChange(); }
      else if (res.status === 403) window.alert('Admin token rejected. Reopen with ?admin=YOUR_TOKEN.');
      else window.alert((res.data && res.data.detail) || 'Delete failed.');
    });
  }

  function renderPager(data) {
    pager.innerHTML = '';
    if (data.pages <= 1) return;
    var prev = el('button', 'btn btn-ghost btn-sm', '← Prev'); prev.type = 'button'; prev.disabled = data.page <= 1;
    prev.addEventListener('click', function () { state.page = data.page - 1; load(); });
    var next = el('button', 'btn btn-ghost btn-sm', 'Next →'); next.type = 'button'; next.disabled = data.page >= data.pages;
    next.addEventListener('click', function () { state.page = data.page + 1; load(); });
    pager.appendChild(prev);
    pager.appendChild(el('span', 'pager-info', 'Page ' + data.page + ' of ' + data.pages));
    pager.appendChild(next);
  }

  // ========================================================
  // Filters
  // ========================================================
  function numOrNull(input) { var v = parseFloat(input.value); return isFinite(v) ? v : null; }
  function syncFilters() {
    state.distMin = numOrNull(fDistMin); state.distMax = numOrNull(fDistMax);
    state.elevMin = numOrNull(fElevMin); state.elevMax = numOrNull(fElevMax);
    var n = 0; ['distMin', 'distMax', 'elevMin', 'elevMax'].forEach(function (k) { if (state[k] != null) n++; });
    if (state.type) n++;
    if (n) { filterCount.textContent = n; filterCount.classList.remove('is-hidden'); } else filterCount.classList.add('is-hidden');
  }
  function clearFilters() {
    fDistMin.value = ''; fDistMax.value = ''; fElevMin.value = ''; fElevMax.value = '';
    state.type = '';
    typeChips.querySelectorAll('.ed-chip').forEach(function (c) { c.classList.toggle('is-active', c.dataset.type === ''); });
    syncFilters(); state.page = 1; load();
  }
  if (filterToggle) filterToggle.addEventListener('click', function () {
    var open = filterPanel.classList.toggle('is-hidden') === false;
    filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  [fDistMin, fDistMax, fElevMin, fElevMax].forEach(function (i) {
    i.addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(function () { syncFilters(); state.page = 1; load(); }, 450); });
  });
  if (typeChips) typeChips.addEventListener('click', function (e) {
    var b = e.target.closest('.ed-chip'); if (!b) return;
    state.type = b.dataset.type || '';
    typeChips.querySelectorAll('.ed-chip').forEach(function (c) { c.classList.toggle('is-active', c === b); });
    syncFilters(); state.page = 1; load();
  });
  if (sortSelect) sortSelect.addEventListener('change', function () { state.sort = sortSelect.value; state.page = 1; load(); });
  if (clearBtn) clearBtn.addEventListener('click', clearFilters);
  if (surpriseBtn) surpriseBtn.addEventListener('click', function () {
    var p = []; if (state.type) p.push('type=' + encodeURIComponent(state.type));
    if (state.distMin != null) p.push('dist_min=' + state.distMin); if (state.distMax != null) p.push('dist_max=' + state.distMax);
    if (state.elevMin != null) p.push('elev_min=' + state.elevMin); if (state.elevMax != null) p.push('elev_max=' + state.elevMax);
    api('/api/routes/random' + (p.length ? '?' + p.join('&') : '')).then(function (res) {
      if (res.ok && res.data) {
        var it = res.data; if (it.polyline_full && !it.polyline) it.polyline = it.polyline_full;
        if (exploreMap && it.bbox) { suppressMove = true; try { exploreMap.fitBounds([[it.bbox[0], it.bbox[1]], [it.bbox[2], it.bbox[3]]], { padding: [40, 40] }); } catch (e) {} }
        GDB.Detail.open(it);
      } else window.alert('No route matches those filters.');
    });
  });

  // ---------- name filter ----------
  if (search) search.addEventListener('input', function () {
    clearTimeout(debounce); debounce = setTimeout(function () { state.q = search.value.trim(); state.page = 1; load(); }, 300);
  });

  // ---------- search this area ----------
  if (searchAreaBtn) searchAreaBtn.addEventListener('click', function () { state.bbox = currentBbox(); state.page = 1; load(); });

  // ---------- place search (Nominatim) ----------
  function hidePlaces() { placeResults.classList.add('is-hidden'); placeResults.innerHTML = ''; }
  if (placeInput) {
    placeInput.addEventListener('input', function () {
      clearTimeout(placeDebounce);
      var q = placeInput.value.trim();
      if (q.length < 3) { hidePlaces(); return; }
      placeDebounce = setTimeout(function () {
        fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=en&q=' + encodeURIComponent(q))
          .then(function (r) { return r.ok ? r.json() : []; }).then(function (rows) {
            placeResults.innerHTML = '';
            if (!rows || !rows.length) { hidePlaces(); return; }
            rows.forEach(function (p) {
              var b = el('button', null, p.display_name); b.type = 'button';
              b.addEventListener('click', function () {
                hidePlaces(); placeInput.value = p.display_name.split(',')[0];
                if (!exploreMap) return;
                suppressMove = true;
                if (p.boundingbox) {
                  var bb = p.boundingbox; // [south, north, west, east]
                  exploreMap.fitBounds([[parseFloat(bb[0]), parseFloat(bb[2])], [parseFloat(bb[1]), parseFloat(bb[3])]]);
                } else { exploreMap.setView([parseFloat(p.lat), parseFloat(p.lon)], 13); }
                state.bbox = currentBbox(); state.page = 1; load();
              });
              placeResults.appendChild(b);
            });
            placeResults.classList.remove('is-hidden');
          }).catch(hidePlaces);
      }, 350);
    });
    document.addEventListener('click', function (e) { if (!placeResults.contains(e.target) && e.target !== placeInput) hidePlaces(); });
  }

  // ---------- near me ----------
  if (nearBtn) nearBtn.addEventListener('click', function () {
    if (!navigator.geolocation || !exploreMap) return;
    nearBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      nearBtn.disabled = false;
      state.near = [pos.coords.latitude, pos.coords.longitude];
      suppressMove = true; exploreMap.setView([pos.coords.latitude, pos.coords.longitude], 12);
      state.bbox = currentBbox(); state.page = 1; load();
    }, function () { nearBtn.disabled = false; }, { timeout: 8000 });
  });

  // ========================================================
  // Segments
  // ========================================================
  function setSeg(seg) {
    state.seg = seg;
    segs.forEach(function (b) { var on = b.dataset.seg === seg; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    viewExplore.classList.toggle('is-hidden', seg !== 'explore');
    viewJournal.classList.toggle('is-hidden', seg !== 'journal');
    if (seg === 'explore' && exploreMap) setTimeout(function () { exploreMap.invalidateSize(); }, 60);
    if (seg === 'journal') loadJournal();
  }
  segs.forEach(function (b) { b.addEventListener('click', function () { setSeg(b.dataset.seg); }); });

  // ========================================================
  // My outings (journal)
  // ========================================================
  var journalMap = null, journalLayer = null;
  function metric(k, v) { var m = el('div', 'metric'); m.appendChild(el('div', 'k', k)); m.appendChild(el('div', 'v', v)); return m; }

  function renderStats(s) {
    jStats.innerHTML = '';
    jStats.appendChild(metric('Outings', s.outings || 0));
    jStats.appendChild(metric('Total distance', (s.total_km || 0) + ' km'));
    jStats.appendChild(metric('Total climb', '+' + (s.total_elevation_gain || 0) + ' m'));
    jStats.appendChild(metric('Active months', s.active_months || 0));
  }

  function renderJournalMap(items) {
    if (typeof L === 'undefined') return;
    var holder = document.getElementById('journal-map');
    if (!journalMap) {
      journalMap = L.map('journal-map', { scrollWheelZoom: false, preferCanvas: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(journalMap);
      journalMap.setView([46, 6], 4);
      journalLayer = L.layerGroup().addTo(journalMap);
    }
    journalLayer.clearLayers();
    var lines = [];
    items.forEach(function (o) {
      var pl = o.route && o.route.polyline; if (!pl || pl.length < 2) return;
      var line = L.polyline(pl, { color: '#11C29B', weight: 3, opacity: 0.6 });
      if (o.route) line.on('click', function () { GDB.Detail.open(o.route); });
      journalLayer.addLayer(line); lines.push(line);
    });
    setTimeout(function () { journalMap.invalidateSize(); if (lines.length) { try { journalMap.fitBounds(L.featureGroup(lines).getBounds(), { padding: [30, 30] }); } catch (e) {} } }, 70);
  }

  function renderStreak(months) {
    // last 12 months activity dots
    var set = {}; (months || []).forEach(function (m) { set[m] = 1; });
    var now = new Date(); var strip = el('div', 'streak-strip');
    for (var i = 11; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var key = d.getFullYear() + '-' + ((d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1));
      var dot = el('span', 'streak-dot' + (set[key] ? ' on' : '')); dot.title = MON_LONG[d.getMonth()] + ' ' + d.getFullYear();
      strip.appendChild(dot);
    }
    return strip;
  }

  function timelineEntry(o) {
    var entry = el('div', 'timeline-entry');
    var box = el('div', 'te-date');
    var p = String(o.date || '').slice(0, 10).split('-');
    box.appendChild(el('div', 'te-day', p[2] ? String(parseInt(p[2], 10)) : '—'));
    box.appendChild(el('div', 'te-mon', p[1] ? MON[(parseInt(p[1], 10) - 1) || 0] : ''));
    entry.appendChild(box);

    var main = el('div', 'te-main');
    var nm = el('div', 'te-name', (o.route && o.route.name) || 'Route');
    if (o.route) nm.addEventListener('click', function () { GDB.Detail.open(o.route); });
    main.appendChild(nm);

    var meta = el('div', 'te-meta');
    if (o.route && o.route.location) { var loc = el('span', 'rm-loc'); loc.innerHTML = PIN_SVG; loc.appendChild(document.createTextNode(' ' + o.route.location)); meta.appendChild(loc); }
    if (o.route) { meta.appendChild(el('span', 'rm-stat', o.route.distance_km + ' km')); meta.appendChild(el('span', 'rm-stat', '+' + o.route.elevation_gain + ' m')); }
    if (o.rating) { var st = el('span', 'rr-stars'); st.textContent = '★'.repeat(o.rating) + '☆'.repeat(5 - o.rating); meta.appendChild(st); }
    if (o.feeling) meta.appendChild(el('span', null, GDB.feelingLabel(o.feeling)));
    main.appendChild(meta);

    if (o.note) main.appendChild(el('div', 'te-note', o.note));
    if (o.tags && o.tags.length) { var tg = el('div', 'te-tags'); o.tags.forEach(function (t) { tg.appendChild(el('span', 'te-tag', t)); }); main.appendChild(tg); }
    if (o.photos && o.photos.length) main.appendChild(GDB.photoGallery(o, { canAdd: false }));
    entry.appendChild(main);

    if (adminToken) {
      var act = el('div', 'te-actions');
      var del = el('button', 'btn btn-ghost btn-sm btn-icon', ''); del.type = 'button'; del.title = 'Delete outing'; del.innerHTML = DEL_SVG;
      del.addEventListener('click', function () {
        if (!window.confirm('Delete this outing and its photos?')) return;
        api('/api/outings/' + encodeURIComponent(o.id), { method: 'DELETE', headers: { 'X-Admin-Token': adminToken } }).then(function (res) { if (res.ok) GDB.afterJournalChange(); });
      });
      act.appendChild(del); entry.appendChild(act);
    }
    return entry;
  }

  function loadJournal() {
    jStatus.classList.add('is-hidden'); jTimeline.innerHTML = ''; jPager.innerHTML = '';
    Promise.all([api('/api/outings?page=1'), api('/api/stats')]).then(function (r) {
      var data = (r[0] && r[0].ok && r[0].data) ? r[0].data : null;
      var s = (r[1] && r[1].ok && r[1].data) ? r[1].data : { outings: 0, total_km: 0, total_elevation_gain: 0, active_months: 0, months: [] };
      if (!data) { jStats.innerHTML = ''; jStatus.classList.remove('is-hidden'); jStatus.textContent = 'History unavailable right now.'; return; }
      renderStats(s);
      var items = data.items || [];
      if (!items.length) {
        renderJournalMap([]);
        jTimeline.innerHTML = '';
        jStatus.classList.remove('is-hidden');
        jStatus.innerHTML = '';
        var box = el('div', 'db-empty');
        var ic = el('div', 'db-empty-icon'); ic.innerHTML = ROUTE_SVG.replace(/#fff/g, 'currentColor'); box.appendChild(ic);
        box.appendChild(el('h3', null, 'No outings yet'));
        box.appendChild(el('p', null, 'Open a route and mark it as done to start your history.'));
        var b = el('button', 'btn btn-primary', 'Explore routes'); b.type = 'button'; b.addEventListener('click', function () { setSeg('explore'); }); box.appendChild(b);
        jStatus.appendChild(box);
        return;
      }
      renderJournalMap(items);
      jTimeline.appendChild(renderStreak(s.months));
      var curMonth = '';
      items.forEach(function (o) {
        var mk = String(o.date || '').slice(0, 7);
        if (mk !== curMonth) {
          curMonth = mk; var pp = mk.split('-');
          jTimeline.appendChild(el('div', 'timeline-month', pp[1] ? (MON_LONG[(parseInt(pp[1], 10) - 1) || 0] + ' ' + pp[0]) : 'Undated'));
        }
        jTimeline.appendChild(timelineEntry(o));
      });
    });
  }

  // ========================================================
  // Done set + cross-view refresh
  // ========================================================
  function loadDoneSet() {
    doneRouteIds = {};
    function page(n) {
      return api('/api/outings?page=' + n).then(function (res) {
        if (!res.ok || !res.data || !res.data.items) return;
        res.data.items.forEach(function (o) { if (o.route_id) doneRouteIds[o.route_id] = 1; });
        if (res.data.page < res.data.pages && n < 20) return page(n + 1);
      });
    }
    return page(1);
  }
  GDB.afterJournalChange = function () {
    return loadDoneSet().then(function () {
      if (state.seg === 'journal') loadJournal();
      else load();
    });
  };

  // ========================================================
  // Add route modal
  // ========================================================
  var modalSouv = null;
  function openModal() {
    modal.classList.remove('is-hidden'); formErr.classList.add('is-hidden'); document.body.style.overflow = 'hidden';
    if (!modalSouv) modalSouv = GDB.buildSouvenir(souvBox, { withPhotos: true });
    nameInput.focus();
  }
  function closeModal() {
    modal.classList.add('is-hidden'); document.body.style.overflow = ''; form.reset();
    formErr.classList.add('is-hidden'); souvBox.classList.add('is-hidden'); if (souvToggle) souvToggle.checked = false;
    if (modalSouv) modalSouv.clear();
  }
  addBtn.addEventListener('click', openModal);
  if (adminToken) { var badge = el('span', 'admin-badge', 'Admin mode'); root.querySelector('#db-admin-slot').appendChild(badge); }
  modal.addEventListener('click', function (e) { if (e.target === modal || e.target.hasAttribute('data-close')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.classList.contains('is-hidden')) closeModal(); });
  if (souvToggle) souvToggle.addEventListener('change', function () { souvBox.classList.toggle('is-hidden', !souvToggle.checked); });

  function detectCountries(file) {
    return new Promise(function (resolve) {
      var done = false; var guard = setTimeout(function () { if (!done) { done = true; resolve(''); } }, 9000);
      function finish(v) { if (!done) { done = true; clearTimeout(guard); resolve(v); } }
      var reader = new FileReader(); reader.onerror = function () { finish(''); };
      reader.onload = function () {
        try {
          var doc = new DOMParser().parseFromString(String(reader.result), 'application/xml');
          var nodes = doc.getElementsByTagName('trkpt'); if (!nodes.length) nodes = doc.getElementsByTagName('rtept');
          var pts = [];
          for (var i = 0; i < nodes.length; i++) { var la = parseFloat(nodes[i].getAttribute('lat')), lo = parseFloat(nodes[i].getAttribute('lon')); if (isFinite(la) && isFinite(lo)) pts.push([la, lo]); }
          if (!pts.length) return finish('');
          var picks = [0, Math.floor(pts.length / 3), Math.floor(2 * pts.length / 3), pts.length - 1].filter(function (v, idx, a) { return a.indexOf(v) === idx; });
          var calls = picks.map(function (i) {
            var p = pts[i];
            return fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=3&accept-language=en&lat=' + p[0] + '&lon=' + p[1])
              .then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { return (j && j.address && j.address.country) ? j.address.country : null; }).catch(function () { return null; });
          });
          Promise.all(calls).then(function (rs) { var seen = {}, out = []; rs.forEach(function (c) { if (c && !seen[c]) { seen[c] = 1; out.push(c); } }); finish(out.join(', ')); });
        } catch (e) { finish(''); }
      };
      reader.readAsText(file);
    });
  }
  function showErr(msg) { formErr.textContent = msg; formErr.classList.remove('is-hidden'); }

  form.addEventListener('submit', function (e) {
    e.preventDefault(); formErr.classList.add('is-hidden');
    var name = nameInput.value.trim(); var file = fileInput.files[0];
    if (!name) return showErr('Please enter a name.');
    if (!file) return showErr('Please choose a .gpx file.');
    if (!/\.gpx$/i.test(file.name)) return showErr('The file must be a .gpx file.');
    if (file.size > 10 * 1024 * 1024) return showErr('File too large (max 10 MB).');

    submitBtn.disabled = true; submitBtn.textContent = 'Reading location…';
    detectCountries(file).then(function (countries) {
      var fd = new FormData(); fd.append('name', name); fd.append('file', file); fd.append('activity_type', typeInput.value || 'run');
      if (countries) fd.append('location', countries);
      submitBtn.textContent = 'Uploading…';
      return api('/api/routes', { method: 'POST', body: fd });
    }).then(function (res) {
      if (!res || !res.ok || !res.data) { showErr((res && res.data && res.data.detail) ? res.data.detail : (res && res.status === 0 ? 'Could not reach the server.' : 'Upload failed. Please try again.')); submitBtn.disabled = false; submitBtn.textContent = 'Add route'; return; }
      var route = res.data;
      var doSouv = souvToggle && souvToggle.checked && modalSouv;
      var chain = Promise.resolve();
      if (doSouv) {
        submitBtn.textContent = 'Saving souvenir…';
        var f = modalSouv.read(); var fd2 = new FormData();
        fd2.append('route_id', route.id); fd2.append('date', f.date); fd2.append('rating', String(f.rating || 0));
        fd2.append('feeling', f.feeling || ''); fd2.append('note', f.note || ''); fd2.append('tags', f.tags || '');
        chain = api('/api/outings', { method: 'POST', body: fd2 }).then(function (r2) {
          if (r2.ok && r2.data) return GDB.uploadPhotos(r2.data.id, modalSouv.files());
        });
      }
      chain.then(function () {
        closeModal(); submitBtn.disabled = false; submitBtn.textContent = 'Add route';
        if (exploreMap && route.bbox) { suppressMove = true; try { exploreMap.fitBounds([[route.bbox[0], route.bbox[1]], [route.bbox[2], route.bbox[3]]], { padding: [40, 40] }); } catch (e) {} state.bbox = currentBbox(); }
        state.q = ''; if (search) search.value = ''; state.page = 1;
        GDB.afterJournalChange();
      });
    });
  });

  // ========================================================
  // Init
  // ========================================================
  initMap();
  loadDoneSet().then(load);
})();
