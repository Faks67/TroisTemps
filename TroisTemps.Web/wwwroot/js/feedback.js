// Sons (synthétisés, aucun fichier à télécharger) et vibrations, activables dans le menu.

const KEY = 'troistemps-feedback';
let prefs = { sound: true, vibrate: true };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* ignoré */ }

export const feedback = {
  get sound() { return prefs.sound; },
  get vibrate() { return prefs.vibrate; },
  set(name, value) {
    prefs[name] = value;
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignoré */ }
    if (name === 'sound' && value) play('found');
    if (name === 'vibrate' && value) buzz(40);
  },
};

let ctx;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
// Les navigateurs n'autorisent le son qu'après un geste de l'utilisateur.
addEventListener('pointerdown', () => { if (prefs.sound) audio(); }, { once: true });

function tone(freq, start, dur, type = 'sine', gain = 0.18) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const SOUNDS = {
  found: () => { tone(660, 0, 0.12, 'triangle'); tone(990, 0.08, 0.18, 'triangle'); },
  pass: () => tone(260, 0, 0.14, 'sine', 0.12),
  tick: () => tone(1200, 0, 0.05, 'square', 0.05),
  start: () => { tone(523, 0, 0.12, 'triangle'); tone(659, 0.1, 0.12, 'triangle'); tone(784, 0.2, 0.22, 'triangle'); },
  end: () => { tone(180, 0, 0.5, 'sawtooth', 0.12); tone(140, 0.05, 0.55, 'sawtooth', 0.1); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.3, 'triangle')),
  turn: () => { tone(880, 0, 0.1, 'sine', 0.12); tone(880, 0.16, 0.1, 'sine', 0.12); },
};

export function play(name) {
  if (!prefs.sound) return;
  try { SOUNDS[name]?.(); } catch { /* son indisponible */ }
}

export function buzz(pattern) {
  if (!prefs.vibrate || !navigator.vibrate) return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // refusé avant un premier appui
  try { navigator.vibrate(pattern); } catch { /* ignoré */ }
}
