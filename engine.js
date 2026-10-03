'use strict';
// 発電所と汚染の開拓ボードゲーム（試作）のルール・盤面・得点計算（画面・音・localStorage に触らない）。
// ブラウザ（main.js が import）からのみ使う。状態は 1 つのオブジェクト game に持たせ、
// 操作はすべて game を直接書き換える関数として export する（イミュータブルにはしない。1 台で交代するだけの試作のため）。
// 音を鳴らすべきこと（サイコロ・建設・盗みなど）は game.events に積む。鳴らすかどうかは main.js が決める。
//
// 作業1（土台）の範囲: 準備・産出・7・建設・銀行交易・最長交易路・勝利判定だけ。
// 発電所・エネルギー・汚染・ハザード・イベント・発展カードの中身・CPU・画面はまだ対応しない
// （docs/private/specs/catan-energy.md の作業2以降。main.js・cpu.js は今回のままで、新しい engine には合っていない）。

export const RESOURCES = ['lumber', 'brick', 'fiber', 'food', 'steel'];
export const RESOURCE_LABEL = { lumber: '木材', brick: 'レンガ', fiber: '繊維', food: '食料', steel: '鉄鋼' };
export const TERRAIN_LABEL = { forest: '森', hills: '丘', pasture: '牧草地', field: '畑', mountains: '山', desert: '砂漠' };
const TERRAIN_RESOURCE = { forest: 'lumber', hills: 'brick', pasture: 'fiber', field: 'food', mountains: 'steel', desert: null };
const TERRAIN_COUNTS = { forest: 4, hills: 3, pasture: 4, field: 4, mountains: 3, desert: 1 };
// 渦巻き（外周から中心へ）の順に置く数字。基本カタンの固定配置と同じ並び（仕様 0 章）。砂漠はとばす
const NUMBER_SPIRAL_ORDER = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];
const PORT_TYPES = ['3:1', '3:1', '3:1', '3:1', 'lumber', 'brick', 'fiber', 'food', 'steel'];
const BANK_START = 19; // 資源1種あたりの銀行の枚数
const SCIENCE_START = 20; // 科学カードの銀行の枚数

export const COSTS = {
  road: { lumber: 1, brick: 1 },
  town: { lumber: 1, brick: 1, fiber: 1, food: 1 },
  city: { steel: 3, food: 2 },
  dev: { food: 1, fiber: 1, steel: 1 },
};
export const MAX_ROADS = 12, MAX_TOWNS = 5, MAX_CITIES = 4;
export const PLANT_COSTS = { fossil: { science: 1 }, renewable: { science: 3 } };
export const MAX_FOSSIL = 6, MAX_RENEWABLE = 9;
export const ENERGY_MAX = 5;
export const ENERGY_TRADE_COST = 2; // エネルギー2 → 資源か科学1
export const ENERGY_DEMOLISH_COST = 1; // エネルギー1 → 自分の化石燃料発電所を1つ壊す
export const WAREHOUSE_ENERGY_COST = 2;
export const HAZARD_SUPPLY = 10;
export const GF_RANGE = { 3: 21, 4: 28 }; // トラックの上限（0章A。3人側は未確定の仮値）
export const DRAW_TABLE = { // [下限, 上限, 引く枚数]（0章A）
  4: [[0, 5, 2], [6, 18, 1], [19, 23, 2], [24, 28, 3]],
  3: [[0, 5, 2], [6, 13, 1], [14, 17, 2], [18, 21, 3]],
};

export const DEV_COUNTS = { roadBuilding: 2, highYield: 2, researchGrant: 2, vp: 5, cleanup: 14 }; // 合計25
export const DEV_LABEL = { roadBuilding: '道路建設', highYield: '豊作', researchGrant: '研究補助金', vp: '勝利点', cleanup: 'クリーンアップ' };
export const CLEANEST_THRESHOLD = 3; // クリーンアップを3枚使うと「最もクリーンな環境」(2点)

// イベントの袋・マス（0章B・RB p.9〜10）
export const EVENT_LABEL = {
  climate: '気候会議', envPollution: '環境汚染', airPollution: '大気汚染',
  prodIncrease: '生産増加', rain: '豪雨と洪水', funding: '政府の補助金', sustainable: '持続可能な生産',
};
export const EVENT_SPACES = { climate: 3, envPollution: 4, airPollution: 3, prodIncrease: 3, rain: 4, funding: 4, sustainable: 3 };
const BROWN_DISC_COUNTS = { climate: 9, envPollution: 8, airPollution: 9, prodIncrease: 9, rain: 8 }; // 袋の初期43枚
const GREEN_UNMARKED_COUNTS = { climate: 3, sustainable: 12, funding: 12 }; // 27枚（3人用はこれだけ使う）
const GREEN_4P_ONLY_COUNTS = { climate: 1, sustainable: 4, funding: 4 }; // 4人のときだけ足す9枚（合計36枚）

export const PLAYER_COLORS = ['#e0553f', '#3f7ee0', '#f0c43c', '#46a86a', '#8a5cc9', '#2bb0b0'];

const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]; // 隣の軸座標の差

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function round3(n) { return Math.round(n * 1000) / 1000; }
function emptyResources() { return { lumber: 0, brick: 0, fiber: 0, food: 0, steel: 0 }; }
function sumRes(o) { return RESOURCES.reduce((a, k) => a + (o[k] || 0), 0); }
function sumHand(p) { return sumRes(p.resources) + (p.science || 0); }
function canAfford(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }
function payCost(res, cost) { Object.entries(cost).forEach(([k, v]) => { res[k] -= v; }); }

// ================================================================
// 盤面の生成: 軸座標の六角形（半径2 = 19枚、3〜4人用の基本盤だけ）。頂点・辺は六角形の角の座標を
// 丸めてキーにし、隣り合うタイルで同じ頂点・辺を共有させる（重複させない）。
// ================================================================
function hexCorner(cx, cy, i) {
  const deg = 60 * i - 30; // pointy-top（頂点が上下にくる向き）
  const rad = (Math.PI / 180) * deg;
  return [round3(cx + Math.cos(rad)), round3(cy + Math.sin(rad))];
}
function hexCenter(q, r) { return [round3(Math.sqrt(3) * (q + r / 2)), round3(1.5 * r)]; }

function buildGeometry(hexes) {
  const vKeyToId = new Map();
  const vertices = [];
  const eKeyToId = new Map();
  const edges = [];
  function vertexAt(cx, cy, i) {
    const [x, y] = hexCorner(cx, cy, i);
    const key = `${x},${y}`;
    let id = vKeyToId.get(key);
    if (id == null) {
      id = vertices.length;
      vKeyToId.set(key, id);
      vertices.push({ id, x, y, hexIds: [], edgeIds: [], neighbors: [], port: null, building: null });
    }
    return id;
  }
  function edgeBetween(va, vb, hexId) {
    const key = va < vb ? `${va}-${vb}` : `${vb}-${va}`;
    let id = eKeyToId.get(key);
    if (id == null) {
      id = edges.length;
      eKeyToId.set(key, id);
      edges.push({ id, v1: va, v2: vb, hexIds: [], road: null });
      vertices[va].edgeIds.push(id);
      vertices[vb].edgeIds.push(id);
      vertices[va].neighbors.push(vb);
      vertices[vb].neighbors.push(va);
    }
    edges[id].hexIds.push(hexId);
    return id;
  }
  hexes.forEach((hex) => {
    const [cx, cy] = hexCenter(hex.q, hex.r);
    const corners = [0, 1, 2, 3, 4, 5].map((i) => vertexAt(cx, cy, i));
    corners.forEach((va, i) => {
      const vb = corners[(i + 1) % 6];
      const eId = edgeBetween(va, vb, hex.id);
      hex.edgeIds.push(eId);
    });
    corners.forEach((vid) => { if (!vertices[vid].hexIds.includes(hex.id)) vertices[vid].hexIds.push(hex.id); });
    hex.vertexIds = corners;
  });
  return { vertices, edges };
}

