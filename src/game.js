// ─── DECK ────────────────────────────────────────────────────────────────────
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];
const RANK_VAL = {};
RANKS.forEach((r, i) => RANK_VAL[r] = i + 2);

function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  return shuffle(d);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── HAND EVALUATOR ──────────────────────────────────────────────────────────
function evalFive(cards) {
  const vals = cards.map(c => RANK_VAL[c.r]).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const flush = suits.every(s => s === suits[0]);
  const sorted = [...vals].sort((a, b) => a - b);
  const isWheel = sorted.join(',') === '2,3,4,5,14';
  const straight = isWheel || sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);

  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const freq = Object.values(counts).sort((a, b) => b - a);
  const pairs = freq.filter(f => f === 2).length;

  let rank = 0, name = 'High Card';
  if (flush && straight) { rank = 8; name = vals[0] === 14 && !isWheel ? 'Royal Flush' : 'Straight Flush'; }
  else if (freq[0] === 4) { rank = 7; name = 'Four of a Kind'; }
  else if (freq[0] === 3 && freq[1] === 2) { rank = 6; name = 'Full House'; }
  else if (flush) { rank = 5; name = 'Flush'; }
  else if (straight) { rank = 4; name = 'Straight'; }
  else if (freq[0] === 3) { rank = 3; name = 'Three of a Kind'; }
  else if (pairs === 2) { rank = 2; name = 'Two Pair'; }
  else if (pairs === 1) { rank = 1; name = 'One Pair'; }

  const tieVals = isWheel ? [5, 4, 3, 2, 1] : vals;
  const score = rank * 1e10 + tieVals[0] * 1e7 + (tieVals[1] || 0) * 1e5 +
    (tieVals[2] || 0) * 1e3 + (tieVals[3] || 0) * 10 + (tieVals[4] || 0);
  return { rank, name, score };
}

function bestOf7(cards) {
  let best = null;
  const n = cards.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const five = cards.filter((_, idx) => idx !== i && idx !== j);
    if (five.length !== 5) continue;
    const h = evalFive(five);
    if (!best || h.score > best.score) best = h;
  }
  return best || evalFive(cards.slice(0, 5));
}

// ─── GAME ENGINE ─────────────────────────────────────────────────────────────
const DEFAULT_SMALL_BLIND = 25;
const DEFAULT_BIG_BLIND = 50;
const STARTING_CHIPS = 1500;

