// The Presentation facade: the single object app.js talks to (docs/architecture.md 8.1). OWNER: UI engineer.
//
// createPresentation({canvas, clock, storage?, audio?, document?, window?, matchMedia?, createCanvas?, hasBluetooth?, config?, assets?, bestHelpers?})
//   -> { ui, step(input), draw(), resize(), getPerf(), setArtLoading(on), audio, storage, dispose(), debug }
//
// This file only wires the real renderers into presentation-core.js: render/world.js (createWorldRenderer), render/hud.js (createHud) and
// audio/audio.js (createAudio). They are imported as namespaces so that a missing export degrades to the core's fallbacks (a plain sky, no
// HUD, silent audio) instead of breaking the module graph. Tests use presentation-core.js with fakes (test-support/ui/fakes.js).

import * as worldModule from '../render/world.js';
import * as hudModule from '../render/hud.js';
import * as audioModule from '../audio/audio.js';
import { createPresentationCore } from './presentation-core.js';

/** @param {object} deps see presentation-core.js */
export function createPresentation(deps) {
  return createPresentationCore(deps, {
    createWorldRenderer: deps.createWorldRenderer ?? worldModule.createWorldRenderer,
    createHud: deps.createHud ?? hudModule.createHud,
    createAudio: audioModule.createAudio,
  });
}