// 外周の辺を、頂点でつながる順に並べる（港をだいたい等間隔に置くため）
function orderedBoundary(edges) {
  const boundary = edges.filter((e) => e.hexIds.length === 1);
  const byVertex = new Map();
  boundary.forEach((e) => {
    [e.v1, e.v2].forEach((v) => { if (!byVertex.has(v)) byVertex.set(v, []); byVertex.get(v).push(e.id); });
  });
  const order = [];
  const seen = new Set();
  let cur = boundary[0];
  let fromVertex = cur.v1;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    order.push(cur.id);
    const nextVertex = cur.v1 === fromVertex ? cur.v2 : cur.v1;
    const candidates = byVertex.get(nextVertex).filter((id) => id !== cur.id);
    const nextId = candidates[0];
    cur = boundary.find((e) => e.id === nextId);
    fromVertex = nextVertex;
  }
  return order;
}

function boardCoords() {
  const coords = [];
  for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) if (q + r >= -2 && q + r <= 2) coords.push({ q, r });
  return coords;
}

// 半径 dist の輪を、隣り合う順に並べて返す（6×dist マス、dist=0 は中心の1マス）
function hexRing(dist) {
  if (dist === 0) return [{ q: 0, r: 0 }];
  let hex = { q: HEX_DIRS[4][0] * dist, r: HEX_DIRS[4][1] * dist };
  const out = [];
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < dist; j++) {
      out.push(hex);
      hex = { q: hex.q + HEX_DIRS[i][0], r: hex.r + HEX_DIRS[i][1] };
    }
  }
  return out;
}
// 渦巻き＝外周の輪→内側の輪→中心、の順に並べた19マスの座標
function spiralCoords() { return [...hexRing(2), ...hexRing(1), ...hexRing(0)]; }

function buildBoard(rng) {
  const coords = boardCoords();
  const terrainPool = shuffle(Object.entries(TERRAIN_COUNTS).flatMap(([t, n]) => Array(n).fill(t)), rng);
  const hexes = coords.map((c, i) => ({
    id: i, q: c.q, r: c.r, terrain: terrainPool[i], number: null, edgeIds: [], vertexIds: [],
  }));
  const byCoord = new Map(hexes.map((h) => [`${h.q},${h.r}`, h]));
  let numIdx = 0;
  spiralCoords().forEach(({ q, r }) => {
    const hex = byCoord.get(`${q},${r}`);
    if (hex && hex.terrain !== 'desert') hex.number = NUMBER_SPIRAL_ORDER[numIdx++];
  });
  const desert = hexes.find((h) => h.terrain === 'desert');

  const { vertices, edges } = buildGeometry(hexes);
  const boundary = orderedBoundary(edges);
  const portTypes = shuffle(PORT_TYPES, rng);
  const portEdgeIds = [];
  portTypes.forEach((type, i) => {
    const edgeId = boundary[Math.round((i * boundary.length) / portTypes.length)];
    const edge = edges[edgeId];
    vertices[edge.v1].port = type;
    vertices[edge.v2].port = type;
    portEdgeIds.push(edgeId);
  });
  return { hexes, vertices, edges, inspectorHex: desert.id, portEdgeIds };
}

function buildDevDeck(rng) {
  return shuffle(Object.entries(DEV_COUNTS).flatMap(([t, n]) => Array(n).fill(t)), rng);
}
function buildEventBag(rng) {
  return shuffle(Object.entries(BROWN_DISC_COUNTS).flatMap(([t, n]) => Array(n).fill(t)), rng);
}
// 再生可能発電所の下に伏せて配る緑ディスク（1人9枚）。3人は4人用印の9枚を抜いた27枚、4人は36枚から配る
function buildGreenPool(playerCount, rng) {
  const counts = { ...GREEN_UNMARKED_COUNTS };
  if (playerCount === 4) Object.entries(GREEN_4P_ONLY_COUNTS).forEach(([t, n]) => { counts[t] += n; });
  return shuffle(Object.entries(counts).flatMap(([t, n]) => Array(n).fill(t)), rng);
}

// ================================================================
// ゲームの状態
// ================================================================
export function createGame(playerCount, rng = Math.random, options = {}) {
  const board = buildBoard(rng);
  const names = options.names || [];
  const greenPool = buildGreenPool(playerCount, rng);
  const players = Array.from({ length: playerCount }, (_, i) => ({
    idx: i,
    name: names[i] || `プレイヤー${i + 1}`,
    color: PLAYER_COLORS[i],
    resources: emptyResources(),
    science: 0,
    energy: 0,
    warehouse: false,
    devCards: [], // { type, boughtTurn }（イベントでもらった分は boughtTurn: null）
    cleanupPlayed: 0, // クリーンアップカードを使った枚数（最もクリーンな環境の判定）
    greenDiscs: greenPool.slice(i * 9, i * 9 + 9), // 自分の再生可能発電所の下に伏せた9枚（建てるたび1枚ずつ袋へ）
    roads: [], towns: [], cities: [],
    roadLength: 0,
  }));
  board.plants = []; // { owner, kind:'fossil'|'renewable', vertexId, hexId }
  const setupOrder = Array.from({ length: playerCount }, (_, i) => i); // 1周目は順に。2周目は逆順にする
  return {
    rulesVersion: 2, // 古い保存（エネルギー版「風」の試作）を見分ける
    playerCount,
    players,
    board,
    bank: {
      resources: { lumber: BANK_START, brick: BANK_START, fiber: BANK_START, food: BANK_START, steel: BANK_START },
      science: SCIENCE_START,
      devDeck: buildDevDeck(rng),
    },
    phase: 'setupTown', // setupTown → setupCity → event → roll → discard → moveInspector → main → gameOver
    setupOrder,
    setupIndex: 0,
    setupPending: 'building', // 'building' | 'road'
    setupLastVertex: null,
    turn: setupOrder[0],
    turnNumber: 1,
    diceLast: null,
    devCardPlayedThisTurn: false,
    plantBuiltThisTurn: false, // 化石+再生で1手番1つ（イベントで建てる分は数えない）
    demolishedThisTurn: false, // 化石を壊すのは1手番1回
    freeRoadsRemaining: 0, // 道路建設カードぶんの、ただで置ける道の残り数
    inspectorHex: board.inspectorHex,
    hazards: { hexes: [], vertices: [] }, // 地形id・交点idの配列。在庫は HAZARD_SUPPLY
    pendingDiscards: [], // [{ player, count }]
    bag: buildEventBag(rng), // 残りの茶のディスク（種類名の配列）。再生可能発電所を建てるたびに緑ディスクが足される
    tracks: { climate: 0, envPollution: 0, airPollution: 0, prodIncrease: 0, rain: 0, funding: 0, sustainable: 0 }, // マスに置いた数
    drawsLeft: 0, // この手番にあと何枚引くか（手番の初めのGFで決め、途中で変えない）
    eventDrawStarted: false, // 1枚でも引いたら、その手番は発展カードをもう使えない
    pendingChoices: [], // [{ player, kind }] 他人が選ぶ場面の順番待ち。先頭から解決する
    longestRoadPlayer: null,
    cleanestPlayer: null,
    winners: null, // 終わったら配列（空＝全員の負け）
    endReason: null, // 'vp' | 'bag'
    events: [], // 音・演出のきっかけ。main.js が読んで clear する
    log: [],
  };
}

