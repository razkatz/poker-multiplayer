const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { PokerGame } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

const rooms = new Map();
const socketToPlayer = new Map();

function getRoom(roomId) { return rooms.get(roomId); }

function broadcastState(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const { game } = room;
  const isShowdown = game.phase === 'showdown';
  for (const player of game.players) {
    const sockets = [...socketToPlayer.entries()]
      .filter(([, v]) => v.roomId === roomId && v.playerId === player.id)
      .map(([sid]) => sid);
    for (const sid of sockets) {
      const state = game.getStateFor(player.id);
      // At showdown: reveal all non-folded players' hands to everyone
      if (isShowdown) {
        state.players = state.players.map(p => {
          const fullP = game.players.find(gp => gp.id === p.id);
          if (fullP && !fullP.folded && fullP.hand && fullP.hand.length === 2) {
            return { ...p, hand: fullP.hand };
          }
          return p;
        });
      }
      io.to(sid).emit('game:state', {
        ...state,
        isHost: room.hostId === player.id,
        settings: room.settings
      });
    }
  }
}

function broadcastToRoom(roomId, event, data) {
  io.to(roomId).emit(event, data);
}

// Default game settings
function defaultSettings() {
  return {
    smallBlind: 25,
    bigBlind: 50,
    startingStack: 1500,
    turnTimer: 30,      // seconds per turn (0 = no limit)
    maxPlayers: 9,
    allowRebuy: false,
  };
}

// REST
app.post('/api/rooms', (req, res) => {
  const roomId = uuidv4().slice(0, 6).toUpperCase();
  const game = new PokerGame(roomId);
  rooms.set(roomId, { game, hostId: null, createdAt: Date.now(), settings: defaultSettings(), webrtcPeers: new Map() });
  console.log(`Room created: ${roomId}`);
  res.json({ roomId });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ roomId: req.params.roomId.toUpperCase(), playerCount: room.game.players.length, phase: room.game.phase, maxPlayers: 9 });
});

