'use strict';
// ルール・盤面・得点計算は engine.js（画面・音を持たない）。イラストの絵の部品は illust.js。CPU は cpu.js。
// ここは見た目の組み立てと入力だけ。
import * as E from './engine.js';
import * as I from './illust.js';
import * as CPU from './cpu.js';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。キーは必ず 'catan-energy.' で始める。
const STORE = 'catan-energy.';
function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

// 盤の動き（波・木・羊など）のオン・オフ。動きを減らす設定の端末では、はじめはオフ。
const motionBtn = document.getElementById('motionBtn');
function setMotion(on) {
  document.documentElement.classList.toggle('motion-off', !on);
  motionBtn.setAttribute('aria-pressed', String(on));
  motionBtn.textContent = on ? '動き オン' : '動き オフ';
  save('motion', on);
}
setMotion(load('motion', !matchMedia('(prefers-reduced-motion: reduce)').matches));
motionBtn.addEventListener('click', () => setMotion(motionBtn.getAttribute('aria-pressed') !== 'true'));

WebAppKit.init({ title: 'catan-energy', text: '発電所と汚染を足したエネルギー版の陣取りボード。交代プレイの試作。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}
let audioCtx = null;
function beep(freq, dur) {
  try {
    if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); setAudioSession(true); }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch { /* 音が出せなくても遊べる */ }
}
// engine.js の fire() が積むイベント名に合わせる
const SOUND = {
  dice: () => beep(340, 0.12),
  build: () => beep(520, 0.1),
  buildFossil: () => beep(440, 0.1),
  buildRenewable: () => beep(600, 0.1),
  hazardPlace: () => beep(200, 0.14),
  hazardClear: () => beep(680, 0.05),
  energy: () => beep(760, 0.05),
  drawDisc: () => beep(300, 0.05),
  eventTriggeredBrown: () => { beep(380, 0.1); setTimeout(() => beep(280, 0.12), 90); },
  eventTriggeredGreen: () => { beep(520, 0.08); setTimeout(() => beep(700, 0.12), 90); },
  rob: () => beep(220, 0.2),
  win: () => { beep(660, 0.15); setTimeout(() => beep(880, 0.25), 140); },
  loseAll: () => { beep(160, 0.3); beep(200, 0.3); },
  shortage: () => beep(180, 0.08),
};

// ---- DOM ----
const els = {
  setupPanel: document.getElementById('setupPanel'),
  gamePanel: document.getElementById('gamePanel'),
  titleBoard: document.getElementById('titleBoard'),
  playerCountPicker: document.getElementById('playerCountPicker'),
  seatsPanel: document.getElementById('seatsPanel'),
  startBtn: document.getElementById('startBtn'),
  continueBtn: document.getElementById('continueBtn'),
  turnNum: document.getElementById('turnNum'),
  board: document.getElementById('board'),
  diceBox: document.getElementById('diceBox'),
  hint: document.getElementById('hint'),
  banner: document.getElementById('banner'),
  playersBar: document.getElementById('playersBar'),
  bankPanel: document.getElementById('bankPanel'),
  statusPanel: document.getElementById('statusPanel'),
  handBar: document.getElementById('handBar'),
  handCount: document.getElementById('handCount'),
  buildGrid: document.getElementById('buildGrid'),
  panelOverlay: document.getElementById('panelOverlay'),
  panel: document.getElementById('panel'),
  actionBar: document.getElementById('actionBar'),
  diceBtn: document.getElementById('diceBtn'),
  tradeBtn: document.getElementById('tradeBtn'),
  devBtn: document.getElementById('devBtn'),
  energyBtn: document.getElementById('energyBtn'),
  endTurnBtn: document.getElementById('endTurnBtn'),
};

const SCALE = 66; // 1マス単位(外接円半径1) → SVG座標のピクセル。illust.js の地形の絵は R=66 に合わせて置いてある。
// illust.js の資源アイコンは基本カタンの名前（wood/brick/sheep/wheat/ore）のまま。新しい資源名はここで対応づける
const ICON_KEY = { lumber: 'wood', brick: 'brick', fiber: 'sheep', food: 'wheat', steel: 'ore' };
const RES_COLOR = { lumber: '#3f8a4a', brick: '#c0643a', fiber: '#8cc063', food: '#e0b440', steel: '#8a92a3' };

// 資源・科学・エネルギーの小さなアイコン（40x40 の viewBox。科学・エネルギーは絵が無いので文字の札で代える）
function resIcon(kind) {
  if (kind === 'science' || kind === 'energy') {
    const span = document.createElement('span');
    span.className = 'res-icon res-icon--badge';
    span.textContent = kind === 'science' ? '科学' : '⚡';
    return span;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'res-icon');
  const shapes = [];
  I.resourceIcon(shapes, ICON_KEY[kind] || kind);
  shapes.forEach((s) => svg.appendChild(pathEl(s)));
  return svg;
}
function pathEl(s) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  n.setAttribute('d', s.d);
  n.setAttribute('fill', s.f);
  let st = `opacity:${s.o};stroke:${s.sk};stroke-width:${s.sw}px;stroke-linejoin:round;stroke-linecap:round`;
  if (s.c) {
    n.setAttribute('class', s.c);
    st += `;transform-origin:${s.ox}px ${s.oy}px;animation-delay:${(s.dl - performance.now() / 1000).toFixed(2)}s`;
  }
  n.setAttribute('style', st);
  return n;
}
function buildIcon(key, color) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('class', 'build-btn__icon');
  const shapes = [];
  const dark = I.tint(color, -0.4), light = I.tint(color, 0.35);
  if (key === 'road') { I.add(shapes, I.line(5, 21, 23, 7), 'none', 1, '#1b1612', 8); I.add(shapes, I.line(5, 21, 23, 7), 'none', 1, color, 4.5); }
  else if (key === 'town') I.house(shapes, 14, 17, color, dark, light);
  else if (key === 'city') I.city(shapes, 14, 17, color, dark, light);
  else if (key === 'devCard') { I.add(shapes, I.rect(6, 3, 16, 22), '#f6eedb', 1, '#1b1612', 1.5); I.add(shapes, I.rect(9, 6, 10, 10), '#7a5bb8', 0.85); }
  else if (key === 'warehouse') { I.add(shapes, I.rect(3, 15, 22, 7), color, 1, '#1b1612', 1.5); I.add(shapes, I.rect(5, 10, 6, 6), color, 1, '#1b1612', 1.2); I.add(shapes, I.rect(13, 10, 6, 6), color, 1, '#1b1612', 1.2); }
  else if (key === 'plantFossil' || key === 'plantRenewable') {
    const base = key === 'plantFossil' ? '#6b6056' : '#3f8a4a';
    I.add(shapes, I.ell(14, 15, 10, 10), base, 1, '#1b1612', 1.5);
    I.add(shapes, I.poly([[15, 5], [9, 16], [14, 16], [12, 25], [21, 13], [15, 13]]), '#f0cf4a', 1);
  }
  shapes.forEach((s) => svg.appendChild(pathEl(s)));
  return svg;
}
function dieEl(value, rotateDeg) {
  const wrap = document.createElement('div');
  wrap.className = 'die';
  wrap.style.transform = `rotate(${rotateDeg}deg)`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', 40); svg.setAttribute('height', 40); svg.setAttribute('viewBox', '0 0 46 46');
  const PIPS = {
    1: [[23, 23]], 2: [[14, 14], [32, 32]], 3: [[13, 13], [23, 23], [33, 33]],
    4: [[14, 14], [32, 14], [14, 32], [32, 32]], 5: [[13, 13], [33, 13], [23, 23], [13, 33], [33, 33]],
    6: [[14, 12], [32, 12], [14, 23], [32, 23], [14, 34], [32, 34]],
  }[value] || [];
  PIPS.forEach(([x, y]) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 4.2); c.setAttribute('fill', '#2a211b');
    svg.appendChild(c);
  });
  wrap.appendChild(svg);
  return wrap;
}

let game = null;
let inspectorMovedAt = 0, lastInspectorHex = null; // 監査官が動いた時刻（動いた直後に点滅させる）
let diceHitAt = 0, diceHitHexes = []; // サイコロで当たったタイル（振った直後だけ光らせて暗くする）
let rolling = false; // サイコロを振るアニメの途中
let playerCount = load('playerCount', 3);
if (![3, 4].includes(playerCount)) playerCount = 3; // 試作は基本盤・3〜4人のみ
let ui = { mode: 'idle', data: {} };

// ---- 人数選び ----
els.playerCountPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-count]');
  if (!btn) return;
  playerCount = Number(btn.dataset.count);
  save('playerCount', playerCount);
  syncCountPicker();
  renderSeatsPanel();
});
function syncCountPicker() {
  [...els.playerCountPicker.children].forEach((b) => b.classList.toggle('is-selected', Number(b.dataset.count) === playerCount));
}
syncCountPicker();