export function currentPlayer(game) {
  if (game.phase === 'setupTown' || game.phase === 'setupCity') return game.setupOrder[game.setupIndex];
  return game.turn;
}
function log(game, text) { game.log.push(text); if (game.log.length > 200) game.log.shift(); }
export function playerName(game, idx) { return (game.players[idx] && game.players[idx].name) || `プレイヤー${idx + 1}`; }
function fire(game, evt) { game.events.push(evt); }

// ---- 汚染（LF・GF） ----
export function localFootprint(game, idx) {
  const p = game.players[idx];
  const fossil = game.board.plants.filter((pl) => pl.owner === idx && pl.kind === 'fossil').length;
  const renewable = game.board.plants.filter((pl) => pl.owner === idx && pl.kind === 'renewable').length;
  return p.towns.length + p.cities.length * 2 + fossil - renewable;
}
export function globalFootprint(game) {
  const sum = game.players.reduce((a, _, i) => a + localFootprint(game, i), 0);
  const max = GF_RANGE[game.playerCount] || GF_RANGE[4];
  return Math.max(0, Math.min(max, sum));
}
export function drawsFor(game) {
  const gf = globalFootprint(game);
  const table = DRAW_TABLE[game.playerCount] || DRAW_TABLE[4];
  const row = table.find(([lo, hi]) => gf >= lo && gf <= hi) || table[table.length - 1];
  return row[2];
}
// 手番の初め: イベントフェーズに入り、その手番に引く枚数をGFで決めて保持する（途中でGFが変わっても変えない）
function startEventPhase(game) {
  game.phase = 'event';
  game.drawsLeft = drawsFor(game);
  game.eventDrawStarted = false;
}

// ---- ハザード（町・都市・地形に1つまで。監査官のいる地形には置けない） ----
function hazardCount(game) { return game.hazards.hexes.length + game.hazards.vertices.length; }
export function canPlaceHazard(game) { return hazardCount(game) < HAZARD_SUPPLY; }
export function hexHasHazard(game, hexId) { return game.hazards.hexes.includes(hexId); }
export function vertexHasHazard(game, vertexId) { return game.hazards.vertices.includes(vertexId); }
function hexBlocked(game, hexId) { return hexId === game.inspectorHex || hexHasHazard(game, hexId); }
export function placeHazardOnHex(game, hexId) {
  if (hexId === game.inspectorHex || hexHasHazard(game, hexId) || !canPlaceHazard(game)) return false;
  game.hazards.hexes.push(hexId);
  fire(game, 'hazard');
  return true;
}
export function placeHazardOnVertex(game, vertexId) {
  const v = game.board.vertices[vertexId];
  if (!v.building || vertexHasHazard(game, vertexId) || !canPlaceHazard(game)) return false;
  game.hazards.vertices.push(vertexId);
  fire(game, 'hazard');
  return true;
}
// 出目の地形にあるハザードは外れ、その地形（監査官がいないもの）に接する町・都市のハザードも外れる（7では呼ばない）
function clearHazardsForRoll(game, total) {
  game.board.hexes.forEach((hex) => {
    if (hex.number !== total) return;
    game.hazards.hexes = game.hazards.hexes.filter((h) => h !== hex.id);
    if (hex.id === game.inspectorHex) return; // 監査官が止めた地形に接する建物のハザードは外れない
    game.hazards.vertices = game.hazards.vertices.filter((v) => !hex.vertexIds.includes(v));
  });
}
export function useEnergyToClearHazard(game, playerIdx, target) {
  if (game.phase !== 'main' || playerIdx !== currentPlayer(game)) return false;
  const p = game.players[playerIdx];
  if (p.energy < ENERGY_DEMOLISH_COST) return false;
  let cleared = false;
  if (target && target.hexId != null && hexHasHazard(game, target.hexId)) {
    game.hazards.hexes = game.hazards.hexes.filter((h) => h !== target.hexId);
    cleared = true;
  } else if (target && target.vertexId != null && vertexHasHazard(game, target.vertexId)) {
    game.hazards.vertices = game.hazards.vertices.filter((v) => v !== target.vertexId);
    cleared = true;
  }
  if (!cleared) return false;
  p.energy -= ENERGY_DEMOLISH_COST;
  fire(game, 'hazard');
  return true;
}

// ---- 得点・勝ち判定 ----
export function devVpCount(player) { return player.devCards.filter((c) => c.type === 'vp').length; }
export function playerScore(game, idx) {
  const p = game.players[idx];
  return p.towns.length + p.cities.length * 2
    + (game.longestRoadPlayer === idx ? 2 : 0)
    + (game.cleanestPlayer === idx ? 2 : 0)
    + devVpCount(p);
}
// 自分の手番中にだけ判定する（他人の手番中に10点に届いても、その人の手番が来るまで勝ちにならない）
function checkWin(game, idx) {
  if (game.winners != null) return;
  if (idx !== currentPlayer(game)) return;
  if (playerScore(game, idx) >= 10) {
    game.winners = [idx];
    game.endReason = 'vp';
    game.phase = 'gameOver';
    fire(game, 'win');
    log(game, `${playerName(game, idx)}の勝ち！`);
  }
}

// ---- 建てられる場所 ----
export function canPlaceTown(game, vertexId, playerIdx, isSetup) {
  const v = game.board.vertices[vertexId];
  if (v.building) return false;
  if (v.neighbors.some((n) => game.board.vertices[n].building)) return false; // 距離ルール
  if (isSetup) return true;
  return v.edgeIds.some((eId) => game.board.edges[eId].road === playerIdx);
}
export function availableTownVertices(game, playerIdx, isSetup) {
  return game.board.vertices.filter((v) => canPlaceTown(game, v.id, playerIdx, isSetup)).map((v) => v.id);
}
export function canPlaceRoad(game, edgeId, playerIdx) {
  const e = game.board.edges[edgeId];
  if (e.road != null) return false;
  return [e.v1, e.v2].some((vid) => {
    const v = game.board.vertices[vid];
    if (v.building && v.building.owner === playerIdx) return true;
    return v.edgeIds.some((other) => other !== edgeId && game.board.edges[other].road === playerIdx);
  });
}
export function availableRoadEdges(game, playerIdx) {
  return game.board.edges.filter((e) => canPlaceRoad(game, e.id, playerIdx)).map((e) => e.id);
}

