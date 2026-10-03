// A recording 2D context, offscreen canvases and a stage rig, for the stage tests only. OWNER: Render & Audio engineer.
//
// The context tracks the current transform matrix and globalAlpha, so a test can read where each layer actually lands (in the frame of
// the base canvas, after the renderer's shake and zoom of the game layer) and with which alpha. It counts save/restore to prove they stay
// balanced even when a draw call throws. It records ASSIGNMENTS to the forbidden properties shadowBlur and filter (architecture 12).

import { ART_CONFIG } from '../../public/js/render/art-config.js';
import { createStage } from '../../public/js/render/stage.js';
import { createStageStubAssets } from './stub-assets.js';

/** A fresh, mutable copy of the shipped config (tests may tune it). */
export function baseStageConfig() {
  return JSON.parse(JSON.stringify(ART_CONFIG));
}

export class RecordingContext {
  constructor(canvas = null) {
    this.canvas = canvas;
    this.ops = [];
    this.stack = [];
    this.m = [1, 0, 0, 1, 0, 0];
    this.globalAlpha = 1;
    this.fillStyle = '#000';
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = 'low';
    this.forbidden = [];
    this.saves = 0;
    this.restores = 0;
    this.underflows = 0;
    this.gradients = 0;
    this.throwOnDrawImage = null; // (img) => boolean
  }

  set shadowBlur(v) { this.forbidden.push(['shadowBlur', v]); }
  set filter(v) { this.forbidden.push(['filter', v]); }

  /** Forget the recorded operations (not the state stack). */
  reset() { this.ops.length = 0; }

  get depth() { return this.stack.length; }

  save() {
    this.saves++;
    this.stack.push({ m: this.m.slice(), alpha: this.globalAlpha, fill: this.fillStyle, op: this.globalCompositeOperation, smooth: this.imageSmoothingEnabled });
  }

  restore() {
    this.restores++;
    const s = this.stack.pop();
    if (!s) { this.underflows++; return; }
    this.m = s.m; this.globalAlpha = s.alpha; this.fillStyle = s.fill; this.globalCompositeOperation = s.op; this.imageSmoothingEnabled = s.smooth;
  }

  translate(x, y) {
    const m = this.m;
    m[4] += m[0] * x + m[2] * y;
    m[5] += m[1] * x + m[3] * y;
    this.ops.push({ op: 'translate', args: [x, y] });
  }

  scale(sx, sy) {
    const m = this.m;
    m[0] *= sx; m[1] *= sx; m[2] *= sy; m[3] *= sy;
    this.ops.push({ op: 'scale', args: [sx, sy] });
  }

  transform(a, b, c, d, e, f) {
    const m = this.m;
    const n = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
    this.m = n;
    this.ops.push({ op: 'transform', args: [a, b, c, d, e, f] });
  }

  setTransform(a, b, c, d, e, f) {
    this.m = [a, b, c, d, e, f];
    this.ops.push({ op: 'setTransform', args: [a, b, c, d, e, f] });
  }

  drawImage(img, ...args) {
    if (this.throwOnDrawImage && this.throwOnDrawImage(img)) throw new Error('InvalidStateError: the image is broken');
    this.ops.push({ op: 'drawImage', img, args, alpha: this.globalAlpha, m: this.m.slice(), smoothing: this.imageSmoothingQuality });
  }

  fillRect(x, y, w, h) {
    this.ops.push({ op: 'fillRect', args: [x, y, w, h], alpha: this.globalAlpha, fill: this.fillStyle, m: this.m.slice() });
  }

  clearRect(x, y, w, h) {
    this.ops.push({ op: 'clearRect', args: [x, y, w, h] });
  }

  // clip paths (the erase rectangles of ART_CONFIG.stage.erase): recorded as ops 'clip' with the rectangles of the path, in the current frame
  beginPath() { this.path = []; }

  rect(x, y, w, h) {
    if (!this.path) this.path = [];
    this.path.push([x, y, w, h]);
  }