// Socket.io
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('room:join', ({ roomId, playerName, playerId, emoji }) => {
    const rid = roomId.toUpperCase();
    const room = getRoom(rid);
    if (!room) { socket.emit('error', { message: `Room "${rid}" not found` }); return; }

    const name = (playerName || 'Player').slice(0, 20);
    const safeEmoji = emoji || '🎭';
    const existingPlayer = playerId ? room.game.players.find(p => p.id === playerId) : null;
    const pid = existingPlayer ? playerId : uuidv4();

    if (existingPlayer) {
      room.game.reconnectPlayer(pid, safeEmoji);
      console.log(`${name} reconnected to ${rid}`);
    } else {
      // Pass current startingStack from settings so new players join with correct stack
      const startingStack = room.settings.startingStack || 1500;
      const result = room.game.addPlayer(pid, name, startingStack, safeEmoji);
      if (result.error) { socket.emit('error', { message: result.error }); return; }
      console.log(`${name} joined ${rid} as ${pid} with $${startingStack}`);
    }

    if (!room.hostId) room.hostId = pid;

    socket.join(rid);
    socketToPlayer.set(socket.id, { roomId: rid, playerId: pid, playerName: name });

    socket.emit('room:joined', { roomId: rid, playerId: pid, playerName: name, isHost: room.hostId === pid });
    socket.emit('game:state', { ...room.game.getStateFor(pid), isHost: room.hostId === pid, settings: room.settings });
    broadcastState(rid);
    broadcastToRoom(rid, 'chat', { system: true, msg: `${safeEmoji} ${name} joined the table.` });
  });

  // Host settings update
  socket.on('settings:update', (newSettings) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const room = getRoom(info.roomId);
    if (!room || room.hostId !== info.playerId) return;
    if (room.game.phase !== 'waiting') {
      socket.emit('error', { message: 'Cannot change settings during a hand' });
      return;
    }
    // Validate and merge
    const s = room.settings;
    if (newSettings.smallBlind >= 1) s.smallBlind = parseInt(newSettings.smallBlind);
    if (newSettings.bigBlind >= 2) s.bigBlind = parseInt(newSettings.bigBlind);
    if (newSettings.bigBlind <= s.smallBlind) s.bigBlind = s.smallBlind * 2;
    if (newSettings.startingStack >= 100) s.startingStack = parseInt(newSettings.startingStack);
    if (newSettings.turnTimer >= 0) s.turnTimer = parseInt(newSettings.turnTimer);
    if (newSettings.maxPlayers >= 2 && newSettings.maxPlayers <= 9) s.maxPlayers = parseInt(newSettings.maxPlayers);
    s.allowRebuy = !!newSettings.allowRebuy;

    // Apply blinds + stack to game engine so new joiners get right chips
    room.game.SMALL_BLIND = s.smallBlind;
    room.game.BIG_BLIND = s.bigBlind;
    room.game.defaultStack = s.startingStack;

    broadcastState(info.roomId);
    broadcastToRoom(info.roomId, 'chat', { system: true, msg: `Host updated settings.` });
  });

  // Turn timer management
  socket.on('game:deal', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const room = getRoom(info.roomId);
    if (!room || room.hostId !== info.playerId) { socket.emit('error', { message: 'Only the host can deal' }); return; }
    clearTurnTimer(info.roomId);
    const result = room.game.startHand(room.settings);
    if (result.error) { socket.emit('error', { message: result.error }); return; }
    broadcastState(info.roomId);
    broadcastCurrentTurn(info.roomId);
    startTurnTimer(info.roomId);
  });

  // New game (reset all chips to starting stack)
  socket.on('game:new_game', (settings) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const room = getRoom(info.roomId);
    if (!room || room.hostId !== info.playerId) return;
    // Apply settings
    if (settings) {
      if (settings.smallBlind >= 1) room.settings.smallBlind = parseInt(settings.smallBlind);
      if (settings.bigBlind >= 2)   room.settings.bigBlind   = parseInt(settings.bigBlind);
      if (settings.startingStack >= 100) room.settings.startingStack = parseInt(settings.startingStack);
      if (settings.turnTimer >= 0)  room.settings.turnTimer  = parseInt(settings.turnTimer);
      room.game.SMALL_BLIND = room.settings.smallBlind;
      room.game.BIG_BLIND   = room.settings.bigBlind;
    }
    // Reset all players
    const stack = room.settings.startingStack || 1500;
    room.game.players.forEach(p => {
      p.chips = stack;
      p.hand  = [];
      p.bet   = 0;
      p.folded = false;
      p.allIn  = false;
      p.buyIns = 1;
    });
    room.game.phase = 'waiting';
    room.game.pot   = 0;
    room.game.community = [];
    room.game.currentIndex = -1;
    room.game.handNumber = 0;
    room.game.log = [];
    clearTurnTimer(info.roomId);
    broadcastState(info.roomId);
    broadcastToRoom(info.roomId, 'chat', { system: true, msg: 'New game started!' });
  });

  // End game — broadcast ledger to all
  socket.on('game:end', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const room = getRoom(info.roomId);
    if (!room || room.hostId !== info.playerId) return;
    clearTurnTimer(info.roomId);
    // Build a final state that includes all hands (for the ledger)
    const baseState = room.game.getStateFor(null);
    baseState.players = baseState.players.map(p => {
      const fullP = room.game.players.find(gp => gp.id === p.id);
      return fullP ? { ...p, hand: fullP.hand, emoji: fullP.emoji } : p;
    });
    broadcastToRoom(info.roomId, 'game:ended', {
      ...baseState,
      isHost: false,
      settings: room.settings
    });
  });

  socket.on('game:action', ({ action, amount }) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const room = getRoom(info.roomId);
    if (!room) return;
    clearTurnTimer(info.roomId);
    const result = room.game.applyAction(info.playerId, action, amount);
    if (result.error) { socket.emit('error', { message: result.error }); return; }
    broadcastState(info.roomId);
    if (result.advance === 'hand_over' || result.advance === 'showdown') {
      broadcastToRoom(info.roomId, 'game:hand_over', { winners: result.winners });
    } else {
      broadcastCurrentTurn(info.roomId);
      startTurnTimer(info.roomId);
    }
  });

  // ── WebRTC signaling (fixed: send back existing peers) ──────
  socket.on('webrtc:join', ({ roomId, playerName }) => {
    const rid = roomId.toUpperCase();
    const room = getRoom(rid);
    if (!room) return;

    // Send this peer the list of EXISTING webrtc peers so they can initiate connections
    const existingPeers = [...(room.webrtcPeers || new Map()).entries()].map(([sid, name]) => ({ peerId: sid, peerName: name }));
    socket.emit('webrtc:existing_peers', { peers: existingPeers });

    // Tell all existing peers about this new joiner
    socket.to(rid).emit('webrtc:peer_joined', { peerId: socket.id, peerName: playerName });

    // Register this peer
    if (!room.webrtcPeers) room.webrtcPeers = new Map();
    room.webrtcPeers.set(socket.id, playerName);
    socket._webrtcName = playerName;
    socket._webrtcRoom = rid;
  });

  socket.on('webrtc:offer',  ({ to, offer })     => io.to(to).emit('webrtc:offer',  { from: socket.id, offer }));
  socket.on('webrtc:answer', ({ to, answer })    => io.to(to).emit('webrtc:answer', { from: socket.id, answer }));
  socket.on('webrtc:ice',    ({ to, candidate }) => io.to(to).emit('webrtc:ice',    { from: socket.id, candidate }));

  socket.on('chat:send', ({ msg }) => {
    const info = socketToPlayer.get(socket.id);
    if (!info || !msg) return;
    broadcastToRoom(info.roomId, 'chat', { name: info.playerName, msg: msg.slice(0, 200) });
  });

  socket.on('disconnect', () => {
    const info = socketToPlayer.get(socket.id);
    if (info) {
      const room = getRoom(info.roomId);
      if (room) {
        room.game.removePlayer(info.playerId);
        broadcastState(info.roomId);
        broadcastToRoom(info.roomId, 'chat', { system: true, msg: `${info.playerName} disconnected.` });
      }
      socketToPlayer.delete(socket.id);
    }
    // Clean up WebRTC peer registry and notify peers
    if (socket._webrtcRoom) {
      const room = getRoom(socket._webrtcRoom);
      if (room && room.webrtcPeers) room.webrtcPeers.delete(socket.id);
      socket.to(socket._webrtcRoom).emit('webrtc:peer_left', { peerId: socket.id });
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ── Turn timer ───────────────────────────────────────────────
const turnTimers = new Map();
function startTurnTimer(roomId) {
  const room = getRoom(roomId);
  if (!room || !room.settings.turnTimer) return;
  clearTurnTimer(roomId);
  const secs = room.settings.turnTimer;
  broadcastToRoom(roomId, 'timer:start', { seconds: secs, playerId: room.game.getCurrentPlayer()?.id });
  const t = setTimeout(() => {
    const cp = room.game.getCurrentPlayer();
    if (!cp) return;
    console.log(`Timer expired for ${cp.name} — auto fold`);
    broadcastToRoom(roomId, 'chat', { system: true, msg: `${cp.name} ran out of time — auto fold.` });
    const result = room.game.applyAction(cp.id, 'fold');
    broadcastState(roomId);
    if (result.advance === 'hand_over' || result.advance === 'showdown') {
      broadcastToRoom(roomId, 'game:hand_over', { winners: result.winners });
    } else {
      broadcastCurrentTurn(roomId);
      startTurnTimer(roomId);
    }
  }, secs * 1000);
  turnTimers.set(roomId, t);
}

function clearTurnTimer(roomId) {
  if (turnTimers.has(roomId)) { clearTimeout(turnTimers.get(roomId)); turnTimers.delete(roomId); }
  broadcastToRoom(roomId, 'timer:stop', {});
}

function broadcastCurrentTurn(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const cp = room.game.getCurrentPlayer();
  if (cp) broadcastToRoom(roomId, 'game:your_turn', { playerId: cp.id });
}

// Cleanup empty rooms every hour
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [id, room] of rooms.entries()) {
    if (room.createdAt < cutoff && room.game.players.filter(p => p.connected).length === 0) {
      rooms.delete(id); console.log(`Cleaned room ${id}`);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`♠ Poker server running on port ${PORT}`));