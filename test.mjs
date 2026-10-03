'use strict';
// engine.js の自己チェック（作業1=土台だけの範囲）。フレームワークなし。node --test で動く。
// cpu.js・main.js は古い engine に合わせたままなので、ここでは触らない（作業4・5で合わせる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from './engine.js';
import * as C from './cpu.js';

test('盤面: 19マス・54頂点・72辺・地形の枚数・数字の分布', () => {
  const g = E.createGame(4, Math.random);
  assert.equal(g.board.hexes.length, 19);
  assert.equal(g.board.vertices.length, 54);
  assert.equal(g.board.edges.length, 72);
  const counts = {};
  g.board.hexes.forEach((h) => { counts[h.terrain] = (counts[h.terrain] || 0) + 1; });
  assert.deepEqual(counts, { forest: 4, hills: 3, pasture: 4, field: 4, mountains: 3, desert: 1 });
  const numbers = g.board.hexes.filter((h) => h.terrain !== 'desert').map((h) => h.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);
  assert.equal(g.board.hexes.find((h) => h.terrain === 'desert').number, null);
  const portVertices = g.board.vertices.filter((v) => v.port);
  assert.equal(portVertices.length, 18); // 港9か所 × 頂点2つ
  const byType = {};
  portVertices.forEach((v) => { byType[v.port] = (byType[v.port] || 0) + 1; });
  assert.equal(byType['3:1'], 8);
  E.RESOURCES.forEach((r) => assert.equal(byType[r], 2));
});

function playSetup(g) {
  // 2人×2周ぶんを機械的に進める（距離ルールに触れない最初の候補を選ぶだけ）
  while (g.phase === 'setupTown' || g.phase === 'setupCity') {
    const idx = E.currentPlayer(g);
    const v = E.availableTownVertices(g, idx, true)[0];
    assert.ok(E.setupPlaceBuilding(g, v));
    const e = g.board.vertices[v].edgeIds[0];
    assert.ok(E.setupPlaceRoad(g, e));
  }
}

test('準備: 距離ルール、2周目は都市、都市のまわりの資源1ずつ＋科学1をもらう', () => {
  const g = E.createGame(3, Math.random);
  assert.equal(E.currentPlayer(g), 0);
  const v0 = E.availableTownVertices(g, 0, true)[0];
  assert.ok(E.setupPlaceBuilding(g, v0));
  assert.equal(g.board.vertices[v0].building.type, 'town');
  // 隣接頂点には置けない（距離ルール）
  const neighbor = g.board.vertices[v0].neighbors[0];
  assert.equal(E.canPlaceTown(g, neighbor, 0, true), false);
  const road0 = g.board.vertices[v0].edgeIds[0];
  assert.ok(E.setupPlaceRoad(g, road0));
  assert.equal(E.currentPlayer(g), 1);

  for (let i = 0; i < 5; i++) {
    const idx = E.currentPlayer(g);
    const wasSetupCity = g.phase === 'setupCity';
    const v = E.availableTownVertices(g, idx, true)[0];
    const scienceBefore = g.players[idx].science;
    E.setupPlaceBuilding(g, v);
    if (wasSetupCity) assert.equal(g.board.vertices[v].building.type, 'city');
    const e = g.board.vertices[v].edgeIds[0];
    const resBefore = JSON.parse(JSON.stringify(g.players[idx].resources));
    E.setupPlaceRoad(g, e);
    if (wasSetupCity) {
      const resAfter = g.players[idx].resources;
      const nonDesertHexes = g.board.vertices[v].hexIds.filter((h) => g.board.hexes[h].terrain !== 'desert');
      const gained = Object.keys(resBefore).some((k) => resAfter[k] > resBefore[k]);
      assert.ok(gained || nonDesertHexes.length === 0);
      assert.equal(g.players[idx].science, scienceBefore + 1); // 科学は都市のまわりの地形数によらず1枚
    }
  }
  assert.equal(g.phase, 'event'); // セットアップのあとは手番の初めのイベントフェーズから
  assert.equal(g.drawsLeft, E.drawsFor(g));
  assert.equal(g.turn, 0);
  g.players.forEach((p) => { assert.equal(p.towns.length, 1); assert.equal(p.cities.length, 1); assert.equal(p.roads.length, 2); });
});

// rollDice に渡すと必ず total を出す rng（d1+d2=total になるよう固定する）
function fixedDiceRng(total) {
  const d1 = Math.min(6, Math.max(1, total - 1));
  const d2 = total - d1;
  const seq = [(d1 - 1) / 6 + 1e-6, (d2 - 1) / 6 + 1e-6];
  let i = 0;
  return () => seq[(i++) % 2];
}

