// Trois Temps : client du jeu. Le serveur (SignalR) fait autorité ; ce fichier affiche l'état
// reçu et envoie les actions du joueur.
import { feedback, play, buzz } from './feedback.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'troistemps-session'; // par onglet : un onglet = un joueur
const LAST_KEY = 'troistemps-derniere-salle'; // secours si le téléphone a fermé l'onglet
const NAME_KEY = 'troistemps-name';

const ROUNDS = {
  1: { name: 'Décrire', text: 'Tout est permis sauf les mots de la carte : pas de traduction, pas d\'épellation. Les devineurs proposent autant qu\'ils veulent.' },
  2: { name: 'Un seul mot', text: 'Un seul mot pour faire deviner, pas de geste. L\'équipe n\'a droit qu\'à une proposition par carte.' },
  3: { name: 'Mime', text: 'Plus aucun mot ni aucun son : seulement des gestes et des mimiques. Une proposition par carte.' },
};
const DIFFS = { 1: 'Facile', 2: 'Moyen', 3: 'Difficile' };

let conn;
let state = null;
let prev = null;
let clockOffset = 0;
let library = { categories: [], total: 0 };
let lanBase = null;
let qrFor = null;
let settingsKey = null;
let wakeLock = null;
let lastTick = null;
let pending = false;

// ---------- Utilitaires ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

const store = {
  get(k, s = localStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k, v, s = localStorage) { try { v == null ? s.removeItem(k) : s.setItem(k, v); } catch { /* ignoré */ } },
};
const session = {
  get: () => { try { return JSON.parse(store.get(SESSION_KEY, sessionStorage)); } catch { return null; } },
  set: (v) => store.set(SESSION_KEY, v ? JSON.stringify(v) : null, sessionStorage),
};
const lastRoom = {
  get: () => { try { return JSON.parse(store.get(LAST_KEY)); } catch { return null; } },
  set: (v) => store.set(LAST_KEY, v ? JSON.stringify(v) : null),
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function cleanError(e) {
  const m = String(e?.message || e);
  const i = m.indexOf('HubException: ');
  return i >= 0 ? m.slice(i + 14) : 'Connexion au serveur impossible. Réessaie dans un instant.';
}

async function call(method, ...args) {
  try { return await conn.invoke(method, ...args); }
  catch (e) { toast(cleanError(e)); throw e; }
}
const send = (method, ...args) => call(method, ...args).catch(() => {});

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

const isHost = () => state && state.hostId === state.meId;
const me = () => state.players.find((p) => p.id === state.meId);
const team = (id) => state.teams.find((t) => t.id === id);
const player = (id) => state.players.find((p) => p.id === id);
const members = (teamId) => state.players.filter((p) => p.teamId === teamId);
const activeTeams = () => state.teams.filter((t) => members(t.id).length > 0);
const iAmGiver = () => !!state.turn && (state.turn.giverId === state.meId || (state.local && isHost()));
const now = () => Date.now() + clockOffset;
const initial = (name) => esc((name || '?').trim().charAt(0).toUpperCase());

function teamValidity() {
  const sizes = state.teams.map((t) => members(t.id).length);
  if (sizes.filter((n) => n > 0).length < 2) return 'Il faut au moins deux équipes avec des joueurs.';
  if (sizes.some((n) => n === 1)) return 'Chaque équipe doit avoir au moins 2 joueurs.';
  return null;
}

// ---------- Connexion ----------

async function connect() {
  conn = new signalR.HubConnectionBuilder()
    .withUrl('/hub/jeu')
    .withAutomaticReconnect([0, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 30000])
    .build();

  conn.on('state', onState);
  conn.on('kicked', () => {
    session.set(null);
    lastRoom.set(null);
    toast('L\'hôte t\'a retiré de la salle.');
    showHome();
  });
  conn.onreconnecting(() => toast('Connexion perdue, reconnexion…'));
  conn.onreconnected(() => { toast('Reconnecté'); rejoin(); });
  conn.onclose(() => toast('Déconnecté du serveur. Recharge la page.'));

  await conn.start();
}

async function rejoin() {
  const s = session.get();
  if (!s) return false;
  try {
    joined(await conn.invoke('Rejoin', s.code, s.playerId, s.token, false));
    return true;
  } catch (e) {
    session.set(null);
    toast(cleanError(e));
    showHome();
    return false;
  }
}

function joined(res) {
  session.set(res);
  lastRoom.set(res);
  history.replaceState(null, '', `/?salle=${res.code}`);
}

// ---------- Accueil ----------

function showHome() {
  state = null;
  prev = null;
  settingsKey = null;
  qrFor = null;
  $('room-chip').hidden = true;
  releaseWake();
  updateMenu();
  showScreen('screen-home');
}

function readName() {
  const name = $('name').value.trim();
  if (!name) { $('home-error').textContent = 'Écris ton prénom ou un pseudo pour jouer.'; $('name').focus(); return null; }
  store.set(NAME_KEY, name);
  $('home-error').textContent = '';
  return name;
}

async function create(local) {
  const name = readName();
  if (!name) return;
  try { joined(await conn.invoke('CreateRoom', name, local)); }
  catch (e) { $('home-error').textContent = cleanError(e); }
}

async function joinCode(code) {
  const name = readName();
  if (!name) return;
  code = (code || '').trim().toUpperCase();
  if (code.length !== 4) { $('home-error').textContent = 'Le code fait 4 lettres.'; $('code').focus(); return; }
  try { joined(await conn.invoke('JoinRoom', code, name)); }
  catch (e) { $('home-error').textContent = cleanError(e); }
}

$('btn-create').addEventListener('click', () => create(false));
$('btn-local').addEventListener('click', () => create(true));
$('btn-join').addEventListener('click', () => joinCode($('code').value));
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinCode($('code').value); });
$('code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('name').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (!$('btn-join-link').hidden) $('btn-join-link').click();
  else if ($('code').value.length === 4) joinCode($('code').value);
  else create(false);
});
$('btn-join-link').addEventListener('click', () => joinCode(new URLSearchParams(location.search).get('salle')));