// ---- 席ごとの人／CPU選び ----
function defaultSeat(i) { return { type: i === 0 ? 'human' : 'cpu', level: 'normal', name: '' }; }
function sanitizeName(s) { return String(s || '').replace(/[<>&"']/g, '').trim().slice(0, 10); }
const SEAT_SLOTS = [0, 1, 2, 3];
let uiSeats = load('seats', null) || SEAT_SLOTS.map(defaultSeat);
if (!Array.isArray(uiSeats) || uiSeats.length < 4) uiSeats = SEAT_SLOTS.map((i) => uiSeats[i] || defaultSeat(i));
let seats = uiSeats.slice(0, playerCount).map((s) => ({ ...s }));

function isCpuSeat(i) { return !!(seats[i] && seats[i].type === 'cpu'); }
function seatLevel(i) { return (seats[i] && seats[i].level) || 'normal'; }

function renderSeatsPanel() {
  els.seatsPanel.innerHTML = '';
  for (let i = 0; i < playerCount; i++) {
    const seat = uiSeats[i];
    const row = document.createElement('div');
    row.className = 'seat-row';
    row.innerHTML = `<input class="seat-row__name" data-i="${i}" maxlength="10" inputmode="text">
      <div class="segmented seat-row__type">
        <button class="btn" data-i="${i}" data-type="human">人</button>
        <button class="btn" data-i="${i}" data-type="cpu">CPU</button>
      </div>
      <div class="segmented seat-row__level"${seat.type === 'cpu' ? '' : ' hidden'}>
        ${CPU.LEVELS.map((l) => `<button class="btn" data-i="${i}" data-level="${l.id}">${l.name}</button>`).join('')}
      </div>`;
    const nameInput = row.querySelector('.seat-row__name');
    nameInput.placeholder = `プレイヤー${i + 1}`;
    nameInput.value = seat.name || '';
    row.querySelector('[data-type="human"]').classList.toggle('is-selected', seat.type === 'human');
    row.querySelector('[data-type="cpu"]').classList.toggle('is-selected', seat.type === 'cpu');
    row.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('is-selected', b.dataset.level === seat.level));
    els.seatsPanel.appendChild(row);
  }
}
els.seatsPanel.addEventListener('click', (e) => {
  const typeBtn = e.target.closest('[data-type]');
  const levelBtn = e.target.closest('[data-level]');
  if (typeBtn) uiSeats[Number(typeBtn.dataset.i)].type = typeBtn.dataset.type;
  else if (levelBtn) uiSeats[Number(levelBtn.dataset.i)].level = levelBtn.dataset.level;
  else return;
  save('seats', uiSeats);
  renderSeatsPanel();
});
els.seatsPanel.addEventListener('change', (e) => {
  const input = e.target.closest('.seat-row__name');
  if (!input) return;
  const name = sanitizeName(input.value);
  uiSeats[Number(input.dataset.i)].name = name;
  input.value = name;
  save('seats', uiSeats);
});
renderSeatsPanel();

els.startBtn.addEventListener('click', () => {
  seats = uiSeats.slice(0, playerCount).map((s) => ({ ...s }));
  const names = seats.map((s) => s.name);
  game = E.createGame(playerCount, Math.random, { names });
  syncUiAfterAction();
  showGame();
  save('game', game);
  save('gameSeats', seats);
  renderAll();
});
els.continueBtn.addEventListener('click', () => {
  const saved = load('game', null);
  if (!saved || saved.rulesVersion !== 2 || saved.winners != null) return;
  game = saved;
  const savedSeats = load('gameSeats', null);
  seats = (savedSeats && savedSeats.length === game.playerCount) ? savedSeats : Array.from({ length: game.playerCount }, () => ({ type: 'human', level: 'normal' }));
  syncUiAfterAction();
  showGame();
  renderAll();
});
const homeBtn = document.getElementById('homeBtn');
function showGame() { els.setupPanel.hidden = true; els.gamePanel.hidden = false; homeBtn.hidden = false; }

// 続きがあれば「つづきから」を出す（自動では始めない。まずタイトルを見せる）。
// 保存の形が変わる前（rulesVersion!==2）のものは試作なので捨てる（9章）
function showContinue() {
  const saved = load('game', null);
  if (saved && saved.rulesVersion !== 2) save('game', null);
  const ok = saved && saved.rulesVersion === 2 && saved.winners == null;
  els.continueBtn.hidden = !ok;
  if (ok) els.continueBtn.textContent = `つづきから（ターン${saved.turnNumber}）`;
}
showContinue();

// タイトルへ戻る。盤は操作のたびに保存済みなので「つづきから」で戻れる
homeBtn.addEventListener('click', () => {
  if (rolling) return;
  clearTimeout(cpuTimer); cpuTimer = null;
  closePanel();
  game = null;
  els.gamePanel.hidden = true; els.setupPanel.hidden = false; homeBtn.hidden = true;
  showContinue();
});

function persistAndRender() { save('game', game); renderAll(); }

// 1つの操作が終わったあとに呼ぶ: 音を鳴らし、画面に出す ui.mode を今の phase/pendingChoice に合わせ、保存して描き直す
function finishAction() {
  playEvents();
  syncUiAfterAction();
  persistAndRender();
}
// 他人が選ぶ場面(pendingChoices)・捨て札・監査官・セットアップ・ゲーム終了のときは、ui.mode を強制的に合わせる。
// それ以外(event・roll・main)は、建てる物を選んでいる途中かもしれないので ui.mode をそのままにする
function syncUiAfterAction() {
  if (!game) { ui = { mode: 'idle', data: {} }; return; }
  const pc = E.pendingChoice(game);
  if (pc) {
    if (pc.kind === 'airPollutionHazard' || pc.kind === 'rainHazard') { ui = { mode: 'choiceHazard', data: { kind: pc.kind, player: pc.player } }; return; }
    if (pc.kind === 'prodIncrease') { ui = { mode: 'choiceProdVertex', data: { player: pc.player } }; return; }
    ui = { mode: 'choicePanel', data: { kind: pc.kind, player: pc.player } };
    return;
  }
  if (game.phase === 'gameOver') { ui = { mode: 'gameOver', data: {} }; return; }
  if (game.phase === 'setupTown' || game.phase === 'setupCity') { ui = { mode: game.setupPending === 'road' ? 'setupRoad' : 'setupTown', data: {} }; return; }
  if (game.phase === 'discard') { ui = { mode: 'discard', data: {} }; return; }
  if (game.phase === 'moveInspector') { ui = { mode: 'moveInspector', data: {} }; return; }
  ui = { mode: 'idle', data: {} };
}

function playEvents() {
  if (!game) return;
  const evts = game.events.splice(0, game.events.length);
  evts.forEach((e) => { if (SOUND[e]) SOUND[e](); });
  if (lastInspectorHex != null && game.inspectorHex !== lastInspectorHex) {
    inspectorMovedAt = Date.now();
    setTimeout(() => { if (game) renderAll(); }, 3100); // 点滅を止める
  }
  lastInspectorHex = game.inspectorHex;
  if (evts.includes('dice') && game.diceLast) {
    const hits = E.hitHexIds(game, game.diceLast[0] + game.diceLast[1]);
    if (hits.length) {
      diceHitHexes = hits; diceHitAt = performance.now();
      setTimeout(() => { if (game) renderAll(); }, 1600);
    }
  }
}

// ================================================================
// CPU の自動進行。人が追えるよう、手ごとに少し間をあけて1手ずつ進める。
// pendingChoices・捨て札・セットアップ・監査官・通常の手番、すべて CPU.step(game, levelFor) の1つで進む。
// ================================================================
const CPU_SPEEDS = [['ふつう', 650], ['はやい', 150], ['最速', 0]];
const cpuSpeedBtn = document.getElementById('cpuSpeedBtn');
let cpuSpeed = load('cpuSpeed', 0);
if (!CPU_SPEEDS[cpuSpeed]) cpuSpeed = 0;
function showCpuSpeed() { cpuSpeedBtn.textContent = 'CPU ' + CPU_SPEEDS[cpuSpeed][0]; }
showCpuSpeed();
cpuSpeedBtn.addEventListener('click', () => {
  cpuSpeed = (cpuSpeed + 1) % CPU_SPEEDS.length;
  save('cpuSpeed', cpuSpeed);
  showCpuSpeed();
});
// 遊び方ダイアログ(30秒でわかる短い説明)
const helpDialog = document.getElementById('helpDialog');
document.getElementById('helpBtn').addEventListener('click', () => helpDialog.showModal());
document.getElementById('helpCloseBtn').addEventListener('click', () => helpDialog.close());
helpDialog.addEventListener('click', (e) => { if (e.target === helpDialog) helpDialog.close(); });

let cpuTimer = null;
// 今、CPUが何か答えるべきか(人の番なら false)
function nextIsCpu() {
  if (!game || game.phase === 'gameOver') return false;
  const pc = E.pendingChoice(game);
  if (pc) return isCpuSeat(pc.player);
  if (game.phase === 'discard') return game.pendingDiscards.some((d) => isCpuSeat(d.player));
  return isCpuSeat(E.currentPlayer(game));
}
function humanToAct() { return !!game && game.phase !== 'gameOver' && !nextIsCpu(); }
function scheduleCpu() {
  if (cpuTimer || !game) return;
  if (!nextIsCpu()) return;
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    CPU.step(game, (i) => seatLevel(i));
    finishAction();
    scheduleCpu();
  }, CPU_SPEEDS[cpuSpeed][1]);
}

