// Generic effect machinery: a particle pool (struct of typed arrays, allocated once), a fixed object pool, and the auto-degrade governor.
// OWNER: Render & Audio engineer. Pure (no canvas): the world renderer owns the drawing.
//
// Every pool has a hard capacity; a full pool recycles its OLDEST member, so no effect can grow without bound and nothing is allocated
// after construction (the 600-frame busy-scene test checks the sizes stay put).

/**
 * Particle pool, struct of arrays. Positions in logical px, velocities px/s, life in seconds; `kind`, `color` and `flag` are small integers
 * the renderer interprets.
 */
export class ParticlePool {
  /** @param {number} capacity @param {number} [kinds] */
  constructor(capacity, kinds = 16) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity); // remaining seconds
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.grav = new Float32Array(capacity); // gravity multiplier (0 = none)
    this.drag = new Float32Array(capacity); // velocity damping per second
    this.kind = new Uint8Array(capacity);
    this.color = new Uint8Array(capacity);
    this.flag = new Uint8Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.seq = new Uint32Array(capacity);
    this.count = 0;
    this.nextSeq = 1;
    this._free = new Int32Array(capacity);
    this._freeTop = 0;
    for (let i = capacity - 1; i >= 0; i--) this._free[this._freeTop++] = i;
    this.dropped = 0;
    this.kindCount = new Uint16Array(kinds);
  }

  /** Spawn one particle; when the pool is full the oldest one is replaced. Returns the slot. */
  spawn(kind, x, y, vx, vy, life, size, color = 0, grav = 0, drag = 0, rot = 0, spin = 0, flag = 0) {
    let i;
    if (this._freeTop > 0) {
      i = this._free[--this._freeTop];
      this.count++;
    } else {
      i = this._oldest();
      this.dropped++;
      this.kindCount[this.kind[i]]--;
    }
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
    this.rot[i] = rot; this.spin[i] = spin; this.grav[i] = grav; this.drag[i] = drag;
    this.kind[i] = kind; this.color[i] = color; this.flag[i] = flag; this.alive[i] = 1;
    this.seq[i] = this.nextSeq++;
    this.kindCount[kind]++;
    return i;
  }

  _oldest() {
    let best = 0;
    let bestSeq = 0xffffffff;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] && this.seq[i] < bestSeq) {
        bestSeq = this.seq[i];
        best = i;
      }
    }
    return best;
  }

  kill(i) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.count--;
    this.kindCount[this.kind[i]]--;
    this._free[this._freeTop++] = i;
  }

  /** Advance every particle by dt seconds under gravity g (px/s^2). Kills particles below `floorY`. No allocation. */
  update(dt, g, floorY = Infinity) {
    if (!(dt > 0)) return;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const l = this.life[i] - dt;
      if (l <= 0) {
        this.kill(i);
        continue;
      }
      this.life[i] = l;
      const d = this.drag[i];
      if (d > 0) {
        const k = d * dt >= 1 ? 0 : 1 - d * dt;
        this.vx[i] *= k;
        this.vy[i] *= k;
      }
      this.vy[i] += g * this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.rot[i] += this.spin[i] * dt;
      if (this.y[i] > floorY) this.kill(i);
    }
  }

  clear() {
    this.alive.fill(0);
    this.count = 0;
    this.kindCount.fill(0);
    this._freeTop = 0;
    for (let i = this.capacity - 1; i >= 0; i--) this._free[this._freeTop++] = i;
  }
}

/**
 * A fixed pool of plain objects made once by `make()`. `take()` returns a free one (or recycles the one with the smallest `born`), marked
 * alive; the caller fills it. `forEach` visits the live ones. Objects must have `alive` and `born` fields.
 */
export class ObjectPool {
  constructor(capacity, make) {
    this.items = [];
    for (let i = 0; i < capacity; i++) {
      const o = make(i);
      o.alive = false;
      o.born = 0;
      this.items.push(o);
    }
    this.clock = 0;
    this.dropped = 0;
  }

  take() {
    let pick = null;
    let oldest = null;
    for (let i = 0; i < this.items.length; i++) {
      const o = this.items[i];
      if (!o.alive) {
        pick = o;
        break;
      }
      if (!oldest || o.born < oldest.born) oldest = o;
    }
    if (!pick) {
      pick = oldest;
      this.dropped++;
    }
    pick.alive = true;
    pick.born = ++this.clock;
    return pick;
  }

  get live() {
    let n = 0;
    for (let i = 0; i < this.items.length; i++) if (this.items[i].alive) n++;
    return n;
  }

  get capacity() {
    return this.items.length;
  }

  clear() {
    for (let i = 0; i < this.items.length; i++) this.items[i].alive = false;
  }
}

/**
 * Auto-degrade governor: average frame time over a window; above the threshold the degrade level goes up by one (1 = halve particle counts,
 * 2 = fewer layers of effects, 3 = backing scale 1.0); after `recoverWindows` good windows it goes down again, with a flap guard.
 */
export function createPerfGovernor({ thresholdMs = 20, windowS = 2, maxLevel = 3, recoverMs = 17.5, recoverWindows = 3, flapWindowS = 30, maxFlaps = 2 } = {}) {
  let sumMs = 0;
  let frames = 0;
  let elapsed = 0;
  let level = 0;
  let avg = null;
  let goodWindows = 0;
  let clockS = 0;
  let lastRecoveryS = -Infinity;
  let flaps = 0;
  return {
    /** @param {number} dtS real frame delta in seconds. @returns {number|null} the new level when it just changed. */
    sample(dtS) {
      if (!(dtS > 0)) return null;
      sumMs += dtS * 1000;
      frames++;
      elapsed += dtS;
      clockS += dtS;
      if (elapsed < windowS) return null;
      avg = sumMs / frames;
      sumMs = 0;
      frames = 0;
      elapsed = 0;
      if (avg > thresholdMs) {
        goodWindows = 0;
        if (level < maxLevel) {
          if (clockS - lastRecoveryS <= flapWindowS) flaps++;
          level++;
          return level;
        }
        return null;
      }
      if (avg <= recoverMs && level > 0 && flaps < maxFlaps) {
        goodWindows++;
        if (goodWindows >= recoverWindows) {
          goodWindows = 0;
          level--;
          lastRecoveryS = clockS;
          return level;
        }
      } else {
        goodWindows = 0;
      }
      return null;
    },
    get level() { return level; },
    get avgFrameMs() { return avg; },
    get fps() { return avg ? 1000 / avg : null; },
    get flaps() { return flaps; },
    reset() { sumMs = 0; frames = 0; elapsed = 0; level = 0; avg = null; goodWindows = 0; clockS = 0; lastRecoveryS = -Infinity; flaps = 0; },
  };
}
