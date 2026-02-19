const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { PokerGame } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// ─── ROOM STORE ──────────────────────────────────────────────────────────────
const rooms = new Map();       // roomId -> { game, hostId, createdAt }
const socketToPlayer = new Map(); // socketId -> { roomId, playerId, playerName }

function getRoom(roomId) { return rooms.get(roomId); }

// Send each player their own personalized game state
function broadcastState(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const { game } = room;

  for (const player of game.players) {
    const sockets = [...socketToPlayer.entries()]
      .filter(([, v]) => v.roomId === roomId && v.playerId === player.id)
      .map(([sid]) => sid);
    for (const sid of sockets) {
      io.to(sid).emit('game:state', {
        ...game.getStateFor(player.id),
        isHost: room.hostId === player.id   // ← always include isHost in state
      });
    }
  }
}

function broadcastToRoom(roomId, event, data) {
  io.to(roomId).emit(event, data);
}

// ─── REST ─────────────────────────────────────────────────────────────────────
app.post('/api/rooms', (req, res) => {
  const roomId = uuidv4().slice(0, 6).toUpperCase();
  const game = new PokerGame(roomId);
  rooms.set(roomId, { game, hostId: null, createdAt: Date.now() });
  console.log(`Room created: ${roomId}`);
  res.json({ roomId });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    roomId: req.params.roomId.toUpperCase(),
    playerCount: room.game.players.length,
    phase: room.game.phase,
    maxPlayers: 9
  });
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('room:join', ({ roomId, playerName, playerId }) => {
    const rid = roomId.toUpperCase();
    const room = getRoom(rid);
    if (!room) {
      socket.emit('error', { message: `Room "${rid}" not found` });
      return;
    }

    const name = (playerName || 'Player').slice(0, 20);

    // Only reuse a playerId if that player actually exists in this room
    const existingPlayer = playerId ? room.game.players.find(p => p.id === playerId) : null;
    const pid = existingPlayer ? playerId : uuidv4();

    if (existingPlayer) {
      room.game.reconnectPlayer(pid);
      console.log(`${name} reconnected to ${rid} as ${pid}`);
    } else {
      const result = room.game.addPlayer(pid, name);
      if (result.error) {
        socket.emit('error', { message: result.error });
        return;
      }
      console.log(`${name} joined ${rid} as ${pid}`);
    }

    // First player is host
    if (!room.hostId) room.hostId = pid;

    // Register socket BEFORE any emits
    socket.join(rid);
    socketToPlayer.set(socket.id, { roomId: rid, playerId: pid, playerName: name });

    // Tell the client who they are
    socket.emit('room:joined', {
      roomId: rid,
      playerId: pid,
      playerName: name,
      isHost: room.hostId === pid
    });

    // Send this player their personalized state immediately
    socket.emit('game:state', {
      ...room.game.getStateFor(pid),
      isHost: room.hostId === pid
    });

    // Broadcast updated state to everyone already in the room
    broadcastState(rid);
    broadcastToRoom(rid, 'chat', { system: true, msg: `${name} joined the table.` });
  });

  // Deal / start hand (host only)
  socket.on('game:deal', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const room = getRoom(info.roomId);
    if (!room) return;

    if (room.hostId !== info.playerId) {
      socket.emit('error', { message: 'Only the host can deal' });
      return;
    }

    const result = room.game.startHand();
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    broadcastState(info.roomId);
    broadcastCurrentTurn(info.roomId);
  });

  // Player action (fold/check/call/raise/allin)
  socket.on('game:action', ({ action, amount }) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const room = getRoom(info.roomId);
    if (!room) return;

    const result = room.game.applyAction(info.playerId, action, amount);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    broadcastState(info.roomId);

    if (result.advance === 'hand_over' || result.advance === 'showdown') {
      broadcastToRoom(info.roomId, 'game:hand_over', { winners: result.winners });
    } else {
      broadcastCurrentTurn(info.roomId);
    }
  });

  // Chat
  socket.on('chat:send', ({ msg }) => {
    const info = socketToPlayer.get(socket.id);
    if (!info || !msg) return;
    broadcastToRoom(info.roomId, 'chat', {
      name: info.playerName,
      msg: msg.slice(0, 200)
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const info = socketToPlayer.get(socket.id);
    if (info) {
      const room = getRoom(info.roomId);
      if (room) {
        room.game.removePlayer(info.playerId);
        broadcastState(info.roomId);
        broadcastToRoom(info.roomId, 'chat', {
          system: true,
          msg: `${info.playerName} disconnected.`
        });
      }
      socketToPlayer.delete(socket.id);
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

function broadcastCurrentTurn(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const cp = room.game.getCurrentPlayer();
  if (cp) broadcastToRoom(roomId, 'game:your_turn', { playerId: cp.id });
}

// Clean up empty rooms after 3 hours
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [id, room] of rooms.entries()) {
    if (room.createdAt < cutoff && room.game.players.filter(p => p.connected).length === 0) {
      rooms.delete(id);
      console.log(`Cleaned room ${id}`);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`♠ Poker server running on port ${PORT}`));