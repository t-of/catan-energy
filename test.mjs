'use strict';
// engine.js の自己チェック。フレームワークなし。node --test で動く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from './engine.js';
import * as CPU from './cpu.js';

test('盤面: 19マス・54頂点・72辺・地形の枚数・6と8が隣り合わない', () => {
  for (let i = 0; i < 20; i++) {
    const g = E.createGame(4, Math.random);
    assert.equal(g.board.hexes.length, 19);
    assert.equal(g.board.vertices.length, 54);
    assert.equal(g.board.edges.length, 72);
    const counts = {};
    g.board.hexes.forEach((h) => { counts[h.terrain] = (counts[h.terrain] || 0) + 1; });
    assert.deepEqual(counts, { forest: 4, hills: 3, pasture: 4, field: 4, mountains: 3, desert: 1 });
    const byCoord = new Map(g.board.hexes.map((h) => [`${h.q},${h.r}`, h]));
    const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    g.board.hexes.forEach((h) => {
      if (h.number !== 6 && h.number !== 8) return;
      dirs.forEach(([dq, dr]) => {
        const n = byCoord.get(`${h.q + dq},${h.r + dr}`);
        if (n) assert.notEqual(n.number === 6 || n.number === 8, true, '6/8が隣り合っている');
      });
    });
    const portVertices = g.board.vertices.filter((v) => v.port);
    assert.equal(portVertices.length, 18); // 港9か所 × 頂点2つ
    const byType = {};
    portVertices.forEach((v) => { byType[v.port] = (byType[v.port] || 0) + 1; });
    assert.equal(byType['3:1'], 8); // 3:1 ×4ヶ所
    ['wood', 'brick', 'sheep', 'wheat', 'ore'].forEach((r) => assert.equal(byType[r], 2)); // 2:1 ×1ヶ所ずつ
  }
});

test('セットアップ: 距離ルールと2周（順→逆）、2個目の開拓地で資源をもらう', () => {
  const g = E.createGame(3, Math.random);
  assert.equal(E.currentPlayer(g), 0);
  const v0 = E.availableSettlementVertices(g, 0, true)[0];
  assert.ok(E.setupPlaceSettlement(g, v0));
  // 隣接頂点には置けない（距離ルール）
  const neighbor = g.board.vertices[v0].neighbors[0];
  assert.equal(E.canPlaceSettlement(g, neighbor, 0, true), false);
  const road0 = g.board.vertices[v0].edgeIds[0];
  assert.ok(E.setupPlaceRoad(g, road0));
  assert.equal(E.currentPlayer(g), 1);

  // 残りの5回（1が2回目、2が2回、0が1回）を進める
  for (let i = 0; i < 5; i++) {
    const idx = E.currentPlayer(g);
    const v = E.availableSettlementVertices(g, idx, true)[0];
    E.setupPlaceSettlement(g, v);
    const e = g.board.vertices[v].edgeIds[0];
    const before = JSON.parse(JSON.stringify(g.players[idx].resources));
    const wasSetup2 = g.phase === 'setup2';
    E.setupPlaceRoad(g, e);
    if (wasSetup2) {
      const after = g.players[idx].resources;
      const gained = Object.keys(before).some((k) => after[k] > before[k]);
      assert.ok(gained || g.board.vertices[v].hexIds.every((h) => g.board.hexes[h].terrain === 'desert'));
    }
  }
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 0);
  g.players.forEach((p) => { assert.equal(p.settlements.length, 2); assert.equal(p.roads.length, 2); });
});

test('セットアップ: 2個目の開拓地の資源は銀行からも引かれる', () => {
  const g = E.createGame(3, Math.random);
  for (let i = 0; i < 3; i++) { // setup1を3人ぶん進めてsetup2に入る
    const idx = E.currentPlayer(g);
    const v = E.availableSettlementVertices(g, idx, true)[0];
    E.setupPlaceSettlement(g, v);
    E.setupPlaceRoad(g, g.board.vertices[v].edgeIds[0]);
  }
  assert.equal(g.phase, 'setup2');
  const idx = E.currentPlayer(g);
  const v = E.availableSettlementVertices(g, idx, true)[0];
  E.setupPlaceSettlement(g, v);
  const bankBefore = { ...g.bank.resources };
  E.setupPlaceRoad(g, g.board.vertices[v].edgeIds[0]);
  const after = g.players[idx].resources;
  Object.keys(bankBefore).forEach((res) => {
    assert.equal(bankBefore[res] - g.bank.resources[res], after[res]); // 配った枚数ぶん、銀行も減る
  });
});