// ================================================================
// 盤面の描画
// ================================================================
const svgNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) {
  const n = document.createElementNS(svgNS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
  if (parent) parent.appendChild(n);
  return n;
}
function ensureDefs(svg) {
  let defs = svg.querySelector('defs');
  if (!defs) { defs = el('defs', {}); defs.innerHTML = I.defsMarkup(svg.id); svg.appendChild(defs); }
  return defs;
}
function hexCenterPx(g, hex) {
  const vs = hex.vertexIds.map((id) => g.board.vertices[id]);
  const cx = vs.reduce((a, v) => a + v.x, 0) / vs.length;
  const cy = vs.reduce((a, v) => a + v.y, 0) / vs.length;
  return [cx * SCALE, cy * SCALE];
}
function hexPointsPx(g, hex) {
  return hex.vertexIds.map((id) => { const v = g.board.vertices[id]; return [v.x * SCALE, v.y * SCALE]; });
}
function viewBoxOf(g) {
  const xs = g.board.vertices.map((v) => v.x * SCALE);
  const ys = g.board.vertices.map((v) => v.y * SCALE);
  const margin = SCALE * 1.15;
  const minX = Math.min(...xs) - margin, maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - margin, maxY = Math.max(...ys) + margin;
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

// ---- 発電所を置ける場所(ui用の候補探し。engine.js 内部の判定を画面側でも再現する) ----
function plantHexesForVertex(idx, vid, kind) {
  const v = game.board.vertices[vid];
  if (!v.building || v.building.owner !== idx) return [];
  const existing = game.board.plants.filter((p) => p.vertexId === vid);
  const limit = v.building.type === 'city' ? 3 : 1;
  if (existing.length >= limit) return [];
  const owned = game.board.plants.filter((p) => p.owner === idx && p.kind === kind).length;
  const max = kind === 'fossil' ? E.MAX_FOSSIL : E.MAX_RENEWABLE;
  if (owned >= max) return [];
  return v.hexIds.filter((hId) => {
    const hex = game.board.hexes[hId];
    return hex && hex.number != null && !existing.some((p) => p.hexId === hId);
  });
}
function plantVertices(idx, kind) {
  if (game.plantBuiltThisTurn) return [];
  const p = game.players[idx];
  return [...p.towns, ...p.cities].filter((vid) => plantHexesForVertex(idx, vid, kind).length > 0);
}
// 生産増加イベント: 1手番1つの制限は数えない(科学も要らない)が、建物・容量・化石の持ち駒上限は同じ
function prodHexesForVertex(idx, vid) {
  const v = game.board.vertices[vid];
  if (!v.building || v.building.owner !== idx) return [];
  const existing = game.board.plants.filter((p) => p.vertexId === vid);
  const limit = v.building.type === 'city' ? 3 : 1;
  if (existing.length >= limit) return [];
  if (game.board.plants.filter((p) => p.owner === idx && p.kind === 'fossil').length >= E.MAX_FOSSIL) return [];
  return v.hexIds.filter((hId) => {
    const hex = game.board.hexes[hId];
    return hex && hex.number != null && !existing.some((p) => p.hexId === hId);
  });
}
function prodVertices(idx) {
  const p = game.players[idx];
  return [...p.towns, ...p.cities].filter((vid) => prodHexesForVertex(idx, vid).length > 0);
}
// ハザードを選んで置く場面(大気汚染・豪雨と洪水)の候補頂点
function hazardChoiceVertices(kind, playerIdx) {
  const p = game.players[playerIdx];
  const openCities = p.cities.filter((v) => !E.vertexHasHazard(game, v));
  const openTowns = p.towns.filter((v) => !E.vertexHasHazard(game, v));
  if (kind === 'airPollutionHazard') return openCities.length ? openCities : openTowns;
  return [...openTowns, ...openCities];
}

function renderBoardInto(svg, g, uiState) {
  const defs = ensureDefs(svg);
  [...svg.children].forEach((c) => { if (c !== defs) c.remove(); });
  const vb = viewBoxOf(g);
  svg.setAttribute('viewBox', `${vb.minX} ${vb.minY} ${vb.w} ${vb.h}`);

  const S = []; // 塗りの図形（順に描く）
  const labels = []; // 文字
  const overlay = []; // タップ判定の実要素（色の図形より後に乗せる）
  const queue = (tag, attrs) => overlay.push({ tag, attrs });

  // 波（飾り。毎回同じ並びでよい）
  for (let k = 0; k < 26; k++) {
    const x = vb.minX + ((k * 137 + 40) % Math.max(1, vb.w));
    const y = vb.minY + ((k * 71 + 20) % Math.max(1, vb.h));
    I.add(S, `M${x},${y} q7,-5 14,0 t14,0`, 'none', 0.18, '#bfe6ee', 1.5);
    I.tag(S, S.length - 1, 'a-wave', x, y, -k * 0.6);
  }
  // 浅瀬と砂浜のふち
  const allHexPath = g.board.hexes.map((h) => I.poly(hexPointsPx(g, h))).join(' ');
  I.add(S, allHexPath, '#5fb7b5', 0.25, '#5fb7b5', 66);
  I.tag(S, S.length - 1, 'a-surf', 0, 0, 0);
  I.add(S, allHexPath, '#e7d3a1', 1, '#e7d3a1', 30);
  I.add(S, allHexPath, '#cdb683', 1, '#cdb683', 12);

  // タイル本体
  g.board.hexes.forEach((hex) => {
    const [cx, cy] = hexCenterPx(g, hex);
    const pts = hexPointsPx(g, hex);
    const style = I.TERRAIN_STYLE[hex.terrain];
    const shrink = (p, k) => p.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
    I.add(S, I.poly(shrink(pts, 0.98)), style.edge);
    I.add(S, I.poly(shrink(pts, 0.94)), `url(#${svg.id}-g-${style.grad})`);
    I.add(S, I.poly(shrink(pts, 0.88)), 'none', 0.22, '#ffffff', 1.5);
    I.terrainDecor(S, hex.terrain, cx, cy);
    if (hex.number != null) {
      const hot = hex.number === 6 || hex.number === 8;
      I.add(S, I.ell(cx + 1, cy + 3, 19, 19), '#000', 0.28);
      I.add(S, I.ell(cx, cy, 18, 18), `url(#${svg.id}-g-token)`, 1, '#c7b58b', 1.2);
      labels.push({ x: cx, y: cy - 3, t: String(hex.number), f: hot ? '#b8321f' : '#2a211b', s: hot ? 21 : 19, w: 700 });
      const dots = 6 - Math.abs(7 - hex.number);
      for (let d = 0; d < dots; d++) I.add(S, I.ell(cx - (dots - 1) * 2.4 + d * 4.8, cy + 10, 1.3, 1.3), hot ? '#b8321f' : '#2a211b');
    }
    if (hex.id === g.inspectorHex) { // 環境監査官の地形は目印(砂と同じ暗い輪)を薄く重ねる
      I.add(S, I.poly(shrink(pts, 0.98)), '#000', 0.18);
    }
    if (E.hexHasHazard(g, hex.id)) {
      I.add(S, I.ell(cx + 22, cy - 22, 10, 10), '#8a2a1e', 1, '#1b1612', 1.4);
      labels.push({ x: cx + 22, y: cy - 19, t: '!', f: '#ffd8c0', s: 13, w: 700 });
    }
  });

  // 港（銀行との交換レートの札）
  g.board.portEdgeIds.forEach((eId) => {
    const e = g.board.edges[eId];
    const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
    const mx = (v1.x + v2.x) / 2 * SCALE, my = (v1.y + v2.y) / 2 * SCALE;
    const [hx, hy] = hexCenterPx(g, g.board.hexes[e.hexIds[0]]);
    const nx = mx - hx, ny = my - hy, len = Math.hypot(nx, ny) || 1;
    const px = mx + (nx / len) * (SCALE * Math.sqrt(3) / 2), py = my + (ny / len) * (SCALE * Math.sqrt(3) / 2);
    const type = v1.port;
    const isAny = type === '3:1';
    const bg = isAny ? '#f6eedb' : RES_COLOR[type];
    [v1, v2].forEach((v) => {
      I.add(S, I.line(v.x * SCALE, v.y * SCALE, px, py), 'none', 1, '#6e5436', 7);
      I.add(S, I.line(v.x * SCALE, v.y * SCALE, px, py), 'none', 1, '#9a7a52', 3);
    });
    I.add(S, I.ell(px, py + 2, 18, 18), '#000', 0.25);
    I.add(S, I.ell(px, py, 18, 18), '#f6eedb', 1, isAny ? '#b9a980' : bg, 3);
    labels.push({ x: px, y: isAny ? py : py - 4, t: isAny ? '3:1' : '2:1', f: '#2a211b', s: 13, w: 700 });
    if (!isAny) labels.push({ x: px, y: py + 8, t: E.RESOURCE_LABEL[type], f: bg, s: 10, w: 700 });
  });

  // サイコロの当たり演出
  if (svg === els.board && diceHitHexes.length && performance.now() < diceHitAt + 1500) {
    g.board.hexes.forEach((hex) => {
      if (!diceHitHexes.includes(hex.id)) I.add(S, I.poly(hexPointsPx(g, hex)), '#000', 0.35);
    });
    const n = S.length;
    diceHitHexes.forEach((id) => I.add(S, I.poly(hexPointsPx(g, g.board.hexes[id])), 'none', 1, '#fff6c8', 6));
    I.tag(S, n, 'tile-hit-blink', 0, 0, diceHitAt / 1000);
  }

  // 道（既存＋置ける場所）
  const buildableEdges = uiState && (uiState.mode === 'setupRoad' || uiState.mode === 'buildRoad' || uiState.mode === 'devRoad')
    ? new Set(edgeChoices()) : new Set();
  g.board.edges.forEach((edge) => {
    const v1 = g.board.vertices[edge.v1], v2 = g.board.vertices[edge.v2];
    const x1 = v1.x * SCALE, y1 = v1.y * SCALE, x2 = v2.x * SCALE, y2 = v2.y * SCALE;
    const tx1 = x1 + (x2 - x1) * 0.1, ty1 = y1 + (y2 - y1) * 0.1;
    const tx2 = x1 + (x2 - x1) * 0.9, ty2 = y1 + (y2 - y1) * 0.9;
    if (edge.road != null) {
      const color = g.players[edge.road].color;
      I.add(S, I.line(tx1 + 1, ty1 + 3, tx2 + 1, ty2 + 3), 'none', 0.3, '#000', 10);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, '#1b1612', 10);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, color, 6);
      I.add(S, I.line(tx1, ty1 - 1, tx2, ty2 - 1), 'none', 0.35, '#ffffff', 1.5);
    } else if (buildableEdges.has(edge.id)) {
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, '#1b1612', 9);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 0.85, 'var(--accent)', 5);
      queue('line', { x1, y1, x2, y2, class: 'road-hit', 'data-edge': edge.id });
    } else {
      queue('line', { x1, y1, x2, y2, stroke: 'rgba(255,255,255,0.14)', 'stroke-width': 2.5 });
    }
  });

  // 頂点（町・都市・発電所・ハザード・置ける場所）
  const idx = E.currentPlayer(g);
  const buildableVerts = uiState && uiState.mode === 'setupTown' ? new Set(vertexChoices('setupTown'))
    : uiState && uiState.mode === 'buildTown' ? new Set(vertexChoices('buildTown'))
    : new Set();
  const cityTargets = uiState && uiState.mode === 'buildCity' ? new Set(g.players[idx].towns) : new Set();
  const plantMode = uiState && (uiState.mode === 'buildPlantFossil' || uiState.mode === 'buildPlantRenewable');
  const plantTargets = plantMode ? new Set(plantVertices(idx, uiState.mode === 'buildPlantFossil' ? 'fossil' : 'renewable')) : new Set();
  const plantHexMode = uiState && uiState.mode === 'buildPlantHex';
  const prodVertexMode = uiState && uiState.mode === 'choiceProdVertex';
  const prodTargets = prodVertexMode ? new Set(prodVertices(uiState.data.player)) : new Set();
  const prodHexMode = uiState && uiState.mode === 'choiceProdHex';
  const hazardMode = uiState && uiState.mode === 'choiceHazard';
  const hazardTargets = hazardMode ? new Set(hazardChoiceVertices(uiState.data.kind, uiState.data.player)) : new Set();
  g.board.vertices.forEach((v) => {
    const x = v.x * SCALE, y = v.y * SCALE;
    if (v.building) {
      const color = g.players[v.building.owner].color;
      const dark = I.tint(color, -0.4), light = I.tint(color, 0.35);
      if (v.building.type === 'city') I.city(S, x, y, color, dark, light); else I.house(S, x, y, color, dark, light);
      const plants = g.board.plants.filter((pl) => pl.vertexId === v.id);
      plants.forEach((pl, i) => {
        const pc = pl.kind === 'fossil' ? '#6b6056' : '#3f8a4a';
        I.add(S, I.ell(x + 11 + i * 9, y - 11, 6.5, 6.5), pc, 1, '#1b1612', 1.2);
        labels.push({ x: x + 11 + i * 9, y: y - 8, t: '⚡', f: '#f0cf4a', s: 9, w: 700 });
      });
      if (E.vertexHasHazard(g, v.id)) {
        I.add(S, I.ell(x - 13, y - 11, 6.5, 6.5), '#8a2a1e', 1, '#1b1612', 1.2);
        labels.push({ x: x - 13, y: y - 8, t: '!', f: '#ffd8c0', s: 11, w: 700 });
      }
      if (cityTargets.has(v.id) || (plantMode && plantTargets.has(v.id)) || (prodVertexMode && prodTargets.has(v.id)) || (hazardMode && hazardTargets.has(v.id))) {
        I.add(S, I.ell(x, y, 17, 17), 'none', 1, '#f0cf85', 2.5);
        queue('circle', { cx: x, cy: y, r: 15, class: 'vertex-hit', 'data-vertex': v.id });
      }
    } else if (buildableVerts.has(v.id)) {
      I.add(S, I.ell(x, y, 15, 15), '#f0cf85', 0.3);
      I.add(S, I.ell(x, y, 9, 9), '#f0cf85', 0.6, '#fff3cf', 2.5);
      queue('circle', { cx: x, cy: y, r: 12, class: 'vertex-hit', 'data-vertex': v.id });
    }
  });
  // 発電所を建てる地形・生産増加の地形(2段目の候補)
  if ((plantHexMode || prodHexMode) && uiState.data.vertexId != null) {
    const vid = uiState.data.vertexId;
    const hexList = plantHexMode ? plantHexesForVertex(idx, vid, uiState.data.kind) : prodHexesForVertex(uiState.data.player, vid);
    hexList.forEach((hId) => {
      const hex = g.board.hexes[hId];
      const pts = hexPointsPx(g, hex).map(([x, y]) => `${x},${y}`).join(' ');
      queue('polygon', { points: pts, class: 'hex-target', 'data-hex': hId });
    });
  }
  // 環境監査官を動かせる地形
  if (uiState && (uiState.mode === 'moveInspector' || uiState.mode === 'cleanupMoveInspectorHex')) {
    g.board.hexes.forEach((hex) => {
      if (hex.id === g.inspectorHex) return;
      const pts = hexPointsPx(g, hex).map(([x, y]) => `${x},${y}`).join(' ');
      queue('polygon', { points: pts, class: 'hex-target', 'data-hex': hex.id });
    });
  }

  // 環境監査官（基本カタンの盗賊にあたる。点滅させるので別の <g> に入れる）
  const inspectorShapes = [];
  const [ix, iy] = hexCenterPx(g, g.board.hexes[g.inspectorHex]);
  I.robber(inspectorShapes, ix + 2, iy + 14, 1.15);
  const inspectorBlink = svg === els.board && (g.phase === 'moveInspector' || Date.now() < inspectorMovedAt + 3000);
  if (inspectorBlink) I.add(inspectorShapes, I.ell(ix + 2, iy + 2, 26, 26), 'none', 1, '#ffd84a', 4);

  S.forEach((s) => svg.appendChild(pathEl(s)));
  const inspectorG = el('g', { class: inspectorBlink ? 'robber-blink' : '' });
  inspectorShapes.forEach((s) => inspectorG.appendChild(pathEl(s)));
  svg.appendChild(inspectorG);
  labels.forEach((l) => {
    const n = el('text', {
      x: l.x, y: l.y, fill: l.f, class: 'hex-number',
      style: `font-family:'Fraunces',serif;font-size:${l.s}px;font-weight:${l.w};text-anchor:middle;dominant-baseline:central`,
    }, svg);
    n.textContent = l.t;
  });
  overlay.forEach((o) => el(o.tag, o.attrs, svg));
}

