// Fake AudioContext for the audio tests: records nodes, connections and AudioParam automation. OWNER: Presentation engineer.
// It models the Web Audio API surface used by audio.js, not a real device (UNVERIFIED-ON-HARDWARE: real output is not tested).

export class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.calls = [];
  }

  setValueAtTime(v, t) { this.calls.push(['set', v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.calls.push(['linear', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); return this; }
  setTargetAtTime(v, t, tc) { this.calls.push(['target', v, t, tc]); this.value = v; return this; }
  cancelScheduledValues(t) { this.calls.push(['cancel', t]); return this; }
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outputs = [];
    this.disconnected = false;
    ctx.nodes.push(this);
  }

  connect(to) { this.outputs.push(to); return to; }
  disconnect() { this.disconnected = true; this.outputs = []; }
}

class FakeGain extends FakeNode {
  constructor(ctx) { super(ctx, 'gain'); this.gain = new FakeParam(1); }
}

class FakeOscillator extends FakeNode {
  constructor(ctx) {
    super(ctx, 'osc');
    this.type = 'sine';
    this.frequency = new FakeParam(440);
    this.detune = new FakeParam(0);
    this.startedAt = null;
    this.stoppedAt = null;
  }

  start(t = 0) { this.startedAt = t; }
  stop(t = 0) { this.stoppedAt = t; }
}

class FakeBufferSource extends FakeNode {
  constructor(ctx) {
    super(ctx, 'noise');
    this.buffer = null;
    this.loop = false;
    this.startedAt = null;
    this.startOffset = null;
    this.stoppedAt = null;
  }

  start(t = 0, offset = 0) { this.startedAt = t; this.startOffset = offset; }
  stop(t = 0) { this.stoppedAt = t; }
}

class FakeBiquad extends FakeNode {
  constructor(ctx) {
    super(ctx, 'filter');
    this.type = 'lowpass';
    this.frequency = new FakeParam(350);
    this.Q = new FakeParam(1);
  }
}

class FakeCompressor extends FakeNode {
  constructor(ctx) {
    super(ctx, 'compressor');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) this[k] = new FakeParam(0);
  }
}

class FakeConvolver extends FakeNode {
  constructor(ctx) { super(ctx, 'convolver'); this.buffer = null; this.normalize = true; }
}

class FakeWaveShaper extends FakeNode {
  constructor(ctx) { super(ctx, 'waveshaper'); this.curve = null; this.oversample = 'none'; }
}

class FakePanner extends FakeNode {
  constructor(ctx) { super(ctx, 'panner'); this.pan = new FakeParam(0); }
}

export class FakeAudioContext {
  constructor({ state = 'running', sampleRate = 8000 } = {}) {
    this.currentTime = 0;
    this.state = state;
    this.sampleRate = sampleRate;
    this.nodes = [];
    this.destination = new FakeNode(this, 'destination');
    this.resumeCalls = 0;
    this.suspendCalls = 0;
    this.closed = false;
  }

  createGain() { return new FakeGain(this); }
  createOscillator() { return new FakeOscillator(this); }
  createBufferSource() { return new FakeBufferSource(this); }
  createBiquadFilter() { return new FakeBiquad(this); }
  createDynamicsCompressor() { return new FakeCompressor(this); }
  createStereoPanner() { return new FakePanner(this); }
  createConvolver() { return new FakeConvolver(this); }
  createWaveShaper() { return new FakeWaveShaper(this); }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return { numberOfChannels: channels, length, sampleRate: rate, getChannelData: () => data };
  }

  resume() { this.resumeCalls++; this.state = 'running'; return Promise.resolve(); }
  suspend() { this.suspendCalls++; this.state = 'suspended'; return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }

  /** Nodes of a kind that have been started (for voice counting). */
  started(kind) { return this.nodes.filter((n) => n.kind === kind && n.startedAt !== null); }
}