// ---------- Réception de l'état ----------

function onState(s) {
  prev = state;
  state = s;
  clockOffset = s.serverNow - Date.now();
  pending = false;

  const chip = $('room-chip');
  chip.hidden = false;
  chip.textContent = s.code;
  chip.title = s.local ? 'Partie sur un seul appareil' : 'Code de la salle : touche pour copier le lien';

  cues();
  updateMenu();
  if (s.phase === 'Lobby') { releaseWake(); renderLobby(); }
  else { requestWake(); renderGame(); }
  if ($('sheet-player').open) refreshPlayerSheet();
}

/** Sons et vibrations aux moments clés, en comparant avec l'état précédent. */
function cues() {
  if (!prev) return;
  const s = state;
  const turnStarted = s.phase === 'Playing' && prev.phase !== 'Playing' && !prev.turn?.pausedMs;
  if (s.phase === 'TurnReady' && (prev.phase !== 'TurnReady' || prev.nextGiverId !== s.nextGiverId) && s.nextGiverId === s.meId) {
    play('turn'); buzz([60, 80, 60]);
  }
  if (turnStarted) play('start');
  if (s.phase === 'Playing' && prev.phase === 'Playing' && s.turn && prev.turn) {
    if (s.turn.found.length > prev.turn.found.length && !iAmGiver()) play('found');
    if (s.turn.passes > prev.turn.passes && !iAmGiver()) play('pass');
  }
  if (s.phase === 'Review' && prev.phase === 'Playing') { play('end'); buzz([180, 90, 180]); }
  if (s.phase === 'Final' && prev.phase !== 'Final') { play('win'); confetti(); }
}

// ---------- Salon ----------

function inviteLink() {
  return `${lanBase || location.origin}/?salle=${state.code}`;
}

function renderLobby() {
  showScreen('screen-lobby');
  const host = isHost();
  document.querySelectorAll('#screen-lobby .host-only').forEach((e) => { e.hidden = !host; });

  // Invitation (ou ajout de joueurs en mode un seul appareil)
  $('invite-card').hidden = state.local;
  $('local-add').hidden = !state.local;
  if (!state.local) {
    const link = inviteLink();
    $('lobby-code').textContent = state.code;
    $('invite-link').textContent = link.replace(/^https?:\/\//, '');
    $('btn-share').hidden = !navigator.share;
    if (qrFor !== link && window.qrcode) {
      const qr = qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      qrFor = link;
    }
    $('invite-hint').textContent = lanBase || !/^(localhost|127\.)/.test(location.hostname)
      ? 'Les autres joueurs scannent le QR code ou ouvrent le lien, sur le même réseau Wi-Fi.'
      : 'Ouvre un autre onglet avec ce lien pour ajouter un joueur.';
  }

  renderTeams();
  renderMyCards();
  renderSettings();

  // Barre de lancement
  const problem = teamValidity();
  const total = Math.max(state.settings.cardCount, state.customTotal);
  const summary = `${plural(state.players.length, 'joueur', 'joueurs')} · ${total} cartes${state.customTotal ? ` dont ${state.customTotal} des joueurs` : ''}`;
  $('btn-start').hidden = !host;
  $('btn-start').disabled = !!problem;
  $('start-hint').textContent = host
    ? (problem || summary)
    : `${summary}. En attente du lancement par ${player(state.hostId)?.name ?? 'l\'hôte'}…`;
}

function memberHtml(p, t, clickable) {
  const tags = [];
  if (p.id === state.hostId && !state.local) tags.push('hôte');
  if (p.id === state.meId && !state.local) tags.push('toi');
  if (!p.connected) tags.push('absent');
  const cls = `member${p.id === state.meId && !state.local ? ' me' : ''}${p.connected ? '' : ' away'}`;
  const inner = `<span class="avatar">${initial(p.name)}</span><span>${esc(p.name)}</span>${tags.length ? `<span class="tag">${tags.join(' · ')}</span>` : ''}`;
  return clickable
    ? `<li><button type="button" class="${cls}" data-player="${p.id}">${inner}</button></li>`
    : `<li class="${cls}">${inner}</li>`;
}

function renderTeams() {
  const host = isHost();
  const mine = me();
  const unassigned = state.players.filter((p) => !state.teams.some((t) => t.id === p.teamId));
  $('teams').innerHTML = state.teams.map((t) => {
    const list = members(t.id);
    const nameHtml = host
      ? `<input value="${esc(t.name)}" maxlength="24" data-rename="${t.id}" aria-label="Nom de l'équipe">`
      : `<span>${esc(t.name)}</span>`;
    const joinBtn = !state.local && mine && mine.teamId !== t.id
      ? `<button type="button" class="btn btn-ghost btn-sm join-team" data-join="${t.id}">Rejoindre</button>` : '';
    return `<div class="team" data-c="${t.color}">
      <div class="team-name"><span class="dot"></span>${nameHtml}</div>
      <ul class="members">${list.map((p) => memberHtml(p, t, host)).join('') || '<li class="empty">Personne pour l\'instant</li>'}</ul>
      ${joinBtn}
    </div>`;
  }).join('') + (unassigned.length ? `<div class="team"><ul class="members">${unassigned.map((p) => memberHtml(p, null, host)).join('')}</ul></div>` : '');

  $('teams-hint').textContent = host
    ? (state.local ? 'Touche un joueur pour le changer d\'équipe ou le retirer.' : 'Touche un joueur pour le déplacer, le nommer hôte ou le retirer. Chacun peut aussi choisir son équipe.')
    : 'Choisis ton équipe avec « Rejoindre ». L\'hôte peut aussi répartir les équipes.';
}

$('teams').addEventListener('click', (e) => {
  const join = e.target.closest('[data-join]');
  if (join) return send('SetTeam', state.meId, Number(join.dataset.join));
  const p = e.target.closest('[data-player]');
  if (p) openPlayerSheet(p.dataset.player);
});
$('teams').addEventListener('change', (e) => {
  const input = e.target.closest('[data-rename]');
  if (input) send('RenameTeam', Number(input.dataset.rename), input.value);
});
$('teams').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-rename]')) e.target.blur();
});
$('btn-shuffle').addEventListener('click', () => send('ShuffleTeams'));