test('産出: 町は資源1、都市は資源1＋科学1（資源2ではない）', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.phase = 'roll'; // イベントフェーズは別のテストで見る
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  const cityVid = p.cities[0];
  const neighborHexes = g.board.vertices[cityVid].hexIds.map((h) => g.board.hexes[h]).filter((h) => h.terrain !== 'desert' && h.id !== g.inspectorHex);
  // 都市のまわりでちょうど1枚だけ出る数字（2枚同じ数字が隣り合う稀なケースは除く）を選ぶ
  const counts = {};
  neighborHexes.forEach((h) => { counts[h.number] = (counts[h.number] || 0) + 1; });
  let number = Number(Object.keys(counts).find((n) => counts[n] === 1));
  // 自分のほかの建物（町やもう1つの都市）が同じ数字の地形にも接していたら、そのぶん資源が増えてしまうので除く
  const otherVertices = [...p.towns, ...p.cities.filter((v) => v !== cityVid)];
  const otherNumbers = new Set(otherVertices.flatMap((v) => g.board.vertices[v].hexIds.map((h) => g.board.hexes[h].number)));
  if (otherNumbers.has(number)) number = null;
  if (!number) return; // 全部かぶっていたら（稀）スキップ
  const before = { res: JSON.parse(JSON.stringify(p.resources)), sci: p.science };
  const total = E.rollDice(g, fixedDiceRng(number));
  assert.equal(total, number);
  const gainedRes = Object.keys(before.res).reduce((a, k) => a + (g.players[idx].resources[k] - before.res[k]), 0);
  assert.equal(gainedRes, 1); // 資源2ではなく1
  assert.equal(g.players[idx].science, before.sci + 1);
});

test('7: 手札8枚以上（科学込み）が半分捨てる', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  p.resources = { lumber: 5, brick: 0, fiber: 0, food: 0, steel: 0 };
  p.science = 3; // 合計8枚
  g.phase = 'roll';
  const total = E.rollDice(g, fixedDiceRng(7));
  assert.equal(total, 7);
  assert.equal(g.phase, 'discard');
  const pending = g.pendingDiscards.find((d) => d.player === idx);
  assert.ok(pending);
  assert.equal(pending.count, 4); // 8枚の半分
  assert.ok(E.discardCards(g, idx, { lumber: 3, science: 1 }));
  assert.equal(g.players[idx].science, 2);
  assert.equal(g.players[idx].resources.lumber, 2);
});

test('銀行交易: 科学3→資源1', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  const idx = E.currentPlayer(g);
  g.phase = 'main';
  g.players[idx].science = 3;
  const bankBefore = g.bank.resources.steel;
  const steelBefore = g.players[idx].resources.steel;
  assert.ok(E.bankTrade(g, idx, 'science', 'steel'));
  assert.equal(g.players[idx].science, 0);
  assert.equal(g.players[idx].resources.steel, steelBefore + 1);
  assert.equal(g.bank.resources.steel, bankBefore - 1);
});

test('港との交易: 3:1港は3枚、2:1港はその資源2枚で交換できる', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  const idx = E.currentPlayer(g);
  g.phase = 'main';
  const p = g.players[idx];
  p.towns = []; p.cities = [];
  g.board.vertices.forEach((v) => { if (v.building && v.building.owner === idx) v.building = null; });

  const threeOne = g.board.vertices.find((v) => v.port === '3:1');
  threeOne.building = { type: 'town', owner: idx };
  p.towns.push(threeOne.id);
  assert.equal(E.tradeRate(g, idx, 'lumber'), 3);
  p.resources.lumber = 3;
  const bankBrickBefore = g.bank.resources.brick;
  assert.ok(E.bankTrade(g, idx, 'lumber', 'brick'));
  assert.equal(p.resources.lumber, 0);
  assert.equal(g.bank.resources.brick, bankBrickBefore - 1);

  const twoOne = g.board.vertices.find((v) => E.RESOURCES.includes(v.port));
  p.towns = [twoOne.id];
  threeOne.building = null;
  twoOne.building = { type: 'town', owner: idx };
  const kind = twoOne.port;
  assert.equal(E.tradeRate(g, idx, kind), 2);
  p.resources[kind] = 2;
  const otherKind = E.RESOURCES.find((r) => r !== kind);
  const bankOtherBefore = g.bank.resources[otherKind];
  assert.ok(E.bankTrade(g, idx, kind, otherKind));
  assert.equal(p.resources[kind], 0);
  assert.equal(g.bank.resources[otherKind], bankOtherBefore - 1);
  // その港は自分の資源だけ。別の資源は2枚あっても4:1のまま
  const thirdKind = E.RESOURCES.find((r) => r !== kind && r !== otherKind);
  p.resources[thirdKind] = 2;
  assert.equal(E.bankTrade(g, idx, thirdKind, otherKind), false);
});

test('相手との交易: 資源・科学・エネルギーを自由に組み合わせ。あげるだけ・同じ物どうし・エネルギー超過は不可', () => {
  const g = E.createGame(3, Math.random);
  playSetup(g);
  const idx = E.currentPlayer(g);
  g.phase = 'main';
  const other = (idx + 1) % 3;
  const me = g.players[idx], ot = g.players[other];
  for (const p of [me, ot]) for (const k in p.resources) p.resources[k] = 0; // 準備でもらう資源は乱数なので空にする
  me.resources.lumber = 2; ot.resources.steel = 1;
  assert.equal(E.playerTrade(g, other, { lumber: 2 }, {}), false); // あげるだけは不可
  assert.equal(E.playerTrade(g, other, { lumber: 2 }, { lumber: 1 }), false); // 同じ物どうしは不可
  assert.ok(E.playerTrade(g, other, { lumber: 2 }, { steel: 1 }));
  assert.equal(me.resources.lumber, 0);
  assert.equal(me.resources.steel, 1);
  assert.equal(ot.resources.steel, 0);
  assert.equal(ot.resources.lumber, 2);
  // エネルギーを含む交易。あげるものが無ければ不可。受け取って5を超えるなら不可
  me.energy = 5; ot.energy = 1; me.resources.brick = 1;
  assert.equal(E.playerTrade(g, other, {}, { energy: 1 }), false); // giveTotalが0
  assert.equal(E.playerTrade(g, other, { brick: 1 }, { energy: 1 }), false); // me.energyが5で受け取ると超える
  me.energy = 3;
  assert.ok(E.playerTrade(g, other, { brick: 1 }, { energy: 1 }));
  assert.equal(me.energy, 4);
  assert.equal(ot.energy, 0);
});