// ---- セットアップ（町1+道1を2周、2周目は町でなく町とは別の交点に都市） ----
function grantSetupResources(game, idx, vertexId) {
  const v = game.board.vertices[vertexId];
  v.hexIds.forEach((hId) => {
    const hex = game.board.hexes[hId];
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (res && game.bank.resources[res] > 0) { game.players[idx].resources[res]++; game.bank.resources[res]--; }
  });
  if (game.bank.science > 0) { game.players[idx].science++; game.bank.science--; }
}
export function setupPlaceBuilding(game, vertexId) {
  const idx = currentPlayer(game);
  if (game.phase !== 'setupTown' && game.phase !== 'setupCity') return false;
  if (game.setupPending !== 'building') return false;
  if (!canPlaceTown(game, vertexId, idx, true)) return false;
  const type = game.phase === 'setupCity' ? 'city' : 'town';
  game.board.vertices[vertexId].building = { owner: idx, type };
  if (type === 'city') game.players[idx].cities.push(vertexId); else game.players[idx].towns.push(vertexId);
  game.setupLastVertex = vertexId;
  game.setupPending = 'road';
  fire(game, 'build');
  log(game, `${playerName(game, idx)}が${type === 'city' ? '都市' : '町'}を置いた`);
  return true;
}
export function setupPlaceRoad(game, edgeId) {
  const idx = currentPlayer(game);
  if (game.phase !== 'setupTown' && game.phase !== 'setupCity') return false;
  if (game.setupPending !== 'road') return false;
  const e = game.board.edges[edgeId];
  if (e.road != null) return false;
  if (e.v1 !== game.setupLastVertex && e.v2 !== game.setupLastVertex) return false;
  e.road = idx;
  game.players[idx].roads.push(edgeId);
  fire(game, 'build');
  if (game.phase === 'setupCity') grantSetupResources(game, idx, game.setupLastVertex);
  game.setupIndex++;
  if (game.setupIndex >= game.setupOrder.length) {
    if (game.phase === 'setupTown') {
      game.phase = 'setupCity';
      game.setupOrder = game.setupOrder.slice().reverse();
      game.setupIndex = 0;
    } else {
      game.turn = 0; // セットアップが終わったら、最初のプレイヤー（1周目を始めた人）から通常手番
      startEventPhase(game);
    }
  }
  game.setupPending = 'building';
  return true;
}

// ---- 資源・科学・エネルギーの産出 ----
function distributeResources(game, total) {
  const demand = emptyResources();
  const contributions = [];
  let scienceDemand = 0;
  const scienceContribs = [];
  const energyGains = {}; // playerIdx -> 個数
  game.board.hexes.forEach((hex) => {
    if (hex.number !== total || hexBlocked(game, hex.id)) return;
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (!res) return;
    hex.vertexIds.forEach((vid) => {
      const v = game.board.vertices[vid];
      if (!v.building) return;
      if (vertexHasHazard(game, vid)) return; // ハザードのある町・都市は資源・科学・エネルギーを何ももらえない
      contributions.push({ player: v.building.owner, res, amt: 1 });
      demand[res] += 1;
      if (v.building.type === 'city') { scienceContribs.push({ player: v.building.owner }); scienceDemand += 1; }
      game.board.plants
        .filter((pl) => pl.hexId === hex.id && pl.vertexId === vid)
        .forEach((pl) => { energyGains[pl.owner] = (energyGains[pl.owner] || 0) + 1; });
    });
  });
  RESOURCES.forEach((res) => {
    if (demand[res] === 0) return;
    const resContribs = contributions.filter((c) => c.res === res);
    if (demand[res] > game.bank.resources[res]) {
      fire(game, 'shortage');
      const players = new Set(resContribs.map((c) => c.player));
      if (players.size !== 1) return; // もらう人が2人以上なら、誰ももらえない
      const avail = game.bank.resources[res];
      if (avail <= 0) return;
      game.players[resContribs[0].player].resources[res] += avail;
      game.bank.resources[res] = 0;
      return;
    }
    resContribs.forEach((c) => { game.players[c.player].resources[res] += c.amt; });
    game.bank.resources[res] -= demand[res];
  });
  if (scienceDemand > 0) {
    if (scienceDemand > game.bank.science) {
      fire(game, 'shortage');
      const players = new Set(scienceContribs.map((c) => c.player));
      if (players.size === 1 && game.bank.science > 0) {
        game.players[scienceContribs[0].player].science += game.bank.science;
        game.bank.science = 0;
      }
    } else {
      scienceContribs.forEach((c) => { game.players[c.player].science++; });
      game.bank.science -= scienceDemand;
    }
  }
  Object.entries(energyGains).forEach(([pid, n]) => {
    const pl = game.players[pid];
    const before = pl.energy;
    pl.energy = Math.min(ENERGY_MAX, pl.energy + n);
    if (pl.energy > before) fire(game, 'energy');
  });
}
// 出目で産出するタイルの id（盤の演出用）
export function hitHexIds(game, total) {
  if (total === 7) return [];
  return game.board.hexes.filter((h) => h.number === total && h.id !== game.inspectorHex).map((h) => h.id);
}

// 7のときに捨てる枚数のしきい値（このマス以上で捨てる。倉庫は作業2で足す。今は8枚固定）
function discardThreshold(player) { return 8 + (player.warehouse ? 3 : 0); }

export function rollDice(game, rng = Math.random) {
  if (game.phase !== 'roll') return null;
  const d1 = 1 + Math.floor(rng() * 6);
  const d2 = 1 + Math.floor(rng() * 6);
  const total = d1 + d2;
  game.diceLast = [d1, d2];
  fire(game, 'dice');
  log(game, `サイコロ: ${d1} + ${d2} = ${total}`);
  if (total === 7) {
    game.pendingDiscards = game.players
      .map((p, i) => ({ i, hand: sumHand(p) }))
      .filter((x) => x.hand >= discardThreshold(game.players[x.i]))
      .map((x) => ({ player: x.i, count: Math.floor(x.hand / 2) }));
    game.phase = game.pendingDiscards.length ? 'discard' : 'moveInspector';
  } else {
    distributeResources(game, total);
    clearHazardsForRoll(game, total); // 産出の終わりに、この出目で止まった地形・建物のハザードを外す
    game.phase = 'main';
  }
  return total;
}

export function discardCards(game, playerIdx, discardObj) {
  const pending = game.pendingDiscards.find((d) => d.player === playerIdx);
  if (!pending) return false;
  const science = discardObj.science || 0;
  const resPart = {}; RESOURCES.forEach((r) => { resPart[r] = discardObj[r] || 0; });
  const total = sumRes(resPart) + science;
  if (total !== pending.count) return false;
  const p = game.players[playerIdx];
  if (!canAfford(p.resources, resPart)) return false;
  if (science > p.science) return false;
  payCost(p.resources, resPart);
  RESOURCES.forEach((r) => { game.bank.resources[r] += resPart[r] || 0; });
  p.science -= science;
  game.bank.science += science;
  game.pendingDiscards = game.pendingDiscards.filter((d) => d.player !== playerIdx);
  if (game.pendingDiscards.length === 0) game.phase = 'moveInspector';
  return true;
}

