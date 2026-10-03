'use strict';
// CPU（画面・音に触らない）。engine.js の公開関数だけを使って手を打つ。
// main.js（作業5）が呼ぶのは基本的に step(game, levelFor) だけでよい。CPU の手番・イベントの順番待ち・
// 7の捨て札・監査官の移動まで、この1つで進む（内部で discardFor を使う）。
// levelFor は 'weak'|'normal'|'strong' の文字列か、(playerIdx) => そのレベルを返す関数。
import * as E from './engine.js';

export const LEVELS = [
  { id: 'weak', name: 'よわい' },
  { id: 'normal', name: 'ふつう' },
  { id: 'strong', name: 'つよい' },
];

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
function affordable(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }
function canAffordScience(p, cost) { return (p.science || 0) >= (cost.science || 0); }
function pip(n) { return n == null ? 0 : 6 - Math.abs(7 - n); }
function levelOf(levelFor, idx) { return typeof levelFor === 'function' ? levelFor(idx) : (levelFor || 'normal'); }

// ---- 頂点・道の値打ち（置ける数字の強さと種類の多さだけで見る簡単な評価） ----
function vertexValue(game, vid) {
  const v = game.board.vertices[vid];
  let score = 0;
  const kinds = new Set();
  v.hexIds.forEach((hId) => {
    const hex = game.board.hexes[hId];
    if (hex.number == null) return;
    score += pip(hex.number);
    kinds.add(hex.terrain);
  });
  return score + kinds.size * 1.5;
}
function roadValue(game, edgeId) {
  const e = game.board.edges[edgeId];
  let best = 0;
  [e.v1, e.v2].forEach((vid) => {
    const v = game.board.vertices[vid];
    if (v.building) return;
    if (v.neighbors.some((n) => game.board.vertices[n].building)) return; // 距離ルールで永久に置けない
    best = Math.max(best, vertexValue(game, vid));
  });
  return best;
}

// ---- 何かが要るときに、今一番足りない物から順に並べる（資源5種＋科学） ----
function neededOrder(game, idx) {
  const p = game.players[idx];
  const amt = (k) => (k === 'science' ? (p.science || 0) : (p.resources[k] || 0));
  return [...E.RESOURCES, 'science'].slice().sort((a, b) => amt(a) - amt(b));
}
function spareOrder(game, idx) { return neededOrder(game, idx).slice().reverse(); }

// ---- 空いている（交点,地形）の組を探す（発電所を置ける場所。砂漠・埋まった組は除く） ----
function findPlantSpot(game, idx, kind) {
  const p = game.players[idx];
  const owned = game.board.plants.filter((pl) => pl.owner === idx && pl.kind === kind).length;
  const max = kind === 'fossil' ? E.MAX_FOSSIL : E.MAX_RENEWABLE;
  if (owned >= max) return null;
  for (const vid of [...p.towns, ...p.cities]) {
    const v = game.board.vertices[vid];
    const existing = game.board.plants.filter((pl) => pl.vertexId === vid);
    const limit = v.building.type === 'city' ? 3 : 1;
    if (existing.length >= limit) continue;
    for (const hexId of v.hexIds) {
      const hex = game.board.hexes[hexId];
      if (hex.number == null) continue;
      if (existing.some((pl) => pl.hexId === hexId)) continue;
      return { vertexId: vid, hexId };
    }
  }
  return null;
}
function ownRenewableHexes(game, idx) {
  return [...new Set(game.board.plants.filter((pl) => pl.owner === idx && pl.kind === 'renewable').map((pl) => pl.hexId))];
}

// ---- 今あるハザード（どれでも外せる。自分の建物・地形につくものだけに絞る版も用意） ----
function allHazardTargets(game) {
  const out = [];
  game.hazards.hexes.forEach((h) => out.push({ hexId: h }));
  game.hazards.vertices.forEach((v) => out.push({ vertexId: v }));
  return out;
}
function ownHazardTargets(game, idx) {
  const p = game.players[idx];
  const out = [];
  [...p.towns, ...p.cities].forEach((v) => { if (E.vertexHasHazard(game, v)) out.push({ vertexId: v }); });
  const myHexes = new Set();
  [...p.towns, ...p.cities].forEach((v) => game.board.vertices[v].hexIds.forEach((h) => myHexes.add(h)));
  game.hazards.hexes.forEach((h) => { if (myHexes.has(h)) out.push({ hexId: h }); });
  return out;
}

