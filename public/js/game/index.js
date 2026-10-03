// Public entry point of the game module (architecture 5). OWNER: Gameplay engineer.
// app.js, the UI and the debug API import ONLY from here (and the data module config.js).

export { createGame } from './game.js';
export { CONFIG } from './config.js';
export { rankFor } from './ranks.js';
export { STAGES } from './stages.js';
export { emptyBest, sanitizeBest, isNewBest, updateBest, bestKey, accuracyPercent, formatDuration } from './highscore.js';