test('CPU: 相手の交易の受け入れは、出すより来る方が多いか、足りない物が来るときに受ける', () => {
  const g = E.createGame(3, Math.random);
  g.players[0].resources.lumber = 0; g.players[0].resources.brick = 0; g.players[0].resources.fiber = 5; g.players[0].resources.food = 5; g.players[0].resources.steel = 5; g.players[0].science = 5;
  assert.ok(C.acceptTrade(g, 0, { steel: 1 }, { lumber: 1 })); // CPUが足りないlumberをもらえるなら受ける
  assert.equal(C.acceptTrade(g, 0, { steel: 1, food: 1 }, { lumber: 1 }), true);
});

test('勝利判定: 他人の手番中に10点になっても勝たず、本人の手番になってから勝つ', () => {
  const g = E.createGame(2, Math.random);
  playSetup(g);
  g.phase = 'main';
  // プレイヤー1に町4つぶんの点（1+1×4=... 実際は長い交易路で作る）: 町1+都市2=3点に、長い交易路(+2)を乗せて5点…
  // もっと単純に: プレイヤー1の得点を10点ぴったりにするため、町を使わず devCards の勝利点カードで足す
  const p1 = g.players[1];
  for (let i = 0; i < 6; i++) p1.devCards.push({ type: 'vp', boughtTurn: 1 }); // 3(町+都市) + 6 = 9点にはまだ届かない
  p1.devCards.push({ type: 'vp', boughtTurn: 1 }); // 10点ちょうど
  assert.ok(E.playerScore(g, 1) >= 10);
  // 今はプレイヤー0の手番。得点が変わるような操作（道を1本自由に置く）をしても、1の勝ちは確定しない
  const idx0 = E.currentPlayer(g);
  assert.equal(idx0, 0);
  const anyEdge = E.availableRoadEdges(g, 0)[0];
  if (anyEdge != null) E.buildRoad(g, anyEdge, { free: true });
  assert.equal(g.winners, null);
  // 0の手番を終えて1の手番になった瞬間に判定される
  E.endTurn(g);
  assert.equal(E.currentPlayer(g), 1);
  assert.deepEqual(g.winners, [1]);
  assert.equal(g.endReason, 'vp');
  assert.equal(g.phase, 'gameOver');
});

// ---- 作業2: 発電所・エネルギー・汚染（LF・GF）・ハザード ----

test('発電所: 町は1つ・都市は3つまで、同じ（交点,地形）の組には2つ目を置けない、1手番に2つ目は不可', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.phase = 'main';
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  p.science = 30;
  const townV = p.towns[0];
  const townHex = g.board.vertices[townV].hexIds.find((hId) => g.board.hexes[hId].number != null);
  assert.ok(E.buildPlant(g, townV, townHex, 'fossil'));
  assert.equal(g.plantBuiltThisTurn, true);
  // 同じ手番にもう1つは不可（別の町・都市でも）
  const cityV = p.cities[0];
  const cityHex = g.board.vertices[cityV].hexIds.find((hId) => g.board.hexes[hId].number != null);
  assert.equal(E.buildPlant(g, cityV, cityHex, 'renewable'), false);
  g.plantBuiltThisTurn = false; // 次の手番とみなす
  // 町にはもう置けない（1つまで）
  assert.equal(E.canBuildPlant(g, idx, townV, townHex, 'renewable'), false);
  // 都市: 同じ組には2つ目を置けないが、別の地形には置ける
  assert.ok(E.buildPlant(g, cityV, cityHex, 'fossil'));
  g.plantBuiltThisTurn = false;
  assert.equal(E.canBuildPlant(g, idx, cityV, cityHex, 'renewable'), false);
  const otherCityHex = g.board.vertices[cityV].hexIds.find((hId) => hId !== cityHex && g.board.hexes[hId].number != null);
  if (otherCityHex != null) assert.ok(E.buildPlant(g, cityV, otherCityHex, 'renewable'));
});

