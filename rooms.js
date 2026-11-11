/* Motion Boxing: room protocol and room logic.
   Transport-agnostic and dependency-free. The SAME file runs
   - in the Node server (server/server.js), where it is the authority, and
   - inside the browser page (injected by build.py) for the local mock mode.

   Client -> server messages (JSON):
     {t:'hello', name}                      first message after connecting
     {t:'create'}                           make a private room, you become slot 0
     {t:'join', code}                       join a room by its six-character code
     {t:'status', cam}                      camera/tracking is ready (true) or not (false)
     {t:'ready', ready}                     toggle "ready"; only allowed while cam is ready
     {t:'leave'}                            leave the room
     {t:'ping', n}                          heartbeat
   Server -> client messages:
     {t:'welcome', id, v}
     {t:'room', code, you, state, players:[{slot,name,connected,cam,ready}]}
     {t:'left'}                             you are no longer in a room
     {t:'error', code, msg}
     {t:'pong', n}
   Room state: 'lobby' (waiting / not everyone ready) | 'ready' (two players present, camera-ready and ready).
   A room never holds more than two players. */
(function (root) {
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';          // no 0/O/1/I so a code can be read out loud
  var CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
  var V = 1;

  function RoomManager(opts) {
    opts = opts || {};
    this.rand = opts.rand || Math.random;
    this.now = opts.now || function () { return Date.now(); };
    this.staleMs = opts.staleMs || 20000;
    this.clients = {};            // id -> {id, send, room, name, cam, lastSeen}
    this.rooms = {};              // code -> {code, slots:[clientId|null, clientId|null], ready:{id:bool}, created}
  }
  RoomManager.normalizeCode = function (c) { return String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, ''); };
  RoomManager.isValidCode = function (c) { return CODE_RE.test(c); };

  RoomManager.prototype.makeCode = function () {
    for (var tries = 0; tries < 200; tries++) {
      var c = ''; for (var i = 0; i < 6; i++) c += ALPHABET.charAt(Math.floor(this.rand() * ALPHABET.length) % ALPHABET.length);
      if (!this.rooms[c]) return c;
    }
    return null;
  };
  RoomManager.prototype.connect = function (id, send) {
    this.clients[id] = { id: id, send: send, room: null, name: 'Player', cam: false, lastSeen: this.now() };
    send({ t: 'welcome', id: id, v: V });
  };
  RoomManager.prototype.has = function (id) { return !!this.clients[id]; };
  RoomManager.prototype.err = function (cl, code, msg) { cl.send({ t: 'error', code: code, msg: msg }); };

  RoomManager.prototype.snapshot = function (room, forId) {
    var self = this, you = room.slots.indexOf(forId), players = [];
    room.slots.forEach(function (pid, slot) {
      if (!pid) return;
      var p = self.clients[pid];
      players.push({ slot: slot, name: p ? p.name : 'Player', connected: !!p, cam: !!(p && p.cam), ready: !!room.ready[pid] });
    });
    var both = players.length === 2 && players.every(function (p) { return p.connected && p.cam && p.ready; });
    return { t: 'room', code: room.code, you: you, state: both ? 'ready' : 'lobby', players: players };
  };
  RoomManager.prototype.broadcast = function (room) {
    var self = this;
    room.slots.forEach(function (pid) { var cl = pid && self.clients[pid]; if (cl) cl.send(self.snapshot(room, pid)); });
  };

  RoomManager.prototype.removeFromRoom = function (cl, notifySelf) {
    var room = cl.room && this.rooms[cl.room]; cl.room = null;
    if (!room) return;
    var i = room.slots.indexOf(cl.id); if (i >= 0) room.slots[i] = null; delete room.ready[cl.id];
    if (!room.slots[0] && room.slots[1]) { room.slots[0] = room.slots[1]; room.slots[1] = null; }       // the remaining player becomes slot 0
    if (!room.slots[0]) { delete this.rooms[room.code]; }
    else { room.ready = {}; this.broadcast(room); }                                                     // someone left: everybody has to ready up again
    if (notifySelf) cl.send({ t: 'left' });
  };

  RoomManager.prototype.handle = function (id, msg) {
    var cl = this.clients[id]; if (!cl) return;
    cl.lastSeen = this.now();
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.err(cl, 'bad_message', 'Malformed message');
    var room = cl.room && this.rooms[cl.room];
    switch (msg.t) {
      case 'hello': cl.name = String(msg.name || 'Player').replace(/[^\w \-.]/g, '').slice(0, 14) || 'Player'; if (room) this.broadcast(room); return;
      case 'ping': return cl.send({ t: 'pong', n: msg.n });
      case 'status': cl.cam = !!msg.cam; if (!cl.cam && room) { delete room.ready[id]; } if (room) this.broadcast(room); return;
      case 'create': {
        if (room) return this.err(cl, 'already_in_room', 'Leave your current room first');
        var code = this.makeCode(); if (!code) return this.err(cl, 'server_busy', 'Could not create a room, try again');
        room = { code: code, slots: [id, null], ready: {}, created: this.now() };
        this.rooms[code] = room; cl.room = code; return this.broadcast(room);
      }
      case 'join': {
        if (room) return this.err(cl, 'already_in_room', 'Leave your current room first');
        var c = RoomManager.normalizeCode(msg.code);
        if (!RoomManager.isValidCode(c)) return this.err(cl, 'bad_code', 'A room code has 6 letters and numbers');
        var target = this.rooms[c];
        if (!target) return this.err(cl, 'no_room', 'No room with that code');
        if (target.slots[0] && target.slots[1]) return this.err(cl, 'room_full', 'That room already has two players');
        target.slots[target.slots[0] ? 1 : 0] = id; target.ready = {}; cl.room = c; return this.broadcast(target);
      }
      case 'ready': {
        if (!room) return this.err(cl, 'not_in_room', 'You are not in a room');
        if (msg.ready && !cl.cam) return this.err(cl, 'cam_not_ready', 'Your camera tracking is not ready yet');
        if (msg.ready && !(room.slots[0] && room.slots[1])) return this.err(cl, 'alone', 'Wait for your opponent to join');
        if (msg.ready) room.ready[id] = true; else delete room.ready[id];
        return this.broadcast(room);
      }
      case 'leave': return this.removeFromRoom(cl, true);
      default: return this.err(cl, 'unknown', 'Unknown message type');
    }
  };

  RoomManager.prototype.disconnect = function (id) {
    var cl = this.clients[id]; if (!cl) return;
    this.removeFromRoom(cl, false); delete this.clients[id];
  };
  /* drop clients that went silent (call on a timer on the server) */
  RoomManager.prototype.sweep = function () {
    var t = this.now(), dead = [], k;
    for (k in this.clients) if (t - this.clients[k].lastSeen > this.staleMs) dead.push(k);
    for (var i = 0; i < dead.length; i++) this.disconnect(dead[i]);
    return dead;
  };

  root.RoomManager = RoomManager;
  if (typeof module !== 'undefined' && module.exports) module.exports = RoomManager;
})(typeof self !== 'undefined' ? self : globalThis);
