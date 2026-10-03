const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
app.use(express.static('public'));

let hideSec = 120, seekSec = 300;
const END_SEC = 10, LOAD_SEC = 5, MAP_SEED = 1337, DEV_NICK = '박준우';
const kor = s => s < 60 ? `${s}초` : s % 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s / 60}분`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const PARTS = ['head', 'body', 'armL', 'armR', 'legL', 'legR'];
const players = {};
let phase = 'lobby', left = 0, seekerId = null;

const pub = p => ({ id: p.id, nick: p.nick, role: p.role, found: p.found, ready: !!p.ready });
const full = p => ({ ...pub(p), x: p.x, z: p.z, ry: p.ry, pose: p.pose, tex: p.tex });
const roster = () => io.emit('roster', Object.values(players).map(pub));
function setPhase(ph, sec, msg) {
  phase = ph; left = sec;
  io.emit('phase', { phase, left, seekerId, msg });
  roster();
}
function endGame(msg) { setPhase('ended', END_SEC, msg); }
function checkEnd() {
  if (phase !== 'seeking') return;
  if (!Object.values(players).some(p => p.role === 'hider' && !p.found)) endGame('술래 승리! 모두 찾았어요');
}

function startGame() {
  const ids = Object.keys(players);
  seekerId = ids[Math.floor(Math.random() * ids.length)];
  ids.forEach(id => { const p = players[id]; p.role = id === seekerId ? 'seeker' : 'hider'; p.found = false; p.ready = false; });
  setPhase('loading', LOAD_SEC, '');
}
function checkStart() {
  const ids = Object.keys(players);
  if (phase === 'lobby' && ids.length >= 2 && ids.every(id => players[id].ready)) startGame();
}

io.on('connection', socket => {
  socket.on('join', nick => {
    nick = String(nick || '').trim().slice(0, 12) || '익명';
    const p = {
      id: socket.id, nick, found: false, ready: false, x: 0, z: 0, ry: 0, pose: 'stand', tex: {},
      role: (phase === 'seeking' || phase === 'ended') ? 'spectator' : 'hider',
    };
    players[socket.id] = p;
    socket.emit('welcome', {
      id: p.id, seed: MAP_SEED, phase, left, seekerId, cfg: { hide: hideSec, seek: seekSec },
      players: Object.values(players).map(full),
    });
    socket.broadcast.emit('player-add', full(p));
    roster();
  });

  socket.on('ready', () => {
    const p = players[socket.id];
    if (!p || phase !== 'lobby') return;
    p.ready = !p.ready;
    roster();
    checkStart();
  });

  socket.on('dev', d => {
    const p = players[socket.id];
    if (!p || p.nick !== DEV_NICK || !d) return;
    const dl = d.delta === 10 ? 10 : d.delta === -10 ? -10 : 0;
    if (!dl) return;
    // 설정값과 (해당 단계가 진행 중이면) 남은 시간을 함께 조절
    if (d.kind === 'hide') {
      hideSec = clamp(hideSec + dl, 10, 600);
      if (phase === 'hiding') { left = Math.max(1, left + dl); io.emit('tick', { left }); }
    } else if (d.kind === 'seek') {
      seekSec = clamp(seekSec + dl, 10, 1200);
      if (phase === 'seeking') { left = Math.max(1, left + dl); io.emit('tick', { left }); }
    } else return;
    io.emit('cfg', { hide: hideSec, seek: seekSec });
  });

  socket.on('state', s => {
    const p = players[socket.id];
    if (!p || !s) return;
    p.x = +s.x || 0; p.z = +s.z || 0; p.ry = +s.ry || 0;
    p.pose = String(s.pose || 'stand').slice(0, 10);
  });

  socket.on('tex', d => {
    const p = players[socket.id];
    if (!p || !d || !PARTS.includes(d.part) || !Array.isArray(d.faces) || d.faces.length < 1 || d.faces.length > 2) return;
    if (!d.faces.every(f => typeof f === 'string' && f.length < 250000 && f.startsWith('data:image/png;base64,'))) return;
    if (phase === 'seeking' || phase === 'loading' || (phase === 'hiding' && p.role === 'seeker')) return;
    p.tex[d.part] = d.faces;
    socket.broadcast.emit('tex', { id: p.id, part: d.part, faces: d.faces });
  });

  socket.on('tag', id => {
    const s = players[socket.id], t = players[id];
    if (phase !== 'seeking' || !s || !t || s.role !== 'seeker' || t.role !== 'hider' || t.found) return;
    if (Math.hypot(s.x - t.x, s.z - t.z) > 8) return;
    t.found = true;
    io.emit('found', { id, nick: t.nick });
    roster();
    checkEnd();
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (!p) return;
    delete players[socket.id];
    io.emit('player-remove', socket.id);
    if (phase === 'loading' || phase === 'hiding' || phase === 'seeking') {
      if (p.role === 'seeker') endGame('술래가 나갔어요. 숨는 팀 승리!');
      else if (Object.keys(players).length < 2) endGame('인원이 부족해 게임이 끝났어요');
      else checkEnd();
    }
    roster();
    checkStart();
  });
});

setInterval(() => {
  if (phase === 'lobby') return;
  left--;
  io.emit('tick', { left });
  if (left > 0) return;
  if (phase === 'loading') setPhase('hiding', hideSec, `${players[seekerId] ? players[seekerId].nick : '누군가'}님이 술래! ${kor(hideSec)} 안에 숨으세요`);
  else if (phase === 'hiding') setPhase('seeking', seekSec, `술래가 움직입니다! ${kor(seekSec)} 안에 찾아요`);
  else if (phase === 'seeking') endGame('시간 종료! 숨는 팀 승리');
  else {
    Object.values(players).forEach(p => { p.role = 'hider'; p.found = false; p.ready = false; });
    seekerId = null;
    setPhase('lobby', 0, '대기실로 돌아왔어요');
  }
}, 1000);

setInterval(() => {
  const list = Object.values(players);
  if (list.length) io.volatile.emit('states', list.map(p => ({ id: p.id, x: p.x, z: p.z, ry: p.ry, pose: p.pose })));
}, 70);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('listening on', PORT));