function vertexChoices(mode) {
  const idx = E.currentPlayer(game);
  if (mode === 'setupTown') return E.availableTownVertices(game, idx, true);
  if (mode === 'buildTown') return E.availableTownVertices(game, idx, false);
  return [];
}
function edgeChoices() {
  const idx = E.currentPlayer(game);
  if (ui.mode === 'setupRoad') return game.board.vertices[game.setupLastVertex].edgeIds.filter((eId) => game.board.edges[eId].road == null);
  return E.availableRoadEdges(game, idx);
}

// ================================================================
// プレイヤー一覧・銀行・汚染(GF)とイベントの状況
// ================================================================
function renderPlayers() {
  const idx = E.currentPlayer(game);
  els.playersBar.innerHTML = '';
  game.players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = `player-card${i === idx ? ' is-turn' : ''}`;
    const light = I.tint(p.color, 0.45), dark = I.tint(p.color, -0.35);
    const dot = document.createElement('div');
    dot.className = 'player-card__dot';
    dot.style.background = `radial-gradient(circle at 35% 30%, ${light}, ${p.color} 60%, ${dark})`;
    dot.textContent = String(i + 1);
    const body = document.createElement('div');
    body.className = 'player-card__body';
    const bonus = [];
    if (game.longestRoadPlayer === i) bonus.push('最長交易路');
    if (game.cleanestPlayer === i) bonus.push('最もクリーンな環境');
    const cpuTag = isCpuSeat(i) ? `CPU・${CPU.LEVELS.find((l) => l.id === seatLevel(i))?.name || ''}` : '人';
    const fossil = game.board.plants.filter((pl) => pl.owner === i && pl.kind === 'fossil').length;
    const renew = game.board.plants.filter((pl) => pl.owner === i && pl.kind === 'renewable').length;
    body.innerHTML = `<div class="player-card__name"><span class="player-card__nametext">${p.name}</span>${i === idx ? '<span class="player-card__cur">手番</span>' : ''}</div>`
      + `<div class="player-card__sub">${cpuTag}・LF${E.localFootprint(game, i)}・発電 化石${fossil}/再生${renew}${p.warehouse ? '・倉庫' : ''}</div>`
      + `<div class="player-card__extra">${bonus.join('・')}</div>`;
    const pips = document.createElement('div');
    pips.className = 'energy-pips';
    for (let k = 0; k < E.ENERGY_MAX; k++) {
      const pip = document.createElement('span');
      pip.className = `energy-pip${k < (p.energy || 0) ? ' is-filled' : ''}`;
      pips.appendChild(pip);
    }
    body.appendChild(pips);
    const vp = document.createElement('div');
    vp.className = 'player-card__vp';
    vp.innerHTML = `<b>${E.playerScore(game, i)}</b><span>点</span>`;
    card.append(dot, body, vp);
    els.playersBar.appendChild(card);
  });
}

function renderBank() {
  els.bankPanel.innerHTML = `<div class="bank__head"><span>銀行</span><span>発展カード 残り ${game.bank.devDeck.length}</span></div>`;
  const grid = document.createElement('div');
  grid.className = 'bank__grid';
  E.RESOURCES.forEach((r) => {
    const cell = document.createElement('div');
    cell.className = 'bank__res';
    cell.appendChild(resIcon(r));
    const b = document.createElement('b');
    b.textContent = game.bank.resources[r];
    cell.appendChild(b);
    grid.appendChild(cell);
  });
  const sci = document.createElement('div');
  sci.className = 'bank__res';
  sci.appendChild(resIcon('science'));
  const sb = document.createElement('b'); sb.textContent = game.bank.science;
  sci.appendChild(sb);
  grid.appendChild(sci);
  els.bankPanel.appendChild(grid);
}

const EVENT_KEYS = ['envPollution', 'rain', 'funding', 'airPollution', 'prodIncrease', 'climate', 'sustainable'];
const BROWN_EVENTS = new Set(['envPollution', 'rain', 'airPollution', 'prodIncrease']);
function renderStatus() {
  const gf = E.globalFootprint(game);
  const max = E.GF_RANGE[game.playerCount] || E.GF_RANGE[4];
  const draws = E.drawsFor(game);
  els.statusPanel.innerHTML = `<div class="panel__head"><span>島のようす</span><span>袋 残り${game.bag.length}</span></div>
    <div class="bank__head"><span>汚染(GF)</span><span>${gf} / ${max}・引く数×${draws}</span></div>
    <div class="pollution-bar"><div class="pollution-bar__fill" style="width:${Math.min(100, gf / max * 100)}%"></div></div>`;
  EVENT_KEYS.forEach((k) => {
    const total = E.EVENT_SPACES[k];
    const filled = game.tracks[k];
    const row = document.createElement('div');
    row.className = `event-row${BROWN_EVENTS.has(k) || k === 'climate' ? ' is-brown' : ''}`;
    const dots = document.createElement('span');
    dots.className = 'event-row__dots';
    for (let i = 0; i < total; i++) {
      const d = document.createElement('span');
      d.className = `event-row__dot${i < filled ? ' is-filled' : ''}`;
      dots.appendChild(d);
    }
    row.innerHTML = `<span>${E.EVENT_LABEL[k]}</span>`;
    row.appendChild(dots);
    els.statusPanel.appendChild(row);
  });
}