test('建設: コストが引かれ、銀行に戻る。足りないと失敗する', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p = g.players[0];
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 2);
  p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert.equal(E.buildRoad(g, v.edgeIds[0]), false); // 何も持っていない
  p.resources = { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  v.building = { owner: 0, type: 'settlement' }; // 自分の開拓地から道を伸ばす
  p.settlements.push(v.id);
  const bankBefore = g.bank.resources.wood;
  assert.ok(E.buildRoad(g, v.edgeIds[0]));
  assert.equal(p.resources.wood, 0);
  assert.equal(g.bank.resources.wood, bankBefore + 1);
});

test('長い交易路: 直線の道は長さどおり。内部の頂点を敵に取られると分断される', () => {
  const g = E.createGame(4, Math.random);
  const interior = g.board.vertices.find((v) => v.edgeIds.length === 3);
  const [e0, e1] = interior.edgeIds;
  const other = (e, vid) => (g.board.edges[e].v1 === vid ? g.board.edges[e].v2 : g.board.edges[e].v1);
  const va = other(e0, interior.id);
  g.board.vertices[va].building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(va);
  E.buildRoad(g, e0, { free: true });
  E.buildRoad(g, e1, { free: true });
  assert.equal(g.players[0].roadLength, 2);
  g.board.vertices[interior.id].building = { owner: 1, type: 'settlement' };
  g.players[1].settlements.push(interior.id);
  E.recalcLongestRoad(g);
  assert.equal(g.players[0].roadLength, 1);
});

test('最長交易路: 建てた本人以外に移ったとき、その人の勝利判定もその場でされる', () => {
  const g = E.createGame(3, Math.random);
  const edgeBetween = (a, b) => g.board.vertices[a].edgeIds.find((e) => {
    const ed = g.board.edges[e];
    return (ed.v1 === a && ed.v2 === b) || (ed.v2 === a && ed.v1 === b);
  });
  // 長さ`length`の単純パスを探す(頂点の重複なし)。avoidに含む頂点は使わない。
  // requireDegree3Atを指定すると、その位置の頂点は分断用の第三の辺を出せる(次数3)ものだけ選ぶ
  function findPath(length, avoid, requireDegree3At) {
    for (const start of g.board.vertices) {
      if (avoid.has(start.id)) continue;
      const path = [start.id];
      const used = new Set();
      const dfs = (vid) => {
        if (requireDegree3At != null && path.length - 1 === requireDegree3At
          && g.board.vertices[vid].edgeIds.length < 3) return false;
        if (path.length === length + 1) return true;
        for (const nb of g.board.vertices[vid].neighbors) {
          if (avoid.has(nb) || path.includes(nb)) continue;
          const e = edgeBetween(vid, nb);
          if (used.has(e)) continue;
          used.add(e); path.push(nb);
          if (dfs(nb)) return true;
          path.pop(); used.delete(e);
        }
        return false;
      };
      if (dfs(start.id)) {
        const edges = [];
        for (let i = 0; i < path.length - 1; i++) edges.push(edgeBetween(path[i], path[i + 1]));
        return { vertices: path, edges };
      }
    }
    return null;
  }
  // プレイヤー1に長さ6の最長交易路を持たせる（得点は0のまま、まだ勝てない）
  const path1 = findPath(6, new Set(), 3); // 4番目の頂点(index3)で分断できるよう、そこは次数3にする
  g.board.vertices[path1.vertices[0]].building = { owner: 1, type: 'settlement' };
  g.players[1].settlements.push(path1.vertices[0]);
  path1.edges.forEach((e) => { g.board.edges[e].road = 1; g.players[1].roads.push(e); });
  E.recalcLongestRoad(g);
  assert.equal(g.longestRoadPlayer, 1);
  assert.equal(g.winner, null);
  // プレイヤー2は別経路に長さ6の道を持ち、都市4つ(8点)を直接積んでおく(現状9点、最長交易路を奪えば11点)
  const path2 = findPath(6, new Set(path1.vertices));
  g.board.vertices[path2.vertices[0]].building = { owner: 2, type: 'settlement' };
  g.players[2].settlements.push(path2.vertices[0]);
  path2.edges.forEach((e) => { g.board.edges[e].road = 2; g.players[2].roads.push(e); });
  g.players[2].cities.push(9001, 9002, 9003, 9004);
  // プレイヤー1の道を分断する: path1の内部頂点にプレイヤー0が開拓地を建てる
  const cutVertex = path1.vertices[3];
  const approach = g.board.vertices[cutVertex].edgeIds.find((e) => !path1.edges.includes(e));
  g.board.edges[approach].road = 0;
  g.players[0].roads.push(approach);
  g.players[0].resources = { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 };
  g.phase = 'main'; g.turn = 0;
  assert.ok(E.buildSettlement(g, cutVertex)); // これで内部で recalcLongestRoad が呼ばれ、最長交易路が2へ移る
  assert.equal(g.longestRoadPlayer, 2);
  assert.equal(g.winner, 2); // buildSettlement自身はプレイヤー0のcheckWinしか見ないが、recalcLongestRoadが2の勝利も拾う
});