// ---- 環境監査官（基本カタンの盗賊にあたる） ----
export function inspectorTargets(game, hexId, playerIdx) {
  const hex = game.board.hexes[hexId];
  const owners = new Set();
  hex.vertexIds.forEach((vid) => {
    const b = game.board.vertices[vid].building;
    if (b && b.owner !== playerIdx) owners.add(b.owner);
  });
  return [...owners].filter((o) => sumHand(game.players[o]) > 0);
}
function stealFromHand(game, fromIdx, toIdx) {
  const p = game.players[fromIdx];
  const pool = RESOURCES.flatMap((r) => Array(p.resources[r]).fill(r));
  for (let i = 0; i < p.science; i++) pool.push('science');
  if (!pool.length) return;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  if (picked === 'science') { p.science--; game.players[toIdx].science++; } else { p.resources[picked]--; game.players[toIdx].resources[picked]++; }
}
export function moveInspector(game, hexId, targetPlayerIdx) {
  if (game.phase !== 'moveInspector') return false;
  const idx = currentPlayer(game);
  if (hexId === game.inspectorHex) return false;
  const targets = inspectorTargets(game, hexId, idx);
  if (targets.length && !targets.includes(targetPlayerIdx)) return false;
  game.inspectorHex = hexId;
  if (targets.length) { stealFromHand(game, targetPlayerIdx, idx); log(game, `${playerName(game, idx)}が${playerName(game, targetPlayerIdx)}から1枚もらった`); }
  fire(game, 'rob');
  game.phase = 'main';
  return true;
}

// ---- 長い交易路 ----
function roadLengthForPlayer(game, playerIdx) {
  const edges = game.board.edges.filter((e) => e.road === playerIdx);
  if (!edges.length) return 0;
  const byId = new Map(edges.map((e) => [e.id, e]));
  const adjacency = new Map();
  edges.forEach((e) => {
    [e.v1, e.v2].forEach((v) => { if (!adjacency.has(v)) adjacency.set(v, []); adjacency.get(v).push(e.id); });
  });
  const blocked = (vid) => { const b = game.board.vertices[vid].building; return b && b.owner !== playerIdx; };
  const otherVertex = (edgeId, vid) => { const e = byId.get(edgeId); return e.v1 === vid ? e.v2 : e.v1; };
  function extend(vid, visited) {
    if (blocked(vid)) return 0;
    let best = 0;
    for (const eId of (adjacency.get(vid) || [])) {
      if (visited.has(eId)) continue;
      visited.add(eId);
      best = Math.max(best, 1 + extend(otherVertex(eId, vid), visited));
      visited.delete(eId);
    }
    return best;
  }
  let max = 0;
  edges.forEach((e) => {
    [e.v1, e.v2].forEach((startV) => {
      const visited = new Set([e.id]);
      max = Math.max(max, 1 + extend(otherVertex(e.id, startV), visited));
    });
  });
  return max;
}
function assignBonus(game, lens, threshold, key) {
  const max = Math.max(...lens);
  if (max < threshold) { game[key] = null; return; }
  const holders = lens.map((l, i) => (l === max ? i : -1)).filter((i) => i >= 0);
  if (holders.length === 1) game[key] = holders[0];
  else if (game[key] != null && holders.includes(game[key])) { /* 保持者そのまま */ }
  else game[key] = null;
}
export function recalcLongestRoad(game) {
  const lens = game.players.map((_, i) => roadLengthForPlayer(game, i));
  game.players.forEach((p, i) => { p.roadLength = lens[i]; });
  assignBonus(game, lens, 5, 'longestRoadPlayer');
  checkWin(game, currentPlayer(game)); // 最長交易路の移動で手番の人が10点に届くことがある
}

// ---- 建設 ----
function canBuildNow(game) { return game.phase === 'main'; }
export function buildRoad(game, edgeId, { free } = {}) {
  if (!free && !canBuildNow(game)) return false; // free はテスト用の道の直置き（長い交易路の検証など）
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (p.roads.length >= MAX_ROADS) return false;
  if (!canPlaceRoad(game, edgeId, idx)) return false;
  if (!free) {
    if (!canAfford(p.resources, COSTS.road)) return false;
    payCost(p.resources, COSTS.road);
    RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.road[r] || 0; });
  }
  game.board.edges[edgeId].road = idx;
  p.roads.push(edgeId);
  fire(game, 'build');
  recalcLongestRoad(game);
  checkWin(game, idx);
  return true;
}
export function buildTown(game, vertexId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (p.towns.length >= MAX_TOWNS) return false;
  if (!canPlaceTown(game, vertexId, idx, false)) return false;
  if (!canAfford(p.resources, COSTS.town)) return false;
  payCost(p.resources, COSTS.town);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.town[r] || 0; });
  game.board.vertices[vertexId].building = { owner: idx, type: 'town' };
  p.towns.push(vertexId);
  fire(game, 'build');
  recalcLongestRoad(game);
  checkWin(game, idx);
  return true;
}
export function buildCity(game, vertexId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (!p.towns.includes(vertexId)) return false;
  if (p.cities.length >= MAX_CITIES) return false;
  if (!canAfford(p.resources, COSTS.city)) return false;
  payCost(p.resources, COSTS.city);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.city[r] || 0; });
  p.towns = p.towns.filter((v) => v !== vertexId);
  p.cities.push(vertexId);
  game.board.vertices[vertexId].building.type = 'city';
  fire(game, 'build');
  checkWin(game, idx);
  return true;
}
// ---- 発電所（町=1つ・都市=3つまで、それぞれ別の地形。化石+再生で1手番1つ） ----
function plantsOnVertex(game, vertexId) { return game.board.plants.filter((p) => p.vertexId === vertexId); }
function plantsOwnedCount(game, playerIdx, kind) { return game.board.plants.filter((p) => p.owner === playerIdx && p.kind === kind).length; }
export function canBuildPlant(game, playerIdx, vertexId, hexId, kind) {
  if (game.plantBuiltThisTurn) return false;
  const v = game.board.vertices[vertexId];
  if (!v.building || v.building.owner !== playerIdx) return false;
  const hex = game.board.hexes[hexId];
  if (!hex || hex.number == null || !v.hexIds.includes(hexId)) return false; // 砂漠不可・隣接していない地形は不可
  const existing = plantsOnVertex(game, vertexId);
  if (existing.some((p) => p.hexId === hexId)) return false; // 同じ（交点,地形）の組には2つ目を置けない
  const limit = v.building.type === 'city' ? 3 : 1;
  if (existing.length >= limit) return false;
  if (kind === 'fossil' && plantsOwnedCount(game, playerIdx, 'fossil') >= MAX_FOSSIL) return false;
  if (kind === 'renewable' && plantsOwnedCount(game, playerIdx, 'renewable') >= MAX_RENEWABLE) return false;
  return true;
}
export function buildPlant(game, vertexId, hexId, kind) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  if (!canBuildPlant(game, idx, vertexId, hexId, kind)) return false;
  const p = game.players[idx];
  const cost = PLANT_COSTS[kind];
  if ((p.science || 0) < cost.science) return false;
  p.science -= cost.science;
  game.bank.science += cost.science;
  game.board.plants.push({ owner: idx, kind, vertexId, hexId });
  game.plantBuiltThisTurn = true;
  if (kind === 'renewable' && p.greenDiscs.length) game.bag.push(p.greenDiscs.pop()); // 下にあった緑ディスク1枚を袋へ
  fire(game, 'build');
  return true;
}

// ---- 倉庫（エネルギー2、1回だけ。7のときの捨て札の上限が8→11枚） ----
export function buildWarehouse(game) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (p.warehouse || p.energy < WAREHOUSE_ENERGY_COST) return false;
  p.energy -= WAREHOUSE_ENERGY_COST;
  p.warehouse = true;
  fire(game, 'build');
  return true;
}