function renderHand() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  els.handBar.innerHTML = '';
  E.RESOURCES.forEach((r) => {
    const cell = document.createElement('div');
    cell.className = 'hand__res';
    cell.appendChild(resIcon(r));
    const b = document.createElement('b');
    b.textContent = `×${p.resources[r]}`;
    cell.appendChild(b);
    els.handBar.appendChild(cell);
  });
  const sci = document.createElement('div');
  sci.className = 'hand__res';
  sci.appendChild(resIcon('science'));
  const sb = document.createElement('b'); sb.textContent = `×${p.science}`;
  sci.appendChild(sb);
  els.handBar.appendChild(sci);
  const extra = document.createElement('div');
  extra.className = 'hand__extra';
  extra.textContent = `発展カード ${p.devCards.length}枚`;
  els.handBar.appendChild(extra);
  const total = E.RESOURCES.reduce((a, r) => a + p.resources[r], 0) + p.science;
  els.handCount.textContent = `${total} 枚`;
}

function renderDice() {
  if (rolling) return;
  els.diceBox.innerHTML = '';
  if (!game.diceLast) return;
  els.diceBox.appendChild(dieEl(game.diceLast[0], -8));
  els.diceBox.appendChild(dieEl(game.diceLast[1], 7));
}

function renderBanner() {
  const idx = E.currentPlayer(game);
  let main = '', hint = '';
  if (game.winners != null) {
    main = game.winners.length ? `${game.winners.map((i) => game.players[i].name).join('・')}の勝ち！` : '袋が尽きて、島の全員が負け……';
  } else if (game.phase === 'setupTown' || game.phase === 'setupCity') {
    main = `${game.players[idx].name}の番。`;
    hint = game.setupPending === 'road' ? '道を置く場所をタップ。' : (game.phase === 'setupCity' ? '都市を置く場所をタップ。' : '町を置く場所をタップ。');
  } else if (game.phase === 'event') { main = `${game.players[idx].name}の手番。`; hint = '発展カードを使うか、イベントを引いてください。'; }
  else if (game.phase === 'roll') { main = `${game.players[idx].name}の手番。`; hint = 'サイコロを振ってください。'; }
  else if (game.phase === 'discard') { const d = game.pendingDiscards[0]; main = `${game.players[d.player].name}は${d.count}枚捨てます。`; hint = '窓で捨てる物を選んでください。'; }
  else if (game.phase === 'moveInspector') { main = `${game.players[idx].name}の番。`; hint = '監査官を動かす地形をタップ。'; }
  else if (game.diceLast) main = `サイコロ ${game.diceLast[0]}＋${game.diceLast[1]}＝${game.diceLast[0] + game.diceLast[1]}。`;
  const pc = E.pendingChoice(game);
  if (pc) {
    const name = game.players[pc.player].name;
    if (pc.kind === 'airPollutionHazard') hint = `${name}: ハザードを置く建物をタップ。`;
    else if (pc.kind === 'rainHazard') hint = `${name}: ハザードを置く建物をタップ。`;
    else if (pc.kind === 'prodIncrease') hint = `${name}: 化石燃料発電所をただで建てる町・都市をタップ(建てなくてもよい)。`;
    else if (pc.kind === 'climateGain' || pc.kind === 'sustainableGain') hint = `${name}: 窓でもらう物を選んでください。`;
    else if (pc.kind === 'climateDiscard') hint = `${name}: 窓で捨てる物を選んでください。`;
  }
  if (game.winners == null && !pc && game.phase !== 'discard' && isCpuSeat(idx)) hint = `CPU（${CPU.LEVELS.find((l) => l.id === seatLevel(idx))?.name || ''}）が考えています…`;
  if (ui.mode === 'buildRoad') hint = '道を置く場所をタップ。';
  else if (ui.mode === 'buildTown') hint = '町を置く場所をタップ。';
  else if (ui.mode === 'buildCity') hint = '都市にする町をタップ。';
  else if (ui.mode === 'buildPlantFossil') hint = '化石燃料発電所を建てる町・都市をタップ。';
  else if (ui.mode === 'buildPlantRenewable') hint = '再生可能発電所を建てる町・都市をタップ。';
  else if (ui.mode === 'buildPlantHex') hint = '発電所を置く地形をタップ。';
  else if (ui.mode === 'choiceProdHex') hint = '発電所を置く地形をタップ。';
  else if (ui.mode === 'devRoad') hint = `道路建設: 残り${game.freeRoadsRemaining}本。道を置く場所をタップ。`;
  els.hint.textContent = hint;
  const lastLog = game.log[game.log.length - 1];
  els.banner.innerHTML = `<div>${main}</div>` + (lastLog ? `<div class="message__log">ひとつ前: ${lastLog}</div>` : '');
  els.turnNum.textContent = String(game.turnNumber);
}

// ================================================================
// 建てるもの
// ================================================================
function costRow(cost) {
  const wrap = document.createElement('span');
  wrap.className = 'build-btn__cost';
  Object.entries(cost).forEach(([r, n]) => {
    const pair = document.createElement('span');
    pair.className = 'cost-pair';
    pair.appendChild(resIcon(r));
    const s = document.createElement('span');
    s.textContent = `×${n}`;
    pair.appendChild(s);
    wrap.appendChild(pair);
  });
  return wrap;
}
function canAfford(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }
function canAffordSci(p, cost) { return (p.science || 0) >= (cost.science || 0); }

const BUILD_MODE = { road: 'buildRoad', town: 'buildTown', city: 'buildCity', plantFossil: 'buildPlantFossil', plantRenewable: 'buildPlantRenewable' };
function renderBuildGrid() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const inMain = game.phase === 'main' && humanToAct();
  const defs = [
    { key: 'road', label: '道', cost: E.COSTS.road, ok: inMain && p.roads.length < E.MAX_ROADS && canAfford(p.resources, E.COSTS.road) && E.availableRoadEdges(game, idx).length },
    { key: 'town', label: '町', cost: E.COSTS.town, ok: inMain && p.towns.length < E.MAX_TOWNS && canAfford(p.resources, E.COSTS.town) && E.availableTownVertices(game, idx, false).length },
    { key: 'city', label: '都市', cost: E.COSTS.city, ok: inMain && p.cities.length < E.MAX_CITIES && p.towns.length && canAfford(p.resources, E.COSTS.city) },
    { key: 'plantFossil', label: '化石発電所', cost: E.PLANT_COSTS.fossil, ok: inMain && canAffordSci(p, E.PLANT_COSTS.fossil) && plantVertices(idx, 'fossil').length },
    { key: 'plantRenewable', label: '再生発電所', cost: E.PLANT_COSTS.renewable, ok: inMain && canAffordSci(p, E.PLANT_COSTS.renewable) && plantVertices(idx, 'renewable').length },
    { key: 'devCard', label: '発展カード', cost: E.COSTS.dev, ok: inMain && game.bank.devDeck.length > 0 && canAfford(p.resources, E.COSTS.dev) },
    { key: 'warehouse', label: '倉庫', cost: { energy: E.WAREHOUSE_ENERGY_COST }, ok: inMain && !p.warehouse && (p.energy || 0) >= E.WAREHOUSE_ENERGY_COST },
  ];
  els.buildGrid.innerHTML = '';
  defs.forEach((d) => {
    const btn = document.createElement('button');
    const active = ui.mode === BUILD_MODE[d.key];
    btn.className = `build-btn${active ? ' is-selected' : ''}`;
    btn.disabled = !d.ok;
    btn.appendChild(buildIcon(d.key, p.color));
    const label = document.createElement('span');
    label.className = 'build-btn__label';
    label.textContent = d.label;
    btn.appendChild(label);
    if (d.key === 'warehouse') { const e = document.createElement('span'); e.className = 'build-btn__cost'; e.textContent = `⚡×${E.WAREHOUSE_ENERGY_COST}`; btn.appendChild(e); }
    else btn.appendChild(costRow(d.cost));
    btn.addEventListener('click', () => {
      if (d.key === 'devCard') { if (E.buyDevCard(game)) finishAction(); return; }
      if (d.key === 'warehouse') { if (E.buildWarehouse(game)) finishAction(); return; }
      if (active) { ui = { mode: 'idle', data: {} }; renderAll(); return; }
      ui = { mode: BUILD_MODE[d.key], data: {} };
      renderAll();
    });
    els.buildGrid.appendChild(btn);
  });
}

// ================================================================
// 操作パネル（画面中央の窓。交易・捨てる・発展カード・他人が選ぶ場面など）
// ================================================================
function openPanel() { els.panelOverlay.hidden = false; }
function closePanel() { els.panelOverlay.hidden = true; els.panel.innerHTML = ''; }
function bindPanel(actions) {
  els.panel.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const fn = actions[btn.dataset.act];
    if (fn) fn(btn);
  };
}