// ---- 銀行・港との交易（E.tradeRate が港を見てレートを返す。成立する組だけを挙げる） ----
function anyBankTrades(game, idx) {
  const p = game.players[idx];
  const out = [];
  [...E.RESOURCES, 'science'].forEach((give) => {
    const rate = E.tradeRate(game, idx, give);
    const have = give === 'science' ? (p.science || 0) : (p.resources[give] || 0);
    if (have < rate) return;
    [...E.RESOURCES, 'science'].forEach((want) => {
      if (want === give) return;
      const bankHas = want === 'science' ? game.bank.science : game.bank.resources[want];
      if (bankHas > 0) out.push([give, want]);
    });
  });
  return out;
}
// 次に建てたい物（都市→町→道）のコスト。足りない資源を銀行交易で補うための目安
function pickTargetCost(game, idx) {
  const p = game.players[idx];
  if (p.cities.length < E.MAX_CITIES && p.towns.length) return E.COSTS.city;
  if (p.towns.length < E.MAX_TOWNS && E.availableTownVertices(game, idx, false).length) return E.COSTS.town;
  if (p.roads.length < E.MAX_ROADS && E.availableRoadEdges(game, idx).length) return E.COSTS.road;
  return null;
}
function tryHelpfulBankTrade(game, idx) {
  const p = game.players[idx];
  const cost = pickTargetCost(game, idx);
  if (!cost) return false;
  const missing = Object.entries(cost).filter(([r, n]) => (p.resources[r] || 0) < n).map(([r]) => r);
  if (!missing.length) return false;
  const want = missing[0];
  // 科学は都市・再生可能発電所のために残す（町・都市・道を建てるためだけには使わない）
  for (const give of E.RESOURCES) {
    if (give === want) continue;
    const rate = E.tradeRate(game, idx, give);
    const spare = (p.resources[give] || 0) - (cost[give] || 0);
    const bankHas = want === 'science' ? game.bank.science : game.bank.resources[want];
    if (spare >= rate && bankHas > 0 && E.bankTrade(game, idx, give, want)) return true;
  }
  return false;
}
// 次に建てたい物に足りない資源を、エネルギー2→1でも補う
function tryHelpfulEnergyTrade(game, idx) {
  const p = game.players[idx];
  if ((p.energy || 0) < E.ENERGY_TRADE_COST) return false;
  const cost = pickTargetCost(game, idx);
  if (!cost) return false;
  const missing = Object.keys(cost).find((r) => (p.resources[r] || 0) < cost[r]);
  if (!missing) return false;
  return E.useEnergyForResource(game, idx, missing);
}

// ---- セットアップ（町/都市1つ＋道1本を2周） ----
function setupStep(game, level) {
  const idx = E.currentPlayer(game);
  if (game.setupPending === 'building') {
    const options = E.availableTownVertices(game, idx, true);
    const v = level === 'weak' ? pick(options) : options.slice().sort((a, b) => vertexValue(game, b) - vertexValue(game, a))[0];
    return E.setupPlaceBuilding(game, v);
  }
  const options = game.board.vertices[game.setupLastVertex].edgeIds.filter((eId) => game.board.edges[eId].road == null);
  const e = level === 'weak' ? pick(options) : options.slice().sort((a, b) => roadValue(game, b) - roadValue(game, a))[0];
  return E.setupPlaceRoad(game, e);
}

// ---- イベントを引く（発展カードを先に使う判断はせず、1枚ずつ引くだけでよい） ----
function eventStep(game) { return E.drawEventDisc(game, Math.random); }