// ---- エネルギーの使い道（倉庫以外の2つ。壊すのは建設コストの要らないハザード除去と同じ節にまとめる） ----
export function useEnergyForResource(game, playerIdx, kind) {
  if (game.phase !== 'main' || playerIdx !== currentPlayer(game)) return false;
  if (kind !== 'science' && !RESOURCES.includes(kind)) return false;
  const p = game.players[playerIdx];
  if (p.energy < ENERGY_TRADE_COST) return false;
  const bankHas = kind === 'science' ? game.bank.science : game.bank.resources[kind];
  if ((bankHas || 0) < 1) return false;
  p.energy -= ENERGY_TRADE_COST;
  if (kind === 'science') { game.bank.science--; p.science++; } else { game.bank.resources[kind]--; p.resources[kind]++; }
  fire(game, 'build');
  return true;
}
export function demolishFossilPlant(game, playerIdx, plantIndex) {
  if (game.phase !== 'main' || playerIdx !== currentPlayer(game) || game.demolishedThisTurn) return false;
  const p = game.players[playerIdx];
  if (p.energy < ENERGY_DEMOLISH_COST) return false;
  const plant = game.board.plants[plantIndex];
  if (!plant || plant.owner !== playerIdx || plant.kind !== 'fossil') return false;
  p.energy -= ENERGY_DEMOLISH_COST;
  game.board.plants.splice(plantIndex, 1);
  game.demolishedThisTurn = true;
  fire(game, 'build');
  return true;
}

export function buyDevCard(game) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (!game.bank.devDeck.length) return false;
  if (!canAfford(p.resources, COSTS.dev)) return false;
  payCost(p.resources, COSTS.dev);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.dev[r] || 0; });
  const type = game.bank.devDeck.pop();
  p.devCards.push({ type, boughtTurn: game.turnNumber });
  fire(game, 'build');
  checkWin(game, idx);
  return true;
}

// ---- 港のレート（町・都市のある交点の port を見る。3:1 港は全資源、2:1 港はその資源だけ。科学・エネルギーは対象外） ----
export function tradeRate(game, playerIdx, giveKind) {
  if (giveKind === 'science') return 3; // 港は資源だけ（3.9）。科学は銀行の 3:1 のまま
  const p = game.players[playerIdx];
  let rate = 4;
  for (const vid of [...p.towns, ...p.cities]) {
    const port = game.board.vertices[vid].port;
    if (port === '3:1' && rate > 3) rate = 3;
    if (port === giveKind) rate = 2;
  }
  return rate;
}

// ---- 銀行・港との交易（資源4:1、科学3:1、港は3:1/2:1。tradeRate が港を見て一番良いレートを返す） ----
export function bankTrade(game, playerIdx, giveKind, wantKind) {
  if (game.phase !== 'main' || playerIdx !== currentPlayer(game)) return false;
  if (giveKind === wantKind) return false;
  if (giveKind !== 'science' && !RESOURCES.includes(giveKind)) return false;
  if (wantKind !== 'science' && !RESOURCES.includes(wantKind)) return false;
  const rate = tradeRate(game, playerIdx, giveKind);
  const p = game.players[playerIdx];
  const have = giveKind === 'science' ? p.science : p.resources[giveKind];
  if ((have || 0) < rate) return false;
  const bankHas = wantKind === 'science' ? game.bank.science : game.bank.resources[wantKind];
  if ((bankHas || 0) < 1) return false;
  if (giveKind === 'science') { p.science -= rate; game.bank.science += rate; } else { p.resources[giveKind] -= rate; game.bank.resources[giveKind] += rate; }
  if (wantKind === 'science') { game.bank.science--; p.science++; } else { game.bank.resources[wantKind]--; p.resources[wantKind]++; }
  fire(game, 'build');
  return true;
}

// ---- 相手との交易（資源・科学・エネルギーを自由に組み合わせ。あげるだけ・同じ物どうしは不可。3.9） ----
const TRADE_KINDS = [...RESOURCES, 'science', 'energy'];
function handOf(p, kind) { return kind === 'science' ? p.science : kind === 'energy' ? p.energy : (p.resources[kind] || 0); }
function addTo(p, kind, n) { if (kind === 'science') p.science += n; else if (kind === 'energy') p.energy += n; else p.resources[kind] += n; }
export function playerTrade(game, otherIdx, give, get) {
  if (game.phase !== 'main') return false;
  const idx = currentPlayer(game);
  if (otherIdx === idx || otherIdx < 0 || otherIdx >= game.playerCount) return false;
  const giveTotal = TRADE_KINDS.reduce((a, k) => a + (give[k] || 0), 0);
  const getTotal = TRADE_KINDS.reduce((a, k) => a + (get[k] || 0), 0);
  if (giveTotal <= 0 || getTotal <= 0) return false; // あげるだけは不可
  if (TRADE_KINDS.some((k) => (give[k] || 0) > 0 && (get[k] || 0) > 0)) return false; // 同じ物どうしは不可
  const me = game.players[idx], other = game.players[otherIdx];
  if (TRADE_KINDS.some((k) => handOf(me, k) < (give[k] || 0))) return false;
  if (TRADE_KINDS.some((k) => handOf(other, k) < (get[k] || 0))) return false;
  if (handOf(me, 'energy') - (give.energy || 0) + (get.energy || 0) > ENERGY_MAX) return false;
  if (handOf(other, 'energy') - (get.energy || 0) + (give.energy || 0) > ENERGY_MAX) return false;
  TRADE_KINDS.forEach((k) => {
    const g = give[k] || 0, w = get[k] || 0;
    if (!g && !w) return;
    addTo(me, k, w - g);
    addTo(other, k, g - w);
  });
  fire(game, 'build');
  return true;
}

// ================================================================
// イベント（袋・茶/緑ディスク・7種の効果・同点の扱い・袋切れの終わり方）
// ================================================================
// 対象の値が全員同じなら何も起きない。そうでなければ最大/最小の人（複数なら全員）を、手番の人から時計回りの順で返す
function tiedGroupClockwise(game, values, mode) {
  if (new Set(values).size === 1) return [];
  const target = mode === 'max' ? Math.max(...values) : Math.min(...values);
  const start = currentPlayer(game);
  const order = [];
  for (let i = 0; i < game.playerCount; i++) {
    const idx = (start + i) % game.playerCount;
    if (values[idx] === target) order.push(idx);
  }
  return order;
}
function allPlayersClockwise(game) {
  const start = currentPlayer(game);
  return Array.from({ length: game.playerCount }, (_, i) => (start + i) % game.playerCount);
}
function grantChoiceCard(game, playerIdx, kind) {
  if (kind !== 'science' && !RESOURCES.includes(kind)) return false;
  const bankHas = kind === 'science' ? game.bank.science : game.bank.resources[kind];
  if ((bankHas || 0) < 1) return false;
  if (kind === 'science') { game.bank.science--; game.players[playerIdx].science++; }
  else { game.bank.resources[kind]--; game.players[playerIdx].resources[kind]++; }
  return true;
}
function discardChoiceCard(game, playerIdx, kind) {
  const p = game.players[playerIdx];
  if (kind === 'science') { if (p.science < 1) return false; p.science--; game.bank.science++; return true; }
  if (!RESOURCES.includes(kind) || (p.resources[kind] || 0) < 1) return false;
  p.resources[kind]--; game.bank.resources[kind]++;
  return true;
}
// 発電所を1手番1つの制限に数えずに建てる（生産増加イベント専用）
function canPlaceFreeFossilPlant(game, playerIdx, vertexId, hexId) {
  const v = game.board.vertices[vertexId];
  if (!v.building || v.building.owner !== playerIdx) return false;
  const hex = game.board.hexes[hexId];
  if (!hex || hex.number == null || !v.hexIds.includes(hexId)) return false;
  const existing = plantsOnVertex(game, vertexId);
  if (existing.some((p) => p.hexId === hexId)) return false;
  const limit = v.building.type === 'city' ? 3 : 1;
  if (existing.length >= limit) return false;
  return plantsOwnedCount(game, playerIdx, 'fossil') < MAX_FOSSIL;
}

