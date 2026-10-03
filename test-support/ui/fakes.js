// Fakes for the UI tests: a recording 2D context and canvas, a stub world renderer, HUD and audio engine. OWNER: UI engineer.
// They implement exactly the APIs of docs/architecture.md 6.1, 6.2 and 6.4 that presentation-core.js calls, and record every call.

/** A 2D context that records the text it draws and counts the other calls. measureText: 0.5 em per character. */
export class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.font = '10px sans-serif';
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.globalAlpha = 1;
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.miterLimit = 10;
    this.letterSpacing = '0px';
    this.imageSmoothingEnabled = true;
    this.texts = [];
    this.calls = new Map();
    this.transform = [1, 0, 0, 1, 0, 0];
    this.stack = [];
  }
  count(name) { this.calls.set(name, (this.calls.get(name) ?? 0) + 1); }
  measureText(s) {
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
    const px = m ? Number(m[1]) : 10;
    return { width: String(s).length * px * 0.5, actualBoundingBoxAscent: px * 0.7, actualBoundingBoxDescent: px * 0.2 };
  }
  fillText(s, x, y) {
    this.count('fillText');
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
    this.texts.push({ text: String(s), x, y, font: this.font, size: m ? Number(m[1]) : 0, fill: this.fillStyle, alpha: this.globalAlpha, align: this.textAlign });
  }
  strokeText() { this.count('strokeText'); }
  save() { this.count('save'); this.stack.push({ t: [...this.transform], a: this.globalAlpha, f: this.font }); }
  restore() {
    this.count('restore');
    const s = this.stack.pop();
    if (s) { this.transform = s.t; this.globalAlpha = s.a; this.font = s.f; }
  }
  setTransform(a, b, c, d, e, f) { this.count('setTransform'); this.transform = [a, b, c, d, e, f]; }
  resetTransform() { this.transform = [1, 0, 0, 1, 0, 0]; }
  translate() { this.count('translate'); }
  rotate() { this.count('rotate'); }
  scale() { this.count('scale'); }
  createLinearGradient() { this.count('createLinearGradient'); return { addColorStop() {} }; }
  createRadialGradient() { this.count('createRadialGradient'); return { addColorStop() {} }; }
  setLineDash() {}
  drawImage() { this.count('drawImage'); }
  clearTexts() { this.texts.length = 0; this.calls.clear(); }
}
for (const name of ['fillRect', 'strokeRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'rect', 'fill', 'stroke', 'clip']) {
  FakeContext.prototype[name] = function fakeCall() { this.count(name); };
}

export class FakeCanvas {
  constructor(w = 1920, h = 1080) {
    this.width = w;
    this.height = h;
    this.style = {};
    this.ctx = new FakeContext(this);
    this.listeners = new Map();
  }
  getContext() { return this.ctx; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1920, height: 1080 }; }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  dispatch(type, e) { for (const fn of this.listeners.get(type) ?? []) fn(e); }
}

export const createFakeCanvas = (w, h) => new FakeCanvas(w, h);

/** A world renderer that records its calls (docs/architecture.md 6.1). */
export function createFakeWorld() {
  const calls = { setStage: [], reset: 0, handleEvents: [], update: [], draw: [] };
  return {
    calls,
    setStage(id) { calls.setStage.push(id); },
    reset() { calls.reset++; },
    handleEvents(events, nowMs) { calls.handleEvents.push({ events: [...events], nowMs }); },
    update(dtS, view) { calls.update.push({ dtS, view: JSON.parse(JSON.stringify(view)) }); },
    draw(ctx, view) { calls.draw.push({ idle: view.idle, showGun: view.showGun, showCrosshair: view.showCrosshair, stageId: view.stageId }); ctx.fillRect(0, 0, 1920, 1080); },
    getDebug: () => ({ particles: 0, stage: calls.setStage.at(-1) ?? null, layers: { far: false, near: false }, shake: 0, zoom: 1 }),
  };
}

/** A HUD that records its calls (docs/architecture.md 6.2) and resolves a few HUD string keys through hv.t, as the real one will. */
export function createFakeHud() {
  const calls = { reset: 0, handleEvents: [], update: [], draw: [] };
  return {
    calls,
    reset() { calls.reset++; },
    handleEvents(events) { calls.handleEvents.push([...events]); },
    update(dtS) { calls.update.push(dtS); },
    draw(ctx, snapshot, hv) {
      calls.draw.push({
        phase: snapshot.phase, labels: hv.labels, battery: hv.battery, reduceMotion: hv.reduceMotion, t: hv.t,
        stage: hv.t('hud.stage', { n: (snapshot.stage?.index ?? 0) + 1, name: snapshot.stage?.name ?? '' }),
        prompt: hv.t('hud.pullPrompt', { fire: hv.labels.fire }),
      });
      hv.t('hud.score');
    },
  };
}

/** The audio engine API used by the presentation (6.4), recording plays and game events. */
export function createFakeAudio() {
  const rec = { played: [], stopped: [], events: [], updates: [], volume: null, unlocked: 0 };
  return {
    rec,
    muted: false,
    play(id, params) { rec.played.push([id, params]); },
    stop(id) { rec.stopped.push(id); },
    setVolume(v) { rec.volume = v; },
    setMuted(m) { this.muted = !!m; },
    unlock() { rec.unlocked++; },
    suspend() {},
    resume() {},
    update(dtS, c) { rec.updates.push({ screen: c.screen, stageId: c.stageId }); },
    handleGameEvent(ev) { rec.events.push(ev.type); },
    dispose() {},
  };
}
