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
     {t:'pose', q, ts, p:[18 ints]}         my compact upper-body pose (Phase 3); relayed to the other player only
     {t:'punch', id, ts, s:'R'|'L', k}      one physical punch with a unique, increasing id; a repeated or older id is dropped
   Server -> client messages:
     {t:'welcome', id, v}
     {t:'room', code, you, state, players:[{slot,name,connected,cam,ready}]}
     {t:'left'}                             you are no longer in a room
     {t:'error', code, msg}
     {t:'pong', n}
     {t:'pose' ...} / {t:'punch' ...}       the opponent's pose and punches, exactly as validated by the server
     {t:'match', phase, you, cd, n, att, rem, hp:[a,b], st:[a,b], ctr:[a,b], el, winner, reason}   authoritative match state (about 10 per second)
     {t:'hit', id, att, def, k, s, res:'hit'|'dodge'|'block'|'tired'|'offturn', dmg, ctr}          result of ONE punch, decided only by the server
   The match starts by itself, with a countdown, as soon as both players are ready. The server owns the turn clock, stamina, health,
   damage and the end of the match; clients only send their pose and their punch events and draw what the server says.
   Room state: 'lobby' (waiting / not everyone ready) | 'ready' (two players present, camera-ready and ready).
   A room never holds more than two players. */