test('発展カード: 買った手番には使えない。独占で資源を総取りできる', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0; g.turnNumber = 1;
  const p0 = g.players[0];
  p0.resources = { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 };
  assert.ok(E.buyDevCard(g));
  p0.devCards[0] = { type: 'knight', boughtTurn: 1, played: false };
  assert.equal(E.playKnight(g, 0, g.board.hexes.find((h) => h.id !== g.board.robberHex).id, null), false);
  g.turnNumber = 2;
  assert.ok(E.playKnight(g, 0, g.board.hexes.find((h) => h.id !== g.board.robberHex).id, null));
  assert.equal(p0.knightsPlayed, 1);

  p0.devCards = [{ type: 'monopoly', boughtTurn: 1, played: false }];
  g.devCardPlayedThisTurn = false;
  g.players[1].resources.wood = 3; g.players[2].resources.wood = 2;
  assert.ok(E.playMonopoly(g, 0, 'wood'));
  assert.equal(p0.resources.wood, 5);
  assert.equal(g.players[1].resources.wood, 0);
});

test('銀行交易: 港なしは4:1、港があればその比率', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  assert.equal(E.playerPortRate(g, 0, 'wood'), 4);
  p0.resources.wood = 4;
  assert.ok(E.bankTrade(g, 'wood', 'ore'));
  assert.equal(p0.resources.wood, 0);
  assert.equal(p0.resources.ore, 1);

  const portV = g.board.vertices.find((v) => v.port === 'wood');
  portV.building = { owner: 0, type: 'settlement' };
  p0.settlements.push(portV.id);
  assert.equal(E.playerPortRate(g, 0, 'wood'), 2);
});

test('7が出たとき: 8枚以上の人だけ半分（切り捨て）捨てる', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'roll';
  g.players[0].resources.wood = 6;
  g.players[1].resources.wood = 7;
  g.players[2].resources.wood = 9;
  const dice = [0.4, 0.6]; // 3 + 4 = 7
  assert.equal(E.rollDice(g, () => dice.shift()), 7);
  assert.deepEqual(g.pendingDiscards, [{ player: 2, count: 4 }]);
});

test('資源の産出: 銀行不足でも、もらう人が1人だけなら残っている分だけ渡す', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'roll'; g.turn = 0;
  g.bank.resources.ore = 1; // 銀行には鉄が1枚しかない
  const mtn = g.board.hexes.find((h) => h.terrain === 'mountains' && h.number != null);
  const vid = mtn.vertexIds[0];
  g.board.vertices[vid].building = { owner: 0, type: 'city' }; // 都市なので鉄2枚を要求するが、要求者は0だけ
  g.players[0].cities.push(vid);
  const d1 = mtn.number <= 7 ? 1 : mtn.number - 6;
  const d2 = mtn.number - d1;
  const dice = [(d1 - 0.5) / 6, (d2 - 0.5) / 6];
  assert.equal(E.rollDice(g, () => dice.shift()), mtn.number);
  assert.equal(g.players[0].resources.ore, 1); // 2枚要求したが、残っていた1枚だけもらえる
  assert.equal(g.bank.resources.ore, 0);
  assert.ok(g.events.includes('shortage'));
});

test('勝利判定: 得点が10に届くと winner が立つ', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  for (let i = 0; i < 4; i++) p0.cities.push(1000 + i); // 4都市=8点
  p0.settlements.push(2000); // +1点
  p0.devCards.push({ type: 'vp', boughtTurn: 1, played: false }); // +1点
  assert.equal(E.playerScore(g, 0), 10);
});

// ---- CPU ----
// CPU だけで1局、決着まで進める（engine.js の公開操作だけを使う）。手が進まなければ無限ループせず止まる。
function playOutCpu(levels, maxSteps = 500000, options = {}) {
  const g = E.createGame(levels.length, Math.random, options);
  for (let i = 0; i < maxSteps; i++) {
    if (g.winner != null) return g;
    if (g.phase === 'discard') {
      const d = g.pendingDiscards[0];
      assert.ok(CPU.discardFor(g, d.player, levels[d.player]), '捨て札が進まない');
      continue;
    }
    if (g.phase === 'goldPick') {
      const d = g.pendingGoldPicks[0];
      assert.ok(CPU.pickGoldFor(g, d.player), '金の川の受け取りが進まない');
      continue;
    }
    if (g.phase === 'scienceBonus') {
      const p = g.pendingScienceBonus[0];
      assert.ok(CPU.pickScienceBonusFor(g, p), '科学3段階目の資源選びが進まない');
      continue;
    }
    const idx = E.currentPlayer(g);
    assert.ok(CPU.step(g, levels[idx]), 'CPUの手が進まない');
  }
  throw new Error(`${maxSteps}手では終わらなかった`);
}

