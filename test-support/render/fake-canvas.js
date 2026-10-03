// Fake canvas, 2D context and window for the Presentation tests (Node has none). OWNER: Presentation engineer.
// The context records every drawing call, tracks the current font, and records ASSIGNMENTS to the forbidden properties
// (shadowBlur, filter) so that tests can assert they are never used (docs/architecture.md 12).

const METHODS = [
  'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'rect', 'quadraticCurveTo', 'bezierCurveTo',
  'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'drawImage', 'translate', 'rotate', 'scale',
  'setTransform', 'transform', 'setLineDash', 'resetTransform',
];

function fontSize(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font ?? '');
  return m ? Number(m[1]) : 10;
}

export class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = [];
    this.counts = Object.create(null);
    this.forbidden = []; // [name, value] of every shadowBlur / filter assignment
    this.texts = []; // {text, font, size, op}
    this.recording = true;
    this.stack = [];
    this._font = '10px sans-serif';
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.miterLimit = 10;
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = 'low';
    for (const name of METHODS) {
      this[name] = (...args) => {
        this.counts[name] = (this.counts[name] ?? 0) + 1;
        if (this.recording) this.calls.push([name, ...args]);
        if (name === 'save') this.stack.push({ font: this._font, alpha: this.globalAlpha, op: this.globalCompositeOperation });
        if (name === 'restore') {
          const s = this.stack.pop();
          if (s) { this._font = s.font; this.globalAlpha = s.alpha; this.globalCompositeOperation = s.op; }
        }
        if (name === 'fillText' || name === 'strokeText') this.texts.push({ text: args[0], font: this._font, size: fontSize(this._font), op: name, depth: this.stack.length, index: this.calls.length - 1 });
        if (name === 'drawImage' && args[0] && args[0].isFakeCanvas) args[0].drawnCount++;
      };
    }
  }

  get font() { return this._font; }
  set font(v) { this._font = v; }
  set shadowBlur(v) { this.forbidden.push(['shadowBlur', v]); }
  get shadowBlur() { return 0; }
  set filter(v) { this.forbidden.push(['filter', v]); }
  get filter() { return 'none'; }

  measureText(text) {
    return { width: String(text).length * fontSize(this._font) * 0.52 };
  }

  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
  createPattern() { return {}; }
  getLineDash() { return []; }

  reset() {
    this.calls.length = 0;
    this.counts = Object.create(null);
    this.texts.length = 0;
  }

  /** Names of the recorded calls in order (optionally filtered). */
  names(filter) {
    const out = this.calls.map((c) => c[0]);
    return filter ? out.filter(filter) : out;
  }
}

export class FakeCanvas {
  constructor(width = 300, height = 150, registry = null) {
    this.width = width;
    this.height = height;
    this.isFakeCanvas = true;
    this.drawnCount = 0;
    this.style = {};
    this.listeners = new Map();
    this.ctx = new FakeContext(this);
    this.cssWidth = 1920;
    this.cssHeight = 1080;
    if (registry) registry.push(this);
  }

  getContext(kind) {
    return kind === '2d' ? this.ctx : null;
  }

  get clientWidth() { return this.cssWidth; }
  get clientHeight() { return this.cssHeight; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.cssWidth, height: this.cssHeight }; }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    if (fn === undefined) this.listeners.delete(type);
    else list.splice(list.indexOf(fn), 1);
  }

  dispatch(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

/** A factory of offscreen canvases that remembers what it created. */
export function createFakeCanvasFactory() {
  const created = [];
  return { created, createCanvas: (w, h) => new FakeCanvas(w, h, created) };
}

export class FakeWindow {
  constructor({ dpr = 1, width = 1920, height = 1080, bluetooth = true } = {}) {
    this.devicePixelRatio = dpr;
    this.innerWidth = width;
    this.innerHeight = height;
    this.navigator = bluetooth ? { bluetooth: {} } : {};
    this.listeners = new Map();
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list && fn) list.splice(list.indexOf(fn), 1);
  }

  dispatch(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }

  matchMedia() {
    return { matches: false };
  }
}
