'use strict';
// engine.js の自己チェック（作業1=土台だけの範囲）。フレームワークなし。node --test で動く。
// cpu.js・main.js は古い engine に合わせたままなので、ここでは触らない（作業4・5で合わせる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from './engine.js';

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
  assert.equal(g.phase, 'roll');
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
  assert.equal(g.winner, null);
  // 0の手番を終えて1の手番になった瞬間に判定される
  E.endTurn(g);
  assert.equal(E.currentPlayer(g), 1);
  assert.equal(g.winner, 1);
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