// ---- 監査官の動かし先（LF最大ではなく、動かせる先の中で一番点が高い相手を狙う） ----
function chooseInspectorMove(game, idx, level) {
  let candidates = game.board.hexes.filter((h) => h.id !== game.inspectorHex && !E.hexHasHazard(game, h.id));
  if (!candidates.length) candidates = game.board.hexes.filter((h) => h.id !== game.inspectorHex);
  if (level === 'weak') {
    const hexId = pick(candidates).id;
    const targets = E.inspectorTargets(game, hexId, idx);
    return { hexId, target: targets.length ? pick(targets) : 0 };
  }
  let best = null;
  candidates.forEach((h) => {
    const targets = E.inspectorTargets(game, h.id, idx);
    const topScore = targets.length ? Math.max(...targets.map((t) => E.playerScore(game, t))) : -1;
    const score = topScore * (1 + pip(h.number) / 10);
    if (!best || score > best.score) best = { hexId: h.id, targets, score };
  });
  const target = best.targets.length ? best.targets.reduce((b, t) => (E.playerScore(game, t) > E.playerScore(game, b) ? t : b)) : 0;
  return { hexId: best.hexId, target };
}

// ---- 7の捨て札: よわいはでたらめ、ふつう・つよいは鉄・科学（発電所・都市に要る）をなるべく残す ----
export function discardFor(game, playerIdx, level) {
  const pending = game.pendingDiscards.find((d) => d.player === playerIdx);
  if (!pending) return false;
  const p = game.players[playerIdx];
  const pool = [];
  E.RESOURCES.forEach((r) => { for (let i = 0; i < (p.resources[r] || 0); i++) pool.push(r); });
  for (let i = 0; i < (p.science || 0); i++) pool.push('science');
  if (level === 'weak') {
    for (let i = pool.length - 1; i > 0; i--) { const j = rnd(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  } else {
    const keep = { steel: 3, science: 2.5, food: 1.5, fiber: 1, lumber: 0, brick: 0 };
    pool.sort((a, b) => keep[a] - keep[b]); // 残したい物ほど後ろへ（先頭から捨てる）
  }
  const obj = { science: 0 }; E.RESOURCES.forEach((r) => { obj[r] = 0; });
  for (let i = 0; i < pending.count; i++) obj[pool[i]]++;
  return E.discardCards(game, playerIdx, obj);
}

// ---- 他人が選ぶ場面（pendingChoices）。答えられなければ読み飛ばす ----
function resolvePendingChoice(game, choice) {
  const { player, kind } = choice;
  const p = game.players[player];
  if (kind === 'airPollutionHazard') {
    const target = p.cities.find((v) => !E.vertexHasHazard(game, v)) ?? p.towns.find((v) => !E.vertexHasHazard(game, v));
    if (target == null) return E.skipPendingChoice(game, player);
    return E.resolveAirPollutionHazard(game, player, target) || E.skipPendingChoice(game, player);
  }
  if (kind === 'rainHazard') {
    const target = p.towns.find((v) => !E.vertexHasHazard(game, v)) ?? p.cities.find((v) => !E.vertexHasHazard(game, v));
    if (target == null) return E.skipPendingChoice(game, player);
    return E.resolveRainHazard(game, player, target) || E.skipPendingChoice(game, player);
  }
  if (kind === 'prodIncrease') {
    const spot = findPlantSpot(game, player, 'fossil');
    if (!spot) return E.skipPendingChoice(game, player);
    return E.resolveProdIncrease(game, player, spot.vertexId, spot.hexId) || E.skipPendingChoice(game, player);
  }
  if (kind === 'climateGain' || kind === 'sustainableGain') {
    const fn = kind === 'climateGain' ? E.resolveClimateGain : E.resolveSustainableGain;
    for (const k of neededOrder(game, player)) { if (fn(game, player, k)) return true; }
    return E.skipPendingChoice(game, player);
  }
  if (kind === 'climateDiscard') {
    for (const k of spareOrder(game, player)) { if (E.resolveClimateDiscard(game, player, k)) return true; }
    return E.skipPendingChoice(game, player);
  }
  return E.skipPendingChoice(game, player);
}

// ---- 発展カード ----
function playableDevCards(game, idx) {
  if (game.devCardPlayedThisTurn) return [];
  return game.players[idx].devCards.map((c, i) => ({ c, i })).filter(({ c }) => c.type !== 'vp' && c.boughtTurn !== game.turnNumber);
}
// よわい・ふつう用: ランダムに1枚使う
function playRandomDev(game, idx, entries) {
  const { c } = pick(entries);
  if (c.type === 'roadBuilding') return E.playRoadBuildingCard(game);
  if (c.type === 'highYield') {
    const hexIds = ownRenewableHexes(game, idx).slice(0, 3);
    return hexIds.length ? E.playHighYieldCard(game, hexIds) : false;
  }
  if (c.type === 'researchGrant') return E.playResearchGrantCard(game, neededOrder(game, idx).slice(0, 2));
  if (c.type === 'cleanup') return playCleanup(game, idx, 'weak');
  return false;
}
// クリーンアップ: ハザードを外して自分以上のLFの人から1枚もらう。だめなら監査官を動かす
function playCleanup(game, idx, level) {
  const myLf = E.localFootprint(game, idx);
  const victims = game.players.map((_, i) => i).filter((i) => E.localFootprint(game, i) >= myLf)
    .sort((a, b) => E.playerScore(game, b) - E.playerScore(game, a)); // 首位から
  for (const t of allHazardTargets(game)) {
    for (const v of victims) { if (E.playCleanupRemoveHazard(game, t, v)) return true; }
  }
  const move = chooseInspectorMove(game, idx, level);
  return E.playCleanupMoveInspector(game, move.hexId, move.target);
}
// つよい: クリーンアップ（首位から取る）を優先し、次に道路建設・豊作・研究補助金
function playStrongDev(game, idx, playable) {
  if (playable.some(({ c }) => c.type === 'cleanup') && playCleanup(game, idx, 'strong')) return true;
  if (playable.some(({ c }) => c.type === 'roadBuilding') && E.playRoadBuildingCard(game)) return true;
  if (playable.some(({ c }) => c.type === 'highYield')) {
    const hexIds = ownRenewableHexes(game, idx).slice(0, 3);
    if (hexIds.length && E.playHighYieldCard(game, hexIds)) return true;
  }
  if (playable.some(({ c }) => c.type === 'researchGrant') && E.playResearchGrantCard(game, neededOrder(game, idx).slice(0, 2))) return true;
  return false;
}

// ---- よわい: 合法手からほぼでたらめ ----
function weakMainStep(game, idx) {
  const p = game.players[idx];
  const opts = [];
  const roads = E.availableRoadEdges(game, idx);
  if (p.roads.length < E.MAX_ROADS && roads.length && affordable(p.resources, E.COSTS.road)) opts.push('road');
  const towns = E.availableTownVertices(game, idx, false);
  if (p.towns.length < E.MAX_TOWNS && towns.length && affordable(p.resources, E.COSTS.town)) opts.push('town');
  if (p.cities.length < E.MAX_CITIES && p.towns.length && affordable(p.resources, E.COSTS.city)) opts.push('city');
  if (!game.plantBuiltThisTurn) {
    if (canAffordScience(p, E.PLANT_COSTS.fossil) && findPlantSpot(game, idx, 'fossil')) opts.push('plantFossil');
    if (canAffordScience(p, E.PLANT_COSTS.renewable) && findPlantSpot(game, idx, 'renewable')) opts.push('plantRenewable');
  }
  if (game.bank.devDeck.length && affordable(p.resources, E.COSTS.dev)) opts.push('dev');
  if (!p.warehouse && (p.energy || 0) >= E.WAREHOUSE_ENERGY_COST) opts.push('warehouse');
  if ((p.energy || 0) >= E.ENERGY_TRADE_COST) opts.push('energyResource');
  const hazardTargets = allHazardTargets(game);
  if ((p.energy || 0) >= 1 && hazardTargets.length) opts.push('energyClearHazard');
  if (!game.demolishedThisTurn && (p.energy || 0) >= 1 && game.board.plants.some((pl) => pl.owner === idx && pl.kind === 'fossil')) opts.push('demolish');
  const trades = anyBankTrades(game, idx);
  if (trades.length) opts.push('trade');
  const playable = playableDevCards(game, idx);
  if (playable.length) opts.push('playdev');
  opts.push('end');
  switch (pick(opts)) {
    case 'road': return E.buildRoad(game, pick(roads));
    case 'town': return E.buildTown(game, pick(towns));
    case 'city': return E.buildCity(game, pick(p.towns));
    case 'plantFossil': { const s = findPlantSpot(game, idx, 'fossil'); return E.buildPlant(game, s.vertexId, s.hexId, 'fossil'); }
    case 'plantRenewable': { const s = findPlantSpot(game, idx, 'renewable'); return E.buildPlant(game, s.vertexId, s.hexId, 'renewable'); }
    case 'dev': return E.buyDevCard(game);
    case 'warehouse': return E.buildWarehouse(game);
    case 'energyResource': return E.useEnergyForResource(game, idx, pick([...E.RESOURCES, 'science']));
    case 'energyClearHazard': return E.useEnergyToClearHazard(game, idx, pick(hazardTargets));
    case 'demolish': return E.demolishFossilPlant(game, idx, game.board.plants.findIndex((pl) => pl.owner === idx && pl.kind === 'fossil'));
    case 'trade': { const [give, want] = pick(trades); return E.bankTrade(game, idx, give, want); }
    case 'playdev': return playRandomDev(game, idx, playable);
    default: return E.endTurn(game);
  }
}

// ---- ふつう・つよい: 建てられる中で一番ましな物を貪欲に建てる ----
function greedyMainStep(game, idx, level) {
  const p = game.players[idx];
  // ほとんどの対局は袋切れ(再生>化石の人が勝つ)で終わるので、つよいは最初から再生可能を優先する
  const bagLow = level === 'strong' && game.bag.length <= 10; // 残りがさらに減ったら化石を壊してでも追いつく

  // 町・都市・道を最優先（点に直結し、そこから発電所の置き場所も増える）
  if (p.cities.length < E.MAX_CITIES && p.towns.length && affordable(p.resources, E.COSTS.city)) {
    const best = p.towns.slice().sort((a, b) => vertexValue(game, b) - vertexValue(game, a))[0];
    if (E.buildCity(game, best)) return true;
  }
  const townVs = E.availableTownVertices(game, idx, false);
  if (p.towns.length < E.MAX_TOWNS && townVs.length && affordable(p.resources, E.COSTS.town)) {
    const best = townVs.slice().sort((a, b) => vertexValue(game, b) - vertexValue(game, a))[0];
    if (E.buildTown(game, best)) return true;
  }
  const edges = E.availableRoadEdges(game, idx).filter((e) => affordable(p.resources, E.COSTS.road));
  if (p.roads.length < E.MAX_ROADS && edges.length) {
    const best = edges.map((e) => ({ e, s: roadValue(game, e) })).sort((a, b) => b.s - a.s)[0];
    if (best.s >= 0 && E.buildRoad(game, best.e)) return true;
  }
  // 町・都市・道に足りない資源は、港・銀行・科学3:1・エネルギー2:1で補ってから次の手番を待つ
  if (tryHelpfulBankTrade(game, idx)) return true;
  if (tryHelpfulEnergyTrade(game, idx)) return true;
  if (!game.plantBuiltThisTurn) {
    // 化石は再生可能より多く建てすぎない（GFが上がりすぎて自分も損をする）。再生可能はいつでも歓迎
    const fossilCount = game.board.plants.filter((pl) => pl.owner === idx && pl.kind === 'fossil').length;
    const renewCount = game.board.plants.filter((pl) => pl.owner === idx && pl.kind === 'renewable').length;
    const order = (level === 'strong' || fossilCount >= renewCount) ? ['renewable', 'fossil'] : ['fossil', 'renewable'];
    for (const kind of order) {
      if (kind === 'fossil' && fossilCount > renewCount) continue;
      if (!canAffordScience(p, E.PLANT_COSTS[kind])) continue;
      const spot = findPlantSpot(game, idx, kind);
      if (spot && E.buildPlant(game, spot.vertexId, spot.hexId, kind)) return true;
    }
  }
  if (bagLow && !game.demolishedThisTurn && (p.energy || 0) >= E.ENERGY_DEMOLISH_COST) {
    const renew = game.board.plants.filter((pl) => pl.owner === idx && pl.kind === 'renewable').length;
    const fossil = game.board.plants.filter((pl) => pl.owner === idx && pl.kind === 'fossil');
    if (renew <= fossil.length && fossil.length) {
      const plantIdx = game.board.plants.findIndex((pl) => pl.owner === idx && pl.kind === 'fossil');
      if (E.demolishFossilPlant(game, idx, plantIdx)) return true;
    }
  }
  const ownTargets = ownHazardTargets(game, idx);
  if ((p.energy || 0) >= 1 && ownTargets.length && E.useEnergyToClearHazard(game, idx, pick(ownTargets))) return true;
  if (game.bank.devDeck.length && affordable(p.resources, E.COSTS.dev) && E.buyDevCard(game)) return true;
  const playable = playableDevCards(game, idx);
  if (playable.length) {
    if (level === 'strong' && playStrongDev(game, idx, playable)) return true;
    if (level === 'normal' && playRandomDev(game, idx, playable)) return true;
  }
  if (!p.warehouse && (p.energy || 0) >= E.WAREHOUSE_ENERGY_COST && E.buildWarehouse(game)) return true;
  // 余ったエネルギーは資源へ替える（ほぼ満タンで、他に使い道がないときだけ）
  if ((p.energy || 0) >= E.ENERGY_MAX - 1 && E.useEnergyForResource(game, idx, neededOrder(game, idx)[0])) return true;
  if (tryHelpfulBankTrade(game, idx)) return true;
  // 盤がほぼ埋まったときの最後の手: 長い交易路だけでも伸ばす
  if (p.roads.length < E.MAX_ROADS && edges.length && game.longestRoadPlayer !== idx && E.buildRoad(game, edges[0])) return true;
  return false;
}

function mainStep(game, idx, level) {
  if (game.freeRoadsRemaining > 0) {
    const edges = E.availableRoadEdges(game, idx);
    if (edges.length) {
      const best = level === 'weak' ? pick(edges) : edges.slice().sort((a, b) => roadValue(game, b) - roadValue(game, a))[0];
      if (E.useFreeRoadFromCard(game, best)) return true;
    }
    // 置ける場所がなければ、残りはそのまま（他の手を打ち、手番の終わりに engine が0へ戻す）
  }
  if (level === 'weak') return weakMainStep(game, idx);
  if (greedyMainStep(game, idx, level)) return true;
  return E.endTurn(game);
}

// ---- 手番で次の1手を1つ進める。true なら何か起きた（main.js はこれを呼び続ける） ----
export function step(game, levelFor = 'normal') {
  if (game.phase === 'gameOver') return false;
  const choice = E.pendingChoice(game);
  if (choice) return resolvePendingChoice(game, choice, levelOf(levelFor, choice.player));
  if (game.phase === 'setupTown' || game.phase === 'setupCity') return setupStep(game, levelOf(levelFor, E.currentPlayer(game)));
  if (game.phase === 'event') return eventStep(game);
  if (game.phase === 'roll') { E.rollDice(game, Math.random); return true; }
  if (game.phase === 'discard') {
    const d = game.pendingDiscards[0];
    return d ? discardFor(game, d.player, levelOf(levelFor, d.player)) : false;
  }
  if (game.phase === 'moveInspector') {
    const idx = E.currentPlayer(game);
    const move = chooseInspectorMove(game, idx, levelOf(levelFor, idx));
    return E.moveInspector(game, move.hexId, move.target);
  }
  if (game.phase === 'main') return mainStep(game, E.currentPlayer(game), levelOf(levelFor, E.currentPlayer(game)));
  return false;
}