test('CPU: 4人（強さいろいろ）で数十局、全局きちんと決着する', () => {
  const mixes = [
    ['weak', 'weak', 'weak', 'weak'],
    ['normal', 'normal', 'normal', 'normal'],
    ['strong', 'strong', 'strong', 'strong'],
    ['weak', 'normal', 'strong', 'normal'],
  ];
  for (let i = 0; i < 24; i++) {
    const g = playOutCpu(mixes[i % mixes.length]);
    assert.ok(g.winner != null);
    // エネルギー版: 汚染が20に達すると、10点未満でも即終了して決着する
    assert.ok(E.playerScore(g, g.winner) >= 10 || g.pollution >= E.POLLUTION_END_AT);
  }
});

test('CPUが受ける交易: 自分の目標に足りない資源をもらい、余っている資源を渡すなら受ける', () => {
  const g = E.createGame(2, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p1 = g.players[1];
  p1.settlements.push(0); // 都市化できる開拓地が1つある扱いにし、目標コストを{wheat:2, ore:3}にする
  p1.resources = { wood: 6, brick: 6, sheep: 6, wheat: 0, ore: 0 };
  // 人が ore を3枚渡し、CPUは余っている wood を1枚渡すだけ
  assert.ok(CPU.acceptTrade(g, 1, { ore: 3 }, { wood: 1 }, 'normal'));
});

test('CPUが断る交易: 自分に足りない資源を手放し、余っている資源しかもらえないなら断る', () => {
  const g = E.createGame(2, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p1 = g.players[1];
  p1.settlements.push(0);
  p1.resources = { wood: 6, brick: 6, sheep: 6, wheat: 0, ore: 5 };
  // CPUが欲しいoreを手放し、すでに余っているwoodを1枚もらうだけ
  assert.ok(!CPU.acceptTrade(g, 1, { wood: 1 }, { ore: 3 }, 'normal'));
});

test('CPUの交易: 持っていない資源は出せない', () => {
  const g = E.createGame(2, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p1 = g.players[1];
  p1.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert.ok(!CPU.acceptTrade(g, 1, { wheat: 4 }, { ore: 1 }, 'normal'));
  assert.ok(!CPU.acceptTrade(g, 1, { wheat: 4 }, { ore: 1 }, 'strong'));
});

// ---- 航海者版 ----
test('CPU: 強さの差（よわい vs ふつう、ふつう vs つよい）を4人（2対2）対局の勝ち数で見る', () => {
  // 実際のアプリは3〜4人用なので、比較も4人（levelA2人 + levelB2人、席はランダム）で行う
  function winRate(levelA, levelB, games) {
    let aWins = 0;
    for (let i = 0; i < games; i++) {
      const seats = [levelA, levelA, levelB, levelB].sort(() => Math.random() - 0.5);
      const g = playOutCpu(seats);
      if (seats[g.winner] === levelA) aWins++;
    }
    return aWins;
  }
  const games = 20;
  const weakVsNormal = winRate('weak', 'normal', games);
  const normalVsStrong = winRate('normal', 'strong', games);
  console.log(`[CPU強さ] よわい vs ふつう: よわい ${weakVsNormal}/${games} 勝`);
  console.log(`[CPU強さ] ふつう vs つよい: ふつう ${normalVsStrong}/${games} 勝`);
  // 強いほうが勝ち越す想定（まれな逆転はあり得るので、惨敗はしていないことだけ確かめる）
  assert.ok(weakVsNormal <= games - 2);
  assert.ok(normalVsStrong <= games - 2);
});

// ---- 交易と略奪 ----

function tbGame(scenario, count = 4) { return E.createGame(count, Math.random, { expansions: ['traders-barbarians'], scenario }); }
// rollDice用に、合計が total になる(d1,d2)の組を作る(1〜6の範囲で必ず作れる)
function diceSeq(total) {
  const d1 = Math.max(1, total - 6);
  const d2 = total - d1;
  const seq = [(d1 - 0.5) / 6, (d2 - 0.5) / 6];
  return () => seq.shift();
}

// ---- 漁師 ----
test('プレイヤー名: 指定すればログに使われ、空ならプレイヤーNのまま', () => {
  const g = E.createGame(3, Math.random, { names: ['あやか', '', 'CPUくん'] });
  assert.equal(g.players[0].name, 'あやか');
  assert.equal(g.players[1].name, 'プレイヤー2'); // 空なら既定の名前
  assert.equal(g.players[2].name, 'CPUくん');
  assert.equal(E.playerName(g, 0), 'あやか');
  // 名前のない古いセーブ相当（player.name が undefined）でも既定名で動く
  delete g.players[2].name;
  assert.equal(E.playerName(g, 2), 'プレイヤー3');
});