function resolveEventEffect(game, type, rng) {
  const lfs = game.players.map((_, i) => localFootprint(game, i));
  if (type === 'airPollution') {
    tiedGroupClockwise(game, lfs, 'max').forEach((p) => game.pendingChoices.push({ player: p, kind: 'airPollutionHazard' }));
  } else if (type === 'envPollution') {
    let total;
    do { total = 2 + Math.floor(rng() * 6) + Math.floor(rng() * 6); } while (total === 7); // 7なら振り直し
    game.board.hexes.forEach((hex) => { if (hex.number === total) placeHazardOnHex(game, hex.id); }); // 監査官の地形には置けない(placeHazardOnHexが見る)
    log(game, `環境汚染: ${total}の地形にハザード`);
  } else if (type === 'prodIncrease') {
    tiedGroupClockwise(game, lfs, 'max').forEach((p) => game.pendingChoices.push({ player: p, kind: 'prodIncrease' }));
  } else if (type === 'rain') {
    allPlayersClockwise(game).forEach((p) => game.pendingChoices.push({ player: p, kind: 'rainHazard' }));
  } else if (type === 'climate') {
    tiedGroupClockwise(game, lfs, 'min').forEach((p) => game.pendingChoices.push({ player: p, kind: 'climateGain' }));
    tiedGroupClockwise(game, lfs, 'max').forEach((p) => game.pendingChoices.push({ player: p, kind: 'climateDiscard' }));
  } else if (type === 'funding') {
    tiedGroupClockwise(game, lfs, 'min').forEach((p) => {
      if (!game.bank.devDeck.length) return;
      const cardType = game.bank.devDeck.pop();
      game.players[p].devCards.push({ type: cardType, boughtTurn: null }); // もらったカード(買ってはいない)
    });
  } else if (type === 'sustainable') {
    const renewCounts = game.players.map((_, i) => plantsOwnedCount(game, i, 'renewable'));
    tiedGroupClockwise(game, renewCounts, 'max').forEach((p) => game.pendingChoices.push({ player: p, kind: 'sustainableGain' }));
  }
}

// 袋が空で引かなければならないときの終わり方（再生>化石の人のうち差が最大の人。いなければ winners は空）
function endGameByEmptyBag(game) {
  const diffs = game.players.map((_, i) => plantsOwnedCount(game, i, 'renewable') - plantsOwnedCount(game, i, 'fossil'));
  const positive = diffs.map((d, i) => ({ i, d })).filter((x) => x.d > 0);
  let winners = [];
  if (positive.length) {
    const maxDiff = Math.max(...positive.map((x) => x.d));
    const top = positive.filter((x) => x.d === maxDiff);
    const maxScore = Math.max(...top.map((x) => playerScore(game, x.i)));
    winners = top.filter((x) => playerScore(game, x.i) === maxScore).map((x) => x.i);
  }
  game.winners = winners;
  game.endReason = 'bag';
  game.phase = 'gameOver';
  fire(game, winners.length ? 'win' : 'loseAll');
  log(game, winners.length ? `袋が尽き、${winners.map((i) => playerName(game, i)).join('・')}の勝ち` : '袋が尽き、全員の負け');
}

// 引くたびに1枚解決してから次を引く（マスが埋まれば発動）。発動後にpendingChoicesが残れば、それを解決するまで次を引けない
export function drawEventDisc(game, rng = Math.random) {
  if (game.phase !== 'event' || game.pendingChoices.length || game.drawsLeft <= 0) return false;
  if (!game.bag.length) { endGameByEmptyBag(game); return 'bagEmpty'; }
  const type = game.bag.pop();
  game.drawsLeft--;
  game.eventDrawStarted = true;
  game.tracks[type]++;
  fire(game, 'drawDisc');
  let triggered = false;
  if (game.tracks[type] >= EVENT_SPACES[type]) {
    triggered = true;
    game.tracks[type] = 0; // 発動したらそのイベントのディスクは全部取り除く(マスは空に戻る)
    log(game, `${EVENT_LABEL[type]}が発動`);
    fire(game, 'eventTriggered');
    resolveEventEffect(game, type, rng);
  }
  if (game.pendingChoices.length === 0 && game.drawsLeft === 0) game.phase = 'roll';
  return triggered ? type : true;
}

function frontChoice(game, playerIdx, kind) {
  const c = game.pendingChoices[0];
  return (c && c.player === playerIdx && c.kind === kind) ? c : null;
}
function finishChoice(game) {
  game.pendingChoices.shift();
  if (game.phase === 'event' && game.pendingChoices.length === 0 && game.drawsLeft === 0) game.phase = 'roll';
}
export function pendingChoice(game) { return game.pendingChoices[0] || null; } // 画面・CPUが見る、今答えるべき場面

// 他人が選ぶ場面に答えられない(在庫切れ・場所がないなど)ときに読み飛ばす
export function skipPendingChoice(game, playerIdx) {
  const c = game.pendingChoices[0];
  if (!c || c.player !== playerIdx) return false;
  finishChoice(game);
  return true;
}
export function resolveAirPollutionHazard(game, playerIdx, vertexId) {
  if (!frontChoice(game, playerIdx, 'airPollutionHazard')) return false;
  const v = game.board.vertices[vertexId];
  if (!v.building || v.building.owner !== playerIdx) return false;
  const p = game.players[playerIdx];
  const hasOpenCity = p.cities.some((cv) => !vertexHasHazard(game, cv));
  if (hasOpenCity && v.building.type !== 'city') return false; // 都市がまだ空いているなら町には置けない
  if (!placeHazardOnVertex(game, vertexId)) return false;
  finishChoice(game);
  return true;
}
export function resolveRainHazard(game, playerIdx, vertexId) {
  if (!frontChoice(game, playerIdx, 'rainHazard')) return false;
  const v = game.board.vertices[vertexId];
  if (!v.building || v.building.owner !== playerIdx) return false;
  if (!placeHazardOnVertex(game, vertexId)) return false;
  finishChoice(game);
  return true;
}
export function resolveProdIncrease(game, playerIdx, vertexId, hexId) {
  if (!frontChoice(game, playerIdx, 'prodIncrease')) return false;
  if (!canPlaceFreeFossilPlant(game, playerIdx, vertexId, hexId)) return false;
  game.board.plants.push({ owner: playerIdx, kind: 'fossil', vertexId, hexId });
  const hex = game.board.hexes[hexId];
  const res = TERRAIN_RESOURCE[hex.terrain];
  if (res && game.bank.resources[res] > 0) { game.players[playerIdx].resources[res]++; game.bank.resources[res]--; }
  fire(game, 'build');
  finishChoice(game);
  return true;
}
export function resolveClimateGain(game, playerIdx, kind) {
  if (!frontChoice(game, playerIdx, 'climateGain')) return false;
  if (!grantChoiceCard(game, playerIdx, kind)) return false;
  finishChoice(game);
  return true;
}
export function resolveClimateDiscard(game, playerIdx, kind) {
  if (!frontChoice(game, playerIdx, 'climateDiscard')) return false;
  if (!discardChoiceCard(game, playerIdx, kind)) return false;
  finishChoice(game);
  return true;
}
export function resolveSustainableGain(game, playerIdx, kind) {
  if (!frontChoice(game, playerIdx, 'sustainableGain')) return false;
  if (!grantChoiceCard(game, playerIdx, kind)) return false;
  finishChoice(game);
  return true;
}