$('form-local-player').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('local-name');
  const name = input.value.trim();
  if (!name) return input.focus();
  try { await call('AddLocalPlayer', name, null); input.value = ''; } catch { /* message déjà affiché */ }
  input.focus();
});

function cardLimit() {
  const per = state.settings.cardsPerPlayer;
  return state.local && isHost() ? Math.max(per * state.players.length, per) : per;
}

function renderMyCards() {
  const limit = cardLimit();
  $('my-cards-card').hidden = limit === 0;
  if (limit === 0) return;
  const mine = state.myCards;
  $('my-cards-count').textContent = `${mine.length} / ${limit}`;
  $('my-cards-hint').textContent = state.local
    ? `Ajoutez jusqu'à ${limit} cartes à vous (${state.settings.cardsPerPlayer} par joueur) : des proches, des souvenirs, des private jokes…`
    : 'Ajoute des personnes ou des choses que tout le monde peut connaître. Les autres ne les verront qu\'en jouant.';
  $('form-card').hidden = mine.length >= limit;
  $('my-cards').innerHTML = mine.map((c) => `<li>${esc(c.text)}<button type="button" data-remove-card="${c.id}" aria-label="Retirer ${esc(c.text)}">✕</button></li>`).join('');
}

$('form-card').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('card-text');
  const text = input.value.trim();
  if (!text) return input.focus();
  try { await call('AddCard', text); input.value = ''; } catch { /* message déjà affiché */ }
  input.focus();
});
$('my-cards').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove-card]');
  if (b) send('RemoveCard', b.dataset.removeCard);
});

// ---------- Réglages ----------

function available(s) {
  return library.categories
    .filter((c) => s.categories.includes(c.id))
    .reduce((n, c) => n + s.difficulties.reduce((m, d) => m + (c.byDifficulty[d - 1] || 0), 0), 0);
}