(function (root) {
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';          // no 0/O/1/I so a code can be read out loud
  var CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
  var V = 3;                                                   // 2 = pose/punch relay, 3 = authoritative multiplayer match

  var POSE_LEN = 18, POSE_LIM = 3000, KINDS = { jab: 1, cross: 1, hook: 1, upper: 1 };
  function validPose(p) {
    if (!Array.isArray(p) || p.length !== POSE_LEN) return false;
    for (var i = 0; i < POSE_LEN; i++) { var v = p[i]; if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v || v > POSE_LIM || v < -POSE_LIM) return false; }
    return true;
  }

  /* Approved Hybrid Boxing rules (same numbers as the solo game). Slot 0 attacks first, then the turns alternate every 5 seconds. */
  var PUNCH = { jab: { st: 5, dmg: 5, zone: 'straight' }, cross: { st: 9, dmg: 9, zone: 'straight' }, hook: { st: 13, dmg: 12, zone: 'hook' }, upper: { st: 18, dmg: 16, zone: 'body' } };
  var RULES = { countdownMs: 3500, turnMs: 5000, counterMs: 1300, resolveMs: 90, maxMs: 180000, regen: 12, regenDelayMs: 600, blockDrain: 3, dodgeCost: 5, low: 25, gapMs: 180, stateMs: 100, poseStaleMs: 1500, endKeepMs: 60000,
    dodgeX: 0.65, dodgeLatchOn: 0.26, dodgeLatchOff: 0.11, duckAvoid: 0.52, blockDmg: 0.25, counterBonus: 1.25, tiredDmg: 0.6 };

  function RoomManager(opts) {
    opts = opts || {};
    this.rand = opts.rand || Math.random;
    this.now = opts.now || function () { return Date.now(); };
    this.staleMs = opts.staleMs || 20000;
    this.autoStart = opts.autoStart !== false;       // the match begins by itself when both are ready (tests of the plain lobby switch this off)
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
    this.clients[id] = { id: id, send: send, room: null, name: 'Player', cam: false, lastSeen: this.now(), poseAt: -1e9, punchAt: -1e9, lastQ: 0, lastPunchId: 0, pose: null };
    this.stats = this.stats || { pose: 0, punch: 0, dropped: 0, dupPunch: 0 };
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
    var playing = !!(room.match && room.match.phase !== 'ended');
    return { t: 'room', code: room.code, you: you, state: playing ? 'playing' : both ? 'ready' : 'lobby', playing: playing, players: players };
  };
  RoomManager.prototype.broadcast = function (room) {
    var self = this;
    room.slots.forEach(function (pid) { var cl = pid && self.clients[pid]; if (cl) cl.send(self.snapshot(room, pid)); });
  };

  RoomManager.prototype.removeFromRoom = function (cl, notifySelf) {
    var room = cl.room && this.rooms[cl.room]; cl.room = null;
    if (!room) return;
    var i = room.slots.indexOf(cl.id);
    if (room.match && room.match.phase !== 'ended' && i >= 0) this.endMatch(room, 1 - i, 'left');             // leaving or losing the connection mid-match forfeits it
    if (i >= 0) room.slots[i] = null; delete room.ready[cl.id];
    if (!room.slots[0] && room.slots[1]) { room.slots[0] = room.slots[1]; room.slots[1] = null; }       // the remaining player becomes slot 0
    if (!room.slots[0]) { delete this.rooms[room.code]; }
    else { room.ready = {}; room.match = null; this.broadcast(room); }                                                     // someone left: everybody has to ready up again
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
        if (room.match && room.match.phase !== 'ended') return;                                    // no changes while a match is running
        if (msg.ready) room.ready[id] = true; else delete room.ready[id];
        this.broadcast(room);
        if (this.autoStart && this.snapshot(room, id).state === 'ready') this.startMatch(room);                       // both ready: the match begins by itself
        return;
      }
      case 'pose': case 'punch': return this.relay(cl, room, msg);
      case 'leave': return this.removeFromRoom(cl, true);
      default: return this.err(cl, 'unknown', 'Unknown message type');
    }
  };

  /* Pose and punch relay. Only between the two players of a room, never echoed to the sender, always validated.
     Bad data, rate abuse, repeated or older sequence numbers and repeated punch ids are dropped silently (no error spam at 20 Hz). */
  RoomManager.prototype.relay = function (cl, room, msg) {
    var st = this.stats = this.stats || { pose: 0, punch: 0, dropped: 0, dupPunch: 0 }, t = this.now();
    if (!room || !room.slots[0] || !room.slots[1]) { st.dropped++; return; }
    var other = this.clients[room.slots[0] === cl.id ? room.slots[1] : room.slots[0]]; if (!other) { st.dropped++; return; }
    if (msg.t === 'pose') {
      if (!validPose(msg.p) || !(msg.q > 0) || Math.floor(msg.q) !== msg.q || typeof msg.ts !== 'number' || !isFinite(msg.ts) || msg.q <= cl.lastQ) { st.dropped++; return; }
      if (t - cl.poseAt < 25) { st.dropped++; return; }                          // at most 40 poses per second per player
      cl.poseAt = t; cl.lastQ = msg.q; cl.pose = msg.p; st.pose++;
      return other.send({ t: 'pose', q: msg.q, ts: msg.ts, p: msg.p });
    }
    if (!(msg.id > 0) || Math.floor(msg.id) !== msg.id || (msg.s !== 'R' && msg.s !== 'L') || !KINDS[msg.k] || typeof msg.ts !== 'number' || !isFinite(msg.ts)) { st.dropped++; return; }
    if (msg.id <= cl.lastPunchId) { st.dupPunch++; return; }                      // the same physical punch can never be relayed (or later scored) twice
    if (t - cl.punchAt < 80) { st.dropped++; return; }
    cl.punchAt = t; cl.lastPunchId = msg.id; st.punch++;
    other.send({ t: 'punch', id: msg.id, ts: msg.ts, s: msg.s, k: msg.k });
    if (room.match && room.match.phase === 'fight') this.matchPunch(cl, room, msg);
  };

  /* ---------------- authoritative match ---------------- */
  RoomManager.prototype.startMatch = function (room) {
    var t = this.now();
    room.match = { phase: 'countdown', t0: t, fightT0: 0, turnT0: 0, n: 0, last: t, hp: [100, 100], st: [100, 100], stAt: [0, 0], ctr: [0, 0], gapAt: [-1e9, -1e9], latch: [false, false], pend: [], lastState: 0, winner: -1, reason: '', endAt: 0,
      stats: [{ swings: 0, hits: 0, dodges: 0, blocks: 0, taken: 0 }, { swings: 0, hits: 0, dodges: 0, blocks: 0, taken: 0 }] };
    this.broadcast(room);                                                              // the room is now 'playing'
    this.sendMatch(room);
  };
  RoomManager.prototype.matchSnapshot = function (room, slot) {
    var m = room.match, t = this.now(), fight = m.phase === 'fight', r1 = function (v) { return Math.round(v * 10) / 10; };
    return { t: 'match', phase: m.phase, you: slot, cd: m.phase === 'countdown' ? Math.max(0, RULES.countdownMs - (t - m.t0)) : 0, n: m.n, att: m.n % 2, rem: fight ? Math.max(0, RULES.turnMs - (t - m.turnT0)) : RULES.turnMs,
      hp: [r1(m.hp[0]), r1(m.hp[1])], st: [r1(m.st[0]), r1(m.st[1])], ctr: [Math.max(0, m.ctr[0] - t), Math.max(0, m.ctr[1] - t)], el: fight || m.phase === 'ended' ? Math.max(0, (m.endAt || t) - m.fightT0) : 0,
      winner: m.winner, reason: m.reason, stats: m.phase === 'ended' ? m.stats : undefined };
  };
  RoomManager.prototype.sendMatch = function (room) {
    var self = this; room.match.lastState = this.now();
    room.slots.forEach(function (pid, slot) { var cl = pid && self.clients[pid]; if (cl) cl.send(self.matchSnapshot(room, slot)); });
  };
  RoomManager.prototype.endMatch = function (room, winner, reason) {
    var m = room.match; if (!m || m.phase === 'ended') return;
    m.phase = 'ended'; m.winner = winner; m.reason = reason; m.endAt = this.now(); m.pend = [];
    this.sendMatch(room);
    room.ready = {};                                                                  // everybody has to ready up again for a rematch
    this.broadcast(room);
  };
  function blockingOf(p) { return !!p && !(p[5] & 8) && ((p[5] & 4) || p[4] >= 50); }
  RoomManager.prototype.poseOf = function (room, slot) {
    var cl = this.clients[room.slots[slot]]; if (!cl || !cl.pose || this.now() - cl.poseAt > RULES.poseStaleMs) return null;   // no recent signal: the fighter can neither dodge nor block
    return cl.pose;
  };
  /* one punch event from slot a. Validates the turn, the counter window and the stamina; the outcome is decided RULES.resolveMs later from the defender's pose. */
  RoomManager.prototype.matchPunch = function (cl, room, msg) {
    var m = room.match, t = this.now(), a = room.slots.indexOf(cl.id), d = 1 - a, pt = PUNCH[msg.k], st = m.stats[a];
    if (a < 0 || !pt || t - m.gapAt[a] < RULES.gapMs) return;
    var mine = (m.n % 2) === a, counter = !mine && m.ctr[a] > t;
    var base = { t: 'hit', id: msg.id, att: a, def: d, k: msg.k, s: msg.s, dmg: 0, ctr: false };
    if (!mine && !counter) return cl.send(Object.assign(base, { res: 'offturn' }));          // defend turn and no counter window: the punch does nothing and costs nothing
    if (m.st[a] < pt.st) return cl.send(Object.assign(base, { res: 'tired' }));              // exhausted: no damage, no cost, a counter window is kept
    if (counter) m.ctr[a] = 0;                                                               // a counter window pays for exactly one punch
    m.st[a] -= pt.st; m.stAt[a] = t; m.gapAt[a] = t; st.swings++;
    m.pend.push({ at: t + RULES.resolveMs, a: a, d: d, id: msg.id, k: msg.k, s: msg.s, counter: counter });
  };
  RoomManager.prototype.resolvePunch = function (room, p) {
    var m = room.match, pt = PUNCH[p.k], t = this.now(), pd = this.poseOf(room, p.d), res, dmg = 0;
    var avX = !!pd && Math.abs(pd[16]) / 100 > RULES.dodgeX, avY = !!pd && pd[1] / 100 > RULES.duckAvoid;
    var avoid = pt.zone === 'straight' ? (avX || avY) : pt.zone === 'hook' ? avY : avX;                  // sidestep, duck or both, depending on the punch (the solo game's attack zones)
    var base = pt.dmg * (m.st[p.a] < RULES.low ? RULES.tiredDmg : 1);
    if (avoid) { res = 'dodge'; m.stats[p.d].dodges++; m.ctr[p.d] = t + RULES.counterMs; }              // a successful dodge opens the counter-punch window
    else if (blockingOf(pd) && m.st[p.d] > 0) { res = 'block'; dmg = base * RULES.blockDmg; m.stats[p.d].blocks++; }
    else { res = 'hit'; dmg = base * (p.counter ? RULES.counterBonus : 1); m.stats[p.a].hits++; m.stats[p.d].taken++; }
    m.hp[p.d] = Math.max(0, m.hp[p.d] - dmg);
    var ev = { t: 'hit', id: p.id, att: p.a, def: p.d, k: p.k, s: p.s, res: res, dmg: Math.round(dmg * 10) / 10, ctr: p.counter };
    var self = this; room.slots.forEach(function (pid) { var cl = pid && self.clients[pid]; if (cl) cl.send(ev); });
    this.sendMatch(room);
    if (m.hp[p.d] <= 0) this.endMatch(room, p.a, 'ko');
  };
  RoomManager.prototype.tick = function () {
    var t = this.now(), code, room, m, i;
    for (code in this.rooms) {
      room = this.rooms[code]; m = room.match; if (!m) continue;
      if (m.phase === 'ended') { if (t - m.endAt > RULES.endKeepMs) room.match = null; continue; }
      if (m.phase === 'countdown') {
        if (t - m.t0 >= RULES.countdownMs) { m.phase = 'fight'; m.fightT0 = t; m.turnT0 = t; m.last = t; this.sendMatch(room); }
        else if (t - m.lastState >= RULES.stateMs) this.sendMatch(room);
        continue;
      }
      var dt = Math.max(0, Math.min(0.25, (t - m.last) / 1000)); m.last = t;
      var flipped = false; while (t - m.turnT0 >= RULES.turnMs) { m.turnT0 += RULES.turnMs; m.n++; flipped = true; }       // exactly five seconds each, then it flips with no pause
      for (i = m.pend.length - 1; i >= 0; i--) if (m.pend[i].at <= t) { var pp = m.pend.splice(i, 1)[0]; this.resolvePunch(room, pp); if (m.phase === 'ended') break; }
      if (m.phase === 'ended') continue;
      for (i = 0; i < 2; i++) {
        var pose = this.poseOf(room, i), blocking = blockingOf(pose);
        if (blocking && m.st[i] > 0) { m.st[i] = Math.max(0, m.st[i] - RULES.blockDrain * dt); m.stAt[i] = t; }
        if (t - m.stAt[i] >= RULES.regenDelayMs && !(blocking && m.st[i] > 0)) m.st[i] = Math.min(100, m.st[i] + RULES.regen * dt);
        var gx = pose ? Math.abs(pose[16]) / 100 : 0;
        if (!m.latch[i] && gx > RULES.dodgeLatchOn) { m.latch[i] = true; m.st[i] = Math.max(0, m.st[i] - RULES.dodgeCost); m.stAt[i] = t; }     // every deliberate dodge costs stamina
        else if (m.latch[i] && gx < RULES.dodgeLatchOff) m.latch[i] = false;
      }
      if (t - m.fightT0 >= RULES.maxMs) { var h0 = m.hp[0], h1 = m.hp[1]; return this.endMatch(room, h0 === h1 ? -1 : h0 > h1 ? 0 : 1, 'time'); }
      if (flipped || t - m.lastState >= RULES.stateMs) this.sendMatch(room);
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

  RoomManager.RULES = RULES; RoomManager.PUNCH = PUNCH;
  root.RoomManager = RoomManager;
  if (typeof module !== 'undefined' && module.exports) module.exports = RoomManager;
})(typeof self !== 'undefined' ? self : globalThis);