  clip(rule) {
    this.ops.push({ op: 'clip', rule, rects: (this.path ?? []).map((r) => r.slice()), m: this.m.slice() });
  }

  createLinearGradient() {
    this.gradients++;
    return { addColorStop() {} };
  }

  createRadialGradient() {
    this.gradients++;
    return { addColorStop() {} };
  }

  // path building and stroking (the procedural painters): counted, not recorded
  moveTo() { this.pathOps = (this.pathOps ?? 0) + 1; }
  lineTo() { this.pathOps = (this.pathOps ?? 0) + 1; }
  arc() { this.pathOps = (this.pathOps ?? 0) + 1; }
  arcTo() { this.pathOps = (this.pathOps ?? 0) + 1; }
  ellipse() { this.pathOps = (this.pathOps ?? 0) + 1; }
  quadraticCurveTo() { this.pathOps = (this.pathOps ?? 0) + 1; }
  bezierCurveTo() { this.pathOps = (this.pathOps ?? 0) + 1; }
  closePath() {}
  fill() { this.ops.push({ op: 'fill', alpha: this.globalAlpha }); }
  stroke() { this.ops.push({ op: 'stroke', alpha: this.globalAlpha }); }
  rotate() {}
  setLineDash() {}
  fillText() {}
  strokeText() {}
  measureText(t) { return { width: String(t).length * 10 }; }

  images() { return this.ops.filter((o) => o.op === 'drawImage'); }
  fills() { return this.ops.filter((o) => o.op === 'fillRect'); }
}

/** Destination rectangle of a recorded drawImage or fillRect, mapped through the transform that was current when it was drawn. */
export function screenRect(o) {
  const a = o.op === 'drawImage' ? o.args.slice(-4) : o.args;
  const [x, y, w, h] = a;
  const m = o.m;
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5], w: m[0] * w, h: m[3] * h, scale: m[0] };
}

class RecordingCanvas {
  constructor(width, height, factory) {
    this.width = width;
    this.height = height;
    this.isRecordingCanvas = true;
    this.factory = factory;
    this.ctx = new RecordingContext(this);
  }

  getContext(kind) {
    return kind === '2d' && !this.factory.noContext ? this.ctx : null;
  }
}

/** An offscreen canvas factory that remembers what it created. `throwAfter`: creating canvas number N + 1 throws (out of memory). */
export function createCanvasFactory({ throwAfter = Infinity, noContext = false } = {}) {
  const factory = {
    created: [],
    noContext,
    createCanvas(w, h) {
      if (factory.created.length >= throwAfter) throw new Error('out of memory');
      const c = new RecordingCanvas(w, h, factory);
      factory.created.push(c);
      return c;
    },
  };
  return factory;
}

/**
 * A stage wired to a stub assets object and a recording context, driven the way the world renderer drives it: setStage, then the far pass
 * and the near pass with the parallax offsets of the view.
 */
export function makeStageRig(o = {}) {
  const config = o.config ?? baseStageConfig();
  const assets = o.assetsObject ?? createStageStubAssets({ config, ...(o.assets ?? {}) });
  const factory = createCanvasFactory(o.canvas ?? {});
  const stage = createStage({ assets, createCanvas: o.noCanvas ? undefined : factory.createCanvas, config });
  const ctx = new RecordingContext();
  const view = { nowMs: 0, farX: 0, farY: 0, nearX: 0, nearY: 0, reduceMotion: false };

  /** One frame: `over` overrides view fields, `stage` calls setStage first. Returns what each pass drew. */
  function frame(over = {}) {
    const { stage: id, ...rest } = over;
    Object.assign(view, rest);
    if (id !== undefined) stage.setStage(id);
    ctx.reset();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    const drewFar = stage.draw(ctx, 'far', view);
    const farOps = ctx.images().slice();
    ctx.reset();
    const drewNear = stage.draw(ctx, 'near', view);
    const nearOps = ctx.images().slice();
    return { drewFar, drewNear, far: farOps, near: nearOps };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { assets, factory, stage, ctx, view, frame, flush };
}
