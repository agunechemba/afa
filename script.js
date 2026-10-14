(function () {
  'use strict';

  /* ============================================================
     1. ENTROPY
     ------------------------------------------------------------
     The outcome is drawn from the operating system's CSPRNG
     (crypto.getRandomValues) — the same source used for keys and
     salts. It is not seeded by time, not derived from the clock,
     and not influenced by anything the user does.

     Rejection sampling is used so that every face has EXACTLY
     probability 1/2 — no modulo bias, no "almost fair".
     ============================================================ */

  var cryptoApi = window.crypto || window.msCrypto;
  var hasCrypto = !!(cryptoApi && typeof cryptoApi.getRandomValues === 'function');

  var UINT32_RANGE = 0x100000000;          // 2^32
  var buf32 = new Uint32Array(1);

  function uint32() {
    if (hasCrypto) {
      cryptoApi.getRandomValues(buf32);
      return buf32[0];
    }
    // Fallback for ancient engines only. Modern browsers never reach this.
    return (Math.random() * UINT32_RANGE) >>> 0;
  }

  /**
   * Uniform integer in [0, n) with zero modulo bias.
   * Values at or above the largest multiple of n are rejected and redrawn.
   */
  function randomBelow(n) {
    var limit = UINT32_RANGE - (UINT32_RANGE % n);
    var x;
    do { x = uint32(); } while (x >= limit);
    return x % n;
  }

  function randomBit() { return randomBelow(2); }   // 0 or 1, fair

  /* ============================================================
     2. TIMERS  (so a reset can cancel a flip in flight)
     ============================================================ */

  var pendingTimers = [];

  function later(fn, ms) {
    var id = window.setTimeout(fn, ms);
    pendingTimers.push(id);
    return id;
  }

  function clearTimers() {
    for (var i = 0; i < pendingTimers.length; i++) {
      window.clearTimeout(pendingTimers[i]);
    }
    pendingTimers.length = 0;
  }

  /* ============================================================
     3. ELEMENTS + CONSTANTS
     ============================================================ */

  var disc      = document.getElementById('disc');
  var lift      = document.getElementById('lift');
  var coinArea  = document.getElementById('coinArea');
  var verdictEl = document.getElementById('verdict');
  var hintEl    = document.getElementById('hint');
  var resetBtn  = document.getElementById('reset');

  var reduceMotion = window.matchMedia &&
                     window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Flip duration is no longer a fixed constant — it is drawn fresh
     at the top of every toss. These are the *bounds*, in ms.
     The CSS declares `var(--flip-dur, 1.7s)` as a safety net so the
     first paint is correct before JS runs. */
  var FLIP_MIN_MS = reduceMotion ? 260 : 900;
  var FLIP_MAX_MS = reduceMotion ? 420 : 2400;

  /* Idle: one slow revolution every ~8s, with a breathing tempo so the
     motion never reads as mechanical. Pure rotateY — the coin is
     genuinely undecided, showing first one face, then the other,
     turning over its vertical axis like a coin on a table. */
  var IDLE_BASE_DPS = reduceMotion ? 18 : 46;   // degrees per second
  var IDLE_SWAY     = reduceMotion ? 0.18 : 0.45;

  /* ============================================================
     4. IDLE MOTION  (rAF-driven, so the flip can take over exactly)
     ============================================================ */

  var idle = {
    active: false,
    angle: 0,      // current rotateY, degrees in [0, 360)
    t: 0,          // time accumulator for tempo modulation
    last: 0,       // last frame timestamp
    raf: null
  };

  function idleFrame(ts) {
    if (!idle.active) return;

    if (!idle.last) idle.last = ts;
    var dt = (ts - idle.last) / 1000;
    idle.last = ts;
    if (dt > 0.05) dt = 0.05;          // tab was hidden — don't jump
    idle.t += dt;

    // tempo breathes between ~55% and ~145% of base speed
    var speed = IDLE_BASE_DPS * (1 + IDLE_SWAY * Math.sin(idle.t * 0.7));

    idle.angle += speed * dt;
    if (idle.angle >= 360) idle.angle %= 360;

    disc.style.transform = 'rotateY(' + idle.angle.toFixed(3) + 'deg)';

    // a faint teeter, so the coin reads as "not yet settled"
    var sway = Math.sin(idle.t * 0.9) * 2.2;
    lift.style.transform = 'rotateZ(' + sway.toFixed(3) + 'deg)';

    idle.raf = requestAnimationFrame(idleFrame);
  }

  function startIdle(fromAngle) {
    stopIdle();

    idle.active = true;
    idle.angle = ((fromAngle % 360) + 360) % 360;
    idle.t = 0;
    idle.last = 0;

    // The idle loop writes transforms every frame — transitions must be off,
    // and the handoff must be committed before the first frame moves.
    disc.style.transition = 'none';
    void disc.offsetWidth;
    disc.style.transform = 'rotateY(' + idle.angle.toFixed(3) + 'deg)';

    coinArea.classList.add('is-idle');
    idle.raf = requestAnimationFrame(idleFrame);
  }

  function stopIdle() {
    if (idle.raf !== null) {
      cancelAnimationFrame(idle.raf);
      idle.raf = null;
    }
    idle.active = false;
    idle.last = 0;
  }

  /* ============================================================
     5. READING THE COIN'S CURRENT ANGLE
     ------------------------------------------------------------
     Only needed when a reset interrupts a flip in flight, so we can
     resume the idle motion from wherever the coin actually is
     instead of teleporting it.

     rotateY(θ) is read from the computed matrix. In the 3D form
     (matrix3d) the relevant column-major slots are:
       index 0 =  cos θ
       index 2 = -sin θ
     so θ = atan2(-m20, m00). In the 2D fallback (matrix) the
     horizontal scale collapses to cos θ.
     ============================================================ */

  function currentVisualAngle() {
    var t = window.getComputedStyle(disc).transform;
    if (!t || t === 'none') return 0;

    var m3 = t.match(/matrix3d\(([^)]+)\)/);
    if (m3) {
      var v = m3[1].split(',').map(parseFloat);
      return Math.atan2(-v[2], v[0]) * 180 / Math.PI;
    }

    var m2 = t.match(/matrix\(([^)]+)\)/);
    if (m2) {
      var w = m2[1].split(',').map(parseFloat);
      // rotateY collapses to matrix(cos θ, 0, 0, 1, 0, 0)
      return w[0] < 0 ? 180 : 0;
    }
    return 0;
  }

  /* ============================================================
     6. THE FLIP
     ============================================================ */

  var busy = false;

  function flip() {
    if (busy) return;
    busy = true;

    // Take over from the idle loop. `from` is exactly where it left off.
    var from = idle.active ? idle.angle : currentVisualAngle();
    stopIdle();

    clearTimers();
    coinArea.classList.remove('is-idle');
    lift.style.transform = '';

    /* -- The decision is made HERE, before any pixel moves. ------- */
    var bit = randomBit();                 // 1 = yes, 0 = no — exactly 50/50
    /* ------------------------------------------------------------- */

    /* -- How long this particular toss will run, and how many
          revolutions it will make. -----------------------------------
       A real coin toss is not metronomic — hand-flicked coins vary
       in both air-time and spin rate from toss to toss. We draw a
       fresh duration from the CSPRNG every flip, then tie the spin
       count to it so long tosses don't look like they're crawling
       and short tosses don't whirl frantically.

       The duration is published as `--flip-dur` on .coin-area so
       the CSS transition (on .disc) and the lift / ground-pulse
       keyframe animations all finish at exactly the same instant
       our timers fire.                                        */

    var flipDur = FLIP_MIN_MS +
                  randomBelow(FLIP_MAX_MS - FLIP_MIN_MS + 1);

    // Roughly one revolution per ~330 ms of air-time (non-reduced).
    // Reduced motion gets a single deliberate turn.
    var spins = reduceMotion
      ? 1
      : Math.max(3, Math.round(flipDur / 330));

    coinArea.style.setProperty('--flip-dur', flipDur + 'ms');
    /* ------------------------------------------------------------- */

    // rotateY(θ) shows face "1" when cos θ > 0, face "0" when cos θ < 0.
    // (The .face--zero rule is mirrored over Y in CSS to match.)
    var targetMod = (bit === 1) ? 0 : 180;
    var current   = ((from % 360) + 360) % 360;
    var align     = ((targetMod - current) % 360 + 360) % 360;
    var target    = from + spins * 360 + align;

    // Hand control from rAF back to the CSS transition, without a jump:
    // freeze at the exact current angle with transitions off, commit that,
    // then restore the transition and move.
    disc.style.transition = 'none';
    disc.style.transform  = 'rotateY(' + from.toFixed(3) + 'deg)';
    void disc.offsetWidth;
    disc.style.transition = '';
    disc.style.transform  = 'rotateY(' + target.toFixed(3) + 'deg)';

    // restart the lift animation cleanly
    coinArea.classList.remove('is-flipping');
    void coinArea.offsetWidth;
    coinArea.classList.add('is-flipping');

    // reset the readout
    hintEl.classList.add('hide');
    verdictEl.classList.remove('show');
    verdictEl.textContent = '';

    later(function () {
      verdictEl.textContent = bit === 1 ? 'Yes' : 'No';
      verdictEl.classList.add('show');
      if (navigator.vibrate) navigator.vibrate(8);
    }, flipDur * 0.92);

    later(function () {
      coinArea.classList.remove('is-flipping');
      busy = false;
    }, flipDur);
  }

  /* ============================================================
     7. RESET — start afresh
     ============================================================ */

  var resetTimer = null;

  function reset() {
    clearTimers();
    busy = false;
    coinArea.classList.remove('is-flipping');
    lift.style.transform = '';

    // Where is the coin right now?
    var from = idle.active ? idle.angle : currentVisualAngle();

    // Clear the verdict and bring the invitation back.
    verdictEl.classList.remove('show');
    verdictEl.textContent = '';
    hintEl.classList.remove('hide');

    // Return to the undecided state.
    startIdle(from);

    // A small turning gesture on the icon itself.
    resetBtn.classList.remove('is-resetting');
    void resetBtn.offsetWidth;
    resetBtn.classList.add('is-resetting');

    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(function () {
      resetBtn.classList.remove('is-resetting');
    }, 700);

    if (navigator.vibrate) navigator.vibrate(5);
  }

  /* ============================================================
     8. INPUT
     ============================================================ */

  // Tap / click anywhere (but not on the corner controls).
  document.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return;   // left / touch only
    if (e.target.closest && e.target.closest('.reset')) return;
    flip();
  }, { passive: true });

  // Keyboard.
  document.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    if (e.target.closest && e.target.closest('.reset')) return;

    if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flip();
    }
  });

  // Reset.
  resetBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    reset();
  });

  /* ============================================================
     9. BUILD THE RIM — thin slats around the coin's edge
     ============================================================ */

  (function buildRim() {
    var rim = document.getElementById('rim');
    if (!rim) return;

    var N = 36;                                   // matches --slat-count
    var step = 360 / N;
    var frag = document.createDocumentFragment();

    for (var i = 0; i < N; i++) {
      var slat = document.createElement('span');
      slat.className = 'rim__slat';
      slat.style.setProperty('--a', (i * step) + 'deg');
      frag.appendChild(slat);
    }

    rim.appendChild(frag);
  })();

  /* ============================================================
     10. BEGIN — the coin starts undecided
     ============================================================ */

  startIdle(0);

})();