// ---- 最もクリーンな環境（クリーンアップ3枚で2点。もっと多く使った人に移る） ----
function recalcCleanest(game) {
  const counts = game.players.map((p) => p.cleanupPlayed || 0);
  assignBonus(game, counts, CLEANEST_THRESHOLD, 'cleanestPlayer');
  checkWin(game, currentPlayer(game));
}

// ---- 発展カード（道路建設・豊作・研究補助金・勝利点・クリーンアップ） ----
// 勝利点は使う操作がなく、devVpCount/playerScoreが常に数える(RB: 手番中に10点に届けば明かして勝ち)
function canPlayDevCardNow(game) {
  if (game.devCardPlayedThisTurn) return false;
  if (game.phase === 'event') return !game.eventDrawStarted; // 引く前ならよい
  return game.phase === 'main';
}
function takeDevCard(game, playerIdx, type) {
  const p = game.players[playerIdx];
  const i = p.devCards.findIndex((c) => c.type === type && c.boughtTurn !== game.turnNumber);
  if (i < 0) return -1;
  return i;
}
export function playRoadBuildingCard(game) {
  const idx = currentPlayer(game);
  if (!canPlayDevCardNow(game)) return false;
  const p = game.players[idx];
  const i = takeDevCard(game, idx, 'roadBuilding');
  if (i < 0) return false;
  p.devCards.splice(i, 1);
  game.freeRoadsRemaining += 2;
  game.devCardPlayedThisTurn = true;
  fire(game, 'build');
  return true;
}
// 道路建設カードぶんの、ただで置ける道（buildRoadの{free:true}と違い、カードの残り枚数を消費する）
export function useFreeRoadFromCard(game, edgeId) {
  if (game.freeRoadsRemaining <= 0) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (p.roads.length >= MAX_ROADS) return false;
  if (!canPlaceRoad(game, edgeId, idx)) return false;
  game.board.edges[edgeId].road = idx;
  p.roads.push(edgeId);
  game.freeRoadsRemaining--;
  fire(game, 'build');
  recalcLongestRoad(game);
  checkWin(game, idx);
  return true;
}
// 豊作: 自分の再生可能発電所がある地形(別々)を3つまで選び、それぞれの資源を1枚ずつ
export function playHighYieldCard(game, hexIds) {
  const idx = currentPlayer(game);
  if (!canPlayDevCardNow(game)) return false;
  const uniq = [...new Set(hexIds || [])];
  if (!uniq.length || uniq.length > 3) return false;
  const ownsHex = (hexId) => game.board.plants.some((pl) => pl.owner === idx && pl.kind === 'renewable' && pl.hexId === hexId);
  if (!uniq.every(ownsHex)) return false;
  const p = game.players[idx];
  const i = takeDevCard(game, idx, 'highYield');
  if (i < 0) return false;
  p.devCards.splice(i, 1);
  uniq.forEach((hexId) => {
    const hex = game.board.hexes[hexId];
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (res && game.bank.resources[res] > 0) { p.resources[res]++; game.bank.resources[res]--; }
  });
  game.devCardPlayedThisTurn = true;
  fire(game, 'build');
  return true;
}
// 研究補助金: 資源・科学を好きに2枚(組み合わせ自由)
export function playResearchGrantCard(game, picks) {
  const idx = currentPlayer(game);
  if (!canPlayDevCardNow(game)) return false;
  if (!Array.isArray(picks) || picks.length !== 2) return false;
  if (!picks.every((k) => k === 'science' || RESOURCES.includes(k))) return false;
  const p = game.players[idx];
  const i = takeDevCard(game, idx, 'researchGrant');
  if (i < 0) return false;
  p.devCards.splice(i, 1);
  picks.forEach((k) => grantChoiceCard(game, idx, k)); // 銀行の札が足りないぶんは諦める(基本カタンと同じ扱い)
  game.devCardPlayedThisTurn = true;
  fire(game, 'build');
  return true;
}
// クリーンアップ: 監査官を動かす(7と同じ)か、ハザードを1つ外してLFが自分以上の人から1枚もらう
export function playCleanupMoveInspector(game, hexId, targetPlayerIdx) {
  const idx = currentPlayer(game);
  if (!canPlayDevCardNow(game)) return false;
  if (hexId === game.inspectorHex) return false;
  const targets = inspectorTargets(game, hexId, idx);
  if (targets.length && !targets.includes(targetPlayerIdx)) return false;
  const p = game.players[idx];
  const i = takeDevCard(game, idx, 'cleanup');
  if (i < 0) return false;
  p.devCards.splice(i, 1);
  game.inspectorHex = hexId;
  if (targets.length) stealFromHand(game, targetPlayerIdx, idx);
  p.cleanupPlayed = (p.cleanupPlayed || 0) + 1;
  game.devCardPlayedThisTurn = true;
  fire(game, 'rob');
  recalcCleanest(game);
  return true;
}
export function playCleanupRemoveHazard(game, target, victimIdx) {
  const idx = currentPlayer(game);
  if (!canPlayDevCardNow(game)) return false;
  if (localFootprint(game, victimIdx) < localFootprint(game, idx)) return false;
  const clearsHex = target && target.hexId != null && hexHasHazard(game, target.hexId);
  const clearsVertex = !clearsHex && target && target.vertexId != null && vertexHasHazard(game, target.vertexId);
  if (!clearsHex && !clearsVertex) return false;
  const p = game.players[idx];
  const i = takeDevCard(game, idx, 'cleanup');
  if (i < 0) return false;
  p.devCards.splice(i, 1);
  if (clearsHex) game.hazards.hexes = game.hazards.hexes.filter((h) => h !== target.hexId);
  else game.hazards.vertices = game.hazards.vertices.filter((v) => v !== target.vertexId);
  stealFromHand(game, victimIdx, idx);
  p.cleanupPlayed = (p.cleanupPlayed || 0) + 1;
  game.devCardPlayedThisTurn = true;
  fire(game, 'hazard');
  recalcCleanest(game);
  return true;
}

// ---- 手番の終わり ----
export function endTurn(game) {
  if (game.phase !== 'main') return false;
  game.turn = (game.turn + 1) % game.playerCount;
  game.turnNumber++;
  game.devCardPlayedThisTurn = false;
  game.plantBuiltThisTurn = false;
  game.demolishedThisTurn = false;
  game.freeRoadsRemaining = 0;
  startEventPhase(game);
  checkWin(game, game.turn); // 手番の初めの判定
  return true;
}