function renderPanel() {
  if (ui.mode === 'discard' && game.phase === 'discard') {
    const d = game.pendingDiscards.find((x) => !isCpuSeat(x.player));
    if (d) { openPanel(); renderDiscardPanel(d); } else closePanel();
    return;
  }
  if (ui.mode === 'choicePanel') { openPanel(); renderChoicePanel(); return; }
  if (ui.mode === 'moveInspectorTarget' || ui.mode === 'cleanupMoveInspectorTarget') { openPanel(); renderInspectorTargetPanel(); return; }
  if (ui.mode === 'tradeMenu') { openPanel(); renderTradeMenu(); return; }
  if (ui.mode === 'devMenu') { openPanel(); renderDevMenu(); return; }
  if (ui.mode === 'devHighYield') { openPanel(); renderHighYieldPanel(); return; }
  if (ui.mode === 'devResearchGrant') { openPanel(); renderResearchGrantPanel(); return; }
  if (ui.mode === 'devCleanup') { openPanel(); renderCleanupPanel(); return; }
  if (ui.mode === 'energyMenu') { openPanel(); renderEnergyMenu(); return; }
  if (ui.mode === 'gameOver' || game.winners != null) { openPanel(); renderGameOverPanel(); return; }
  closePanel();
}

const DISCARD_KEYS = [...E.RESOURCES, 'science'];
function renderDiscardPanel(d) {
  const p = game.players[d.player];
  const picked = ui.data.discardPicked || (ui.data.discardPicked = DISCARD_KEYS.reduce((o, r) => ({ ...o, [r]: 0 }), {}));
  const total = Object.values(picked).reduce((a, b) => a + b, 0);
  els.panel.innerHTML = `<h2>${p.name}: ${d.count}枚捨てる（あと${d.count - total}枚）</h2>`
    + DISCARD_KEYS.map((r) => `<div class="sheet__row"><span class="res-pick__label" data-row="${r}">持ち${r === 'science' ? p.science : p.resources[r]}</span>
        <span class="stepper">
          <button data-act="dec" data-res="${r}">−</button><b>${picked[r]}</b>
          <button data-act="inc" data-res="${r}">＋</button>
        </span></div>`).join('')
    + `<button class="btn btn--accent" data-act="confirm" ${total === d.count ? '' : 'disabled'}>捨てる</button>`;
  DISCARD_KEYS.forEach((r) => { els.panel.querySelector(`[data-row="${r}"]`).prepend(resIcon(r)); });
  bindPanel({
    inc: (b) => { const r = b.dataset.res; const have = r === 'science' ? p.science : p.resources[r]; if (picked[r] < have && total < d.count) { picked[r]++; renderPanel(); } },
    dec: (b) => { const r = b.dataset.res; if (picked[r] > 0) { picked[r]--; renderPanel(); } },
    confirm: () => {
      E.discardCards(game, d.player, picked);
      ui.data.discardPicked = null;
      finishAction();
    },
  });
}

// 他人が選ぶ場面: 気候会議(もらう/捨てる)・持続可能な生産(もらう)。資源か科学を1種選ぶだけの窓
const CHOICE_TITLE = { climateGain: '資源か科学を1枚もらう', climateDiscard: '資源か科学を1枚捨てる', sustainableGain: '資源か科学を1枚もらう（持続可能な生産）' };
function renderChoicePanel() {
  const { kind, player } = ui.data;
  const p = game.players[player];
  const isDiscard = kind === 'climateDiscard';
  const resolver = kind === 'climateGain' ? E.resolveClimateGain : kind === 'climateDiscard' ? E.resolveClimateDiscard : E.resolveSustainableGain;
  const kinds = [...E.RESOURCES, 'science'];
  const enabled = (k) => (isDiscard ? (k === 'science' ? p.science : p.resources[k]) > 0 : (k === 'science' ? game.bank.science : game.bank.resources[k]) > 0);
  els.panel.innerHTML = `<h2>${p.name}: ${CHOICE_TITLE[kind]}</h2><div class="res-pick" data-row="pick"></div>`;
  const row = els.panel.querySelector('[data-row="pick"]');
  kinds.forEach((k) => {
    const b = document.createElement('button');
    b.dataset.act = 'pick'; b.dataset.k = k;
    b.disabled = !enabled(k);
    b.appendChild(resIcon(k));
    row.appendChild(b);
  });
  if (!kinds.some(enabled)) {
    const skip = document.createElement('button');
    skip.className = 'btn btn--accent';
    skip.dataset.act = 'skip';
    skip.textContent = '選べるものがない（飛ばす）';
    els.panel.appendChild(skip);
  }
  bindPanel({
    pick: (b) => { resolver(game, player, b.dataset.k); finishAction(); },
    skip: () => { E.skipPendingChoice(game, player); finishAction(); },
  });
}

// 監査官を動かした先に町・都市が2人以上いるときに、奪う相手を選ぶ窓（7の処理・クリーンアップ共通）
function renderInspectorTargetPanel() {
  const { hexId, targets } = ui.data;
  const isCleanup = ui.mode === 'cleanupMoveInspectorTarget';
  els.panel.innerHTML = `<h2>誰から1枚もらう？</h2>`
    + targets.map((t) => `<button class="card-btn" data-act="pick" data-target="${t}">${game.players[t].name}</button>`).join('');
  bindPanel({
    pick: (b) => {
      const target = Number(b.dataset.target);
      const ok = isCleanup ? E.playCleanupMoveInspector(game, hexId, target) : E.moveInspector(game, hexId, target);
      if (ok) finishAction();
    },
  });
}