function renderSettings() {
  const s = state.settings;
  const host = isHost();
  const key = JSON.stringify([s, host, library.total]);
  const box = $('settings');
  if (key === settingsKey || box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  settingsKey = key;
  $('settings-who').textContent = host ? 'Tu choisis' : 'Choisis par l\'hôte';
  box.classList.toggle('readonly', !host);

  const stepper = (name, value, label, step, min, max) => `
    <div class="stepper">
      <button type="button" data-step="${name}" data-delta="${-step}" data-min="${min}" data-max="${max}" aria-label="Moins" ${value <= min ? 'disabled' : ''}>−</button>
      <output>${label}</output>
      <button type="button" data-step="${name}" data-delta="${step}" data-min="${min}" data-max="${max}" aria-label="Plus" ${value >= max ? 'disabled' : ''}>+</button>
    </div>`;
  const pressed = (b) => `aria-pressed="${b}"`;
  const avail = available(s);

  box.innerHTML = `
    <div class="setting">
      <div class="setting-label">Durée d'un tour <small>pour chaque joueur</small></div>
      ${stepper('turnSeconds', s.turnSeconds, `${s.turnSeconds} s`, 5, 15, 120)}
    </div>
    <div class="setting">
      <div class="setting-label">Nombre de cartes <small>les mêmes pour les 3 manches</small></div>
      ${stepper('cardCount', s.cardCount, s.cardCount, 5, 10, 100)}
    </div>
    <div class="setting">
      <div class="setting-label">Nombre d'équipes</div>
      <div class="seg cols">${[2, 3, 4].map((n) => `<button type="button" data-team-count="${n}" ${pressed(s.teamCount === n)}>${n}</button>`).join('')}</div>
    </div>
    <div class="setting">
      <div class="setting-label">Catégories <small>${avail} cartes disponibles</small></div>
      <div class="seg">
        ${library.categories.map((c) => `<button type="button" class="tog" data-cat="${c.id}" ${pressed(s.categories.includes(c.id))}>${esc(c.name)}<small>${c.count}</small></button>`).join('')}
        ${host ? `<button type="button" class="tog" data-cat-all>${s.categories.length === library.categories.length ? 'Aucune' : 'Toutes'}</button>` : ''}
      </div>
    </div>
    <div class="setting">
      <div class="setting-label">Difficulté</div>
      <div class="seg">${[1, 2, 3].map((d) => `<button type="button" class="tog" data-diff="${d}" ${pressed(s.difficulties.includes(d))}>${DIFFS[d]}</button>`).join('')}</div>
    </div>
    <div class="setting">
      <div class="setting-label">Cartes ajoutées par chaque joueur <small>${s.cardsPerPlayer ? '' : 'désactivé'}</small></div>
      ${stepper('cardsPerPlayer', s.cardsPerPlayer, s.cardsPerPlayer || 'Aucune', 1, 0, 10)}
    </div>
    <label class="switch-row"><span>« Passer » autorisé en manche 1<small>Sinon, il faut faire trouver chaque carte avant la suivante.</small></span>
      <input type="checkbox" role="switch" data-flag="passInRound1" ${s.passInRound1 ? 'checked' : ''} ${host ? '' : 'disabled'}></label>
    <label class="switch-row"><span>Temps reporté<small>Si le paquet se vide en plein tour, le joueur garde le temps restant pour la manche suivante.</small></span>
      <input type="checkbox" role="switch" data-flag="carryOver" ${s.carryOver ? 'checked' : ''} ${host ? '' : 'disabled'}></label>
    ${avail < s.cardCount - state.customTotal ? `<p class="error">Seulement ${avail} cartes avec ces choix : ajoute des catégories ou des difficultés.</p>` : ''}
  `;
}

function changeSettings(patch) {
  const next = { ...state.settings, ...patch };
  state.settings = next;
  renderSettings();
  send('UpdateSettings', next);
}

$('settings').addEventListener('click', (e) => {
  if (!isHost()) return;
  const s = state.settings;
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.step) {
    const d = Number(b.dataset.delta);
    const v = Math.min(Number(b.dataset.max), Math.max(Number(b.dataset.min), s[b.dataset.step] + d));
    changeSettings({ [b.dataset.step]: v });
  } else if (b.dataset.teamCount) changeSettings({ teamCount: Number(b.dataset.teamCount) });
  else if (b.dataset.cat) {
    const cats = s.categories.includes(b.dataset.cat) ? s.categories.filter((c) => c !== b.dataset.cat) : [...s.categories, b.dataset.cat];
    if (cats.length === 0) return toast('Garde au moins une catégorie.');
    changeSettings({ categories: cats });
  } else if ('catAll' in b.dataset) {
    const all = s.categories.length === library.categories.length;
    changeSettings({ categories: all ? [library.categories[0].id] : library.categories.map((c) => c.id) });
  } else if (b.dataset.diff) {
    const d = Number(b.dataset.diff);
    const diffs = s.difficulties.includes(d) ? s.difficulties.filter((x) => x !== d) : [...s.difficulties, d].sort();
    if (diffs.length === 0) return toast('Garde au moins une difficulté.');
    changeSettings({ difficulties: diffs });
  }
});
$('settings').addEventListener('change', (e) => {
  const f = e.target.closest('[data-flag]');
  if (f && isHost()) changeSettings({ [f.dataset.flag]: f.checked });
});

$('btn-start').addEventListener('click', () => send('StartGame'));

$('btn-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(inviteLink()); toast('Lien copié'); }
  catch { toast(inviteLink()); }
});
$('btn-share').addEventListener('click', () => {
  navigator.share?.({ title: 'Trois Temps', text: `Rejoins ma partie de Trois Temps (salle ${state.code})`, url: inviteLink() }).catch(() => {});
});
$('room-chip').addEventListener('click', async () => {
  if (!state || state.local) return;
  try { await navigator.clipboard.writeText(inviteLink()); toast(`Lien de la salle ${state.code} copié`); }
  catch { toast(`Code de la salle : ${state.code}`); }
});

// ---------- Fiche d'un joueur (hôte) ----------

let sheetPlayer = null;
function openPlayerSheet(id) {
  if (!isHost()) return;
  sheetPlayer = id;
  refreshPlayerSheet();
  openSheet('sheet-player');
}

function refreshPlayerSheet() {
  const content = $('player-sheet-content');
  if (sheetPlayer === '*') {
    $('player-sheet-title').textContent = 'Joueurs';
    content.innerHTML = `<div class="manage-list">${state.players.map((p) => {
      const t = team(p.teamId);
      return `<button type="button" class="member" data-c="${t?.color ?? 0}" style="--tc: var(--t${t?.color ?? 0})" data-player="${p.id}">
        <span class="avatar">${initial(p.name)}</span><span>${esc(p.name)}</span><span class="tag">${esc(t?.name ?? '')}${p.connected ? '' : ' · absent'}</span></button>`;
    }).join('')}</div>`;
    return;
  }
  const p = player(sheetPlayer);
  if (!p || !isHost()) { closeSheet('sheet-player'); return; }
  $('player-sheet-title').textContent = p.name;
  const inTurn = state.turn?.giverId === p.id && ['Playing', 'Review'].includes(state.phase);
  content.innerHTML = `
    <p class="muted small">${p.connected ? 'Connecté' : 'Absent pour le moment : sa place est gardée.'}</p>
    <p class="eyebrow">Équipe</p>
    <div class="sheet-teams">${state.teams.map((t) => `
      <button type="button" class="btn ${t.id === p.teamId ? 'btn-primary' : 'btn-secondary'}" data-move="${t.id}" ${t.id === p.teamId || inTurn ? 'disabled' : ''}>${esc(t.name)}</button>`).join('')}
    </div>
    <div class="menu-actions">
      ${!p.virtual && p.id !== state.meId ? '<button type="button" class="btn btn-secondary" data-make-host>Nommer hôte</button>' : ''}
      ${p.id !== state.meId ? '<button type="button" class="btn btn-danger" data-kick>Retirer de la salle</button>' : ''}
    </div>`;
}

