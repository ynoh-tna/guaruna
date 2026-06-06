/* =========================================================
   Guaruna — tool logic
   Each block is guarded by the presence of its root element,
   so this single file is safe to load on any page.
   No external calls except: same-origin GPX fetch (database),
   and Leaflet/OSM tiles for the map.
   ========================================================= */
(function () {
  'use strict';

  var KM_PER_MILE = 1.609344;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function num(el) { if (!el) return 0; var v = parseFloat(el.value); return isFinite(v) ? v : 0; }

  function fmtDuration(totalSec) {
    totalSec = Math.round(totalSec);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  function fmtPace(secPerUnit) {
    if (!isFinite(secPerUnit) || secPerUnit <= 0) return '—';
    var total = Math.round(secPerUnit);
    return Math.floor(total / 60) + ':' + pad(total % 60);
  }
  function wireSegmented(root, onChange) {
    root.querySelectorAll('[data-segmented]').forEach(function (group) {
      group.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-val]');
        if (!btn) return;
        group.querySelectorAll('button[data-val]').forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        if (onChange) onChange();
      });
    });
  }
  function segValue(root, name) {
    var sel = root.querySelector('[data-segmented="' + name + '"] button[aria-pressed="true"]');
    return sel ? sel.getAttribute('data-val') : null;
  }
  function resultCell(k, v) {
    return '<div class="result-cell"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  }

  // ========================================================
  // Shared GPX helpers (converter + cleaner reuse these;
  // the analyzer & editor keep their own copies untouched).
  // ========================================================
  var GPX_R = 6371000;
  function gpxHaversine(a, b) {
    var toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * GPX_R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function gpxParse(text, filename) {
    var doc;
    try { doc = new DOMParser().parseFromString(text, 'application/xml'); }
    catch (e) { return null; }
    if (doc.getElementsByTagName('parsererror').length) return null;
    var nodes = doc.getElementsByTagName('trkpt');
    if (!nodes.length) nodes = doc.getElementsByTagName('rtept');
    if (nodes.length < 2) return null;
    var pts = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      var eleN = n.getElementsByTagName('ele')[0], timeN = n.getElementsByTagName('time')[0];
      var ele = eleN ? parseFloat(eleN.textContent) : null;
      pts.push({ lat: lat, lon: lon, ele: (ele != null && isFinite(ele)) ? ele : null, time: (timeN && timeN.textContent) ? timeN.textContent.trim() : null });
    }
    if (pts.length < 2) return null;
    var cum = [0], total = 0;
    for (var j = 1; j < pts.length; j++) { total += gpxHaversine(pts[j - 1], pts[j]); cum.push(total); }
    var name = filename ? filename.replace(/\.gpx$/i, '') : 'track';
    var nameN = doc.querySelector('trk > name') || doc.querySelector('metadata > name');
    if (nameN && nameN.textContent && nameN.textContent.trim()) name = nameN.textContent.trim();
    return { name: name, pts: pts, cum: cum, totalKm: total / 1000 };
  }
  function gpxEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function gpxSlug(s) { return (String(s).trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase()) || 'track'; }
  function gpxSerialize(name, pts) {
    var body = '';
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], s = '    <trkpt lat="' + p.lat + '" lon="' + p.lon + '">';
      if (p.ele != null) s += '<ele>' + p.ele + '</ele>';
      if (p.time) s += '<time>' + gpxEsc(p.time) + '</time>';
      body += s + '</trkpt>\n';
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Guaruna - guaruna.com" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      '<metadata><name>' + gpxEsc(name) + '</name></metadata>\n' +
      '<trk><name>' + gpxEsc(name) + '</name><trkseg>\n' + body + '</trkseg></trk>\n</gpx>\n';
  }
  function saveFile(filename, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function gpxDropWire(el, cb) {
    ['dragenter', 'dragover'].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.add('is-drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.remove('is-drag'); }); });
    el.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) cb(e.dataTransfer.files); });
  }
  function gpxMiniMap(holder, ref, pts, baseColor) {
    if (typeof L === 'undefined' || !holder) return null;
    if (ref) { ref.remove(); }
    var step = Math.max(1, Math.ceil(pts.length / 2000)), ll = [];
    for (var i = 0; i < pts.length; i += step) ll.push([pts[i].lat, pts[i].lon]);
    ll.push([pts[pts.length - 1].lat, pts[pts.length - 1].lon]);
    var map = L.map(holder, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    var line = L.polyline(ll, { color: baseColor || '#2F6BFF', weight: 4, opacity: 0.95 }).addTo(map);
    L.circleMarker(ll[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#11C29B', fillOpacity: 1 }).addTo(map);
    L.circleMarker(ll[ll.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#FF5C39', fillOpacity: 1 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [26, 26] });
    setTimeout(function () { map.invalidateSize(); }, 80);
    return map;
  }

  // ========================================================
  // HEART RATE ZONES  (#hr-zones)
  // ========================================================
  (function hrZones() {
    var root = document.getElementById('hr-zones');
    if (!root) return;
    var ageInput = root.querySelector('#hr-age');
    var maxInput = root.querySelector('#hr-max');
    var restInput = root.querySelector('#hr-rest');
    var body = root.querySelector('#hr-body');
    var maxLabel = root.querySelector('#hr-max-label');
    var methodNote = root.querySelector('#hr-method-note');

    var ZONES = [
      { z: 'Z1', name: 'Recovery', lo: 0.50, hi: 0.60, color: '#11C29B' },
      { z: 'Z2', name: 'Endurance', lo: 0.60, hi: 0.70, color: '#2F6BFF' },
      { z: 'Z3', name: 'Tempo', lo: 0.70, hi: 0.80, color: '#F4B740' },
      { z: 'Z4', name: 'Threshold', lo: 0.80, hi: 0.90, color: '#FF8A3D' },
      { z: 'Z5', name: 'VO2 max', lo: 0.90, hi: 1.00, color: '#FF5C39' }
    ];

    function compute() {
      var method = segValue(root, 'hr-method') || 'max';
      var hrMax = num(maxInput);
      if (hrMax <= 0) { var age = num(ageInput); if (age > 0) hrMax = 220 - age; }
      var hrRest = num(restInput);
      if (hrMax <= 0) {
        body.innerHTML = '<tr><td colspan="3" class="result-empty" style="color:var(--ink-mute)">Enter your age or max heart rate.</td></tr>';
        maxLabel.textContent = '—'; return;
      }
      maxLabel.textContent = Math.round(hrMax) + ' bpm';
      var useKarvonen = method === 'karvonen' && hrRest > 0 && hrRest < hrMax;
      methodNote.textContent = useKarvonen
        ? 'Karvonen method — % of heart-rate reserve (max − resting).'
        : '% of maximum heart rate.' + (method === 'karvonen' ? ' (Enter a valid resting HR to use Karvonen.)' : '');
      function bpm(p) { return useKarvonen ? Math.round(p * (hrMax - hrRest) + hrRest) : Math.round(p * hrMax); }
      var rows = '';
      ZONES.forEach(function (zn) {
        rows += '<tr><td><span class="zone-pill" style="background:' + zn.color + '"></span>' + zn.z + ' · ' + zn.name + '</td>' +
          '<td class="num">' + Math.round(zn.lo * 100) + '–' + Math.round(zn.hi * 100) + '%</td>' +
          '<td class="num">' + bpm(zn.lo) + '–' + bpm(zn.hi) + ' bpm</td></tr>';
      });
      body.innerHTML = rows;
    }
    wireSegmented(root, compute);
    root.querySelectorAll('input').forEach(function (i) { i.addEventListener('input', compute); });
    compute();
  })();

  // ========================================================
  // PACE CONVERTER  (#pace-converter) — bidirectional
  //   input a pace OR a speed, get everything back
  // ========================================================
  (function paceConverter() {
    var root = document.getElementById('pace-converter');
    if (!root) return;
    var typeSel = root.querySelector('#cv-type');
    var paceGroup = root.querySelector('#cv-pace-group');
    var speedGroup = root.querySelector('#cv-speed-group');
    var minI = root.querySelector('#cv-min');
    var secI = root.querySelector('#cv-sec');
    var spdI = root.querySelector('#cv-speed');
    var grid = root.querySelector('#cv-grid');

    function isSpeed(t) { return t === 'kmh' || t === 'mph'; }
    function syncInputs() {
      var t = typeSel.value, sp = isSpeed(t);
      speedGroup.classList.toggle('is-hidden', !sp);
      paceGroup.classList.toggle('is-hidden', sp);
      if (sp && spdI) spdI.placeholder = (t === 'kmh') ? 'e.g. 12.0 (km/h)' : 'e.g. 7.5 (mph)';
    }
    function compute() {
      var t = typeSel.value, secPerKm = 0;
      if (t === 'pace_km') secPerKm = num(minI) * 60 + num(secI);
      else if (t === 'pace_mi') secPerKm = (num(minI) * 60 + num(secI)) / KM_PER_MILE;
      else if (t === 'kmh') { var v = num(spdI); secPerKm = v > 0 ? 3600 / v : 0; }
      else if (t === 'mph') { var v2 = num(spdI) * KM_PER_MILE; secPerKm = v2 > 0 ? 3600 / v2 : 0; }
      if (!(secPerKm > 0)) { grid.innerHTML = '<div class="result-empty">Enter a value to convert.</div>'; return; }
      var secPerMi = secPerKm * KM_PER_MILE, kmh = 3600 / secPerKm, mph = kmh / KM_PER_MILE;
      grid.innerHTML =
        resultCell('Pace /km', fmtPace(secPerKm)) +
        resultCell('Pace /mile', fmtPace(secPerMi)) +
        resultCell('Speed', kmh.toFixed(2) + ' km/h') +
        resultCell('Speed', mph.toFixed(2) + ' mph') +
        resultCell('Per 400 m', fmtPace(secPerKm * 0.4)) +
        resultCell('Per 1000 m', fmtDuration(secPerKm));
    }
    typeSel.addEventListener('change', function () { syncInputs(); compute(); });
    root.querySelectorAll('input').forEach(function (i) { i.addEventListener('input', compute); });
    syncInputs(); compute();
  })();

  // ========================================================
  // RACE PLANNER  (#race-planner)
  //   distance (or preset) + target time -> avg pace + splits
  // ========================================================
  (function racePlanner() {
    var root = document.getElementById('race-planner');
    if (!root) return;
    var distInput = root.querySelector('#pl-distance');
    var big = root.querySelector('#pl-big');
    var bigUnit = root.querySelector('#pl-big-unit');
    var grid = root.querySelector('#pl-grid');
    var splitsBody = root.querySelector('#pl-splits');
    var empty = root.querySelector('#pl-empty');
    var results = root.querySelector('#pl-results');

    root.querySelectorAll('[data-preset-km]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var km = parseFloat(btn.getAttribute('data-preset-km'));
        var unit = segValue(root, 'pl-unit') || 'km';
        distInput.value = unit === 'mi' ? +(km / KM_PER_MILE).toFixed(2) : km;
        compute();
      });
    });

    function compute() {
      var unit = segValue(root, 'pl-unit') || 'km';
      var dist = num(distInput);
      var totalSec = num(root.querySelector('#pl-h')) * 3600 + num(root.querySelector('#pl-m')) * 60 + num(root.querySelector('#pl-s'));
      if (dist <= 0 || totalSec <= 0) { results.classList.add('is-hidden'); empty.classList.remove('is-hidden'); return; }
      empty.classList.add('is-hidden'); results.classList.remove('is-hidden');

      var km = unit === 'mi' ? dist * KM_PER_MILE : dist;
      var mi = km / KM_PER_MILE;
      var pk = totalSec / km, pm = totalSec / mi, kmh = km / (totalSec / 3600), mph = mi / (totalSec / 3600);

      if (unit === 'mi') { big.textContent = fmtPace(pm); bigUnit.textContent = 'min / mile'; }
      else { big.textContent = fmtPace(pk); bigUnit.textContent = 'min / km'; }

      grid.innerHTML =
        resultCell('Pace /km', fmtPace(pk)) +
        resultCell('Pace /mile', fmtPace(pm)) +
        resultCell('Speed', kmh.toFixed(2) + ' km/h') +
        resultCell('Finish', fmtDuration(totalSec));

      var rows = '', full = Math.floor(km), marks = [];
      for (var k = 1; k <= full && k <= 80; k++) marks.push(k);
      if (km > full && marks.length < 80) marks.push(km);
      marks.forEach(function (mk) {
        var label = Number.isInteger(mk) ? mk : mk.toFixed(2);
        rows += '<tr><td class="num">' + label + '</td><td class="num">' + fmtPace(pk) + ' /km</td><td class="num">' + fmtDuration(pk * mk) + '</td></tr>';
      });
      splitsBody.innerHTML = rows;
    }

    wireSegmented(root, compute);
    root.querySelectorAll('input').forEach(function (i) { i.addEventListener('input', compute); });
    var form = root.querySelector('form');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); compute(); });
    compute();
  })();

  // ========================================================
  // GPX VIEWER  (#gpx-analyzer)
  //   Upload/drag a .gpx (or ?gpx=/routes/x.gpx from the
  //   database) -> stats, real map (Leaflet/OSM), profile, splits.
  // ========================================================
  (function gpxAnalyzer() {
    var root = document.getElementById('gpx-analyzer');
    if (!root) return;

    var fileInput = root.querySelector('#gpx-file');
    var drop = root.querySelector('#gpx-drop');
    var loadingEl = root.querySelector('#gpx-loading');
    var results = root.querySelector('#gpx-results');
    var errorBox = root.querySelector('#gpx-error');
    var nameEl = root.querySelector('#gpx-name');
    var statsEl = root.querySelector('#gpx-stats');
    var eleSection = root.querySelector('#gpx-ele-section');
    var eleWrap = root.querySelector('#gpx-elevation');
    var mapEl = root.querySelector('#gpx-map');
    var splitsBody = root.querySelector('#gpx-splits');
    var splitsNote = root.querySelector('#gpx-splits-note');
    var splitsHead = root.querySelector('#gpx-splits-head');
    var leafletMap = null;
    var revealTimer = null;
    var dlBtn = root.querySelector('#gpx-download');
    var countryEl = root.querySelector('#gpx-country');
    var source = null;       // { url } (from the database) or { file } (drag/drop) for the download button
    var routeCountry = '';   // from ?country= when opened from the database
    var dlObjUrl = null;

    var R = 6371000;
    function toRad(d) { return d * Math.PI / 180; }
    function haversine(a, b) {
      var dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
      var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    }
    function showError(msg) {
      errorBox.textContent = msg;
      errorBox.classList.remove('is-hidden');
      results.classList.add('is-hidden');
      if (loadingEl) loadingEl.classList.add('is-hidden');
      if (drop) drop.classList.remove('is-hidden');
    }
    function sample(n, max) {
      var step = Math.max(1, Math.ceil(n / max)), idx = [];
      for (var i = 0; i < n; i += step) idx.push(i);
      if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
      return idx;
    }

    function handleFile(file) {
      if (!file) return;
      if (!/\.gpx$/i.test(file.name)) { showError('Please choose a .gpx file.'); return; }
      var reader = new FileReader();
      reader.onload = function () { source = { file: file }; routeCountry = ''; parseGpx(String(reader.result), file.name); };
      reader.onerror = function () { showError('Could not read that file.'); };
      reader.readAsText(file);
    }

    function parseGpx(text, filename) {
      var doc;
      try { doc = new DOMParser().parseFromString(text, 'application/xml'); }
      catch (e) { showError('Invalid GPX file.'); return; }
      if (doc.getElementsByTagName('parsererror').length) { showError('This file is not valid XML/GPX.'); return; }
      var nodes = doc.getElementsByTagName('trkpt');
      if (!nodes.length) nodes = doc.getElementsByTagName('rtept');
      if (!nodes.length) { showError('No track points found in this GPX file.'); return; }
      var pts = [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
        if (!isFinite(lat) || !isFinite(lon)) continue;
        var eleN = n.getElementsByTagName('ele')[0], timeN = n.getElementsByTagName('time')[0];
        pts.push({ lat: lat, lon: lon, ele: eleN ? parseFloat(eleN.textContent) : null, time: timeN ? Date.parse(timeN.textContent) : null });
      }
      if (pts.length < 2) { showError('Not enough points to analyse.'); return; }
      render(pts, filename);
    }

    function reveal() {
      if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
      if (loadingEl) loadingEl.classList.add('is-hidden');
      if (drop) drop.classList.remove('is-hidden');
    }

    function render(pts, filename) {
      errorBox.classList.add('is-hidden');
      results.classList.remove('is-hidden');   // laid out under the loading overlay so the map can size
      nameEl.textContent = filename;

      var cum = [0], total = 0;
      for (var i = 1; i < pts.length; i++) { total += haversine(pts[i - 1], pts[i]); cum.push(total); }
      var totalKm = total / 1000;

      var hasEle = false, gain = 0, loss = 0, minE = Infinity, maxE = -Infinity, ref = null;
      for (i = 0; i < pts.length; i++) {
        var e = pts[i].ele; if (e === null || !isFinite(e)) continue;
        hasEle = true; if (e < minE) minE = e; if (e > maxE) maxE = e;
        if (ref === null) ref = e;
        else if (e > ref + 2) { gain += e - ref; ref = e; }
        else if (e < ref - 2) { loss += ref - e; ref = e; }
      }
      var t0 = pts[0].time, t1 = pts[pts.length - 1].time;
      var hasTime = !!(t0 && t1 && t1 > t0);
      var durSec = hasTime ? (t1 - t0) / 1000 : null;

      function metric(k, v) { return '<div class="metric"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
      statsEl.innerHTML =
        metric('Distance', totalKm.toFixed(2) + ' km') +
        metric('Elevation gain', hasEle ? '+' + Math.round(gain) + ' m' : '—') +
        metric('Elevation loss', hasEle ? '−' + Math.round(loss) + ' m' : '—') +
        metric('Duration', hasTime ? fmtDuration(durSec) : '—') +
        metric('Avg pace', hasTime ? fmtPace(durSec / totalKm) + ' /km' : '—') +
        metric('Max altitude', hasEle ? Math.round(maxE) + ' m' : '—');

      drawMap(pts, reveal);
      drawElevation(pts, cum, total, hasEle, minE, maxE);
      buildSplits(pts, cum, total, hasTime, t0, hasEle);
      setupActions(filename);
      // fallback: reveal even if map tiles never fire 'load' (e.g. offline)
      if (loadingEl && !loadingEl.classList.contains('is-hidden')) revealTimer = setTimeout(reveal, 4000);
    }

    function drawMap(pts, onReady) {
      if (typeof L === 'undefined' || !mapEl) { if (onReady) onReady(); return; }
      var idx = sample(pts.length, 2000);
      var latlngs = idx.map(function (i) { return [pts[i].lat, pts[i].lon]; });
      if (leafletMap) { leafletMap.remove(); leafletMap = null; }
      leafletMap = L.map(mapEl, { scrollWheelZoom: false, attributionControl: true });
      var tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap'
      }).addTo(leafletMap);
      if (onReady) tiles.on('load', onReady);
      var line = L.polyline(latlngs, { color: '#2F6BFF', weight: 4, opacity: 0.95 }).addTo(leafletMap);
      L.circleMarker(latlngs[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#11C29B', fillOpacity: 1 }).addTo(leafletMap);
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#FF5C39', fillOpacity: 1 }).addTo(leafletMap);
      leafletMap.fitBounds(line.getBounds(), { padding: [26, 26] });
      setTimeout(function () { if (leafletMap) leafletMap.invalidateSize(); }, 80);
    }

    function drawElevation(pts, cum, total, hasEle, minE, maxE) {
      if (!hasEle) { eleSection.classList.add('is-hidden'); return; }
      eleSection.classList.remove('is-hidden');

      var totalKm = total / 1000, range = (maxE - minE) || 1;
      var idx = sample(pts.length, 300), samples = [];
      idx.forEach(function (i) {
        if (pts[i].ele == null || !isFinite(pts[i].ele)) return;
        samples.push({ d: cum[i] / 1000, e: pts[i].ele });
      });
      if (samples.length < 2) { eleSection.classList.add('is-hidden'); return; }

      var W = 760, H = 280, mL = 46, mR = 14, mT = 14, mB = 28;
      var x0 = mL, plotW = W - mL - mR, yTop = mT, yBot = H - mB, plotH = yBot - yTop;
      function sx(d) { return x0 + (totalKm ? d / totalKm : 0) * plotW; }
      function sy(e) { return yBot - ((e - minE) / range) * plotH; }

      var line = '', area = '';
      samples.forEach(function (p, j) {
        var x = sx(p.d), y = sy(p.e);
        line += (j === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
        area += (j === 0 ? 'M' + x.toFixed(1) + ' ' + yBot + ' L' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      });
      area += 'L' + sx(samples[samples.length - 1].d).toFixed(1) + ' ' + yBot + ' Z';

      var grid = '';
      for (var t = 0; t <= 3; t++) {
        var val = minE + range * t / 3, gy = sy(val);
        grid += '<line x1="' + x0 + '" y1="' + gy.toFixed(1) + '" x2="' + (W - mR) + '" y2="' + gy.toFixed(1) + '" class="ax-grid"/>';
        grid += '<text x="' + (x0 - 7) + '" y="' + (gy + 4).toFixed(1) + '" class="ax-lbl ax-y">' + Math.round(val) + '</text>';
      }
      var xax = '';
      for (var k = 0; k <= 4; k++) {
        var km = totalKm * k / 4, xx = sx(km);
        xax += '<text x="' + xx.toFixed(1) + '" y="' + (yBot + 19) + '" class="ax-lbl ax-x">' + (totalKm >= 10 ? Math.round(km) : km.toFixed(1)) + '</text>';
      }

      eleWrap.style.position = 'relative';
      eleWrap.innerHTML =
        '<svg class="gpx-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Elevation profile">' +
        '<defs><linearGradient id="eleFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2F6BFF" stop-opacity="0.3"/><stop offset="1" stop-color="#2F6BFF" stop-opacity="0"/></linearGradient></defs>' +
        grid +
        '<path d="' + area + '" fill="url(#eleFill)"/>' +
        '<path d="' + line + '" fill="none" stroke="#2F6BFF" stroke-width="2.2" stroke-linejoin="round"/>' +
        xax +
        '<text x="8" y="16" class="ax-lbl ax-unit">m</text>' +
        '<text x="' + (W - mR) + '" y="' + (yBot + 19) + '" class="ax-lbl ax-x" style="text-anchor:end">km</text>' +
        '<line class="gpx-cross is-hidden" y1="' + yTop + '" y2="' + yBot + '"/>' +
        '<circle class="gpx-dot is-hidden" r="4.5"/>' +
        '<rect x="' + x0 + '" y="' + yTop + '" width="' + plotW + '" height="' + plotH + '" fill="transparent" class="gpx-hit"/>' +
        '</svg><div class="gpx-tip is-hidden"></div>';

      var svg = eleWrap.querySelector('svg');
      var cross = eleWrap.querySelector('.gpx-cross');
      var dot = eleWrap.querySelector('.gpx-dot');
      var tip = eleWrap.querySelector('.gpx-tip');
      var hit = eleWrap.querySelector('.gpx-hit');

      function move(ev) {
        var rect = svg.getBoundingClientRect();
        var cx = (ev.touches ? ev.touches[0].clientX : ev.clientX);
        var frac = ((cx - rect.left) / rect.width * W - x0) / plotW;
        frac = Math.max(0, Math.min(1, frac));
        var d = frac * totalKm, best = samples[0], bd = Math.abs(best.d - d);
        for (var i = 1; i < samples.length; i++) { var dd = Math.abs(samples[i].d - d); if (dd < bd) { bd = dd; best = samples[i]; } }
        var X = sx(best.d), Y = sy(best.e);
        cross.setAttribute('x1', X); cross.setAttribute('x2', X); cross.classList.remove('is-hidden');
        dot.setAttribute('cx', X); dot.setAttribute('cy', Y); dot.classList.remove('is-hidden');
        tip.textContent = best.d.toFixed(2) + ' km · ' + Math.round(best.e) + ' m';
        tip.style.left = (X / W * rect.width) + 'px';
        tip.style.top = (Y / H * rect.height) + 'px';
        tip.classList.remove('is-hidden');
      }
      function leave() { cross.classList.add('is-hidden'); dot.classList.add('is-hidden'); tip.classList.add('is-hidden'); }
      hit.addEventListener('pointermove', move);
      hit.addEventListener('pointerleave', leave);
      hit.addEventListener('touchmove', move, { passive: true });
      hit.addEventListener('touchend', leave);
    }

    function buildSplits(pts, cum, total, hasTime, t0, hasEle) {
      function interp(target) {
        for (var i = 1; i < cum.length; i++) {
          if (cum[i] >= target) {
            var seg = (cum[i] - cum[i - 1]) || 1, f = (target - cum[i - 1]) / seg;
            return {
              time: (pts[i - 1].time && pts[i].time) ? pts[i - 1].time + f * (pts[i].time - pts[i - 1].time) : null,
              ele: (pts[i - 1].ele != null && pts[i].ele != null) ? pts[i - 1].ele + f * (pts[i].ele - pts[i - 1].ele) : null
            };
          }
        }
        return { time: pts[pts.length - 1].time, ele: pts[pts.length - 1].ele };
      }
      splitsHead.innerHTML = '<tr><th>Km</th>' + (hasTime ? '<th>Split</th><th>Cumulative</th>' : '') + (hasEle ? '<th>Altitude</th>' : '') + '</tr>';
      var marks = [], full = Math.floor(total / 1000);
      for (var k = 1; k <= full && k <= 80; k++) marks.push(k * 1000);
      if (total > full * 1000 && marks.length < 80) marks.push(total);
      var prevMark = 0, prevCum = 0, rows = '';
      marks.forEach(function (m) {
        var segKm = (m - prevMark) / 1000;
        var label = (m === total && total % 1000 !== 0) ? (total / 1000).toFixed(2) : (m / 1000);
        var p = interp(m), row = '<tr><td class="num">' + label + '</td>';
        if (hasTime) {
          var cumT = (p.time - t0) / 1000, splitT = cumT - prevCum;
          row += '<td class="num">' + (segKm > 0 ? fmtPace(splitT / segKm) : '—') + ' /km</td><td class="num">' + fmtDuration(cumT) + '</td>';
          prevCum = cumT;
        }
        if (hasEle) row += '<td class="num">' + (p.ele != null ? Math.round(p.ele) + ' m' : '—') + '</td>';
        rows += row + '</tr>';
        prevMark = m;
      });
      splitsBody.innerHTML = rows;
      splitsNote.classList.toggle('is-hidden', hasTime);
    }

    // Show the download button (and country chip) once a route is loaded.
    function setupActions(filename) {
      if (dlBtn) {
        if (dlObjUrl) { URL.revokeObjectURL(dlObjUrl); dlObjUrl = null; }
        var href = null, dlName = (filename || 'route').replace(/\.gpx$/i, '');
        if (source && source.url) {
          href = source.url;
        } else if (source && source.file) {
          dlObjUrl = URL.createObjectURL(source.file);
          href = dlObjUrl;
        }
        if (href) {
          dlBtn.href = href;
          dlBtn.setAttribute('download', dlName + '.gpx');
          dlBtn.classList.remove('is-hidden');
        } else {
          dlBtn.classList.add('is-hidden');
        }
      }
      if (countryEl) {
        if (routeCountry) {
          countryEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/></svg>';
          countryEl.appendChild(document.createTextNode(' ' + routeCountry));
          countryEl.classList.remove('is-hidden');
        } else {
          countryEl.textContent = '';
          countryEl.classList.add('is-hidden');
        }
      }
    }

    // load a route passed by the GPX database (?gpx=/routes/x.gpx&name=&country=)
    function loadFromUrl() {
      var m = location.search.match(/[?&]gpx=([^&]+)/);
      if (!m) return;
      var url = decodeURIComponent(m[1]);
      if (!/^\/[\w\-\/.]+\.gpx$/i.test(url)) return;       // same-origin path only
      var nm = location.search.match(/[?&]name=([^&]+)/);
      var cc = location.search.match(/[?&]country=([^&]+)/);
      var displayName = nm ? decodeURIComponent(nm[1].replace(/\+/g, ' ')) : url.split('/').pop();
      routeCountry = cc ? decodeURIComponent(cc[1].replace(/\+/g, ' ')) : '';
      source = { url: url };
      if (drop) drop.classList.add('is-hidden');
      if (loadingEl) loadingEl.classList.remove('is-hidden');
      fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : Promise.reject(); })
        .then(function (txt) { parseGpx(txt, displayName); })
        .catch(function () { showError('Could not load that route.'); });
    }

    if (fileInput) fileInput.addEventListener('change', function () { handleFile(fileInput.files[0]); });
    if (drop) {
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-drag'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-drag'); }); });
      drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
    }
    loadFromUrl();
  })();

  // ========================================================
  // GPX EDITOR  (#gpx-editor)
  //   Shorten (trim) / Split / Merge. Shorten & Split share a
  //   single track on an interactive Leaflet map + draggable
  //   elevation profile; Merge combines several files in order.
  //   All client-side; nothing is uploaded.
  // ========================================================
  (function gpxEditor() {
    var root = document.getElementById('gpx-editor');
    if (!root) return;

    var R = 6371000;
    function toRad(d) { return d * Math.PI / 180; }
    function haversine(a, b) {
      var dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
      var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    var SEG = ['#2F6BFF', '#FF5C39', '#11C29B', '#F4B740', '#9B5DE5', '#00B4D8'];

    // ---- elements ----
    var elError = root.querySelector('#ed-error');
    var elReset = root.querySelector('#ed-reset');
    var modeBtns = root.querySelectorAll('.ed-modes button');
    var single = root.querySelector('#ed-single');
    var drop = root.querySelector('#ed-drop');
    var fileInput = root.querySelector('#ed-file');
    var loadingEl = root.querySelector('#ed-loading');
    var work = root.querySelector('#ed-work');
    var nameEl = root.querySelector('#ed-name');
    var statsEl = root.querySelector('#ed-stats');
    var hintEl = root.querySelector('#ed-hint');
    var eleWrap = root.querySelector('#ed-elevation');
    var controls = root.querySelector('#ed-controls');
    var mapEl = root.querySelector('#ed-map');
    var mergeWrap = root.querySelector('#ed-merge');
    var mergeDrop = root.querySelector('#ed-merge-drop');
    var mergeFileInput = root.querySelector('#ed-merge-file');
    var mergeAddInput = root.querySelector('#ed-merge-add');
    var mergeWork = root.querySelector('#ed-merge-work');
    var mergeListEl = root.querySelector('#ed-merge-list');
    var mergeSummary = root.querySelector('#ed-merge-summary');
    var mergeNameInput = root.querySelector('#ed-merge-name');
    var mergeGo = root.querySelector('#ed-merge-go');

    // ---- state ----
    var mode = 'shorten';
    var track = null;            // { name, pts, cum, totalKm }
    var startIdx = 0, endIdx = 0;
    var splits = [];             // point indices (unsorted)
    var mergeItems = [];         // [{ name, pts, distKm }]
    var leafletMap = null, hlLayer = null;
    var drag = null;             // { kind:'start'|'end'|'split', pos? }
    var rafPending = false;

    // ---- profile geometry (viewBox space) ----
    var PW = 760, PH = 300, mL = 46, mR = 16, mT = 30, mB = 30;
    var x0 = mL, plotW = PW - mL - mR, yTop = mT, yBot = PH - mB, plotH = yBot - yTop;

    // ---- parsing ----
    function parseGpx(text, filename) {
      var doc;
      try { doc = new DOMParser().parseFromString(text, 'application/xml'); }
      catch (e) { return null; }
      if (doc.getElementsByTagName('parsererror').length) return null;
      var nodes = doc.getElementsByTagName('trkpt');
      if (!nodes.length) nodes = doc.getElementsByTagName('rtept');
      if (nodes.length < 2) return null;
      var pts = [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
        if (!isFinite(lat) || !isFinite(lon)) continue;
        var eleN = n.getElementsByTagName('ele')[0], timeN = n.getElementsByTagName('time')[0];
        var ele = eleN ? parseFloat(eleN.textContent) : null;
        pts.push({ lat: lat, lon: lon, ele: (ele != null && isFinite(ele)) ? ele : null, time: timeN ? timeN.textContent : null });
      }
      if (pts.length < 2) return null;
      var name = filename ? filename.replace(/\.gpx$/i, '') : 'track';
      var nameN = doc.querySelector('trk > name') || doc.querySelector('metadata > name');
      if (nameN && nameN.textContent && nameN.textContent.trim()) name = nameN.textContent.trim();
      return buildTrack(name, pts);
    }
    function buildTrack(name, pts) {
      var cum = [0], total = 0;
      for (var i = 1; i < pts.length; i++) { total += haversine(pts[i - 1], pts[i]); cum.push(total); }
      return { name: name, pts: pts, cum: cum, totalKm: total / 1000 };
    }
    function rangeStats(t, a, b) {
      var lo = Math.min(a, b), hi = Math.max(a, b), gain = 0, loss = 0, ref = null;
      for (var i = lo; i <= hi; i++) {
        var e = t.pts[i].ele; if (e == null) continue;
        if (ref === null) ref = e;
        else if (e > ref + 2) { gain += e - ref; ref = e; }
        else if (e < ref - 2) { loss += ref - e; ref = e; }
      }
      return { distKm: (t.cum[hi] - t.cum[lo]) / 1000, gain: Math.round(gain), loss: Math.round(loss), pts: hi - lo + 1 };
    }
    function distToIndex(t, km) {
      var target = km * 1000, lo = 0, hi = t.cum.length - 1;
      if (target <= 0) return 0;
      if (target >= t.cum[hi]) return hi;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (t.cum[mid] < target) lo = mid + 1; else hi = mid; }
      if (lo > 0 && Math.abs(t.cum[lo - 1] - target) <= Math.abs(t.cum[lo] - target)) return lo - 1;
      return lo;
    }
    function sortedSplits() { return splits.slice().sort(function (a, b) { return a - b; }); }
    function segBounds() {
      var s = sortedSplits(), b = [0].concat(s, [track.pts.length - 1]), out = [];
      for (var i = 0; i < b.length - 1; i++) out.push([b[i], b[i + 1]]);
      return out;
    }

    // ---- serialize + download ----
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function ptXml(p) {
      var s = '    <trkpt lat="' + p.lat + '" lon="' + p.lon + '">';
      if (p.ele != null) s += '<ele>' + p.ele + '</ele>';
      if (p.time) s += '<time>' + esc(p.time) + '</time>';
      return s + '</trkpt>';
    }
    function gpxDoc(name, segs) {
      var body = '';
      for (var i = 0; i < segs.length; i++) body += '  <trkseg>\n' + segs[i].map(ptXml).join('\n') + '\n  </trkseg>\n';
      return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<gpx version="1.1" creator="Guaruna GPX Editor - guaruna.com" xmlns="http://www.topografix.com/GPX/1/1">\n' +
        '<metadata><name>' + esc(name) + '</name></metadata>\n' +
        '<trk><name>' + esc(name) + '</name>\n' + body + '</trk>\n</gpx>\n';
    }
    function slug(s) { return (String(s).trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase()) || 'track'; }
    function download(name, content) {
      var fn = /\.gpx$/i.test(name) ? name : name + '.gpx';
      var blob = new Blob([content], { type: 'application/gpx+xml' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = fn;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function showError(msg) { elError.textContent = msg; elError.classList.remove('is-hidden'); }
    function clearError() { elError.classList.add('is-hidden'); }
    function closestData(el, attr) {
      while (el && el.getAttribute) { if (el.getAttribute(attr) != null) return el.getAttribute(attr); el = el.parentNode; }
      return null;
    }

    // ---- icons ----
    function dlIcon() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>'; }
    function checkIcon() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'; }
    function upIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>'; }
    function downIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'; }
    function trashIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'; }

    // ---- mode switching ----
    function setMode(m) {
      mode = m;
      for (var i = 0; i < modeBtns.length; i++) modeBtns[i].setAttribute('aria-pressed', modeBtns[i].getAttribute('data-mode') === m ? 'true' : 'false');
      clearError();
      var isMerge = (m === 'merge');
      single.classList.toggle('is-hidden', isMerge);
      mergeWrap.classList.toggle('is-hidden', !isMerge);
      elReset.classList.toggle('is-hidden', isMerge || !track);
      if (!isMerge && track) {
        renderControls();
        if (leafletMap) setTimeout(function () { leafletMap.invalidateSize(); }, 60);
      }
    }

    // ---- single-file load ----
    function handleSingle(file) {
      if (!file) return;
      if (!/\.gpx$/i.test(file.name)) { showError('Please choose a .gpx file.'); return; }
      clearError();
      drop.classList.add('is-hidden');
      loadingEl.classList.remove('is-hidden');
      var reader = new FileReader();
      reader.onload = function () {
        var t = parseGpx(String(reader.result), file.name);
        loadingEl.classList.add('is-hidden');
        if (!t) { drop.classList.remove('is-hidden'); showError('Could not read a valid track from that file.'); return; }
        track = t; startIdx = 0; endIdx = t.pts.length - 1; splits = [];
        nameEl.textContent = t.name;
        work.classList.remove('is-hidden');
        elReset.classList.remove('is-hidden');
        renderStats();
        drawMap();
        renderControls();
      };
      reader.onerror = function () { loadingEl.classList.add('is-hidden'); drop.classList.remove('is-hidden'); showError('Could not read that file.'); };
      reader.readAsText(file);
    }
    function resetSingle() {
      track = null; splits = [];
      work.classList.add('is-hidden');
      drop.classList.remove('is-hidden');
      elReset.classList.add('is-hidden');
      if (leafletMap) { leafletMap.remove(); leafletMap = null; hlLayer = null; }
      clearError();
    }

    // ---- map ----
    function sampledBetween(a, b, cap) {
      var lo = Math.min(a, b), hi = Math.max(a, b), n = hi - lo + 1;
      var step = Math.max(1, Math.ceil(n / (cap || 1000))), out = [];
      for (var i = lo; i <= hi; i += step) out.push([track.pts[i].lat, track.pts[i].lon]);
      out.push([track.pts[hi].lat, track.pts[hi].lon]);
      return out;
    }
    function dot(i, color) {
      return L.circleMarker([track.pts[i].lat, track.pts[i].lon], { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 });
    }
    function drawMap() {
      if (typeof L === 'undefined' || !mapEl) return;
      if (leafletMap) { leafletMap.remove(); leafletMap = null; }
      var coords = sampledBetween(0, track.pts.length - 1, 2000);
      leafletMap = L.map(mapEl, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(leafletMap);
      var base = L.polyline(coords, { color: '#CBD5E1', weight: 3, opacity: 0.95 }).addTo(leafletMap);
      hlLayer = L.layerGroup().addTo(leafletMap);
      leafletMap.fitBounds(base.getBounds(), { padding: [26, 26] });
      setTimeout(function () { if (leafletMap) leafletMap.invalidateSize(); }, 80);
      updateHighlight();
    }
    function updateHighlight() {
      if (!hlLayer) return;
      hlLayer.clearLayers();
      if (mode === 'shorten') {
        L.polyline(sampledBetween(startIdx, endIdx, 1000), { color: '#2F6BFF', weight: 5, opacity: 1 }).addTo(hlLayer);
        dot(startIdx, '#11C29B').addTo(hlLayer);
        dot(endIdx, '#FF5C39').addTo(hlLayer);
      } else {
        var bounds = segBounds();
        for (var i = 0; i < bounds.length; i++) {
          L.polyline(sampledBetween(bounds[i][0], bounds[i][1], 1000), { color: SEG[i % SEG.length], weight: 5, opacity: 0.95 }).addTo(hlLayer);
        }
        var sorted = sortedSplits();
        for (var j = 0; j < sorted.length; j++) {
          L.circleMarker([track.pts[sorted[j]].lat, track.pts[sorted[j]].lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#0F172A', fillOpacity: 1 }).addTo(hlLayer);
        }
        dot(0, '#11C29B').addTo(hlLayer);
        dot(track.pts.length - 1, '#FF5C39').addTo(hlLayer);
      }
    }

    // ---- elevation profile ----
    function profileSamples() {
      var n = track.pts.length, step = Math.max(1, Math.ceil(n / 360)), out = [];
      for (var i = 0; i < n; i += step) { var p = track.pts[i]; if (p.ele == null) continue; out.push({ d: track.cum[i] / 1000, e: p.ele }); }
      var last = track.pts[n - 1]; if (last.ele != null) out.push({ d: track.cum[n - 1] / 1000, e: last.ele });
      return out;
    }
    function drawProfile() {
      var totalKm = track.totalKm || 1;
      var samples = profileSamples();
      var hasEle = samples.length >= 2;
      var minE = Infinity, maxE = -Infinity, i;
      for (i = 0; i < samples.length; i++) { if (samples[i].e < minE) minE = samples[i].e; if (samples[i].e > maxE) maxE = samples[i].e; }
      if (!hasEle) { minE = 0; maxE = 1; }
      var range = (maxE - minE) || 1;
      function sx(d) { return x0 + (d / totalKm) * plotW; }
      function sy(e) { return yBot - ((e - minE) / range) * plotH; }
      function lineBetween(aKm, bKm) {
        var s = '';
        for (var k = 0; k < samples.length; k++) {
          if (samples[k].d < aKm - 1e-9 || samples[k].d > bKm + 1e-9) continue;
          s += (s ? 'L' : 'M') + sx(samples[k].d).toFixed(1) + ' ' + sy(samples[k].e).toFixed(1) + ' ';
        }
        return s;
      }

      var grid = '';
      for (var g = 0; g <= 3; g++) {
        var val = minE + range * g / 3, gy = sy(val);
        grid += '<line x1="' + x0 + '" y1="' + gy.toFixed(1) + '" x2="' + (PW - mR) + '" y2="' + gy.toFixed(1) + '" class="ax-grid"/>';
        if (hasEle) grid += '<text x="' + (x0 - 7) + '" y="' + (gy + 4).toFixed(1) + '" class="ax-lbl ax-y">' + Math.round(val) + '</text>';
      }
      var xax = '';
      for (var c = 0; c <= 4; c++) { var km = totalKm * c / 4; xax += '<text x="' + sx(km).toFixed(1) + '" y="' + (yBot + 20) + '" class="ax-lbl ax-x">' + (totalKm >= 10 ? Math.round(km) : km.toFixed(1)) + '</text>'; }

      var svg = '<svg class="gpx-chart ed-chart ' + (mode === 'split' ? 'is-split' : '') + '" viewBox="0 0 ' + PW + ' ' + PH + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Elevation editor">';
      svg += '<defs><linearGradient id="edFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2F6BFF" stop-opacity="0.18"/><stop offset="1" stop-color="#2F6BFF" stop-opacity="0"/></linearGradient></defs>';
      svg += grid + xax;
      if (hasEle) {
        var area = 'M' + sx(samples[0].d).toFixed(1) + ' ' + yBot;
        for (i = 0; i < samples.length; i++) area += ' L' + sx(samples[i].d).toFixed(1) + ' ' + sy(samples[i].e).toFixed(1);
        area += ' L' + sx(samples[samples.length - 1].d).toFixed(1) + ' ' + yBot + ' Z';
        svg += '<path d="' + area + '" fill="url(#edFill)"/>';
      } else {
        svg += '<line x1="' + x0 + '" y1="' + (yBot - plotH / 2).toFixed(1) + '" x2="' + (PW - mR) + '" y2="' + (yBot - plotH / 2).toFixed(1) + '" stroke="#CBD5E1" stroke-width="2" stroke-dasharray="4 5"/>';
      }

      if (mode === 'shorten') {
        var sX = sx(track.cum[startIdx] / 1000), eX = sx(track.cum[endIdx] / 1000);
        svg += '<rect class="ed-cut" x="' + x0 + '" y="' + yTop + '" width="' + Math.max(0, sX - x0).toFixed(1) + '" height="' + plotH + '"/>';
        svg += '<rect class="ed-cut" x="' + eX.toFixed(1) + '" y="' + yTop + '" width="' + Math.max(0, PW - mR - eX).toFixed(1) + '" height="' + plotH + '"/>';
        svg += '<rect class="ed-keep" x="' + sX.toFixed(1) + '" y="' + yTop + '" width="' + Math.max(0, eX - sX).toFixed(1) + '" height="' + plotH + '"/>';
        if (hasEle) {
          svg += '<path class="ed-fullline" d="' + lineBetween(0, totalKm) + '"/>';
          svg += '<path class="ed-keepline" d="' + lineBetween(track.cum[startIdx] / 1000, track.cum[endIdx] / 1000) + '"/>';
        }
        svg += handle('start', sX, '#11C29B');
        svg += handle('end', eX, '#FF5C39');
      } else {
        var bounds = segBounds();
        if (hasEle) {
          for (i = 0; i < bounds.length; i++) {
            svg += '<path d="' + lineBetween(track.cum[bounds[i][0]] / 1000, track.cum[bounds[i][1]] / 1000) + '" fill="none" stroke="' + SEG[i % SEG.length] + '" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>';
          }
        }
        svg += '<rect class="ed-addhit" x="' + x0 + '" y="' + yTop + '" width="' + plotW + '" height="' + plotH + '"/>';
        for (var pi = 0; pi < splits.length; pi++) {
          var cx = sx(track.cum[splits[pi]] / 1000);
          svg += '<line class="ed-split-line" x1="' + cx.toFixed(1) + '" y1="' + yTop + '" x2="' + cx.toFixed(1) + '" y2="' + yBot + '"/>';
          svg += '<rect class="ed-split-hit" data-split="' + pi + '" x="' + (cx - 9).toFixed(1) + '" y="' + yTop + '" width="18" height="' + plotH + '"/>';
          svg += '<circle class="ed-split-knob" cx="' + cx.toFixed(1) + '" cy="' + yBot + '" r="5"/>';
          svg += '<g class="ed-split-x" data-remove="' + pi + '"><circle cx="' + cx.toFixed(1) + '" cy="' + (yTop - 12) + '" r="8.5"/><line x1="' + (cx - 3).toFixed(1) + '" y1="' + (yTop - 15) + '" x2="' + (cx + 3).toFixed(1) + '" y2="' + (yTop - 9) + '"/><line x1="' + (cx + 3).toFixed(1) + '" y1="' + (yTop - 15) + '" x2="' + (cx - 3).toFixed(1) + '" y2="' + (yTop - 9) + '"/></g>';
        }
      }
      svg += '<text x="8" y="' + (yTop - 14) + '" class="ax-lbl ax-unit">m</text>';
      svg += '</svg>';
      eleWrap.innerHTML = svg;
      hintEl.textContent = (mode === 'shorten') ? 'drag the handles to crop' : 'click the chart to add a split';
      wireProfile(totalKm);
    }
    function handle(kind, cx, color) {
      var top = yTop - 8;
      return '<g>' +
        '<line class="ed-handle-line" x1="' + cx.toFixed(1) + '" y1="' + top + '" x2="' + cx.toFixed(1) + '" y2="' + yBot + '" stroke="' + color + '"/>' +
        '<rect class="ed-handle-hit" data-handle="' + kind + '" x="' + (cx - 11).toFixed(1) + '" y="' + (top - 4) + '" width="22" height="' + (plotH + 12) + '"/>' +
        '<circle class="ed-knob" data-handle="' + kind + '" cx="' + cx.toFixed(1) + '" cy="' + top + '" r="8.5" fill="' + color + '"/>' +
        '<line class="ed-knob-grip" x1="' + (cx - 2.5).toFixed(1) + '" y1="' + (top - 3) + '" x2="' + (cx - 2.5).toFixed(1) + '" y2="' + (top + 3) + '"/>' +
        '<line class="ed-knob-grip" x1="' + (cx + 2.5).toFixed(1) + '" y1="' + (top - 3) + '" x2="' + (cx + 2.5).toFixed(1) + '" y2="' + (top + 3) + '"/>' +
        '</g>';
    }
    function wireProfile(totalKm) {
      var svg = eleWrap.querySelector('svg');
      if (!svg) return;
      function clientToKm(clientX) {
        var rect = svg.getBoundingClientRect();
        return clamp(((clientX - rect.left) / rect.width * PW - x0) / plotW, 0, 1) * totalKm;
      }
      svg._toKm = clientToKm;
      svg.addEventListener('pointerdown', function (e) {
        var h = e.target.getAttribute && e.target.getAttribute('data-handle');
        var sp = e.target.getAttribute && e.target.getAttribute('data-split');
        if (h) { drag = { kind: h }; e.preventDefault(); }
        else if (sp != null) { drag = { kind: 'split', pos: parseInt(sp, 10) }; e.preventDefault(); }
      });
      svg.addEventListener('click', function (e) {
        var rm = closestData(e.target, 'data-remove');
        if (rm != null) { splits.splice(parseInt(rm, 10), 1); hideDone(); syncSingle(); return; }
        if (mode === 'split' && e.target.classList && e.target.classList.contains('ed-addhit')) addSplitKm(clientToKm(e.clientX));
      });
    }

    function onPointerMove(e) {
      if (!drag || !track) return;
      var svg = eleWrap.querySelector('svg'); if (!svg || !svg._toKm) return;
      var idx = distToIndex(track, svg._toKm(e.clientX));
      if (drag.kind === 'start') startIdx = clamp(idx, 0, endIdx - 1);
      else if (drag.kind === 'end') endIdx = clamp(idx, startIdx + 1, track.pts.length - 1);
      else if (drag.kind === 'split' && drag.pos < splits.length) splits[drag.pos] = clamp(idx, 1, track.pts.length - 2);
      hideDone();
      if (!rafPending) { rafPending = true; requestAnimationFrame(function () { rafPending = false; syncSingle(); }); }
    }
    function onPointerUp() { drag = null; }

    function addSplitKm(km) {
      var idx = distToIndex(track, km);
      var margin = Math.max(1, Math.round(track.pts.length * 0.02));
      if (idx < margin || idx > track.pts.length - 1 - margin) return;
      for (var i = 0; i < splits.length; i++) if (Math.abs(splits[i] - idx) < margin) return;
      splits.push(idx); hideDone(); syncSingle();
    }
    function equalParts(n) {
      n = clamp(Math.round(n), 2, 30);
      var idxs = [];
      for (var k = 1; k < n; k++) idxs.push(distToIndex(track, track.totalKm * k / n));
      splits = uniqInner(idxs); hideDone(); syncSingle();
    }
    function everyKm(km) {
      km = Math.max(0.1, km);
      var idxs = [];
      for (var d = km; d < track.totalKm - 0.02; d += km) idxs.push(distToIndex(track, d));
      splits = uniqInner(idxs); hideDone(); syncSingle();
    }
    function uniqInner(arr) {
      arr.sort(function (a, b) { return a - b; });
      var seen = {}, out = [];
      for (var i = 0; i < arr.length; i++) { var v = arr[i]; if (v > 0 && v < track.pts.length - 1 && !seen[v]) { seen[v] = 1; out.push(v); } }
      return out;
    }

    // ---- stats + controls ----
    function renderStats() {
      var minE = Infinity, maxE = -Infinity, hasE = false, gain = 0, loss = 0, ref = null;
      for (var i = 0; i < track.pts.length; i++) {
        var e = track.pts[i].ele; if (e == null) continue;
        hasE = true; if (e < minE) minE = e; if (e > maxE) maxE = e;
        if (ref === null) ref = e;
        else if (e > ref + 2) { gain += e - ref; ref = e; }
        else if (e < ref - 2) { loss += ref - e; ref = e; }
      }
      function m(k, v) { return '<div class="metric"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
      statsEl.innerHTML =
        m('Distance', track.totalKm.toFixed(2) + ' km') +
        m('Elevation gain', hasE ? '+' + Math.round(gain) + ' m' : '—') +
        m('Elevation loss', hasE ? '−' + Math.round(loss) + ' m' : '—') +
        m('Highest', hasE ? Math.round(maxE) + ' m' : '—') +
        m('Lowest', hasE ? Math.round(minE) + ' m' : '—') +
        m('Points', track.pts.length.toLocaleString());
    }
    function setText(sel, txt) { var el = controls.querySelector(sel); if (el) el.textContent = txt; }
    function renderControls() { controls.innerHTML = (mode === 'shorten') ? shortenScaffold() : splitScaffold(); wireControls(); syncSingle(); }
    function syncSingle() { drawProfile(); updateHighlight(); if (mode === 'shorten') syncShorten(); else syncSplit(); }

    function shortenScaffold() {
      return '' +
        '<div class="ed-preview">' +
          '<div class="metric"><div class="k">Kept distance</div><div class="v" id="ed-pv-dist">—</div></div>' +
          '<div class="metric"><div class="k">Elevation gain</div><div class="v" id="ed-pv-gain">—</div></div>' +
          '<div class="metric"><div class="k">Elevation loss</div><div class="v" id="ed-pv-loss">—</div></div>' +
        '</div>' +
        '<div class="ed-allrow">' +
          '<div class="field"><label for="ed-start-km">Start (km)</label><input class="input mono" type="number" id="ed-start-km" min="0" step="0.1"></div>' +
          '<div class="field"><label for="ed-end-km">End (km)</label><input class="input mono" type="number" id="ed-end-km" min="0" step="0.1"></div>' +
        '</div>' +
        '<div class="ed-allrow" style="margin-top:14px">' +
          '<div class="field"><label for="ed-trim-name">Output filename</label><div class="ed-namerow"><input class="input" type="text" id="ed-trim-name" value="' + esc(slug(track.name) + '-trimmed') + '"><span class="ed-ext mono">.gpx</span></div></div>' +
          '<button type="button" class="btn btn-primary" id="ed-trim-go">' + dlIcon() + 'Download trimmed</button>' +
        '</div>' +
        '<div class="ed-success is-hidden" id="ed-done"></div>';
    }
    function syncShorten() {
      var st = rangeStats(track, startIdx, endIdx);
      setText('#ed-pv-dist', st.distKm.toFixed(2) + ' km');
      setText('#ed-pv-gain', '+' + st.gain + ' m');
      setText('#ed-pv-loss', '−' + st.loss + ' m');
      var si = controls.querySelector('#ed-start-km'), ei = controls.querySelector('#ed-end-km');
      if (si && document.activeElement !== si) si.value = (track.cum[startIdx] / 1000).toFixed(2);
      if (ei && document.activeElement !== ei) ei.value = (track.cum[endIdx] / 1000).toFixed(2);
      if (si) si.max = (track.cum[endIdx] / 1000).toFixed(2);
    }

    function splitScaffold() {
      return '' +
        '<div class="ed-quick">' +
          '<span class="ed-quick-label">Quick split</span>' +
          '<button type="button" class="ed-chip" data-half>In half</button>' +
          '<span class="ed-chip-combo"><input type="number" id="ed-eq" min="2" max="30" value="3"><button type="button" data-eq>equal parts</button></span>' +
          '<span class="ed-chip-combo"><span class="ed-pre">every</span><input type="number" id="ed-every" min="0.5" step="0.5" value="5"><button type="button" data-every>km</button></span>' +
          '<button type="button" class="ed-clear" data-clear>Clear</button>' +
        '</div>' +
        '<p class="ed-hint" id="ed-split-summary" style="text-align:left;margin:0 0 10px"></p>' +
        '<div class="ed-seglist" id="ed-seglist"></div>' +
        '<div class="ed-allrow" style="margin-top:16px">' +
          '<div class="field"><label for="ed-split-base">Segment base name</label><div class="ed-namerow"><input class="input" type="text" id="ed-split-base" value="' + esc(slug(track.name)) + '"><span class="ed-ext mono">-1.gpx, -2.gpx …</span></div></div>' +
          '<button type="button" class="btn btn-primary" id="ed-split-all">' + dlIcon() + 'Download all</button>' +
        '</div>' +
        '<div class="ed-success is-hidden" id="ed-done"></div>';
    }
    function baseName() { var el = controls.querySelector('#ed-split-base'); return slug(el && el.value ? el.value : track.name); }
    function syncSplit() {
      var bounds = segBounds();
      setText('#ed-split-summary', bounds.length + ' segment' + (bounds.length !== 1 ? 's' : '') + ' · click the chart or use quick split');
      var html = '', base = baseName();
      for (var i = 0; i < bounds.length; i++) {
        var st = rangeStats(track, bounds[i][0], bounds[i][1]);
        html += '<div class="ed-segrow">' +
          '<span class="ed-seg-dot" style="background:' + SEG[i % SEG.length] + '"></span>' +
          '<div class="ed-row-main"><div class="ed-row-name">' + esc(base) + '-' + (i + 1) + '.gpx</div>' +
          '<div class="ed-row-meta">' + st.distKm.toFixed(2) + ' km · +' + st.gain + ' m · ' + st.pts.toLocaleString() + ' pts</div></div>' +
          '<button type="button" class="ed-dlbtn" data-dl-seg="' + i + '">' + dlIcon() + 'GPX</button>' +
        '</div>';
      }
      var list = controls.querySelector('#ed-seglist'); if (list) list.innerHTML = html;
      var all = controls.querySelector('#ed-split-all'); if (all) all.disabled = bounds.length < 2;
    }
    function wireControls() {
      if (mode === 'shorten') {
        var si = controls.querySelector('#ed-start-km'), ei = controls.querySelector('#ed-end-km');
        if (si) si.addEventListener('input', function () { var km = parseFloat(si.value); if (isFinite(km)) { startIdx = clamp(distToIndex(track, km), 0, endIdx - 1); hideDone(); syncSingle(); } });
        if (ei) ei.addEventListener('input', function () { var km = parseFloat(ei.value); if (isFinite(km)) { endIdx = clamp(distToIndex(track, km), startIdx + 1, track.pts.length - 1); hideDone(); syncSingle(); } });
        var go = controls.querySelector('#ed-trim-go'); if (go) go.addEventListener('click', downloadTrim);
      } else {
        var half = controls.querySelector('[data-half]'); if (half) half.addEventListener('click', function () { equalParts(2); });
        var eqb = controls.querySelector('[data-eq]'); if (eqb) eqb.addEventListener('click', function () { equalParts(parseFloat(controls.querySelector('#ed-eq').value) || 2); });
        var evb = controls.querySelector('[data-every]'); if (evb) evb.addEventListener('click', function () { everyKm(parseFloat(controls.querySelector('#ed-every').value) || 5); });
        var clr = controls.querySelector('[data-clear]'); if (clr) clr.addEventListener('click', function () { splits = []; hideDone(); syncSingle(); });
        var base = controls.querySelector('#ed-split-base'); if (base) base.addEventListener('input', syncSplit);
        var list = controls.querySelector('#ed-seglist'); if (list) list.addEventListener('click', function (e) { var d = closestData(e.target, 'data-dl-seg'); if (d != null) downloadSeg(parseInt(d, 10)); });
        var all = controls.querySelector('#ed-split-all'); if (all) all.addEventListener('click', downloadAllSegs);
      }
    }
    function showDone(msg) { var d = controls.querySelector('#ed-done'); if (d) { d.innerHTML = checkIcon() + '<span>' + esc(msg) + '</span>'; d.classList.remove('is-hidden'); } }
    function hideDone() { var d = controls.querySelector('#ed-done'); if (d) d.classList.add('is-hidden'); }

    function downloadTrim() {
      var a = Math.min(startIdx, endIdx), b = Math.max(startIdx, endIdx);
      var inp = controls.querySelector('#ed-trim-name');
      var name = (inp && inp.value ? inp.value : slug(track.name) + '-trimmed').replace(/\.gpx$/i, '');
      download(name, gpxDoc(name, [track.pts.slice(a, b + 1)]));
      showDone('Downloaded ' + name + '.gpx — ' + rangeStats(track, a, b).distKm.toFixed(1) + ' km.');
    }
    function downloadSeg(i) {
      var bounds = segBounds(); if (i >= bounds.length) return;
      var nm = baseName() + '-' + (i + 1);
      download(nm, gpxDoc(nm, [track.pts.slice(bounds[i][0], bounds[i][1] + 1)]));
    }
    function downloadAllSegs() {
      var bounds = segBounds(); if (bounds.length < 2) return;
      var base = baseName();
      bounds.forEach(function (b, i) {
        setTimeout(function () { var nm = base + '-' + (i + 1); download(nm, gpxDoc(nm, [track.pts.slice(b[0], b[1] + 1)])); }, i * 250);
      });
      showDone('Downloading ' + bounds.length + ' segments…');
    }

    // ---- merge ----
    function handleMergeFiles(fileList, additive) {
      var files = Array.prototype.slice.call(fileList);
      if (!files.length) return;
      if (!additive) mergeItems = [];
      clearError();
      var pending = files.length;
      files.forEach(function (file) {
        if (!/\.gpx$/i.test(file.name)) { pending--; showError('"' + file.name + '" is not a .gpx file.'); finishMerge(pending); return; }
        var reader = new FileReader();
        reader.onload = function () { var t = parseGpx(String(reader.result), file.name); if (t) mergeItems.push({ name: t.name, pts: t.pts, distKm: t.totalKm }); pending--; finishMerge(pending); };
        reader.onerror = function () { pending--; finishMerge(pending); };
        reader.readAsText(file);
      });
    }
    function finishMerge(pending) {
      if (pending > 0) return;
      if (mergeItems.length) { mergeDrop.classList.add('is-hidden'); mergeWork.classList.remove('is-hidden'); }
      else { mergeDrop.classList.remove('is-hidden'); mergeWork.classList.add('is-hidden'); }
      renderMergeList();
    }
    function renderMergeList() {
      var total = 0, html = '';
      for (var i = 0; i < mergeItems.length; i++) {
        var it = mergeItems[i]; total += it.distKm;
        html += '<div class="ed-filerow">' +
          '<span class="ed-idx">' + (i + 1) + '</span>' +
          '<div class="ed-row-main"><div class="ed-row-name">' + esc(it.name) + '</div>' +
          '<div class="ed-row-meta">' + it.distKm.toFixed(2) + ' km · ' + it.pts.length.toLocaleString() + ' pts</div></div>' +
          '<div class="ed-row-actions">' +
            '<button type="button" class="ed-iconbtn" data-up="' + i + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">' + upIcon() + '</button>' +
            '<button type="button" class="ed-iconbtn" data-down="' + i + '"' + (i === mergeItems.length - 1 ? ' disabled' : '') + ' aria-label="Move down">' + downIcon() + '</button>' +
            '<button type="button" class="ed-iconbtn ed-danger" data-remove-file="' + i + '" aria-label="Remove">' + trashIcon() + '</button>' +
          '</div></div>';
      }
      mergeListEl.innerHTML = html;
      mergeSummary.textContent = mergeItems.length + ' file' + (mergeItems.length !== 1 ? 's' : '') + ' · ' + total.toFixed(1) + ' km total';
      if (!mergeNameInput.value) mergeNameInput.value = 'merged-route';
      mergeGo.disabled = mergeItems.length < 2;
    }

    // ---- drag & drop wiring ----
    function wireDrop(el, cb) {
      ['dragenter', 'dragover'].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.add('is-drag'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.remove('is-drag'); }); });
      el.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) cb(e.dataTransfer.files); });
    }

    // ---- init ----
    for (var mi = 0; mi < modeBtns.length; mi++) {
      (function (btn) { btn.addEventListener('click', function () { setMode(btn.getAttribute('data-mode')); }); })(modeBtns[mi]);
    }
    elReset.addEventListener('click', resetSingle);
    fileInput.addEventListener('change', function () { handleSingle(fileInput.files[0]); fileInput.value = ''; });
    wireDrop(drop, function (files) { handleSingle(files[0]); });
    mergeFileInput.addEventListener('change', function () { handleMergeFiles(mergeFileInput.files, false); mergeFileInput.value = ''; });
    mergeAddInput.addEventListener('change', function () { handleMergeFiles(mergeAddInput.files, true); mergeAddInput.value = ''; });
    wireDrop(mergeDrop, function (files) { handleMergeFiles(files, false); });
    mergeListEl.addEventListener('click', function (e) {
      var up = closestData(e.target, 'data-up'), dn = closestData(e.target, 'data-down'), rm = closestData(e.target, 'data-remove-file'), t;
      if (up != null) { var i = +up; if (i > 0) { t = mergeItems[i]; mergeItems[i] = mergeItems[i - 1]; mergeItems[i - 1] = t; renderMergeList(); } }
      else if (dn != null) { var j = +dn; if (j < mergeItems.length - 1) { t = mergeItems[j]; mergeItems[j] = mergeItems[j + 1]; mergeItems[j + 1] = t; renderMergeList(); } }
      else if (rm != null) { mergeItems.splice(+rm, 1); if (!mergeItems.length) { mergeDrop.classList.remove('is-hidden'); mergeWork.classList.add('is-hidden'); } renderMergeList(); }
    });
    mergeGo.addEventListener('click', function () {
      if (mergeItems.length < 2) return;
      var nm = (mergeNameInput.value || 'merged-route').replace(/\.gpx$/i, '');
      var segs = mergeItems.map(function (it) { return it.pts; });
      download(nm, gpxDoc(nm, segs));
    });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  })();

  // ========================================================
  // GPX CONVERTER  (#gpx-converter)
  //   GPX -> GeoJSON / CSV / KML / TCX, all in the browser.
  // ========================================================
  (function gpxConverter() {
    var root = document.getElementById('gpx-converter');
    if (!root) return;
    var drop = root.querySelector('#cv-drop');
    var fileInput = root.querySelector('#cv-file');
    var loadingEl = root.querySelector('#cv-loading');
    var results = root.querySelector('#cv-results');
    var errorBox = root.querySelector('#cv-error');
    var nameEl = root.querySelector('#cv-name');
    var statsEl = root.querySelector('#cv-stats');
    var mapEl = root.querySelector('#cv-map');
    var fmtWrap = root.querySelector('#cv-formats');
    var doneEl = root.querySelector('#cv-done');
    var resetBtn = root.querySelector('#cv-reset');
    var track = null, lmap = null;

    function err(m) { errorBox.textContent = m; errorBox.classList.remove('is-hidden'); results.classList.add('is-hidden'); loadingEl.classList.add('is-hidden'); drop.classList.remove('is-hidden'); }
    function handle(file) {
      if (!file) return;
      if (!/\.gpx$/i.test(file.name)) { err('Please choose a .gpx file.'); return; }
      errorBox.classList.add('is-hidden'); drop.classList.add('is-hidden'); doneEl.classList.add('is-hidden'); loadingEl.classList.remove('is-hidden');
      var r = new FileReader();
      r.onload = function () { var t = gpxParse(String(r.result), file.name); loadingEl.classList.add('is-hidden'); if (!t) { err('Could not read a valid track from that file.'); return; } track = t; render(); };
      r.onerror = function () { err('Could not read that file.'); };
      r.readAsText(file);
    }
    function render() {
      results.classList.remove('is-hidden');
      nameEl.textContent = track.name;
      var hasEle = false, gain = 0, ref = null;
      for (var i = 0; i < track.pts.length; i++) { var e = track.pts[i].ele; if (e == null) continue; hasEle = true; if (ref === null) ref = e; else if (e > ref + 2) { gain += e - ref; ref = e; } else if (e < ref - 2) { ref = e; } }
      function m(k, v) { return '<div class="metric"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
      statsEl.innerHTML = m('Distance', track.totalKm.toFixed(2) + ' km') + m('Points', track.pts.length.toLocaleString()) + m('Elevation gain', hasEle ? '+' + Math.round(gain) + ' m' : '—') + m('Timestamps', track.pts[0].time ? 'Yes' : 'No');
      lmap = gpxMiniMap(mapEl, lmap, track.pts);
    }
    function toGeoJSON() {
      var coords = track.pts.map(function (p) { return p.ele != null ? [+p.lon, +p.lat, p.ele] : [+p.lon, +p.lat]; });
      return JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: track.name }, geometry: { type: 'LineString', coordinates: coords } }] }, null, 2);
    }
    function toCSV() {
      var rows = ['index,latitude,longitude,elevation_m,time'];
      for (var i = 0; i < track.pts.length; i++) { var p = track.pts[i]; rows.push(i + ',' + p.lat + ',' + p.lon + ',' + (p.ele != null ? p.ele : '') + ',' + (p.time || '')); }
      return rows.join('\n') + '\n';
    }
    function toKML() {
      var c = track.pts.map(function (p) { return p.lon + ',' + p.lat + (p.ele != null ? (',' + p.ele) : ''); }).join(' ');
      return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document><name>' + gpxEsc(track.name) + '</name>\n<Placemark><name>' + gpxEsc(track.name) + '</name>\n<LineString><tessellate>1</tessellate><coordinates>' + c + '</coordinates></LineString>\n</Placemark>\n</Document>\n</kml>\n';
    }
    function toTCX() {
      var t0 = track.pts[0].time ? Date.parse(track.pts[0].time) : Date.parse('2024-01-01T00:00:00Z');
      var tp = '';
      for (var i = 0; i < track.pts.length; i++) {
        var p = track.pts[i];
        var tm = p.time ? p.time : new Date(t0 + i * 1000).toISOString();
        tp += '<Trackpoint><Time>' + gpxEsc(tm) + '</Time><Position><LatitudeDegrees>' + p.lat + '</LatitudeDegrees><LongitudeDegrees>' + p.lon + '</LongitudeDegrees></Position>' + (p.ele != null ? ('<AltitudeMeters>' + p.ele + '</AltitudeMeters>') : '') + '</Trackpoint>\n';
      }
      var startT = track.pts[0].time ? track.pts[0].time : new Date(t0).toISOString();
      return '<?xml version="1.0" encoding="UTF-8"?>\n<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">\n<Activities><Activity Sport="Other"><Id>' + gpxEsc(startT) + '</Id><Lap StartTime="' + gpxEsc(startT) + '"><Track>\n' + tp + '</Track></Lap></Activity></Activities>\n</TrainingCenterDatabase>\n';
    }
    var FMT = { geojson: { ext: 'geojson', mime: 'application/geo+json', fn: toGeoJSON }, csv: { ext: 'csv', mime: 'text/csv', fn: toCSV }, kml: { ext: 'kml', mime: 'application/vnd.google-earth.kml+xml', fn: toKML }, tcx: { ext: 'tcx', mime: 'application/vnd.garmin.tcx+xml', fn: toTCX } };
    fmtWrap.addEventListener('click', function (e) {
      var el = e.target; while (el && el !== fmtWrap && !(el.getAttribute && el.getAttribute('data-fmt'))) el = el.parentNode;
      if (!el || el === fmtWrap || !track) return;
      var key = el.getAttribute('data-fmt'), f = FMT[key]; if (!f) return;
      var fn = gpxSlug(track.name) + '.' + f.ext;
      saveFile(fn, f.mime, f.fn());
      doneEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>Downloaded ' + fn + '</span>';
      doneEl.classList.remove('is-hidden');
    });
    function reset() { track = null; if (lmap) { lmap.remove(); lmap = null; } results.classList.add('is-hidden'); drop.classList.remove('is-hidden'); errorBox.classList.add('is-hidden'); doneEl.classList.add('is-hidden'); }
    if (resetBtn) resetBtn.addEventListener('click', reset);
    fileInput.addEventListener('change', function () { handle(fileInput.files[0]); fileInput.value = ''; });
    gpxDropWire(drop, function (files) { handle(files[0]); });
  })();

  // ========================================================
  // GPX CLEANER  (#gpx-cleaner)
  //   Simplify (Ramer-Douglas-Peucker), drop pauses, smooth
  //   elevation -> a smaller, cleaner .gpx.
  // ========================================================
  (function gpxCleaner() {
    var root = document.getElementById('gpx-cleaner');
    if (!root) return;
    var drop = root.querySelector('#cl-drop');
    var fileInput = root.querySelector('#cl-file');
    var loadingEl = root.querySelector('#cl-loading');
    var results = root.querySelector('#cl-results');
    var errorBox = root.querySelector('#cl-error');
    var nameEl = root.querySelector('#cl-name');
    var statsEl = root.querySelector('#cl-stats');
    var mapEl = root.querySelector('#cl-map');
    var tol = root.querySelector('#cl-tol');
    var tolVal = root.querySelector('#cl-tolval');
    var pauseChk = root.querySelector('#cl-pause');
    var smoothChk = root.querySelector('#cl-smooth');
    var fnameInput = root.querySelector('#cl-fname');
    var goBtn = root.querySelector('#cl-go');
    var doneEl = root.querySelector('#cl-done');
    var resetBtn = root.querySelector('#cl-reset');
    var track = null, cleaned = null, lmap = null, hl = null, origBytes = 0;

    function err(m) { errorBox.textContent = m; errorBox.classList.remove('is-hidden'); results.classList.add('is-hidden'); loadingEl.classList.add('is-hidden'); drop.classList.remove('is-hidden'); }
    function handle(file) {
      if (!file) return;
      if (!/\.gpx$/i.test(file.name)) { err('Please choose a .gpx file.'); return; }
      errorBox.classList.add('is-hidden'); drop.classList.add('is-hidden'); doneEl.classList.add('is-hidden'); loadingEl.classList.remove('is-hidden');
      var r = new FileReader();
      r.onload = function () { var t = gpxParse(String(r.result), file.name); loadingEl.classList.add('is-hidden'); if (!t) { err('Could not read a valid track from that file.'); return; } track = t; origBytes = gpxSerialize(t.name, t.pts).length; load(); };
      r.onerror = function () { err('Could not read that file.'); };
      r.readAsText(file);
    }
    function rdp(pts, eps) {
      if (pts.length < 3 || eps <= 0) return pts.slice();
      var toR = Math.PI / 180, lat0 = pts[0].lat * toR;
      var mLat = 111320, mLon = 111320 * Math.cos(lat0);
      function X(p) { return p.lon * mLon; }
      function Y(p) { return p.lat * mLat; }
      var keep = new Array(pts.length); keep[0] = keep[pts.length - 1] = true;
      var stack = [[0, pts.length - 1]];
      while (stack.length) {
        var seg = stack.pop(), s = seg[0], e = seg[1];
        var ax = X(pts[s]), ay = Y(pts[s]), bx = X(pts[e]), by = Y(pts[e]);
        var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, maxD = -1, idx = -1;
        for (var i = s + 1; i < e; i++) {
          var px = X(pts[i]), py = Y(pts[i]), d;
          if (len2 === 0) { var ex = px - ax, ey = py - ay; d = Math.sqrt(ex * ex + ey * ey); }
          else { var t = ((px - ax) * dx + (py - ay) * dy) / len2; if (t < 0) t = 0; else if (t > 1) t = 1; var cx = ax + t * dx, cy = ay + t * dy, gx = px - cx, gy = py - cy; d = Math.sqrt(gx * gx + gy * gy); }
          if (d > maxD) { maxD = d; idx = i; }
        }
        if (maxD > eps && idx > -1) { keep[idx] = true; stack.push([s, idx]); stack.push([idx, e]); }
      }
      var out = []; for (var k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k]);
      return out;
    }
    function process() {
      if (!track) return;
      var pts = track.pts.slice();
      if (pauseChk.checked) {
        var f = [pts[0]];
        for (var i = 1; i < pts.length; i++) { if (gpxHaversine(f[f.length - 1], pts[i]) >= 1.0) f.push(pts[i]); }
        if (f.length >= 2) pts = f;
      }
      var eps = parseFloat(tol.value) || 0;
      if (eps > 0 && pts.length > 2) pts = rdp(pts, eps);
      if (smoothChk.checked) {
        pts = pts.map(function (p) { return { lat: p.lat, lon: p.lon, ele: p.ele, time: p.time }; });
        var es = pts.map(function (p) { return p.ele; });
        for (var j = 0; j < pts.length; j++) {
          if (es[j] == null) continue;
          var vals = [es[Math.max(0, j - 1)], es[j], es[Math.min(es.length - 1, j + 1)]].filter(function (v) { return v != null; });
          if (vals.length) pts[j].ele = Math.round((vals.reduce(function (x, y) { return x + y; }, 0) / vals.length) * 10) / 10;
        }
      }
      cleaned = pts;
      renderStats(); updateHl();
    }
    function renderStats() {
      var bytes = gpxSerialize(track.name, cleaned).length;
      var saved = origBytes > 0 ? Math.max(0, Math.round((1 - bytes / origBytes) * 100)) : 0;
      function m(k, v) { return '<div class="metric"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
      statsEl.innerHTML =
        m('Points', track.pts.length.toLocaleString() + ' &rarr; ' + cleaned.length.toLocaleString()) +
        m('New file size', (bytes / 1024).toFixed(0) + ' KB') +
        m('Reduction', saved + '% smaller');
    }
    function load() {
      results.classList.remove('is-hidden');
      nameEl.textContent = track.name;
      if (fnameInput) fnameInput.value = gpxSlug(track.name) + '-clean';
      if (lmap) { lmap.remove(); lmap = null; }
      var step = Math.max(1, Math.ceil(track.pts.length / 2000)), ll = [];
      for (var i = 0; i < track.pts.length; i += step) ll.push([track.pts[i].lat, track.pts[i].lon]);
      lmap = L.map(mapEl, { scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(lmap);
      var base = L.polyline(ll, { color: '#CBD5E1', weight: 3, opacity: 0.9 }).addTo(lmap);
      hl = L.layerGroup().addTo(lmap);
      lmap.fitBounds(base.getBounds(), { padding: [26, 26] });
      setTimeout(function () { if (lmap) lmap.invalidateSize(); }, 80);
      process();
    }
    function updateHl() {
      if (!hl) return;
      hl.clearLayers();
      var step = Math.max(1, Math.ceil(cleaned.length / 2000)), ll = [];
      for (var i = 0; i < cleaned.length; i += step) ll.push([cleaned[i].lat, cleaned[i].lon]);
      ll.push([cleaned[cleaned.length - 1].lat, cleaned[cleaned.length - 1].lon]);
      L.polyline(ll, { color: '#2F6BFF', weight: 4, opacity: 0.95 }).addTo(hl);
    }
    function syncTolLabel() { if (tolVal) tolVal.textContent = (parseFloat(tol.value) || 0) + ' m'; }
    function download() {
      if (!cleaned) return;
      var nm = (fnameInput && fnameInput.value ? fnameInput.value : gpxSlug(track.name) + '-clean').replace(/\.gpx$/i, '');
      saveFile(nm + '.gpx', 'application/gpx+xml', gpxSerialize(nm, cleaned));
      doneEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>Downloaded ' + nm + '.gpx — ' + cleaned.length.toLocaleString() + ' points</span>';
      doneEl.classList.remove('is-hidden');
    }
    function reset() { track = null; cleaned = null; if (lmap) { lmap.remove(); lmap = null; hl = null; } results.classList.add('is-hidden'); drop.classList.remove('is-hidden'); errorBox.classList.add('is-hidden'); doneEl.classList.add('is-hidden'); }
    tol.addEventListener('input', function () { syncTolLabel(); doneEl.classList.add('is-hidden'); process(); });
    pauseChk.addEventListener('change', function () { doneEl.classList.add('is-hidden'); process(); });
    smoothChk.addEventListener('change', function () { doneEl.classList.add('is-hidden'); process(); });
    if (goBtn) goBtn.addEventListener('click', download);
    if (resetBtn) resetBtn.addEventListener('click', reset);
    fileInput.addEventListener('change', function () { handle(fileInput.files[0]); fileInput.value = ''; });
    gpxDropWire(drop, function (files) { handle(files[0]); });
    syncTolLabel();
  })();

  // ========================================================
  // RACE TIME PREDICTOR  (#race-predictor)
  //   Riegel: T2 = T1 * (D2/D1)^k   (k default 1.06)
  // ========================================================
  (function racePredictor() {
    var root = document.getElementById('race-predictor');
    if (!root) return;
    var distInput = root.querySelector('#rp-distance');
    var bodyEl = root.querySelector('#rp-splits');
    var big = root.querySelector('#rp-big');
    var bigUnit = root.querySelector('#rp-big-unit');
    var grid = root.querySelector('#rp-grid');
    var empty = root.querySelector('#rp-empty');
    var results = root.querySelector('#rp-results');
    var kInput = root.querySelector('#rp-k');
    var DISTS = [
      { n: '1 mile', km: 1.609344 }, { n: '5K', km: 5 }, { n: '10K', km: 10 },
      { n: '15K', km: 15 }, { n: '10 miles', km: 16.09344 }, { n: 'Half marathon', km: 21.0975 },
      { n: '30K', km: 30 }, { n: 'Marathon', km: 42.195 }, { n: '50K', km: 50 }
    ];
    root.querySelectorAll('[data-preset-km]').forEach(function (b) {
      b.addEventListener('click', function () {
        var km = parseFloat(b.getAttribute('data-preset-km'));
        var unit = segValue(root, 'rp-unit') || 'km';
        distInput.value = unit === 'mi' ? +(km / KM_PER_MILE).toFixed(2) : km;
        compute();
      });
    });
    function compute() {
      var unit = segValue(root, 'rp-unit') || 'km';
      var dist = num(distInput);
      var t = num(root.querySelector('#rp-h')) * 3600 + num(root.querySelector('#rp-m')) * 60 + num(root.querySelector('#rp-s'));
      var k = parseFloat(kInput && kInput.value); if (!(k > 0)) k = 1.06;
      var d1 = unit === 'mi' ? dist * KM_PER_MILE : dist;
      if (d1 <= 0 || t <= 0) { results.classList.add('is-hidden'); empty.classList.remove('is-hidden'); return; }
      empty.classList.add('is-hidden'); results.classList.remove('is-hidden');
      function predict(d2) { return t * Math.pow(d2 / d1, k); }
      var rows = '';
      DISTS.forEach(function (D) {
        var pt = predict(D.km), near = Math.abs(D.km - d1) < 0.05;
        rows += '<tr' + (near ? ' style="background:rgba(47,107,255,.07)"' : '') + '><td>' + D.n + (near ? ' <span class="muted" style="font-size:.82em">· your input</span>' : '') + '</td><td class="num">' + fmtDuration(pt) + '</td><td class="num">' + fmtPace(pt / D.km) + ' /km</td></tr>';
      });
      bodyEl.innerHTML = rows;
      big.textContent = fmtDuration(predict(42.195));
      bigUnit.textContent = 'predicted marathon';
      grid.innerHTML = resultCell('5K', fmtDuration(predict(5))) + resultCell('10K', fmtDuration(predict(10))) + resultCell('Half', fmtDuration(predict(21.0975))) + resultCell('Marathon', fmtDuration(predict(42.195)));
    }
    wireSegmented(root, compute);
    root.querySelectorAll('input').forEach(function (i) { i.addEventListener('input', compute); });
    var form = root.querySelector('form');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); compute(); });
    compute();
  })();

})();