test('発電所: 都市でも4つ目は置けない（上限3）、化石6・再生9の持ち駒を超えられない', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.phase = 'main';
  const idx = E.currentPlayer(g);
  const cityV = g.players[idx].cities[0];
  const hexId = g.board.vertices[cityV].hexIds.find((hId) => g.board.hexes[hId].number != null);
  for (let i = 0; i < 3; i++) g.board.plants.push({ owner: idx, kind: 'fossil', vertexId: cityV, hexId: -1 - i });
  assert.equal(E.canBuildPlant(g, idx, cityV, hexId, 'renewable'), false);
  g.board.plants = [];
  for (let i = 0; i < E.MAX_FOSSIL; i++) g.board.plants.push({ owner: idx, kind: 'fossil', vertexId: -1, hexId: -1 - i });
  assert.equal(E.canBuildPlant(g, idx, cityV, hexId, 'fossil'), false);
  assert.equal(E.canBuildPlant(g, idx, cityV, hexId, 'renewable'), true);
});

test('エネルギー: 発電所の産出で増え、上限5で止まる。使い道3つ（資源/科学・ハザード除去・化石を壊す）', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  const cityV = p.cities[0];
  const hexId = g.board.vertices[cityV].hexIds.find((hId) => g.board.hexes[hId].number != null);
  const number = g.board.hexes[hexId].number;
  p.science = 10;
  g.phase = 'main';
  assert.ok(E.buildPlant(g, cityV, hexId, 'fossil'));
  g.plantBuiltThisTurn = false;
  p.energy = 4;
  g.phase = 'roll';
  E.rollDice(g, fixedDiceRng(number));
  assert.equal(p.energy, E.ENERGY_MAX); // 4+1だが上限5で止まる
  g.phase = 'main';
  // 使い道1: エネルギー2 → 資源か科学1
  const steelBefore = p.resources.steel;
  assert.ok(E.useEnergyForResource(g, idx, 'steel'));
  assert.equal(p.resources.steel, steelBefore + 1);
  assert.equal(p.energy, E.ENERGY_MAX - E.ENERGY_TRADE_COST);
  // 使い道3: エネルギー1 → 自分の化石燃料発電所を壊す（1手番1回）
  const plantIndex = g.board.plants.findIndex((pl) => pl.owner === idx && pl.kind === 'fossil');
  assert.ok(E.demolishFossilPlant(g, idx, plantIndex));
  assert.equal(g.board.plants.some((pl) => pl.owner === idx && pl.kind === 'fossil'), false);
  assert.equal(g.demolishedThisTurn, true);
  // もう1つ化石があっても1手番1回まで
  g.board.plants.push({ owner: idx, kind: 'fossil', vertexId: cityV, hexId });
  assert.equal(E.demolishFossilPlant(g, idx, g.board.plants.length - 1), false);
});

test('ハザード: 地形・建物の産出を止め、その出目のあと外れる。監査官が止めた地形に接する建物のハザードは外れない', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  const townV = p.towns[0];
  // 自分のほかの建物が同じ数字の地形にも接していると、そちらは産出してしまい比較できないので避ける
  const otherVertices = [...p.towns.filter((v) => v !== townV), ...p.cities];
  const otherNumbers = new Set(otherVertices.flatMap((v) => g.board.vertices[v].hexIds.map((h) => g.board.hexes[h].number)));
  const hex = g.board.vertices[townV].hexIds.map((h) => g.board.hexes[h]).find((h) => h.number != null && !otherNumbers.has(h.number));
  if (!hex) return; // 全部かぶっていたら（稀）スキップ
  // 建物にハザード: その出目で何ももらえない
  assert.ok(E.placeHazardOnVertex(g, townV));
  g.phase = 'roll';
  const before = { res: JSON.parse(JSON.stringify(p.resources)), energy: p.energy };
  E.rollDice(g, fixedDiceRng(hex.number));
  assert.deepEqual(p.resources, before.res); // もらえない
  assert.equal(E.vertexHasHazard(g, townV), false); // 出目のあと外れる

  // 監査官をその地形へ動かすと、接する建物のハザードは外れない
  g.phase = 'main';
  assert.ok(E.placeHazardOnVertex(g, townV));
  g.inspectorHex = hex.id;
  g.phase = 'roll';
  E.rollDice(g, fixedDiceRng(hex.number)); // 監査官の地形は産出もなく、ハザードも外れない
  assert.equal(E.vertexHasHazard(g, townV), true);
});

test('汚染(LF・GF): 町+2x都市+化石-再生、合計をトラックの範囲に収める', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  const base = E.localFootprint(g, idx);
  assert.equal(base, p.towns.length + p.cities.length * 2);
  const cityV = p.cities[0];
  const hexId = g.board.vertices[cityV].hexIds.find((hId) => g.board.hexes[hId].number != null);
  g.board.plants.push({ owner: idx, kind: 'fossil', vertexId: cityV, hexId });
  assert.equal(E.localFootprint(g, idx), base + 1);
  g.board.plants.push({ owner: idx, kind: 'renewable', vertexId: cityV, hexId: -1 });
  assert.equal(E.localFootprint(g, idx), base); // 化石+1・再生-1で元に戻る
  const gf = E.globalFootprint(g);
  assert.ok(gf >= 0 && gf <= E.GF_RANGE[4]);
  assert.ok(E.drawsFor(g) >= 1);
});