$('player-sheet-content').addEventListener('click', async (e) => {
  const pick = e.target.closest('[data-player]');
  if (pick) { sheetPlayer = pick.dataset.player; refreshPlayerSheet(); return; }
  const move = e.target.closest('[data-move]');
  if (move) { send('SetTeam', sheetPlayer, Number(move.dataset.move)); return; }
  if (e.target.closest('[data-make-host]')) { send('MakeHost', sheetPlayer); closeSheet('sheet-player'); return; }
  if (e.target.closest('[data-kick]')) {
    const p = player(sheetPlayer);
    if (p && confirm(`Retirer ${p.name} de la salle ?`)) { send('Kick', sheetPlayer); closeSheet('sheet-player'); }
  }
});

// ---------- Partie ----------

function renderScorebar() {
  const active = state.turn?.teamId;
  const inTurn = ['TurnReady', 'Playing', 'Review'].includes(state.phase);
  $('scorebar').innerHTML = activeTeams().map((t) => `
    <div class="score ${inTurn && t.id === active ? 'active' : ''}" data-c="${t.color}">
      <span class="dot" style="background: var(--t${t.color})"></span><span class="nm">${esc(t.name)}</span><span class="n">${t.total}</span>
    </div>`).join('');
}

function roundTag() {
  const r = state.round;
  return `<span class="round-tag" data-r="${r}"><b>${r}</b>Manche ${r} · ${ROUNDS[r].name}</span>`;
}

function stageTop() {
  return `<div class="stage-top">${roundTag()}<span class="pill">${plural(state.deckLeft, 'carte restante', 'cartes restantes')} sur ${state.deckTotal}</span></div>`;
}

function ruleBox(r, big) {
  return `<div class="rule-box" data-r="${r}"><h3>${big ? `Manche ${r} : ` : ''}${ROUNDS[r].name}</h3><p>${ROUNDS[r].text}</p></div>`;
}

const teamWord = (t) => t ? `<span class="team-word" style="--tc: var(--t${t.color})">${esc(t.name)}</span>` : '';

function timerHtml(small) {
  const r = 46;
  const c = (2 * Math.PI * r).toFixed(1);
  return `<div class="timer ${small ? 'small' : ''}" data-live>
    <svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="${r}" fill="none" stroke-width="8"/>
    <circle class="bar" cx="50" cy="50" r="${r}" fill="none" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="0"/></svg>
    <div class="num">–</div></div>`;
}

function renderGame() {
  showScreen('screen-game');
  renderScorebar();
  const stage = $('stage');
  const view = {
    TurnReady: renderReady,
    Playing: () => (iAmGiver() ? renderGiver() : renderWatcher()),
    Review: renderReview,
    RoundEnd: renderRoundEnd,
    Final: renderFinal,
  }[state.phase];
  stage.innerHTML = view ? view() : '';
  tickTimers();
}

function renderReady() {
  const t = state.turn;
  const giver = player(t.giverId);
  const gt = team(giver?.teamId);
  const mine = me();
  const seconds = Math.round(t.turnMs / 1000);
  const carried = seconds !== state.settings.turnSeconds;
  const last = state.lastTurn;
  const lastHtml = last ? `<p class="muted small">${esc(last.giverName)} a fait trouver ${plural(last.found.length, 'carte', 'cartes')}.</p>` : '';
  const timeHtml = `<p><strong>${seconds} secondes</strong>${carried ? ' (temps reporté de la manche précédente)' : ''}</p>`;
  let body;

  if (iAmGiver()) {
    if (state.local) {
      body = `<p class="eyebrow">Passe l'appareil à</p>
        <div class="big-name">${esc(giver?.name)}</div>
        <p>Équipe ${teamWord(gt)}</p>
        ${timeHtml}
        <button class="btn btn-primary btn-lg" type="button" data-act="StartTurn">C'est parti !</button>
        <p class="muted small">Une fois le tour lancé, l'écran est réservé à ${esc(giver?.name)} : les autres ne regardent pas !</p>`;
    } else {
      const mates = members(giver.teamId).filter((p) => p.id !== giver.id).map((p) => esc(p.name));
      body = `<p class="eyebrow">À toi de jouer</p>
        <h2>Tu fais deviner !</h2>
        <p>Ton équipe ${teamWord(gt)} : ${mates.join(', ')}</p>
        ${timeHtml}
        <button class="btn btn-primary btn-lg" type="button" data-act="StartTurn">C'est parti !</button>
        <p class="muted small">Toi seul verras les cartes.</p>`;
    }
  } else {
    const myTurn = mine && giver && mine.teamId === giver.teamId;
    body = `<p class="eyebrow">Au tour de</p>
      <div class="big-name">${esc(giver?.name ?? '?')}</div>
      <p>Équipe ${teamWord(gt)}${giver && !giver.connected ? ' · <strong>absent</strong>' : ''}</p>
      <p>${myTurn ? 'Prépare-toi à deviner avec ton équipe !' : 'Ton équipe surveille : pas de mots interdits !'}</p>
      ${isHost() ? `<button class="btn btn-ghost btn-sm" type="button" data-act="SkipGiver">Passer son tour</button>` : ''}`;
  }

  return `${stageTop()}
    ${state.roundStart ? ruleBox(state.round, true) : ''}
    <div class="card panel">${lastHtml}${body}</div>
    ${!state.roundStart ? `<details class="muted small"><summary>Rappel de la règle</summary>${ruleBox(state.round, false)}</details>` : ''}`;
}

