// Italian leak detector (test support). The game was Italian until 2026-09-30 (owner decision: the whole game is English); the tests use
// this module to prove that no Italian word and no accented vowel survives in anything a player or the owner can read.
//
// The word list holds common Italian words that are NOT English words (so a plain English sentence never trips it): the vocabulary of the
// former Italian strings plus frequent function words. It is a list of whole words, compared case-insensitively.
// Proper names that must keep an accent (none today) go into ALLOWED_PROPER_NAMES and are removed from the text before the check.

export const ITALIAN_WORDS = new Set([
  'abbastanza', 'abbiamo', 'accendi', 'accesa', 'acceso', 'adesso', 'aggiungi', 'agli', 'alla', 'allo', 'allontana', 'almeno',
  'altre', 'altri', 'altro', 'altrove', 'anche', 'ancora', 'andrà', 'animali', 'annulla', 'aperta', 'aperto', 'appoggiarla',
  'apprendista', 'apre', 'apri', 'aprire', 'aspetta', 'attento', 'attenzione', 'attiva', 'attorno', 'automatico', 'avete',
  'avvicinati', 'azzera', 'batteria', 'benvenuto', 'bomba', 'bombe', 'calibra', 'calibrazione', 'calma', 'cancella',
  'cancellare', 'caricamento', 'casa', 'centra', 'centro', 'cerca', 'cercare', 'cerco', 'chiudere', 'chiudi', 'chiudila',
  'chiudilo', 'chiuso', 'ciao', 'classica', 'clic', 'collega', 'collegamento', 'collegarlo', 'collegato', 'colpire', 'colpite',
  'colpo', 'compilatore', 'completa', 'completata', 'completo', 'connessione', 'connesso', 'consenti', 'consentire', 'continua',
  'controlla', 'corso', 'cosa', 'cose', 'così', 'cui', 'dagli', 'dalla', 'dalle', 'dati', 'dato', 'deciso', 'degli', 'dei',
  'della', 'delle', 'dello', 'dentro', 'destra', 'destro', 'deve', 'devi', 'devono', 'diagnostica', 'direttamente', 'direzione',
  'disponibile', 'dispositivo', 'dolore', 'dopo', 'doppio', 'dove', 'dritta', 'dunque', 'durata', 'effetti', 'elenco', 'errore',
  'errori', 'esci', 'essere', 'evitare', 'fai', 'farti', 'fendente', 'ferma', 'fermati', 'fermi', 'fermo', 'finché', 'finestra',
  'fino', 'fissa', 'fragili', 'fretta', 'frutta', 'frutti', 'frutto', 'funziona', 'fuori', 'furia', 'gelo', 'gioca', 'giocando',
  'giocare', 'giocato', 'giochi', 'gioco', 'giri', 'giusta', 'giusti', 'giusto', 'già', 'giù', 'grado', 'grazie', 'guerriero',
  'hai', 'hanno', 'impedire', 'impostazioni', 'impugnatura', 'impugni', 'indietro', 'infatti', 'installa', 'installare',
  'intero', 'invece', 'invia', 'inviare', 'invio', 'istruzioni', 'laccio', 'lampeggia', 'lampeggiano', 'lampi', 'lascia', 'lato',
  'legge', 'leggenda', 'leggi', 'leggo', 'lentamente', 'letali', 'lettura', 'liberi', 'libero', 'lontano', 'luci', 'luminosi',
  'mai', 'mancata', 'meno', 'mentre', 'metri', 'migliore', 'minuti', 'mirino', 'molte', 'molti', 'molto', 'mosso', 'mostra',
  'movimento', 'muove', 'muoverti', 'muovi', 'nascondi', 'nativo', 'necessario', 'negli', 'nella', 'nelle', 'nello', 'nessuna',
  'nessuno', 'niente', 'nomi', 'normale', 'nuova', 'nuove', 'nuovi', 'nuovo', 'oggetti', 'ogni', 'oltre', 'oppure', 'ormai',
  'orologio', 'parte', 'particelle', 'partita', 'perché', 'perciò', 'permesso', 'persa', 'persone', 'però', 'più', 'pochi',
  'polso', 'ponte', 'posizioni', 'possono', 'potenziamenti', 'precisione', 'prego', 'premere', 'premi', 'premuti', 'premuto',
  'prova', 'provare', 'provo', 'pulsante', 'puoi', 'può', 'qualche', 'qualcosa', 'quali', 'quando', 'quante', 'quanti', 'quanto',
  'quasi', 'quella', 'quelle', 'quelli', 'quello', 'questa', 'queste', 'questi', 'questo', 'quindi', 'rallenta', 'respira',
  'riavvia', 'riavvialo', 'riavviare', 'riavvio', 'ricalibra', 'ricalibrare', 'ricentra', 'ricentrare', 'ricentrato', 'ricentro',
  'ricerca', 'ricollegarlo', 'ricollegato', 'ricominciamo', 'riduci', 'riesci', 'riesco', 'rifiutato', 'rigioca', 'rimuovi',
  'riparte', 'ripartire', 'ripeti', 'ripetuti', 'riposa', 'riposo', 'riprendi', 'riprova', 'riprovare', 'risponde', 'risposta',
  'ritorna', 'riuscita', 'riuscito', 'rotazione', 'ruotalo', 'ruotare', 'ruoti', 'salvata', 'salvato', 'saranno', 'sarà',
  'scaduto', 'scappare', 'scegli', 'sceglierlo', 'scelta', 'scelto', 'scheda', 'schermo', 'scollegalo', 'scollegato',
  'sconosciuto', 'scorre', 'scorrere', 'scorrono', 'scritta', 'scrittura', 'scuoti', 'secondi', 'segno', 'selezione', 'sembra',
  'sempre', 'sensibile', 'sensibilità', 'sensori', 'senti', 'senza', 'servono', 'siamo', 'siete', 'simili', 'simulati',
  'simulatore', 'sincronizzazione', 'sinistra', 'sinistro', 'soffitto', 'soglia', 'sono', 'sopra', 'sotto', 'spada', 'spalla',
  'spazio', 'spegni', 'spenta', 'spento', 'spesso', 'stai', 'stata', 'stati', 'stato', 'stessa', 'stesse', 'stessi', 'stesso',
  'strumenti', 'subito', 'sugli', 'sulla', 'sulle', 'sullo', 'supporta', 'sviluppo', 'taglia', 'tagliare', 'tagliarle',
  'tagliati', 'tanto', 'tasto', 'tenere', 'tentativi', 'tentativo', 'termina', 'terminale', 'tieni', 'tienila', 'toccare',
  'torna', 'tornare', 'tremolio', 'troppo', 'trovare', 'trovata', 'trovato', 'tuo', 'tutta', 'tutte', 'tutti', 'tutto', 'ultime',
  'ultimi', 'usa', 'usare', 'usato', 'uscire', 'valore', 'valori', 'vecchia', 'vecchie', 'vecchio', 'vedere', 'vedi',
  'velocemente', 'velocità', 'vicina', 'vicini', 'vicino', 'virtuale', 'vite', 'vuoi', 'vuole',
]);

/** Proper names allowed to contain accented letters or Italian-looking words. Empty on purpose: add a name here only with a reason. */
export const ALLOWED_PROPER_NAMES = Object.freeze([]);

/** The accented vowels of Italian: a grave, e grave, e acute, i grave, o grave, u grave (either case). */
export const ACCENTED_VOWELS = /[àèéìòùÀÈÉÌÒÙ]/;

/**
 * Italian leaks of one text: the accented vowel it contains and the Italian words it uses.
 * @param {string} text
 * @returns {string[]} empty when the text is clean
 */
export function findItalian(text) {
  let s = String(text);
  for (const name of ALLOWED_PROPER_NAMES) s = s.split(name).join(' ');
  const hits = [];
  const accent = s.match(ACCENTED_VOWELS);
  if (accent) hits.push(`accented vowel "${accent[0]}"`);
  for (const token of s.match(/[A-Za-zÀ-ÿ]+/g) ?? []) {
    if (ITALIAN_WORDS.has(token.toLowerCase())) hits.push(`Italian word "${token}"`);
  }
  return hits;
}
