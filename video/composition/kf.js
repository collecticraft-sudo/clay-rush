/* KF: a tiny keyframe helper on top of the Web Animations API (WAAPI).
 * Why: HyperFrames seeks every document animation (document.getAnimations()) to the render time, so plain
 * element.animate() with finite duration, fill "both" and a delay works with no library and no network.
 * Times are in seconds. KF.scene(T0) returns a helper whose times are LOCAL to a scene that starts at T0 on the
 * composition clock (WAAPI time is the document time, so the helper adds T0 for you).
 *
 * track(el, keys, opts): keys = [{t, x, y, s, sx, sy, r, o, css:{clipPath:"...", filter:"..."}, ease}]
 *   - t   local seconds. The ease on a key is the easing of the segment that STARTS at that key.
 *   - x, y px translate; r deg rotate; s uniform scale (or sx/sy); o opacity; css: any other CSS property (camelCase).
 *   - every property is carried forward from the previous key, so you only list what changes.
 *   - before the first key and after the last key the state is held (fill both).
 */
(function () {
  var E = {
    out: "cubic-bezier(0.16,1,0.3,1)",
    out2: "cubic-bezier(0.22,1,0.36,1)",
    inout: "cubic-bezier(0.65,0,0.35,1)",
    in: "cubic-bezier(0.55,0,1,0.45)",
    back: "cubic-bezier(0.34,1.56,0.64,1)",
    soft: "cubic-bezier(0.37,0,0.63,1)",
    lin: "linear"
  };
  var TF = ["x", "y", "r", "s", "sx", "sy"];

  function el$(root, q) {
    if (q && q.nodeType === 1) return q;
    var r = (root || document).querySelector(q);
    if (!r) throw new Error("KF: element not found: " + q);
    return r;
  }

  function track(T0, el, keys, opts) {
    opts = opts || {};
    var defEase = opts.ease || E.out2;
    var useXY = false, useS2 = false, useR = false, useS = false, cssProps = {}, hasO = false;
    keys.forEach(function (k) {
      if (k.x !== undefined || k.y !== undefined) useXY = true;
      if (k.r !== undefined) useR = true;
      if (k.s !== undefined) useS = true;
      if (k.sx !== undefined || k.sy !== undefined) useS2 = true;
      if (k.o !== undefined) hasO = true;
      if (k.css) Object.keys(k.css).forEach(function (p) { cssProps[p] = true; });
    });
    var cur = { x: 0, y: 0, r: 0, s: 1, sx: 1, sy: 1, o: undefined, css: {} };
    // first defined values backwards: find first defined value for css props / opacity
    var first = {};
    keys.forEach(function (k) {
      if (k.o !== undefined && first.o === undefined) first.o = k.o;
      if (k.css) Object.keys(k.css).forEach(function (p) { if (first[p] === undefined) first[p] = k.css[p]; });
    });
    if (hasO) cur.o = first.o;
    Object.keys(cssProps).forEach(function (p) { cur.css[p] = first[p]; });

    var t0 = keys[0].t, tN = keys[keys.length - 1].t;
    var dur = Math.max(1, Math.round((tN - t0) * 1000));
    var frames = keys.map(function (k, i) {
      TF.forEach(function (p) { if (k[p] !== undefined) cur[p] = k[p]; });
      if (k.s !== undefined) { cur.sx = k.s; cur.sy = k.s; }
      if (k.o !== undefined) cur.o = k.o;
      if (k.css) Object.keys(k.css).forEach(function (p) { cur.css[p] = k.css[p]; });
      var f = {};
      var tf = [];
      if (useXY) tf.push("translate3d(" + cur.x + "px," + cur.y + "px,0)");
      if (useR) tf.push("rotate(" + cur.r + "deg)");
      if (useS2 || useS) tf.push("scale(" + (useS2 ? cur.sx + "," + cur.sy : cur.s) + ")");
      if (tf.length) f.transform = tf.join(" ");
      if (hasO) f.opacity = cur.o;
      Object.keys(cur.css).forEach(function (p) { f[p] = cur.css[p]; });
      f.offset = tN === t0 ? (i === 0 ? 0 : 1) : (k.t - t0) / (tN - t0);
      f.easing = k.ease || defEase;
      return f;
    });
    if (frames.length === 1) frames.push(Object.assign({}, frames[0], { offset: 1 }));
    frames[frames.length - 1].easing = "linear";
    // guard: two animations (fill both) on the same property of one element fight each other; fail loudly instead of rendering wrong
    var seen = el.__kfProps || (el.__kfProps = {});
    Object.keys(frames[0]).forEach(function (p) {
      if (p === "offset" || p === "easing") return;
      if (seen[p]) console.error("KF: property '" + p + "' of #" + (el.id || el.className) + " is animated by two tracks; merge them into one track");
      seen[p] = true;
    });
    var a = el.animate(frames, {
      duration: dur,
      delay: Math.round((T0 + t0) * 1000),
      fill: "both",
      easing: "linear",
      iterations: 1
    });
    a.pause();
    return a;
  }

  function scene(T0, root) {
    return {
      T0: T0,
      $: function (q) { return el$(root, q); },
      $$: function (q) { return Array.prototype.slice.call((root || document).querySelectorAll(q)); },
      track: function (q, keys, opts) { return track(T0, el$(root, q), keys, opts); },
      // shorthand: one tween from state a to state b
      tween: function (q, t, d, a, b, ease) {
        var k0 = Object.assign({ t: t }, a), k1 = Object.assign({ t: t + d }, b);
        if (ease) k0.ease = ease;
        return track(T0, el$(root, q), [k0, k1]);
      },
      // staggered tween over several elements
      stagger: function (list, t, each, d, a, b, ease) {
        var self = this;
        return list.map(function (el, i) {
          var k0 = Object.assign({ t: t + i * each }, a), k1 = Object.assign({ t: t + i * each + d }, b);
          if (ease) k0.ease = ease;
          return track(T0, el, [k0, k1]);
        });
      }
    };
  }

  // split an element's text into word spans (each word in an overflow-hidden mask when mask=true)
  function words(el, mask) {
    var txt = el.textContent.trim().split(/\s+/);
    el.textContent = "";
    return txt.map(function (w, i) {
      var outer = document.createElement("span");
      outer.className = "kfw";
      outer.style.display = "inline-block";
      if (mask) { outer.style.overflow = "hidden"; outer.style.verticalAlign = "top"; outer.style.paddingBottom = "0.12em"; }
      var inner = document.createElement("span");
      inner.className = "kfwi";
      inner.style.display = "inline-block";
      inner.textContent = w;
      outer.appendChild(inner);
      el.appendChild(outer);
      if (i < txt.length - 1) el.appendChild(document.createTextNode(" "));
      return inner;
    });
  }

  // odometer: builds digit reels inside el for the string `text` (digits spin, other chars stay);
  // returns [{reel, digit}] so the caller can animate each reel with translateY.
  function odometer(el, text, lineH) {
    el.textContent = "";
    var out = [];
    text.split("").forEach(function (ch) {
      var cell = document.createElement("span");
      cell.className = "odo-cell";
      cell.style.cssText = "display:inline-block;overflow:hidden;height:" + lineH + "px;line-height:" + lineH + "px;vertical-align:top;text-align:center;" + (ch === "," ? "margin-left:0.02em;" : "");
      if (/[0-9]/.test(ch)) {
        var reel = document.createElement("span");
        reel.className = "odo-reel";
        reel.style.cssText = "display:block;will-change:transform;text-align:center;font-variant-numeric:tabular-nums;";
        var s = "";
        for (var r = 0; r < 3; r++) for (var d = 0; d < 10; d++) s += "<span style='display:block;height:" + lineH + "px;line-height:" + lineH + "px'>" + d + "</span>";
        reel.innerHTML = s;
        cell.appendChild(reel);
        out.push({ reel: reel, digit: +ch, cell: cell });
      } else {
        cell.textContent = ch;
      }
      el.appendChild(cell);
    });
    return out;
  }

  window.KF = { E: E, scene: scene, words: words, odometer: odometer, track: function (T0, q, keys, opts) { return track(T0, el$(null, q), keys, opts); } };
})();