function renderGiver() {
  const t = state.turn;
  const c = state.card;
  const paused = t.pausedMs != null;
  const canPass = t.canPass && !t.lastCard;
  const cat = library.categories.find((x) => x.id === c?.category)?.name ?? (c?.category === 'joueurs' ? 'Carte d\'un joueur' : '');
  return `${stageTop()}
    <div class="play">
      <div class="play-head">
        ${timerHtml(true)}
        <div class="counts"><strong>${t.found.length}</strong>${t.found.length > 1 ? 'trouvées' : 'trouvée'}</div>
      </div>
      ${paused ? `<div class="card panel"><p class="paused-label">Pause</p><p>Le chrono est arrêté et la carte cachée.</p>
          <button class="btn btn-primary btn-lg" type="button" data-act="TogglePause">Reprendre</button></div>`
        : c ? `<div class="game-card" data-card="${c.id}">
          <span class="cat">${esc(cat)}</span>
          <span class="diff" title="${DIFFS[c.difficulty] ?? ''}">${[1, 2, 3].map((i) => `<i class="${i <= c.difficulty ? 'on' : ''}"></i>`).join('')}</span>
          <span class="txt">${esc(c.text)}</span><span class="stripe"></span></div>` : ''}
      ${paused ? '' : `<div class="actions">
        <button class="btn btn-pass" type="button" data-act="Pass" ${canPass ? '' : 'disabled'}>Passer</button>
        <button class="btn btn-found" type="button" data-act="Found">Trouvé !</button>
      </div>
      ${!t.canPass ? '<p class="hint-last">Pas de « Passer » en manche 1 : fais trouver cette carte.</p>' : t.lastCard ? '<p class="hint-last">Dernière carte du paquet !</p>' : ''}
      <div class="sub-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-act="TogglePause">Pause</button>
        <span class="pill">${['', 'Aucun mot de la carte', 'Un seul mot, pas de geste', 'Mime, sans un son'][state.round]}</span>
      </div>`}
    </div>`;
}