test('倉庫: 建てると7のときの捨て札の上限が8→11枚になる。壊す・捨てるの操作自体は1回だけ', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  g.phase = 'main';
  p.energy = 2;
  assert.ok(E.buildWarehouse(g));
  assert.equal(p.warehouse, true);
  assert.equal(p.energy, 0);
  assert.equal(E.buildWarehouse(g), false); // 1回だけ
  // 10枚(科学込み)は捨てない。11枚以上で捨てる
  p.resources = { lumber: 10, brick: 0, fiber: 0, food: 0, steel: 0 };
  p.science = 0;
  g.phase = 'roll';
  E.rollDice(g, fixedDiceRng(7));
  assert.equal(g.phase, 'moveInspector'); // 10枚なので捨てずに次へ
  p.resources.lumber = 11;
  g.phase = 'roll';
  E.rollDice(g, fixedDiceRng(7));
  const pending = g.pendingDiscards.find((d) => d.player === idx);
  assert.ok(pending);
  assert.equal(pending.count, 5); // 11枚の半分(切り捨て)
});

// ---- 作業3: イベント・終わり方・発展カード ----

test('緑ディスク: 3人は27枚(9×3)、4人は36枚(9×4)を各自の再生可能発電所の下に配る', () => {
  const g3 = E.createGame(3, Math.random);
  assert.equal(g3.players.reduce((a, p) => a + p.greenDiscs.length, 0), 27);
  g3.players.forEach((p) => assert.equal(p.greenDiscs.length, 9));
  const g4 = E.createGame(4, Math.random);
  assert.equal(g4.players.reduce((a, p) => a + p.greenDiscs.length, 0), 36);
});

test('イベント: 手番の初めのGFで引く枚数が決まり、途中でGFが変わっても変えない', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  assert.equal(g.phase, 'event');
  const initial = g.drawsLeft;
  assert.equal(initial, E.drawsFor(g));
  const idx = E.currentPlayer(g);
  g.board.plants.push({ owner: idx, kind: 'fossil', vertexId: -1, hexId: -900 }); // GFが動く操作をしても
  assert.equal(g.drawsLeft, initial); // 保持した値は変わらない
});

test('イベント: マスが埋まると発動し、ディスクが消える(マスは空に戻る)', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.bag = ['funding', 'funding', 'funding', 'funding']; // 政府の補助金は4枚で発動(0章B)
  g.drawsLeft = 4;
  assert.equal(E.drawEventDisc(g), true);
  assert.equal(E.drawEventDisc(g), true);
  assert.equal(E.drawEventDisc(g), true);
  assert.equal(g.tracks.funding, 3);
  assert.equal(E.drawEventDisc(g), 'funding'); // 全員LFが同点なので何も起きないが、発動自体はする
  assert.equal(g.tracks.funding, 0);
  assert.equal(g.bag.length, 0);
  assert.equal(g.phase, 'roll'); // drawsLeftも尽きている
});

test('イベント: 大気汚染はLFが一番高い人が都市にハザード', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  const idx = 2;
  for (let k = 0; k < 2; k++) g.board.plants.push({ owner: idx, kind: 'fossil', vertexId: -1, hexId: -200 - k });
  g.bag = ['airPollution', 'airPollution', 'airPollution'];
  g.drawsLeft = 3;
  E.drawEventDisc(g); E.drawEventDisc(g);
  assert.equal(E.drawEventDisc(g), 'airPollution');
  assert.deepEqual(g.pendingChoices, [{ player: idx, kind: 'airPollutionHazard' }]);
  const cityV = g.players[idx].cities[0];
  assert.ok(E.resolveAirPollutionHazard(g, idx, cityV));
  assert.equal(E.vertexHasHazard(g, cityV), true);
  assert.equal(g.pendingChoices.length, 0);
});

test('イベント: 環境汚染は出目の地形にハザード(7は振り直し)。監査官の地形は除く', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  const eightHexes = g.board.hexes.filter((h) => h.number === 8);
  assert.ok(eightHexes.length >= 1);
  g.inspectorHex = eightHexes[0].id; // 監査官を8の地形に置いておく
  g.bag = ['envPollution', 'envPollution', 'envPollution', 'envPollution']; // 0章Bで4枚で発動
  g.drawsLeft = 4;
  E.drawEventDisc(g); E.drawEventDisc(g); E.drawEventDisc(g);
  // 7,7,8の順に出るrng(fixedDiceRngと同じ作り方。6面サイコロ2個ぶんを順に消費する)
  const seq = [5 / 6 + 1e-6, 0 + 1e-6, 5 / 6 + 1e-6, 0 + 1e-6, 3 / 6 + 1e-6, 3 / 6 + 1e-6];
  let i = 0;
  const rng = () => seq[(i++) % seq.length];
  assert.equal(E.drawEventDisc(g, rng), 'envPollution');
  assert.ok(!g.hazards.hexes.includes(eightHexes[0].id)); // 監査官のいる地形には置かない
  if (eightHexes.length > 1) assert.ok(g.hazards.hexes.includes(eightHexes[1].id));
});

