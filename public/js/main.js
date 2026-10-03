// Clay Rush entry point. OWNER: integrator.
// Boot only: everything else is in app.js so that it can be exercised in Node (test/app). The wiring is documented there.

import { createApp } from './app.js';

const canvas = document.getElementById('stage');

function showFatal(message) {
  // Only used when the game cannot start at all (no 2D canvas, broken module). English, like every player-visible text.
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:#1B1F24;color:#FFF4DC;font:600 24px system-ui,sans-serif;text-align:center;white-space:pre-wrap';
  box.textContent = `Could not start Clay Rush.\n${message}`;
  document.body.append(box);
}

try {
  const app = createApp({ window, document, canvas });
  app.start();
} catch (err) {
  console.error('[clay-rush] boot failed', err);
  showFatal(err && err.message ? err.message : String(err));
}