class PokerGame {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = []; // { id, name, chips, hand, bet, folded, allIn, sitOut, connected }
    this.community = [];
    this.pot = 0;
    this.sidePots = [];
    this.deck = [];
    this.phase = 'waiting'; // waiting, preflop, flop, turn, river, showdown
    this.dealerIndex = -1;
    this.currentIndex = -1;
    this.callAmount = 0;
    this.minRaise = this.BIG_BLIND;
    this.actedThisRound = new Set();
    this.roundBets = {};
    this.log = [];
    this.handNumber = 0;
    this.lastAction = null;
    this.SMALL_BLIND = DEFAULT_SMALL_BLIND;
    this.BIG_BLIND = DEFAULT_BIG_BLIND;
    this.defaultStack = 1500;
  }

  addPlayer(id, name, startingStack, emoji) {
    // If player exists but is disconnected, just reconnect them
    const existing = this.players.find(p => p.id === id);
    if (existing) {
      if (!existing.connected) {
        existing.connected = true;
        this.addLog(`${existing.name} reconnected.`);
        return { success: true, seatIndex: existing.seatIndex };
      }
      return { error: 'Already seated' };
    }
    if (this.players.length >= 9) return { error: 'Table is full' };
    const player = {
      id, name,
      chips: startingStack || this.defaultStack || 1500,
      hand: [],
      bet: 0,
      folded: false,
      allIn: false,
      sitOut: false,
      connected: true,
      buyIns: 1,
      emoji: emoji || '🎭',
      seatIndex: this.players.length
    };
    this.players.push(player);
    this.addLog(`${name} joined the table.`);
    return { success: true, seatIndex: player.seatIndex };
  }

  removePlayer(id) {
    const p = this.players.find(p => p.id === id);
    if (p) {
      p.connected = false;
      this.addLog(`${p.name} disconnected.`);
    }
  }

  reconnectPlayer(id, emoji) {
    const p = this.players.find(p => p.id === id);
    if (p) { p.connected = true; this.addLog(`${p.name} reconnected.`); }
  }

  canStart() {
    return this.activePlayers().length >= 2 && this.phase === 'waiting';
  }

  activePlayers() {
    return this.players.filter(p => p.chips > 0 && p.connected && !p.sitOut);
  }

  inHandPlayers() {
    return this.players.filter(p => !p.folded && p.hand.length === 2);
  }

  startHand(settings = {}) {
    const active = this.activePlayers();
    if (active.length < 2) return { error: 'Need at least 2 players' };

    this.handNumber++;
    // Apply settings if provided
    if (settings.smallBlind) this.SMALL_BLIND = settings.smallBlind;
    if (settings.bigBlind)   this.BIG_BLIND   = settings.bigBlind;
    this.deck = newDeck();
    this.community = [];
    this.pot = 0;
    this.sidePots = [];
    this.callAmount = this.BIG_BLIND;
    this.minRaise = this.BIG_BLIND;
    this.actedThisRound = new Set();
    this.roundBets = {};
    this.lastAction = null;

    // Reset players
    for (const p of this.players) {
      p.hand = [];
      p.bet = 0;
      p.folded = p.chips <= 0 || !p.connected || p.sitOut;
      p.allIn = false;
    }

    // Advance dealer
    this.dealerIndex = this.nextActiveIndex(this.dealerIndex, 1);

    // Deal cards
    for (const p of this.players) {
      if (!p.folded) p.hand = [this.deck.pop(), this.deck.pop()];
    }

    // Blinds
    const sbIdx = this.nextActiveIndex(this.dealerIndex, 1);
    const bbIdx = this.nextActiveIndex(sbIdx, 1);
    this.postBlind(sbIdx, this.SMALL_BLIND, 'SB');
    this.postBlind(bbIdx, this.BIG_BLIND, 'BB');

    this.phase = 'preflop';
    this.currentIndex = this.nextActiveIndex(bbIdx, 1);
    this.addLog(`--- Hand #${this.handNumber} --- Dealer: ${this.players[this.dealerIndex].name}`);
    this.addLog(`${this.players[sbIdx].name} posts $${this.SMALL_BLIND} (SB)`);
    this.addLog(`${this.players[bbIdx].name} posts $${this.BIG_BLIND} (BB)`);

    return { success: true };
  }

  postBlind(idx, amount, type) {
    const p = this.players[idx];
    const actual = Math.min(amount, p.chips);
    p.chips -= actual;
    p.bet += actual;
    this.pot += actual;
    this.roundBets[p.id] = (this.roundBets[p.id] || 0) + actual;
    if (p.chips === 0) p.allIn = true;
  }

  nextActiveIndex(from, step = 1) {
    const n = this.players.length;
    let i = ((from + step) % n + n) % n;
    let count = 0;
    while ((this.players[i].folded || this.players[i].allIn) && count < n) {
      i = ((i + step) % n + n) % n;
      count++;
    }
    return i;
  }

  getCurrentPlayer() {
    if (this.currentIndex < 0) return null;
    return this.players[this.currentIndex];
  }

  applyAction(playerId, action, amount = 0) {
    const p = this.players[this.currentIndex];
    if (!p || p.id !== playerId) return { error: 'Not your turn' };

    const toCall = this.callAmount - p.bet;

    switch (action) {
      case 'fold':
        p.folded = true;
        this.addLog(`${p.name} folds.`);
        break;

      case 'check':
        if (toCall > 0) return { error: 'Cannot check, must call or fold' };
        this.addLog(`${p.name} checks.`);
        break;

      case 'call': {
        const amt = Math.min(toCall, p.chips);
        p.chips -= amt;
        p.bet += amt;
        this.pot += amt;
        if (p.chips === 0) p.allIn = true;
        this.addLog(`${p.name} calls $${amt}.`);
        break;
      }

      case 'raise': {
        if (amount <= this.callAmount) return { error: 'Raise must be higher than call amount' };
        if (amount > p.chips + p.bet) return { error: 'Not enough chips' };
        const extra = amount - p.bet;
        p.chips -= extra;
        this.pot += extra;
        p.bet = amount;
        this.callAmount = amount;
        this.minRaise = amount - this.callAmount;
        this.actedThisRound.clear();
        if (p.chips === 0) p.allIn = true;
        this.addLog(`${p.name} raises to $${amount}.`);
        break;
      }

      case 'allin': {
        const amt = p.chips;
        p.bet += amt;
        this.pot += amt;
        p.chips = 0;
        p.allIn = true;
        if (p.bet > this.callAmount) {
          this.callAmount = p.bet;
          this.actedThisRound.clear();
        }
        this.addLog(`${p.name} goes ALL IN for $${p.bet}!`);
        break;
      }

      default:
        return { error: 'Unknown action' };
    }

    this.actedThisRound.add(playerId);
    this.lastAction = { playerId, action, amount };
    return this.advanceTurn();
  }

  advanceTurn() {
    // Check if only one active player remains
    const stillIn = this.inHandPlayers();
    if (stillIn.length === 1) {
      const winner = stillIn[0];
      winner.chips += this.pot;
      this.addLog(`${winner.name} wins $${this.pot} (everyone folded)!`);
      this.pot = 0;
      this.phase = 'waiting';
      return { advance: 'hand_over', winners: [{ id: winner.id, name: winner.name, amount: this.pot }] };
    }

    // Find next to act
    const next = this.findNextToAct();
    if (next === -1) {
      return this.nextStreet();
    }

    this.currentIndex = next;
    return { advance: 'next_turn', currentPlayer: this.players[next].id };
  }

  findNextToAct() {
    const n = this.players.length;
    let i = ((this.currentIndex + 1) % n + n) % n;
    for (let count = 0; count < n; count++) {
      const p = this.players[i];
      if (!p.folded && !p.allIn) {
        if (!this.actedThisRound.has(p.id) || p.bet < this.callAmount) return i;
      }
      i = ((i + 1) % n + n) % n;
    }
    return -1;
  }

  nextStreet() {
    // Reset for next street
    for (const p of this.players) p.bet = 0;
    this.callAmount = 0;
    this.minRaise = this.BIG_BLIND;
    this.actedThisRound.clear();
    this.roundBets = {};

    if (this.phase === 'preflop') {
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
      this.addLog('--- FLOP ---');
    } else if (this.phase === 'flop') {
      this.community.push(this.deck.pop());
      this.phase = 'turn';
      this.addLog('--- TURN ---');
    } else if (this.phase === 'turn') {
      this.community.push(this.deck.pop());
      this.phase = 'river';
      this.addLog('--- RIVER ---');
    } else if (this.phase === 'river') {
      return this.showdown();
    }

    this.currentIndex = this.nextActiveIndex(this.dealerIndex, 1);
    return { advance: 'new_street', phase: this.phase, currentPlayer: this.players[this.currentIndex]?.id };
  }

  showdown() {
    this.phase = 'showdown';
    this.addLog('--- SHOWDOWN ---');

    const stillIn = this.inHandPlayers();
    let bestScore = -1;
    const results = [];

    for (const p of stillIn) {
      const allCards = [...p.hand, ...this.community];
      const h = bestOf7(allCards);
      results.push({ player: p, handResult: h });
      this.addLog(`${p.name}: ${p.hand.map(c => c.r + c.s).join(' ')} — ${h.name}`);
      if (h.score > bestScore) bestScore = h.score;
    }

    const winners = results.filter(r => r.handResult.score === bestScore);
    const share = Math.floor(this.pot / winners.length);

    for (const { player } of winners) {
      player.chips += share;
      this.addLog(`${player.name} wins $${share}!`);
    }

    const winnerInfo = winners.map(w => ({
      id: w.player.id,
      name: w.player.name,
      handName: w.handResult.name,
      amount: share
    }));

    this.pot = 0;
    this.phase = 'waiting';

    return { advance: 'showdown', winners: winnerInfo };
  }

  addLog(msg) {
    this.log.unshift({ time: Date.now(), msg });
    if (this.log.length > 50) this.log.pop();
  }

  // Safe state to send to a specific player
  getStateFor(playerId) {
    return {
      phase: this.phase,
      pot: this.pot,
      community: this.community,
      dealerIndex: this.dealerIndex,
      currentPlayerId: this.players[this.currentIndex]?.id || null,
      callAmount: this.callAmount,
      minRaise: this.minRaise,
      handNumber: this.handNumber,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        connected: p.connected,
        seatIndex: p.seatIndex,
        cardCount: p.hand.length,
        buyIns: p.buyIns || 1,
        emoji: p.emoji || '🎭',
        // Only reveal hand to the player themselves (or on showdown)
        hand: (p.id === playerId || this.phase === 'showdown') ? p.hand : null
      })),
      log: this.log.slice(0, 20),
      lastAction: this.lastAction
    };
  }
}

module.exports = { PokerGame, bestOf7, evalFive };