test('イベント: 生産増加はLFが一番高い人が化石燃料発電所を1つただで建てられ、1手番1つの制限に数えない', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  for (let k = 0; k < 2; k++) g.board.plants.push({ owner: idx, kind: 'fossil', vertexId: -1, hexId: -300 - k }); // LFを一番高くする
  g.phase = 'main';
  p.science = 10;
  const townV = p.towns[0];
  const townHex = g.board.vertices[townV].hexIds.find((h) => g.board.hexes[h].number != null);
  assert.ok(E.buildPlant(g, townV, townHex, 'renewable')); // 通常の1手番1つを使い切る
  assert.equal(g.plantBuiltThisTurn, true);
  g.phase = 'event';
  g.bag = ['prodIncrease', 'prodIncrease', 'prodIncrease'];
  g.drawsLeft = 3;
  E.drawEventDisc(g); E.drawEventDisc(g);
  assert.equal(E.drawEventDisc(g), 'prodIncrease');
  assert.deepEqual(g.pendingChoices, [{ player: idx, kind: 'prodIncrease' }]);
  const cityV = p.cities[0];
  const cityHex = g.board.vertices[cityV].hexIds.find((h) => g.board.hexes[h].number != null);
  const before = g.board.plants.length;
  const resBefore = { ...p.resources };
  assert.ok(E.resolveProdIncrease(g, idx, cityV, cityHex));
  assert.equal(g.board.plants.length, before + 1);
  const gained = Object.keys(resBefore).some((k) => p.resources[k] > resBefore[k]);
  assert.ok(gained); // 建てた地形の資源を1枚もらう
  assert.equal(g.plantBuiltThisTurn, true); // 通常の1手番1つの制限はそのまま(無料ぶんは数えていない)
});

test('イベント: 豪雨と洪水は全員が(手番の人から時計回りに)自分の町/都市にハザードを置く', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.bag = ['rain', 'rain', 'rain', 'rain'];
  g.drawsLeft = 4;
  E.drawEventDisc(g); E.drawEventDisc(g); E.drawEventDisc(g);
  assert.equal(E.drawEventDisc(g), 'rain');
  assert.deepEqual(g.pendingChoices.map((c) => c.player), [0, 1, 2, 3]);
  g.pendingChoices.map((c) => c.player).slice().forEach((p) => {
    assert.ok(E.resolveRainHazard(g, p, g.players[p].towns[0]));
  });
  assert.equal(g.pendingChoices.length, 0);
});

test('イベント: 気候会議は同点なら全員が時計回りに行う。全員同点なら何も起きない', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  // 全員同点(LF3)のときは何も起きない
  g.bag = ['climate', 'climate', 'climate'];
  g.drawsLeft = 3;
  E.drawEventDisc(g); E.drawEventDisc(g);
  assert.equal(E.drawEventDisc(g), 'climate');
  assert.equal(g.pendingChoices.length, 0);

  // 0,1のLFを5に上げる(化石を2つずつ追加)。2,3はLF3のまま最低
  [0, 1].forEach((i) => { for (let k = 0; k < 2; k++) g.board.plants.push({ owner: i, kind: 'fossil', vertexId: -1, hexId: -1000 - i * 10 - k }); });
  g.phase = 'event';
  g.drawsLeft = 3;
  g.bag = ['climate', 'climate', 'climate'];
  E.drawEventDisc(g); E.drawEventDisc(g); E.drawEventDisc(g);
  const kinds = g.pendingChoices.map((c) => `${c.player}:${c.kind}`);
  assert.deepEqual(kinds, ['2:climateGain', '3:climateGain', '0:climateDiscard', '1:climateDiscard']);
  assert.ok(E.resolveClimateGain(g, 2, 'lumber'));
  assert.ok(E.resolveClimateGain(g, 3, 'lumber'));
  g.players[0].resources.lumber = 1;
  assert.ok(E.resolveClimateDiscard(g, 0, 'lumber'));
  g.players[1].resources.lumber = 1;
  assert.ok(E.resolveClimateDiscard(g, 1, 'lumber'));
  assert.equal(g.pendingChoices.length, 0);
  assert.equal(g.phase, 'roll');
});

test('イベント: 政府の補助金はLFが一番低い人が発展カードを1枚もらう(選ぶ場面ではない)', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  [0, 1, 2].forEach((i) => g.board.plants.push({ owner: i, kind: 'fossil', vertexId: -1, hexId: -1100 - i }));
  g.bag = ['funding', 'funding', 'funding', 'funding'];
  g.drawsLeft = 4;
  E.drawEventDisc(g); E.drawEventDisc(g); E.drawEventDisc(g);
  const before = g.players[3].devCards.length;
  assert.equal(E.drawEventDisc(g), 'funding');
  assert.equal(g.players[3].devCards.length, before + 1);
  assert.equal(g.pendingChoices.length, 0);
});

test('イベント: 持続可能な生産は再生可能発電所が一番多い人がもらう', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.board.plants.push({ owner: 1, kind: 'renewable', vertexId: -1, hexId: -1200 });
  g.bag = ['sustainable', 'sustainable', 'sustainable'];
  g.drawsLeft = 3;
  E.drawEventDisc(g); E.drawEventDisc(g);
  assert.equal(E.drawEventDisc(g), 'sustainable');
  assert.deepEqual(g.pendingChoices, [{ player: 1, kind: 'sustainableGain' }]);
  const before = g.players[1].resources.lumber;
  assert.ok(E.resolveSustainableGain(g, 1, 'lumber'));
  assert.equal(g.players[1].resources.lumber, before + 1);
});