function renderWatcher() {
  const t = state.turn;
  const giver = player(t.giverId);
  const gt = team(giver?.teamId);
  const mine = me();
  const guessing = mine && giver && mine.teamId === giver.teamId;
  const paused = t.pausedMs != null;
  return `${stageTop()}
    <div class="card panel">
      ${timerHtml(false)}
      ${paused ? '<p class="paused-label">Pause</p>' : ''}
      <p><strong>${esc(giver?.name)}</strong> fait deviner · ${teamWord(gt)}</p>
      <h2>${guessing ? 'Devine !' : 'Surveille !'}</h2>
      <p>${guessing ? `Manche ${state.round} : ${ROUNDS[state.round].name.toLowerCase()}. Crie tes réponses !` : 'Vérifie que les règles de la manche sont respectées.'}</p>
      ${t.found.length ? `<p class="eyebrow">${plural(t.found.length, 'carte trouvée', 'cartes trouvées')}</p><ul class="found-list">${t.found.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul>` : ''}
      ${isHost() ? `<button class="btn btn-ghost btn-sm" type="button" data-act="TogglePause">${paused ? 'Reprendre' : 'Pause'}</button>` : ''}
    </div>`;
}

function renderReview() {
  const t = state.turn;
  const giver = player(t.giverId);
  const canEdit = iAmGiver() || isHost();
  const ok = t.found.filter((c) => !t.rejected.includes(c.id)).length;
  const deckEmpty = state.deckLeft === 0 && t.rejected.length === 0;
  return `${stageTop()}
    <div class="card panel">
      <p class="eyebrow">Fin du tour</p>
      <h2>${esc(giver?.name ?? 'Le joueur')} a fait trouver ${plural(ok, 'carte', 'cartes')}</h2>
      ${deckEmpty ? `<p><strong>Le paquet est vide : c'est la fin de la manche ${state.round} !</strong></p>` : ''}
      ${t.found.length ? `<p class="muted small">${canEdit ? 'Touche une carte pour l\'annuler si elle a été mal trouvée (elle retournera dans le paquet).' : 'Vérification des cartes…'}</p>
        <ul class="review-list">${t.found.map((c) => {
          const off = t.rejected.includes(c.id);
          return `<li><button type="button" class="review-item ${off ? 'off' : ''}" data-review="${c.id}" ${canEdit ? '' : 'disabled'}><span class="box">✓</span>${esc(c.text)}</button></li>`;
        }).join('')}</ul>` : '<p>Aucune carte trouvée cette fois-ci.</p>'}
      ${t.passes ? `<p class="muted small">${plural(t.passes, 'carte passée', 'cartes passées')}</p>` : ''}
      ${canEdit ? `<button class="btn btn-primary btn-lg" type="button" data-act="ConfirmReview">Valider ${plural(ok, 'point', 'points')}</button>`
        : `<p class="muted">En attente de la validation par ${esc(giver?.name ?? 'l\'hôte')}…</p>`}
    </div>`;
}

function scoresTable(upTo) {
  const teams = activeTeams().sort((a, b) => b.total - a.total);
  const top = teams[0]?.total;
  const rounds = [1, 2, 3].slice(0, upTo);
  return `<div class="table-wrap"><table class="scores">
    <thead><tr><th>Équipe</th>${rounds.map((r) => `<th>M${r}</th>`).join('')}<th>Total</th></tr></thead>
    <tbody>${teams.map((t) => `<tr class="${t.total === top ? 'lead' : ''}">
      <td><span class="team-cell" style="--tc: var(--t${t.color})"><span class="dot"></span>${esc(t.name)}</span></td>
      ${rounds.map((r) => `<td>${t.scores[r - 1]}</td>`).join('')}<td class="total">${t.total}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function renderRoundEnd() {
  const r = state.round;
  const host = player(state.hostId);
  return `<div class="stage-top">${roundTag()}<span class="pill">Manche terminée</span></div>
    <div class="card panel">
      <p class="eyebrow">Fin de la manche ${r}</p>
      <h2>Toutes les cartes ont été trouvées !</h2>
      ${scoresTable(r)}
    </div>
    ${ruleBox(r + 1, true)}
    <p class="muted small" style="text-align:center;margin:0">Mêmes cartes, nouvelle règle : souvenez-vous des indices qui ont marché !</p>
    ${isHost() ? `<button class="btn btn-primary btn-lg" type="button" data-act="NextRound">Lancer la manche ${r + 1}</button>`
      : `<p class="muted" style="text-align:center">${esc(host?.name ?? 'L\'hôte')} va lancer la manche suivante…</p>`}`;
}

function renderFinal() {
  const teams = activeTeams().sort((a, b) => b.total - a.total);
  const top = teams[0]?.total ?? 0;
  const winners = teams.filter((t) => t.total === top);
  const title = winners.length > 1 ? 'Égalité !' : `Bravo, ${esc(winners[0]?.name ?? '')} !`;
  let rank = 0;
  let lastPts = null;
  const stars = [...state.players].filter((p) => p.found > 0).sort((a, b) => b.found - a.found).slice(0, 5);
  return `<div class="card panel">
      <p class="eyebrow">Fin de la partie</p>
      <h2>${title}</h2>
      <div class="podium">${teams.map((t, i) => {
        if (t.total !== lastPts) { rank = i + 1; lastPts = t.total; }
        return `<div class="podium-row ${rank === 1 ? 'first' : ''}" data-c="${t.color}"><span class="rank">${rank}</span><span class="nm">${esc(t.name)}</span><span class="pts">${t.total}</span></div>`;
      }).join('')}</div>
      ${scoresTable(3)}
      ${stars.length ? `<p class="eyebrow">Meilleurs orateurs</p><ul class="stats">${stars.map((p) => `<li><span>${esc(p.name)}</span><b>${plural(p.found, 'carte', 'cartes')}</b></li>`).join('')}</ul>` : ''}
    </div>
    ${isHost() ? '<button class="btn btn-primary btn-lg" type="button" data-act="BackToLobby">Rejouer avec de nouvelles cartes</button>' : '<p class="muted" style="text-align:center">L\'hôte peut relancer une partie.</p>'}
    <button class="btn btn-secondary btn-lg" type="button" data-leave>Quitter la salle</button>`;
}

$('stage').addEventListener('click', (e) => {
  const review = e.target.closest('[data-review]');
  if (review) return send('ToggleReview', review.dataset.review);
  if (e.target.closest('[data-leave]')) return leave();
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  act(b.dataset.act);
});

function act(name) {
  if (name === 'Found' || name === 'Pass') {
    if (pending || !state.card) return;
    pending = true; // un seul appui compte jusqu'à la carte suivante
    document.querySelectorAll('.actions .btn').forEach((x) => { x.disabled = true; });
    if (name === 'Found') { play('found'); buzz(35); } else { play('pass'); buzz(15); }
    return call(name, state.card.id).catch(() => { pending = false; });
  }
  send(name);
}

// Raccourcis clavier pour celui qui fait deviner sur ordinateur.
addEventListener('keydown', (e) => {
  if (!state || state.phase !== 'Playing' || !iAmGiver() || e.target.closest('input, textarea, dialog')) return;
  if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp') { e.preventDefault(); act('Found'); }
  else if ((e.key === 'ArrowRight' || e.key.toLowerCase() === 'p') && state.turn.canPass && !state.turn.lastCard) { e.preventDefault(); act('Pass'); }
});

// ---------- Chrono ----------

function remainingMs() {
  const t = state?.turn;
  if (!t) return 0;
  if (t.pausedMs != null) return t.pausedMs;
  if (t.deadline == null) return t.turnMs;
  return Math.max(0, t.deadline - now());
}

function tickTimers() {
  const timers = document.querySelectorAll('.timer[data-live]');
  if (!timers.length || !state?.turn) return;
  const ms = remainingMs();
  const sec = Math.ceil(ms / 1000);
  const frac = Math.max(0, Math.min(1, ms / (state.turn.turnMs || 1)));
  for (const el of timers) {
    el.querySelector('.num').textContent = sec;
    const bar = el.querySelector('.bar');
    bar.style.strokeDashoffset = (Number(bar.getAttribute('stroke-dasharray')) * (1 - frac)).toFixed(1);
    el.classList.toggle('warn', sec <= 10 && sec > 5);
    el.classList.toggle('danger', sec <= 5 && state.turn.pausedMs == null);
  }
  if (state.phase === 'Playing' && state.turn.pausedMs == null && sec <= 5 && sec > 0 && sec !== lastTick) {
    lastTick = sec;
    play('tick');
    if (iAmGiver()) buzz(10);
  }
}

setInterval(() => { if (state?.phase === 'Playing') tickTimers(); }, 100);

// L'écran reste allumé pendant la partie (si le navigateur le permet).
async function requestWake() {
  if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
  catch { /* refusé */ }
}
function releaseWake() { wakeLock?.release().catch(() => {}); wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (state && state.phase !== 'Lobby') requestWake(); });

function confetti() {
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--t1)', 'var(--t3)'];
  for (let i = 0; i < 90; i++) {
    const c = document.createElement('i');
    c.style.left = `${Math.random() * 100}%`;
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = `${2 + Math.random() * 2.5}s`;
    c.style.animationDelay = `${Math.random() * 0.8}s`;
    box.appendChild(c);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5500);
}

// ---------- Menu et feuilles ----------

function openSheet(id) { const d = $(id); if (!d.open) d.showModal(); }
function closeSheet(id) { const d = $(id); if (d.open) d.close(); }

document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { closeSheet('sheet-menu'); openSheet(open.dataset.open); return; }
  if (e.target.closest('[data-close]')) e.target.closest('dialog')?.close();
});
for (const d of document.querySelectorAll('dialog.sheet')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // clic sur le fond
}

function updateMenu() {
  const inRoom = !!state;
  const inGame = inRoom && state.phase !== 'Lobby';
  document.querySelectorAll('#sheet-menu .in-room').forEach((e) => { e.hidden = !inRoom; });
  document.querySelectorAll('#sheet-menu .in-game').forEach((e) => { e.hidden = !inGame; });
  document.querySelectorAll('#sheet-menu .host-only').forEach((e) => { e.hidden = e.hidden || !isHost(); });
}

$('btn-menu').addEventListener('click', () => {
  $('opt-sound').checked = feedback.sound;
  $('opt-vibrate').checked = feedback.vibrate;
  $('opt-dark').checked = window.currentTheme() === 'dark';
  updateMenu();
  openSheet('sheet-menu');
});
$('opt-sound').addEventListener('change', (e) => feedback.set('sound', e.target.checked));
$('opt-vibrate').addEventListener('change', (e) => feedback.set('vibrate', e.target.checked));
$('opt-dark').addEventListener('change', () => window.toggleTheme());
$('btn-manage').addEventListener('click', () => { closeSheet('sheet-menu'); sheetPlayer = '*'; refreshPlayerSheet(); openSheet('sheet-player'); });
$('btn-to-lobby').addEventListener('click', () => {
  if (confirm('Arrêter la partie en cours et revenir au salon ?')) { send('BackToLobby'); closeSheet('sheet-menu'); }
});
$('btn-leave').addEventListener('click', () => { closeSheet('sheet-menu'); leave(); });

async function leave() {
  if (!confirm(state?.local ? 'Quitter la partie ?' : 'Quitter la salle ? Tu pourras la rejoindre avec le code.')) return;
  try { await conn.invoke('Leave'); } catch { /* ignoré */ }
  session.set(null);
  lastRoom.set(null);
  history.replaceState(null, '', '/');
  resetHomeForm();
  showHome();
}

function resetHomeForm() {
  $('join-banner').hidden = true;
  $('home-create').hidden = false;
  $('btn-join-link').hidden = true;
}

// ---------- Démarrage ----------

async function init() {
  $('name').value = store.get(NAME_KEY) || '';
  const urlCode = (new URLSearchParams(location.search).get('salle') || '').toUpperCase();
  if (urlCode) $('code').value = urlCode;

  const libReq = fetch('/api/cartes').then((r) => r.json()).then((l) => { library = l; }).catch(() => {});
  if (/^(localhost|127\.|\[::1\])/.test(location.hostname)) {
    fetch('/api/reseau').then((r) => r.json()).then((n) => {
      lanBase = n.addresses?.[0] || null;
      if (state?.phase === 'Lobby') { qrFor = null; renderLobby(); }
    }).catch(() => {});
  }

  try { await connect(); }
  catch { $('home-error').textContent = 'Serveur injoignable. Vérifie qu\'il est bien lancé.'; return; }
  await libReq;

  if (session.get()) { if (await rejoin()) return; }
  else if (urlCode) {
    const last = lastRoom.get();
    if (last?.code === urlCode) {
      try { joined(await conn.invoke('Rejoin', last.code, last.playerId, last.token, true)); return; }
      catch { /* place occupée ou salle fermée : on propose de rejoindre */ }
    }
  }

  if (urlCode) {
    const info = await fetch(`/api/salle/${encodeURIComponent(urlCode)}`).then((r) => r.json()).catch(() => null);
    if (info?.exists) {
      $('join-banner').hidden = false;
      $('join-banner').textContent = `Tu es invité dans la salle ${urlCode}. Choisis ton pseudo pour la rejoindre.`;
      $('home-create').hidden = true;
      $('btn-join-link').hidden = false;
      $('name').focus();
    } else {
      history.replaceState(null, '', '/');
      $('home-error').textContent = `La salle ${urlCode} n'existe plus. Crée-en une nouvelle !`;
    }
  }
  showHome();
}

init();
