/* =========================================================
   Guaruna — global UI behaviour
   (loaded on every page; tool logic lives in tools.js)
   ========================================================= */
(function () {
  'use strict';

  // ------------------------------------------------------
  // Header — subtle border once the user scrolls
  // ------------------------------------------------------
  var header = document.getElementById('site-header');
  if (header) {
    var onScroll = function () {
      if (window.scrollY > 4) header.classList.add('is-scrolled');
      else header.classList.remove('is-scrolled');
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ------------------------------------------------------
  // Mobile nav toggle
  // ------------------------------------------------------
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.primary-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ------------------------------------------------------
  // Email obfuscation — reassembled at runtime
  // ------------------------------------------------------
  document.querySelectorAll('[data-u][data-d]').forEach(function (cta) {
    var wire = function () {
      var u = cta.getAttribute('data-u'), d = cta.getAttribute('data-d');
      if (!u || !d) return;
      var subject = cta.getAttribute('data-subject') || 'Hello Guaruna';
      cta.setAttribute('href', 'mailto:' + u + '@' + d + '?subject=' + encodeURIComponent(subject));
    };
    cta.addEventListener('pointerenter', wire, { once: true });
    cta.addEventListener('focus', wire, { once: true });
    cta.addEventListener('click', function () { if (cta.getAttribute('href') === '#') wire(); });
  });

  // ------------------------------------------------------
  // Year in footer
  // ------------------------------------------------------
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  // No analytics, no cookies, no trackers. Everything runs locally.
})();