const BANK_GIVE_WANT = [...E.RESOURCES, 'science'];
function renderTradeMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const give = ui.data.tradeGive || (ui.data.tradeGive = BANK_GIVE_WANT[0]);
  const want = ui.data.tradeWant || (ui.data.tradeWant = BANK_GIVE_WANT[1]);
  const rate = E.tradeRate(game, idx, give);
  const giveHave = give === 'science' ? p.science : p.resources[give];
  const other = ui.data.tradeOther == null ? (idx + 1) % game.playerCount : ui.data.tradeOther;
  const TKEYS = [...E.RESOURCES, 'science', 'energy'];
  const pGive = ui.data.pGive || (ui.data.pGive = TKEYS.reduce((o, r) => ({ ...o, [r]: 0 }), {}));
  const pGet = ui.data.pGet || (ui.data.pGet = TKEYS.reduce((o, r) => ({ ...o, [r]: 0 }), {}));
  const validPlayerTrade = playerTradeValid(pGive, pGet, other);

  els.panel.innerHTML = `<h2>銀行・港と交易</h2>
    <div class="sheet__row"><span>出す（${rate}枚で1枚、持ち${giveHave}）</span><div class="res-pick" data-row="give"></div></div>
    <div class="sheet__row"><span>もらう</span><div class="res-pick" data-row="want"></div></div>
    <button class="btn btn--accent" data-act="bank" ${giveHave >= rate && give !== want ? '' : 'disabled'}>${rate}:1で交易する</button>
    <hr style="border-color:rgba(255,255,255,0.15)">
    <h2>相手と交易（資源・科学・エネルギーを自由に）</h2>
    <div class="sheet__row"><span>相手</span><div class="res-pick" data-row="other"></div></div>
    <div class="sheet__row"><span>自分が出す</span></div>
    <div class="trade-steppers" data-row="pgive"></div>
    <div class="sheet__row"><span>相手からもらう</span></div>
    <div class="trade-steppers" data-row="pget"></div>
    <button class="btn btn--accent" data-act="playerTrade" ${validPlayerTrade ? '' : 'disabled'}>この内容で成立させる</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;

  fillResPick(els.panel.querySelector('[data-row="give"]'), BANK_GIVE_WANT, (r) => r === give, (r, b) => b.appendChild(resIcon(r)), 'give');
  fillResPick(els.panel.querySelector('[data-row="want"]'), BANK_GIVE_WANT, (r) => r === want, (r, b) => b.appendChild(resIcon(r)), 'want');
  fillOtherPick(els.panel.querySelector('[data-row="other"]'), other);
  fillStepperRow(els.panel.querySelector('[data-row="pgive"]'), pGive, TKEYS, 'pg');
  fillStepperRow(els.panel.querySelector('[data-row="pget"]'), pGet, TKEYS, 'pw');

  bindPanel({
    give: (b) => { ui.data.tradeGive = b.dataset.res; renderPanel(); },
    want: (b) => { ui.data.tradeWant = b.dataset.res; renderPanel(); },
    other: (b) => { ui.data.tradeOther = Number(b.dataset.p); renderPanel(); },
    pginc: (b) => { const r = b.dataset.res; const have = r === 'science' ? p.science : r === 'energy' ? p.energy : p.resources[r]; if (pGive[r] < have) { pGive[r]++; renderPanel(); } },
    pgdec: (b) => { const r = b.dataset.res; if (pGive[r] > 0) { pGive[r]--; renderPanel(); } },
    pwinc: (b) => { const r = b.dataset.res; const other2 = game.players[other]; const have = r === 'science' ? other2.science : r === 'energy' ? other2.energy : other2.resources[r]; if (pGet[r] < have) { pGet[r]++; renderPanel(); } },
    pwdec: (b) => { const r = b.dataset.res; if (pGet[r] > 0) { pGet[r]--; renderPanel(); } },
    bank: () => { E.bankTrade(game, idx, give, want); ui.data.tradeGive = null; ui.data.tradeWant = null; playEvents(); persistAndRender(); renderPanel(); },
    playerTrade: () => {
      if (isCpuSeat(other)) {
        if (CPU.acceptTrade(game, other, pGive, pGet)) {
          E.playerTrade(game, other, pGive, pGet);
          game.log.push(`${game.players[other].name}が交易を受けました`);
        } else {
          game.log.push(`${game.players[other].name}は交易を断りました`);
        }
      } else {
        E.playerTrade(game, other, pGive, pGet);
      }
      ui.data.pGive = null; ui.data.pGet = null;
      playEvents(); persistAndRender(); renderPanel();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function playerTradeValid(give, get, other) {
  const idx = E.currentPlayer(game);
  const me = game.players[idx], ot = game.players[other];
  const keys = [...E.RESOURCES, 'science', 'energy'];
  const handOf = (pl, k) => (k === 'science' ? pl.science : k === 'energy' ? pl.energy : (pl.resources[k] || 0));
  const giveTotal = keys.reduce((a, k) => a + (give[k] || 0), 0);
  const getTotal = keys.reduce((a, k) => a + (get[k] || 0), 0);
  if (giveTotal <= 0 || getTotal <= 0) return false;
  if (keys.some((k) => (give[k] || 0) > 0 && (get[k] || 0) > 0)) return false;
  if (keys.some((k) => handOf(me, k) < (give[k] || 0))) return false;
  if (keys.some((k) => handOf(ot, k) < (get[k] || 0))) return false;
  if (handOf(me, 'energy') - (give.energy || 0) + (get.energy || 0) > E.ENERGY_MAX) return false;
  if (handOf(ot, 'energy') - (get.energy || 0) + (give.energy || 0) > E.ENERGY_MAX) return false;
  return true;
}
function fillResPick(container, list, isSelected, build, act) {
  list.forEach((r) => {
    const b = document.createElement('button');
    b.dataset.act = act; b.dataset.res = r;
    if (isSelected(r)) b.classList.add('is-selected');
    build(r, b);
    container.appendChild(b);
  });
}
function fillOtherPick(container, other) {
  const idx = E.currentPlayer(game);
  game.players.forEach((_, i) => {
    if (i === idx) return;
    const b = document.createElement('button');
    b.dataset.act = 'other'; b.dataset.p = i;
    if (i === other) b.classList.add('is-selected');
    b.textContent = `${game.players[i].name}` + (isCpuSeat(i) ? '（CPU）' : '');
    container.appendChild(b);
  });
}
function fillStepperRow(container, obj, keys, prefix) {
  keys.forEach((r) => {
    const span = document.createElement('span');
    span.className = 'stepper';
    span.appendChild(resIcon(r));
    const dec = document.createElement('button'); dec.dataset.act = `${prefix}dec`; dec.dataset.res = r; dec.textContent = '−';
    const b = document.createElement('b'); b.textContent = obj[r];
    const inc = document.createElement('button'); inc.dataset.act = `${prefix}inc`; inc.dataset.res = r; inc.textContent = '＋';
    span.append(dec, b, inc);
    container.appendChild(span);
  });
}

// ---- 発展カード ----
function renderDevMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const canPlay = game.phase === 'main' || (game.phase === 'event' && !game.eventDrawStarted);
  const cards = p.devCards.filter((c) => c.boughtTurn !== game.turnNumber);
  const counts = {};
  cards.forEach((c) => { counts[c.type] = (counts[c.type] || 0) + 1; });
  els.panel.innerHTML = `<h2>発展カード（${p.devCards.length}枚）</h2>`
    + Object.keys(E.DEV_LABEL).map((t) => `<button class="card-btn" data-act="play" data-type="${t}" ${(!canPlay || game.devCardPlayedThisTurn || !counts[t] || t === 'vp') ? 'disabled' : ''}>
        ${E.DEV_LABEL[t]} ×${counts[t] || 0}</button>`).join('')
    + `<p style="opacity:.7;font-size:12px">勝利点カードは手札に隠れたまま点に数えます。買った手番には使えません。</p>`
    + `<button class="ghost-btn" data-act="cancel">とじる</button>`;
  bindPanel({
    play: (b) => {
      const t = b.dataset.type;
      if (t === 'roadBuilding') { if (E.playRoadBuildingCard(game)) { ui = { mode: 'devRoad', data: {} }; playEvents(); persistAndRender(); } return; }
      if (t === 'highYield') { ui = { mode: 'devHighYield', data: { picked: [] } }; renderAll(); return; }
      if (t === 'researchGrant') { ui = { mode: 'devResearchGrant', data: { picked: [] } }; renderAll(); return; }
      if (t === 'cleanup') { ui = { mode: 'devCleanup', data: {} }; renderAll(); return; }
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renewableHexesOf(idx) { return [...new Set(game.board.plants.filter((pl) => pl.owner === idx && pl.kind === 'renewable').map((pl) => pl.hexId))]; }
function renderHighYieldPanel() {
  const idx = E.currentPlayer(game);
  const hexes = renewableHexesOf(idx);
  const picked = ui.data.picked;
  els.panel.innerHTML = `<h2>豊作: 再生可能発電所の地形を3つまで選ぶ（${picked.length}/3）</h2>`
    + hexes.map((h) => `<button class="card-btn" data-act="toggle" data-hex="${h}">${E.TERRAIN_LABEL[game.board.hexes[h].terrain]}${picked.includes(h) ? ' ✓' : ''}</button>`).join('')
    + `<button class="btn btn--accent" data-act="confirm" ${picked.length ? '' : 'disabled'}>この地形でもらう</button>`
    + `<button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    toggle: (b) => {
      const h = Number(b.dataset.hex);
      const i = picked.indexOf(h);
      if (i >= 0) picked.splice(i, 1); else if (picked.length < 3) picked.push(h);
      renderPanel();
    },
    confirm: () => { if (E.playHighYieldCard(game, picked)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderResearchGrantPanel() {
  const picked = ui.data.picked;
  const kinds = [...E.RESOURCES, 'science'];
  els.panel.innerHTML = `<h2>研究補助金: 資源・科学を好きに2枚（${picked.length}/2）</h2><div class="res-pick" data-row="pick"></div>
    <button class="btn btn--accent" data-act="confirm" ${picked.length === 2 ? '' : 'disabled'}>もらう</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  const row = els.panel.querySelector('[data-row="pick"]');
  kinds.forEach((k) => {
    const b = document.createElement('button');
    b.dataset.act = 'pick'; b.dataset.k = k;
    b.disabled = picked.length >= 2;
    b.appendChild(resIcon(k));
    row.appendChild(b);
  });
  const p = document.createElement('p');
  picked.forEach((k) => p.appendChild(resIcon(k)));
  els.panel.appendChild(p);
  bindPanel({
    pick: (b) => { if (picked.length < 2) { picked.push(b.dataset.k); renderPanel(); } },
    confirm: () => { if (E.playResearchGrantCard(game, picked)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
// クリーンアップ: 監査官を動かす(盤をタップ)か、ハザードを外して1枚もらう(ここで選ぶ)
function allHazardTargets() {
  const out = [];
  game.hazards.hexes.forEach((h) => out.push({ hexId: h, label: `地形(${E.TERRAIN_LABEL[game.board.hexes[h].terrain]})` }));
  game.hazards.vertices.forEach((v) => out.push({ vertexId: v, label: `${game.players[game.board.vertices[v].building.owner].name}の${game.board.vertices[v].building.type === 'city' ? '都市' : '町'}` }));
  return out;
}
function renderCleanupPanel() {
  const idx = E.currentPlayer(game);
  const myLf = E.localFootprint(game, idx);
  const victims = game.players.map((_, i) => i).filter((i) => E.localFootprint(game, i) >= myLf);
  const targets = allHazardTargets();
  const t = ui.data.target, v = ui.data.victim;
  els.panel.innerHTML = `<h2>クリーンアップ: ハザードを外して1枚もらう</h2>
    ${targets.length ? targets.map((x, i) => `<button class="card-btn${t === i ? ' is-selected' : ''}" data-act="target" data-i="${i}">${x.label}</button>`).join('') : '<p>今は外せるハザードがありません。</p>'}
    <div class="sheet__row"><span>もらう相手</span><div class="res-pick" data-row="victim"></div></div>
    <button class="btn btn--accent" data-act="confirm" ${t != null && v != null ? '' : 'disabled'}>この内容で使う</button>
    <hr style="border-color:rgba(255,255,255,0.15)">
    <h2>または: 監査官を動かす</h2>
    <button class="ghost-btn" data-act="moveInspector">盤で監査官を動かす場所を選ぶ</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  fillResPick(els.panel.querySelector('[data-row="victim"]'), victims, (i) => i === v, (i, b) => { b.textContent = game.players[i].name; b.dataset.i = i; }, 'victim');
  bindPanel({
    target: (b) => { ui.data.target = Number(b.dataset.i); renderPanel(); },
    victim: (b) => { ui.data.victim = Number(b.dataset.i); renderPanel(); },
    confirm: () => {
      const target = targets[ui.data.target];
      if (E.playCleanupRemoveHazard(game, target, ui.data.victim)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    },
    moveInspector: () => { ui = { mode: 'cleanupMoveInspectorHex', data: {} }; renderAll(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// ---- エネルギーの使い道（資源/科学をもらう・ハザードを外す・化石を壊す） ----
function renderEnergyMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const kinds = [...E.RESOURCES, 'science'];
  const hazards = allHazardTargets();
  const ownFossil = game.board.plants.map((pl, i) => ({ pl, i })).filter(({ pl }) => pl.owner === idx && pl.kind === 'fossil');
  els.panel.innerHTML = `<h2>エネルギー（持ち${p.energy || 0}）</h2>
    <h2 style="font-size:14px">⚡${E.ENERGY_TRADE_COST} → 資源か科学を1枚</h2>
    <div class="res-pick" data-row="gain"></div>
    <h2 style="font-size:14px">⚡${E.ENERGY_DEMOLISH_COST} → ハザードを1つ外す（自分以外の物でもよい）</h2>
    ${hazards.length ? hazards.map((x, i) => `<button class="card-btn" data-act="clear" data-i="${i}" ${(p.energy || 0) < E.ENERGY_DEMOLISH_COST ? 'disabled' : ''}>${x.label}</button>`).join('') : '<p>今は外せるハザードがありません。</p>'}
    <h2 style="font-size:14px">⚡${E.ENERGY_DEMOLISH_COST} → 自分の化石燃料発電所を1つ壊す（1手番1回）</h2>
    ${ownFossil.length ? ownFossil.map(({ i }) => `<button class="card-btn" data-act="demolish" data-i="${i}" ${(game.demolishedThisTurn || (p.energy || 0) < E.ENERGY_DEMOLISH_COST) ? 'disabled' : ''}>地形(${E.TERRAIN_LABEL[game.board.hexes[game.board.plants[i].hexId].terrain]})の化石燃料発電所</button>`).join('') : '<p>自分の化石燃料発電所がありません。</p>'}
    <button class="ghost-btn" data-act="cancel">とじる</button>`;
  const row = els.panel.querySelector('[data-row="gain"]');
  kinds.forEach((k) => {
    const b = document.createElement('button');
    b.dataset.act = 'gain'; b.dataset.k = k;
    b.disabled = (p.energy || 0) < E.ENERGY_TRADE_COST;
    b.appendChild(resIcon(k));
    row.appendChild(b);
  });
  bindPanel({
    gain: (b) => { if (E.useEnergyForResource(game, idx, b.dataset.k)) { playEvents(); persistAndRender(); renderPanel(); } },
    clear: (b) => { if (E.useEnergyToClearHazard(game, idx, hazards[Number(b.dataset.i)])) { playEvents(); persistAndRender(); renderPanel(); } },
    demolish: (b) => { if (E.demolishFossilPlant(game, idx, Number(b.dataset.i))) { playEvents(); persistAndRender(); renderPanel(); } },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

function renderGameOverPanel() {
  const reason = game.endReason === 'bag'
    ? '袋が尽きました。' + (game.winners.length ? '再生可能発電所が化石燃料発電所より多い人のうち、差が一番大きい人が勝ちです。' : '再生可能発電所が化石燃料発電所より多い人がいませんでした。')
    : `${game.winners.map((i) => game.players[i].name).join('・')}が10点に到達しました。`;
  const rows = game.players.map((p, i) => {
    const fossil = game.board.plants.filter((pl) => pl.owner === i && pl.kind === 'fossil').length;
    const renew = game.board.plants.filter((pl) => pl.owner === i && pl.kind === 'renewable').length;
    const win = game.winners.includes(i);
    return `<div class="sheet__row"><span>${win ? '★ ' : ''}${p.name}</span><span>${E.playerScore(game, i)}点・再生${renew}/化石${fossil}</span></div>`;
  }).join('');
  els.panel.innerHTML = `<h2>${game.winners.length ? game.winners.map((i) => game.players[i].name).join('・') + 'の勝ち！' : '全員の負け……'}</h2>
    <p>${reason}</p>${rows}
    <button class="btn btn--accent" data-act="close">とじる</button>`;
  bindPanel({ close: () => { closePanel(); } });
}

// ================================================================
// 操作ボタン（手番の段階ごとに出すものを変える）
// ================================================================
function renderActionBar() {
  const canAct = humanToAct() && game.winners == null;
  const inEvent = game.phase === 'event';
  const inRoll = game.phase === 'roll';
  const inMain = game.phase === 'main';
  els.diceBtn.hidden = !inEvent && !inRoll;
  els.diceBtn.textContent = inEvent ? `イベントを引く（残り${game.drawsLeft}）` : 'サイコロ';
  els.diceBtn.disabled = !canAct || rolling || !(inEvent || inRoll) || (inEvent && game.drawsLeft <= 0);
  const p = game.players[E.currentPlayer(game)];
  const canPlayDev = !game.devCardPlayedThisTurn && (inMain || (inEvent && !game.eventDrawStarted)) && p.devCards.some((c) => c.boughtTurn !== game.turnNumber && c.type !== 'vp');
  els.devBtn.hidden = !(inEvent || inMain);
  els.devBtn.textContent = `発展カードを使う${p.devCards.length ? ` (${p.devCards.length})` : ''}`;
  els.devBtn.disabled = !canAct || !canPlayDev;
  els.tradeBtn.hidden = !inMain;
  els.tradeBtn.disabled = !canAct || !inMain;
  els.energyBtn.hidden = !inMain;
  els.energyBtn.disabled = !canAct || !inMain || (p.energy || 0) < 1;
  els.endTurnBtn.hidden = !inMain;
  els.endTurnBtn.disabled = !canAct || !inMain;
}
els.diceBtn.addEventListener('click', () => {
  if (!humanToAct()) return;
  if (game.phase === 'event') { if (E.drawEventDisc(game, Math.random)) finishAction(); return; }
  if (game.phase !== 'roll') return;
  const finish = () => { rolling = false; E.rollDice(game); finishAction(); };
  if (document.documentElement.classList.contains('motion-off')) { finish(); return; }
  rolling = true;
  els.diceBtn.disabled = true;
  const face = () => 1 + Math.floor(Math.random() * 6);
  let delay = 40;
  const spin = () => {
    els.diceBox.innerHTML = '';
    els.diceBox.appendChild(dieEl(face(), Math.random() * 60 - 30));
    els.diceBox.appendChild(dieEl(face(), Math.random() * 60 - 30));
    beep(500 + Math.random() * 300, 0.03);
    delay *= 1.25;
    if (delay < 260) setTimeout(spin, delay); else finish();
  };
  spin();
});
els.tradeBtn.addEventListener('click', () => { if (!humanToAct()) return; ui = { mode: 'tradeMenu', data: {} }; renderAll(); });
els.devBtn.addEventListener('click', () => { if (!humanToAct()) return; ui = { mode: 'devMenu', data: {} }; renderAll(); });
els.energyBtn.addEventListener('click', () => { if (!humanToAct()) return; ui = { mode: 'energyMenu', data: {} }; renderAll(); });
els.endTurnBtn.addEventListener('click', () => {
  if (!humanToAct()) return;
  E.endTurn(game);
  ui = { mode: 'idle', data: {} };
  finishAction();
});

// ================================================================
// 盤面のタップ
// ================================================================
els.board.addEventListener('click', (e) => {
  if (!humanToAct()) return;
  const vEl = e.target.closest('[data-vertex]');
  const eEl = e.target.closest('[data-edge]');
  const hEl = e.target.closest('[data-hex]');
  if (vEl) return onVertexTap(Number(vEl.dataset.vertex));
  if (eEl) return onEdgeTap(Number(eEl.dataset.edge));
  if (hEl) return onHexTap(Number(hEl.dataset.hex));
});

function onVertexTap(vid) {
  if (ui.mode === 'setupTown') { if (E.setupPlaceBuilding(game, vid)) finishAction(); return; }
  if (ui.mode === 'buildTown') { if (E.buildTown(game, vid)) { ui = { mode: 'idle', data: {} }; finishAction(); } return; }
  if (ui.mode === 'buildCity') {
    if (game.players[E.currentPlayer(game)].towns.includes(vid) && E.buildCity(game, vid)) { ui = { mode: 'idle', data: {} }; finishAction(); }
    return;
  }
  if (ui.mode === 'buildPlantFossil' || ui.mode === 'buildPlantRenewable') {
    const idx = E.currentPlayer(game);
    const kind = ui.mode === 'buildPlantFossil' ? 'fossil' : 'renewable';
    if (!plantHexesForVertex(idx, vid, kind).length) return;
    ui = { mode: 'buildPlantHex', data: { kind, vertexId: vid } };
    renderAll();
    return;
  }
  if (ui.mode === 'choiceHazard') {
    const { kind, player } = ui.data;
    const fn = kind === 'airPollutionHazard' ? E.resolveAirPollutionHazard : E.resolveRainHazard;
    if (fn(game, player, vid)) finishAction();
    return;
  }
  if (ui.mode === 'choiceProdVertex') {
    const { player } = ui.data;
    if (!prodHexesForVertex(player, vid).length) return;
    ui = { mode: 'choiceProdHex', data: { player, vertexId: vid } };
    renderAll();
  }
}
function onEdgeTap(eid) {
  if (ui.mode === 'setupRoad') { if (E.setupPlaceRoad(game, eid)) finishAction(); return; }
  if (ui.mode === 'buildRoad') { if (E.buildRoad(game, eid)) { ui = { mode: 'idle', data: {} }; finishAction(); } return; }
  if (ui.mode === 'devRoad') {
    if (E.useFreeRoadFromCard(game, eid)) {
      if (game.freeRoadsRemaining <= 0) { ui = { mode: 'idle', data: {} }; finishAction(); } else { playEvents(); persistAndRender(); }
    }
  }
}
function onHexTap(hid) {
  if (ui.mode === 'moveInspector') {
    if (hid === game.inspectorHex) return;
    const idx = E.currentPlayer(game);
    const targets = E.inspectorTargets(game, hid, idx);
    if (targets.length > 1) { ui = { mode: 'moveInspectorTarget', data: { hexId: hid, targets } }; renderAll(); return; }
    if (E.moveInspector(game, hid, targets[0] ?? 0)) finishAction();
    return;
  }
  if (ui.mode === 'cleanupMoveInspectorHex') {
    if (hid === game.inspectorHex) return;
    const idx = E.currentPlayer(game);
    const targets = E.inspectorTargets(game, hid, idx);
    if (targets.length > 1) { ui = { mode: 'cleanupMoveInspectorTarget', data: { hexId: hid, targets } }; renderAll(); return; }
    if (E.playCleanupMoveInspector(game, hid, targets[0] ?? 0)) { ui = { mode: 'idle', data: {} }; finishAction(); }
    return;
  }
  if (ui.mode === 'buildPlantHex') {
    const { kind, vertexId } = ui.data;
    if (E.buildPlant(game, vertexId, hid, kind)) { ui = { mode: 'idle', data: {} }; finishAction(); }
    return;
  }
  if (ui.mode === 'choiceProdHex') {
    const { player, vertexId } = ui.data;
    if (E.resolveProdIncrease(game, player, vertexId, hid)) finishAction();
  }
}

// ================================================================
// まとめて描画
// ================================================================
renderBoardInto(els.titleBoard, E.createGame(4, Math.random), null);

function renderAll() {
  if (!game) return;
  renderBoardInto(els.board, game, ui);
  renderDice();
  renderPlayers();
  renderBank();
  renderStatus();
  renderHand();
  renderBuildGrid();
  renderBanner();
  renderActionBar();
  renderPanel();
  scheduleCpu();
}