test('袋切れ: 再生>化石の差が一番大きい人が勝つ。いなければ全員の負け(winnersが空)', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.board.plants.push({ owner: 0, kind: 'renewable', vertexId: -1, hexId: -1300 });
  g.board.plants.push({ owner: 0, kind: 'renewable', vertexId: -1, hexId: -1301 });
  g.board.plants.push({ owner: 1, kind: 'renewable', vertexId: -1, hexId: -1302 });
  g.board.plants.push({ owner: 1, kind: 'fossil', vertexId: -1, hexId: -1303 });
  g.bag = [];
  g.drawsLeft = 1;
  assert.equal(E.drawEventDisc(g), 'bagEmpty');
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.endReason, 'bag');
  assert.deepEqual(g.winners, [0]); // 0は差+2、1は差+1

  const g2 = E.createGame(4, Math.random);
  playSetup(g2);
  g2.board.plants.push({ owner: 0, kind: 'fossil', vertexId: -1, hexId: -1400 });
  g2.bag = [];
  g2.drawsLeft = 1;
  E.drawEventDisc(g2);
  assert.deepEqual(g2.winners, []); // 誰も再生>化石でない
});

test('発展カード: 道路建設は道を2本ただで置ける。1手番1枚の制限にかかる', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.phase = 'main';
  const idx = E.currentPlayer(g);
  g.players[idx].devCards.push({ type: 'roadBuilding', boughtTurn: null });
  assert.ok(E.playRoadBuildingCard(g));
  assert.equal(g.freeRoadsRemaining, 2);
  assert.ok(E.useFreeRoadFromCard(g, E.availableRoadEdges(g, idx)[0]));
  assert.equal(g.freeRoadsRemaining, 1);
  assert.ok(E.useFreeRoadFromCard(g, E.availableRoadEdges(g, idx)[0]));
  assert.equal(g.freeRoadsRemaining, 0);
  // 同じ手番にもう1枚は使えない
  g.players[idx].devCards.push({ type: 'researchGrant', boughtTurn: null });
  assert.equal(E.playResearchGrantCard(g, ['science', 'science']), false);
});

test('発展カード: 豊作は自分の再生可能発電所がある地形(別々)を選んだ分の資源をもらう', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.phase = 'main';
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  const hexIds = g.board.hexes.filter((h) => h.terrain !== 'desert').slice(0, 3).map((h) => h.id);
  hexIds.forEach((hexId) => g.board.plants.push({ owner: idx, kind: 'renewable', vertexId: -1, hexId }));
  p.devCards.push({ type: 'highYield', boughtTurn: null });
  const totalBefore = E.RESOURCES.reduce((a, k) => a + p.resources[k], 0);
  assert.ok(E.playHighYieldCard(g, hexIds));
  const totalAfter = E.RESOURCES.reduce((a, k) => a + p.resources[k], 0);
  assert.equal(totalAfter, totalBefore + hexIds.length);
});

test('発展カード: 研究補助金は資源・科学を好きに2枚', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.phase = 'main';
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  p.devCards.push({ type: 'researchGrant', boughtTurn: null });
  const sciBefore = p.science;
  assert.ok(E.playResearchGrantCard(g, ['science', 'science']));
  assert.equal(p.science, sciBefore + 2);
});

test('発展カード: 手番の初めはイベントを引く前なら使える。引き始めたら使えない', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  assert.equal(g.phase, 'event');
  const idx = E.currentPlayer(g);
  g.players[idx].devCards.push({ type: 'researchGrant', boughtTurn: null });
  assert.ok(E.playResearchGrantCard(g, ['science', 'science']));
  assert.equal(g.devCardPlayedThisTurn, true);
  g.bag = ['funding'];
  g.drawsLeft = 1;
  g.devCardPlayedThisTurn = false; // 次の確認のため、1手番1枚の制限だけ外す
  E.drawEventDisc(g);
  assert.equal(g.eventDrawStarted, true);
  g.players[idx].devCards.push({ type: 'researchGrant', boughtTurn: null });
  assert.equal(E.playResearchGrantCard(g, ['science', 'science']), false); // 引き始めたあとは使えない
});

test('発展カード: クリーンアップを3枚使うと最もクリーンな環境(2点)。もっと多く使った人に移る', () => {
  const g = E.createGame(4, Math.random);
  playSetup(g);
  g.phase = 'main';
  const idx = E.currentPlayer(g);
  const p = g.players[idx];
  function playOneCleanup(playerIdx) {
    const hex = g.board.hexes.find((h) => h.id !== g.inspectorHex);
    g.hazards.hexes = g.hazards.hexes.filter((h) => h !== hex.id);
    assert.ok(E.placeHazardOnHex(g, hex.id));
    g.turn = playerIdx;
    g.devCardPlayedThisTurn = false;
    g.players[playerIdx].devCards.push({ type: 'cleanup', boughtTurn: null });
    assert.ok(E.playCleanupRemoveHazard(g, { hexId: hex.id }, playerIdx)); // 自分以上=自分でもよい
  }
  const scoreBefore = E.playerScore(g, idx);
  playOneCleanup(idx); assert.equal(p.cleanupPlayed, 1); assert.equal(g.cleanestPlayer, null);
  playOneCleanup(idx); assert.equal(p.cleanupPlayed, 2); assert.equal(g.cleanestPlayer, null);
  playOneCleanup(idx); assert.equal(p.cleanupPlayed, 3); assert.equal(g.cleanestPlayer, idx);
  assert.equal(E.playerScore(g, idx), scoreBefore + 2); // 最もクリーンな環境の2点が足される

  const other = (idx + 1) % 4;
  for (let i = 0; i < 4; i++) playOneCleanup(other);
  assert.equal(g.players[other].cleanupPlayed, 4);
  assert.equal(g.cleanestPlayer, other); // 4枚 > 3枚で移る
});

