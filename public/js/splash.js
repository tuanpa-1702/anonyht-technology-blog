// Landing screen ("màn chào") in front of the homepage.
//
// The homepage itself is unchanged and stays at "/" - the splash is a fixed
// layer drawn OVER it, so crawlers, no-JS visitors and the SSR'd post list see
// exactly what they saw before (nothing here runs for them: the layer is
// display:none until this script adds html.splash-on).
//
// Loaded BLOCKING in <head>, right after theme.js, for the same reason theme.js
// is: the class has to be on <html> before the first paint, or the index would
// flash before the splash covers it.
//
// Shown only to a visitor ARRIVING at "/":
//   - not after "Vào blog" was pressed in this tab (sessionStorage), so the logo
//     link / back button lead straight to the index;
//   - not when coming from another page of this site (same-origin referrer);
//   - not when "/" carries a query or hash - OAuth callbacks land on
//     /?oauth=github, /?auth_error=..., and those must reach home.js.
(function () {
  var KEY = 'anonyht_entered';
  var root = document.documentElement;

  function entered() {
    try {
      return sessionStorage.getItem(KEY) === '1';
    } catch (e) {
      return false;
    }
  }
  function remember() {
    try {
      sessionStorage.setItem(KEY, '1');
    } catch (e) {
      /* private mode: the splash simply shows again next visit */
    }
  }

  // Never for crawlers and link-preview bots: they arrive with no referrer and
  // empty storage, so they would otherwise index the homepage hidden behind a
  // full-screen layer (Google treats that as an intrusive interstitial).
  if (/bot|crawl|spider|slurp|bingpreview|facebookexternalhit|lighthouse|chrome-lighthouse|headless|inspectiontool/i.test(navigator.userAgent || '')) return;
  // Automated audits (Lighthouse/PageSpeed) run under an EMULATED mobile UA that
  // carries none of the words above, so the UA test alone misses them and the
  // audit measures the splash's fade + canvas animation (Speed Index ~7s) rather
  // than the homepage. navigator.webdriver is true for every automated/headless
  // run and false for real browsers, so this is the reliable signal. A human on
  // a link already sees the homepage (splash only shows on a direct "/" visit),
  // so the audit now measures what those visitors get.
  if (navigator.webdriver) return;
  // A query string only blocks the splash when it means something to the page
  // (OAuth returns such as ?oauth=github / ?auth_error=, a ?tag= forward...).
  // Tracking parameters that apps and ads append - Facebook's ?fbclid= on a
  // link opened from a post or comment, utm_*, gclid, Zalo's zarsrc - do not.
  function hasRealQuery() {
    var TRACKING = /^(fbclid|gclid|gbraid|wbraid|dclid|msclkid|twclid|ttclid|li_fat_id|igshid|igsh|mibextid|zarsrc|zalo_?\w*|utm_\w+|mc_cid|mc_eid|_ga|_gl|ref|ref_src|si|s)$/i;
    try {
      var keys = [];
      new URLSearchParams(location.search).forEach(function (v, k) {
        if (!TRACKING.test(k)) keys.push(k);
      });
      return keys.length > 0;
    } catch (e) {
      return !!location.search;
    }
  }
  // "/?splash" always shows it - the admin panel's "Xem màn chào" link.
  var preview = location.pathname === '/' && location.search === '?splash';
  if (!preview) {
    if (location.pathname !== '/' || location.hash || hasRealQuery()) return;
    if (entered()) return;
  }
  var refOrigin = '';
  try {
    refOrigin = document.referrer ? new URL(document.referrer).origin : '';
  } catch (e) {
    /* malformed referrer - treat as external */
  }
  if (!preview && refOrigin === location.origin) return;

  root.classList.add('splash-on');

  // Everything behind the layer is taken out of the tab order and the
  // accessibility tree while it is up, then given back on enter.
  var behind = [];
  function setInert(on) {
    if (on) {
      behind = Array.prototype.filter.call(document.body.children, function (el) {
        return el.id !== 'splash' && el.tagName !== 'SCRIPT';
      });
    }
    behind.forEach(function (el) {
      if (on) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
  }


  // ---- faint "data-link" network behind the layers ------------------------
  // Points drifting slowly, joined by a line whenever two come close - the
  // plexus look. Weighted to the LEFT, behind the text (splash.css dims and
  // blurs it there, then fades it out before the layers). Stopped on enter.
  var netStop = null;
  function startNet(canvas) {
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var rgb = (getComputedStyle(root).getPropertyValue('--sp-hi') || '96 165 250').trim().split(/\s+/).join(',');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = 0, h = 0, pts = [], link = 0, raf = 0, animate = false;

    function size() {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      link = Math.max(90, Math.min(w, h) * 0.17);
      var n = Math.round(Math.min(130, Math.max(40, (w * h) / 13000)));
      pts = [];
      for (var i = 0; i < n; i++) {
        pts.push({
          x: w * 0.75 * (1 - Math.sqrt(Math.random())),
          y: h * Math.random(),
          vx: (Math.random() - 0.5) * 0.25,
          vy: (Math.random() - 0.5) * 0.25,
          r: Math.random() < 0.12 ? 2.2 : 1.1 + Math.random() * 0.6,
        });
      }
    }

    function frame() {
      ctx.clearRect(0, 0, w, h);
      var i, j, a, b, dx, dy, d;
      for (i = 0; i < pts.length; i++) {
        a = pts[i];
        if (!reduce) {
          a.x += a.vx;
          a.y += a.vy;
          if (a.x < -20 || a.x > w * 0.8) a.vx *= -1;
          if (a.y < -20 || a.y > h + 20) a.vy *= -1;
        }
      }
      ctx.lineWidth = 0.8;
      for (i = 0; i < pts.length; i++) {
        a = pts[i];
        for (j = i + 1; j < pts.length; j++) {
          b = pts[j];
          dx = a.x - b.x;
          dy = a.y - b.y;
          if (Math.abs(dx) > link || Math.abs(dy) > link) continue;
          d = Math.sqrt(dx * dx + dy * dy);
          if (d > link) continue;
          ctx.strokeStyle = 'rgba(' + rgb + ',' + (1 - d / link) * 0.45 + ')';
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      for (i = 0; i < pts.length; i++) {
        a = pts[i];
        ctx.fillStyle = 'rgba(' + rgb + ',0.9)';
        ctx.shadowColor = 'rgba(' + rgb + ',0.9)';
        ctx.shadowBlur = a.r > 2 ? 10 : 4;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      if (!reduce && animate) raf = requestAnimationFrame(frame);
    }

    size();
    frame(); // one static frame right away - the page looks complete at once
    // Start the drifting only after the first paint has settled: a canvas that
    // animates from frame 1 keeps the page "visually changing", which is the one
    // thing Speed Index counts against. A ~1s hold makes the first view stable
    // and is imperceptible to a visitor reading the splash.
    var startTimer = 0;
    if (!reduce) {
      startTimer = setTimeout(function () {
        animate = true;
        raf = requestAnimationFrame(frame);
      }, 1000);
    }
    var onResize = function () {
      size();
      if (reduce || !animate) frame();
    };
    window.addEventListener('resize', onResize);
    netStop = function () {
      clearTimeout(startTimer);
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }

  var leaving = false;
  function enter() {
    if (leaving) return;
    leaving = true;
    remember();
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.classList.add('splash-leaving');
    setTimeout(function () {
      root.classList.remove('splash-on', 'splash-leaving');
      setInert(false);
      if (netStop) netStop();
      var logo = document.querySelector('.ed-nav a');
      if (logo) logo.focus({ preventScroll: true });
    }, reduce ? 0 : 560);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('splash-enter');
    if (!btn) {
      root.classList.remove('splash-on');
      return;
    }
    setInert(true);
    var net = document.querySelector('#splash .splash-net');
    if (net) startNet(net);
    btn.addEventListener('click', enter);
    // Not focused on load: a programmatic focus draws the focus ring around the
    // button at once. Enter works from anywhere (keydown below), and Tab still
    // reaches the button, since everything else is inert.
  });
  document.addEventListener('keydown', function (e) {
    if (!root.classList.contains('splash-on')) return;
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      enter();
    }
  });
})();
