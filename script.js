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

  function randomFloat() { return uint32() / UINT32_RANGE; }   // [0, 1)
  function randomBit()   { return randomBelow(2); }            // 0 or 1, fair

  /* ============================================================
     2. AUDIO  (fully synthesised — no files to load)
     ============================================================ */

  var ctx = null;
  var master = null;
  var muted = false;
  var noiseBuffer = null;

  function audio() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    master.connect(ctx.destination);
    return ctx;
  }

  function resumeAudio() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function getNoise(c) {
    if (noiseBuffer && noiseBuffer.sampleRate === c.sampleRate) return noiseBuffer;

    var len = Math.floor(c.sampleRate * 0.6);
    var buffer = c.createBuffer(1, len, c.sampleRate);
    var data = buffer.getChannelData(0);
    var raw = new Uint32Array(len);

    if (hasCrypto) {
      cryptoApi.getRandomValues(raw);
    } else {
      for (var j = 0; j < len; j++) raw[j] = (Math.random() * UINT32_RANGE) >>> 0;
    }

    for (var i = 0; i < len; i++) {
      data[i] = raw[i] / 2147483648 - 1;   // [0, 2^32) → [-1, 1)
    }

    noiseBuffer = buffer;
    return buffer;
  }

  /** Air moving past the coin. */
  function playWhoosh() {
    var c = audio();
    if (!c) return;
    resumeAudio();

    var t = c.currentTime;

    var src = c.createBufferSource();
    src.buffer = getNoise(c);

    var bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 0.16);
    bp.frequency.exponentialRampToValueAtTime(820, t + 0.5);

    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.13, t + 0.07);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);

    src.connect(bp);
    bp.connect(g);
    g.connect(master);

    src.start(t, 0, 0.55);
    src.stop(t + 0.56);
  }

  /** The strike: inharmonic partials = metal. */
  function playClink() {
    var c = audio();
    if (!c) return;
    resumeAudio();

    var t = c.currentTime;

    var out = c.createGain();
    out.gain.value = 1;
    out.connect(master);

    var partials = [
      [2093, 0.40, 1.50],
      [3136, 0.26, 1.10],
      [4699, 0.15, 0.80],
      [6320, 0.09, 0.55],
      [8420, 0.05, 0.35]
    ];

    for (var i = 0; i < partials.length; i++) {
      var f = partials[i][0], amp = partials[i][1], dur = partials[i][2];

      var osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f * (1 + (randomFloat() - 0.5) * 0.006); // micro-detune

      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + dur + 0.03);
    }

    // metallic attack transient
    var n = c.createBufferSource();
    n.buffer = getNoise(c);

    var hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;

    var ng = c.createGain();
    ng.gain.setValueAtTime(0.085, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);

    n.connect(hp);
    hp.connect(ng);
    ng.connect(out);
    n.start(t, 0, 0.09);
    n.stop(t + 0.1);
  }

  /* ============================================================
     3. TIMERS  (so a reset can cancel a flip in flight)
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
     4. ELEMENTS + CONSTANTS
     ============================================================ */

  var disc      = document.getElementById('disc');
  var lift      = document.getElementById('lift');
  var coinArea  = document.getElementById('coinArea');
  var verdictEl = document.getElementById('verdict');
  var hintEl    = document.getElementById('hint');
  var soundBtn  = document.getElementById('sound');
  var resetBtn  = document.getElementById('reset');

  var reduceMotion = window.matchMedia &&
                     window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var FLIP_MS = reduceMotion ? 340 : 1700;

  /* Idle: one slow revolution every ~8s, with a breathing tempo so the
     motion never reads as mechanical. Pure rotateX — the coin is
     genuinely undecided, showing first one face, then the other. */
  var IDLE_BASE_DPS = reduceMotion ? 18 : 46;   // degrees per second
  var IDLE_SWAY     = reduceMotion ? 0.18 : 0.45;

  /* ============================================================
     5. IDLE MOTION  (rAF-driven, so the flip can take over exactly)
     ============================================================ */

  var idle = {
    active: false,
    angle: 0,      // current rotateX, degrees in [0, 360)
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

    disc.style.transform = 'rotateX(' + idle.angle.toFixed(3) + 'deg)';

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
    disc.style.transform = 'rotateX(' + idle.angle.toFixed(3) + 'deg)';

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
     6. READING THE COIN'S CURRENT ANGLE
     ------------------------------------------------------------
     Only needed when a reset interrupts a flip in flight, so we can
     resume the idle motion from wherever the coin actually is
     instead of teleporting it.
     ============================================================ */

  function currentVisualAngle() {
    var t = window.getComputedStyle(disc).transform;
    if (!t || t === 'none') return 0;

    var m3 = t.match(/matrix3d\(([^)]+)\)/);
    if (m3) {
      var v = m3[1].split(',').map(parseFloat);
      // rotateX(θ) → column-major: index 5 = cos θ, index 6 = sin θ
      return Math.atan2(v[6], v[5]) * 180 / Math.PI;
    }

    var m2 = t.match(/matrix\(([^)]+)\)/);
    if (m2) {
      var w = m2[1].split(',').map(parseFloat);
      // rotateX collapses to matrix(1, 0, 0, cos θ, 0, 0)
      return w[3] < 0 ? 180 : 0;
    }
    return 0;
  }

  /* ============================================================
     7. THE FLIP
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

    audio();
    resumeAudio();

    /* -- The decision is made HERE, before any pixel moves. ------- */
    var bit = randomBit();                 // 1 = yes, 0 = no — exactly 50/50
    /* ------------------------------------------------------------- */

    // Cosmetic: how many full turns. Does not affect the outcome.
    var spins = 4 + randomBelow(3);        // 4, 5 or 6

    // rotateX(θ) shows face "1" when cos θ > 0, face "0" when cos θ < 0.
    var targetMod = (bit === 1) ? 0 : 180;
    var current   = ((from % 360) + 360) % 360;
    var align     = ((targetMod - current) % 360 + 360) % 360;
    var target    = from + spins * 360 + align;

    // Hand control from rAF back to the CSS transition, without a jump:
    // freeze at the exact current angle with transitions off, commit that,
    // then restore the transition and move.
    disc.style.transition = 'none';
    disc.style.transform  = 'rotateX(' + from.toFixed(3) + 'deg)';
    void disc.offsetWidth;
    disc.style.transition = '';
    disc.style.transform  = 'rotateX(' + target.toFixed(3) + 'deg)';

    // restart the lift animation cleanly
    coinArea.classList.remove('is-flipping');
    void coinArea.offsetWidth;
    coinArea.classList.add('is-flipping');

    // reset the readout
    hintEl.classList.add('hide');
    verdictEl.classList.remove('show');
    verdictEl.textContent = '';

    playWhoosh();
    later(playClink, FLIP_MS * 0.80);

    later(function () {
      verdictEl.textContent = bit === 1 ? 'Yes' : 'No';
      verdictEl.classList.add('show');
      if (navigator.vibrate) navigator.vibrate(8);
    }, FLIP_MS * 0.92);

    later(function () {
      coinArea.classList.remove('is-flipping');
      busy = false;
    }, FLIP_MS);
  }

  /* ============================================================
     8. RESET — start afresh
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
     9. INPUT
     ============================================================ */

  // Tap / click anywhere (but not on the corner controls).
  document.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return;   // left / touch only
    if (e.target.closest && e.target.closest('.sound, .reset')) return;
    flip();
  }, { passive: true });

  // Keyboard.
  document.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    if (e.target.closest && e.target.closest('.sound, .reset')) return;

    if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flip();
    }
  });

  // Mute toggle.
  soundBtn.addEventListener('click', function (e) {
    e.stopPropagation();

    muted = !muted;
    soundBtn.setAttribute('aria-pressed', String(muted));
    soundBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');

    var c = audio();
    if (!c) return;
    resumeAudio();

    master.gain.setTargetAtTime(muted ? 0 : 0.6, c.currentTime, 0.02);

    if (!muted) playClink();   // quiet confirmation
  });

  // Reset.
  resetBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    reset();
  });

  // Warm up the audio graph on the first gesture so the first flip is instant.
  window.addEventListener('pointerdown', function once() {
    audio();
    resumeAudio();
    window.removeEventListener('pointerdown', once);
  }, { once: true, passive: true });

  /* ============================================================
     10. BEGIN — the coin starts undecided
     ============================================================ */

  startIdle(0);

})();