// ---- CPU（作業4）: すべての場面で合法な手を返し、vpかbagで必ず終わる ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// CPUだけで1局を最後まで進める。止まり（同じ手が何度も不発）を防ぐため上限手数で打ち切り、到達できたか返す
function playOneCpuGame(playerCount, levelFor, seed) {
  const rng = mulberry32(seed);
  const g = E.createGame(playerCount, rng);
  const MAX_STEPS = 20000;
  let steps = 0;
  while (g.phase !== 'gameOver' && steps < MAX_STEPS) {
    C.step(g, levelFor);
    steps++;
  }
  return { g, steps };
}

test('CPU: 3人・4人、強さいろいろで何局も最後まで進み、vpかbagで終わる（例外・止まりなし）', () => {
  const levelSets = [
    () => 'weak', () => 'normal', () => 'strong',
    (i) => ['weak', 'normal', 'strong', 'weak'][i % 4],
    (i) => ['strong', 'weak', 'strong'][i % 3],
  ];
  const counts = { vp: 0, bag: 0 };
  let totalTurns = 0, games = 0;
  for (let pc = 3; pc <= 4; pc++) {
    for (let s = 0; s < 8; s++) {
      const levelFor = levelSets[s % levelSets.length];
      const { g, steps } = playOneCpuGame(pc, levelFor, pc * 1000 + s);
      assert.equal(g.phase, 'gameOver', `pc=${pc} seed=${s} が${steps}手で終わらなかった`);
      assert.ok(g.endReason === 'vp' || g.endReason === 'bag');
      assert.ok(Array.isArray(g.winners));
      counts[g.endReason]++;
      totalTurns += g.turnNumber;
      games++;
    }
  }
  assert.equal(games, 16);
  console.log(`  CPUだけ${games}局: vp終了${counts.vp}・bag終了${counts.bag}、平均${Math.round(totalTurns / games)}手番`);
});

test('CPU: ふつう・つよいの4人対局は町・都市がよく建ち、終局時の最高点が伸びる', () => {
  // よわいを混ぜず、ふつう・つよいだけで数十局まわす（作業4のテストはよわいも混ざって点が低く出るため別に見る）
  const levelSets = [
    () => 'normal', () => 'strong',
    (i) => ['normal', 'strong', 'normal', 'strong'][i % 4],
    (i) => ['strong', 'normal', 'strong'][i % 3],
  ];
  const counts = { vp: 0, bag: 0 };
  let totalTurns = 0, games = 0, maxScoreSum = 0;
  // CPUの手・サイコロはMath.randomも使うので同じseedでも結果が揺れる。vp終了は数%しか出ないので、
  // たまたま0局になって落ちない程度まで局数を増やす(pc3,4合わせて120局。全体は1秒もかからない)
  for (let pc = 3; pc <= 4; pc++) {
    for (let s = 0; s < 60; s++) {
      const levelFor = levelSets[s % levelSets.length];
      const { g } = playOneCpuGame(pc, levelFor, pc * 2000 + s);
      assert.equal(g.phase, 'gameOver');
      counts[g.endReason]++;
      totalTurns += g.turnNumber;
      maxScoreSum += Math.max(...g.players.map((_, i) => E.playerScore(g, i)));
      games++;
    }
  }
  const avgMaxScore = maxScoreSum / games;
  console.log(`  ふつう/つよい${games}局: vp終了${counts.vp}・bag終了${counts.bag}、平均${Math.round(totalTurns / games)}手番、終局時の最高点の平均${avgMaxScore.toFixed(2)}`);
  assert.ok(counts.vp > 0, 'vpで終わる対局が一局も無い');
  // 直す前は全員3点のまま(平均3)で止まっていた。7台まで伸びれば明らかな改善とみなす(seedにより7〜8台で揺れる)
  assert.ok(avgMaxScore >= 7, `終局時の最高点の平均が低い(${avgMaxScore.toFixed(2)})`);
});

test('CPU: つよいはよわいに勝ち越す', () => {
  // 袋切れ(bag)の終わりも「再生>化石」を満たした人の勝ちなので、vp・bagどちらの勝ちも数える
  let strongWins = 0, weakWins = 0;
  for (let s = 0; s < 20; s++) {
    const levelFor = (i) => (i % 2 === 0 ? 'strong' : 'weak'); // 0,2=つよい　1,3=よわい
    const { g } = playOneCpuGame(4, levelFor, 5000 + s);
    g.winners.forEach((w) => { if (w % 2 === 0) strongWins++; else weakWins++; });
  }
  assert.ok(strongWins > weakWins, `つよい${strongWins}勝 よわい${weakWins}勝`);
});
