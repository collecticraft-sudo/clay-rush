// Screen drawing dispatch. OWNER: UI engineer.
import * as best from './best.js';
import * as boot from './boot.js';
import * as calibration from './calibration.js';
import * as connect from './connect.js';
import * as countdown from './countdown.js';
import * as menu from './menu.js';
import * as pause from './pause.js';
import * as results from './results.js';
import * as safety from './safety.js';
import * as settings from './settings.js';
import * as setup from './setup.js';
import * as tuning from './tuning.js';
import { drawConfirm, drawDisconnect } from './overlays.js';

/** screen id (contracts SCREEN) -> drawer. 'playing' has no drawer of its own (the HUD and the resume countdown). */
export const SCREEN_DRAWERS = Object.freeze({ boot, safety, connect, calibration, menu, setup, settings, best, tuning, countdown, paused: pause, results });

export { drawConfirm, drawDisconnect };
export const drawResumeCountdown = pause.drawResumeCountdown;
