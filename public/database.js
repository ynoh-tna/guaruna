/* =========================================================
   Guaruna — GPX database: map explorer
   Public catalog: find routes in a zone, filter for ideas, share a GPX.
   Each route opens a detail panel (map + profile + community photos).
   Talks to /api on the same origin; robust against an offline API.
   User text -> textContent (no XSS). Map: Leaflet (optional; falls back
   to a list-only experience if absent).
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

  var lightbox = root.querySelector('#lightbox');
  var lightboxImg = root.querySelector('#lightbox-img');
  var lightboxClose = root.querySelector('#lightbox-close');

  var modal = root.querySelector('#db-modal');
  var form = root.querySelector('#db-form');
  var nameInput = root.querySelector('#db-name');
  var fileInput = root.querySelector('#db-file');
  var typeInput = root.querySelector('#db-type');
  var formErr = root.querySelector('#db-form-error');
  var submitBtn = root.querySelector('#db-submit');

  // ---------- shared icons ----------
  var ROUTE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18 Q 9 8 13 14 T 20 6"/><circle cx="4" cy="18" r="1.5" fill="#fff"/><circle cx="20" cy="6" r="1.5" fill="#fff"/></svg>';
  var PIN_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  var DL_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>';
  var DEL_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
  var CAM_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="3.5"/></svg>';

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

  GDB.fmtDuration = function (s) { if (!s || s <= 0) return '—'; var m = Math.round(s / 60); if (m < 60) return m + ' min'; var h = Math.floor(m / 60), mm = m % 60; return h + 'h' + (mm < 10 ? '0' : '') + mm; };

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
  function closeLightbox() {
    lightbox.classList.add('is-hidden'); lightboxImg.src = '';
    var rd = document.getElementById('route-detail');
    if (modal.classList.contains('is-hidden') && (!rd || rd.classList.contains('is-hidden'))) document.body.style.overflow = '';
  }
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
    q: '', bbox: null, near: null,
    distMin: null, distMax: null, elevMin: null, elevMax: null,
    type: '', sort: 'newest', page: 1,
    autoSearch: !(window.matchMedia && window.matchMedia('(max-width: 900px)').matches)
  };
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
    if (on) L.polyline(rec.item.polyline, { color: '#1E4FD0', weight: 5, opacity: 1 }).addTo(hlLayer);
  }

  function drawTraces(items) {
    if (!routesLayer) return;
    routesLayer.clearLayers(); if (hlLayer) hlLayer.clearLayers();
    var all = [];
    items.forEach(function (it) {
      if (!it.polyline || it.polyline.length < 2) return;
      var line = L.polyline(it.polyline, { color: '#2F6BFF', weight: 3, opacity: 0.55 });
      line.on('mouseover', function () { highlight(it.id, true); });
      line.on('mouseout', function () { highlight(it.id, false); });
      line.on('click', function () { GDB.Detail.open(it); });
      routesLayer.addLayer(line);
      if (routesById[it.id]) routesById[it.id].layer = line; else routesById[it.id] = { item: it, layer: line, row: null };
      all.push(line);
    });
    if (!didInitialFit && !state.bbox && all.length && exploreMap) {
      try { suppressMove = true; exploreMap.fitBounds(L.featureGroup(all).getBounds(), { padding: [30, 30] }); } catch (e) {}
      didInitialFit = true;
    }
  }

  // ========================================================
  // List
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
    nameWrap.appendChild(el('span', 'route-row-name', it.name));
    if (it.photo_count) {
      var pb = el('span', 'rr-photos'); pb.innerHTML = CAM_SVG; pb.appendChild(document.createTextNode(' ' + it.photo_count));
      nameWrap.appendChild(pb);
    }
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
      if (state.q || state.type || state.distMin != null || state.distMax != null || state.elevMin != null || state.elevMax != null)
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
  GDB.refresh = load;   // detail panel calls this after photos change (to update badges)

  function removeRoute(it) {
    if (!window.confirm('Delete “' + it.name + '”? This also removes its photos. This cannot be undone.')) return;
    api('/api/routes/' + encodeURIComponent(it.id), { method: 'DELETE', headers: { 'X-Admin-Token': adminToken } }).then(function (res) {
      if (res.ok) { load(); }
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
  // Add route modal
  // ========================================================
  function openModal() { modal.classList.remove('is-hidden'); formErr.classList.add('is-hidden'); document.body.style.overflow = 'hidden'; nameInput.focus(); }
  function closeModal() { modal.classList.add('is-hidden'); document.body.style.overflow = ''; form.reset(); formErr.classList.add('is-hidden'); }
  addBtn.addEventListener('click', openModal);
  if (adminToken) { var badge = el('span', 'admin-badge', 'Admin mode'); root.querySelector('#db-admin-slot').appendChild(badge); }
  modal.addEventListener('click', function (e) { if (e.target === modal || e.target.hasAttribute('data-close')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.classList.contains('is-hidden')) closeModal(); });

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
      if (!res || !res.ok || !res.data) {
        showErr((res && res.data && res.data.detail) ? res.data.detail : (res && res.status === 0 ? 'Could not reach the server.' : 'Upload failed. Please try again.'));
        return;
      }
      var route = res.data;
      closeModal();
      if (exploreMap && route.bbox) { suppressMove = true; try { exploreMap.fitBounds([[route.bbox[0], route.bbox[1]], [route.bbox[2], route.bbox[3]]], { padding: [40, 40] }); } catch (e) {} state.bbox = currentBbox(); }
      state.q = ''; if (search) search.value = ''; state.page = 1; load();
      GDB.Detail.open(route);   // open the new route so the user can add photos/info right away
    }).finally(function () { submitBtn.disabled = false; submitBtn.textContent = 'Add route'; });
  });

  // ========================================================
  // Init
  // ========================================================
  initMap();
  load();
})();
