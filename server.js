const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });
app.use(express.static('public', { etag: false, setHeaders: res => res.set('Cache-Control', 'no-store') }));

let hideSec = 120, seekSec = 300;
const END_SEC = 10, LOAD_SEC = 5, REVEAL_SEC = 15, BURY_SEC = 5, MAP_SEED = 1337, DEV_NICK = '박준우';
const kor = s => s < 60 ? `${s}초` : s % 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s / 60}분`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const PARTS = ['head', 'body', 'armL', 'armR', 'legL', 'legR'];
const players = {};
let phase = 'lobby', left = 0, seekerId = null;

const pub = p => ({ id: p.id, nick: p.nick, role: p.role, found: p.found, ready: !!p.ready });
const full = p => ({ ...pub(p), x: p.x, z: p.z, y: p.y, pit: p.pit, run: p.run, ry: p.ry, pose: p.pose, air: !!p.air, exposed: !!p.exposed, tex: p.tex });
const roster = () => io.emit('roster', Object.values(players).map(pub));
function clearExtras() {
  Object.values(players).forEach(p => {
    delete p.clone; p.burySince = 0;
    if (p.exposed) { p.exposed = false; io.emit('expose', { id: p.id, on: false }); }
  });
  io.emit('clones-clear');
}
function setPhase(ph, sec, msg) {
  phase = ph; left = sec;
  if (ph === 'lobby' || ph === 'loading' || ph === 'ended') clearExtras();
  io.emit('phase', { phase, left, seekerId, msg });
  roster();
}
function endGame(msg) { setPhase('ended', END_SEC, msg); }
function checkEnd() {
  if (phase !== 'seeking' && phase !== 'reveal') return;
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
      id: socket.id, nick, found: false, ready: false, x: 0, z: 0, y: 0, pit: 0, run: false, ry: 0, pose: 'stand', tex: {},
      role: (phase === 'seeking' || phase === 'ended') ? 'spectator' : 'hider',
    };
    players[socket.id] = p;
    socket.emit('welcome', {
      id: p.id, seed: MAP_SEED, phase, left, seekerId, cfg: { hide: hideSec, seek: seekSec },
      players: Object.values(players).map(full),
      clones: Object.values(players).filter(q => q.clone).map(q => q.clone),
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

  // 술래 페인트 총: 발사 이펙트를 다른 사람에게도 전달 (잡기 판정은 'tag')
  socket.on('shot', d => {
    const p = players[socket.id];
    if (!p || p.role !== 'seeker' || (phase !== 'seeking' && phase !== 'hiding' && phase !== 'reveal') || !d) return;
    const now = Date.now();
    if (now - (p.lastShot || 0) < 150) return;
    p.lastShot = now;
    const v3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a.map(x => clamp(x, -1000, 1000)) : null;
    const o = v3(d.o), pt = v3(d.p), n = v3(d.n);
    if (!o || !pt) return;
    socket.broadcast.emit('shot', { id: p.id, o, p: pt, n, c: (d.c | 0) & 0xffffff });
  });

  // 분신: 소환 시점의 자세·색을 그대로 복사해 고정 (AI 없음). 도망자 1명당 1개
  socket.on('clone', d => {
    const p = players[socket.id];
    if (!p || !d || p.role !== 'hider' || p.found || p.clone || (phase !== 'hiding' && phase !== 'seeking')) return;
    const tex = {};
    if (d.tex && typeof d.tex === 'object') for (const part of PARTS) {
      const f = d.tex[part];
      if (Array.isArray(f) && f.length >= 1 && f.length <= 2 && f.every(u => typeof u === 'string' && u.length < 250000 && u.startsWith('data:image/png;base64,'))) tex[part] = f;
    }
    p.clone = { id: p.id, x: p.x, z: p.z, y: p.y, ry: p.ry, pose: String(d.pose || 'stand').slice(0, 10), tex };
    io.emit('clone', p.clone);
  });
  socket.on('clone-del', () => {
    const p = players[socket.id];
    if (!p || !p.clone) return;
    delete p.clone;
    io.emit('clone-del', p.id);
  });
  // 술래가 분신을 맞히면 술래 아웃 (= 술래 패배)
  socket.on('tag-clone', id => {
    const s = players[socket.id], t = players[id];
    if (phase !== 'seeking' || !s || !t || s.role !== 'seeker' || !t.clone) return;
    if (Math.hypot(s.x - t.clone.x, s.z - t.clone.z) > 24) return;
    delete t.clone;
    io.emit('clone-del', id);
    endGame(`술래 아웃! ${t.nick}님의 분신을 맞혔어요. 숨는 팀 승리`);
  });
  // 몸이 너무 파묻힘: BURY_SEC초 유지되면 위치 공개 (빠져나오면 해제)
  socket.on('bury', on => {
    const p = players[socket.id];
    if (!p) return;
    if (on && p.role === 'hider' && !p.found && (phase === 'hiding' || phase === 'seeking' || phase === 'reveal')) {
      if (!p.burySince) p.burySince = Date.now();
    } else {
      p.burySince = 0;
      if (p.exposed) { p.exposed = false; io.emit('expose', { id: p.id, on: false }); }
    }
  });

  socket.on('state', s => {
    const p = players[socket.id];
    if (!p || !s) return;
    if (phase === 'reveal' && p.role === 'hider') return;   // 공개 타임: 도망자는 움직일 수 없음
    p.x = +s.x || 0; p.z = +s.z || 0; p.ry = +s.ry || 0;
    p.y = clamp(+s.y || 0, 0, 6); p.run = !!s.run; p.pit = clamp(+s.pit || 0, -1.5, 1.5);
    let pose = String(s.pose || 'stand').slice(0, 10);
    // 술래는 포즈 변경 불가(서 있기/엎드리기만), 도망자는 엎드리기 불가
    if (p.role === 'seeker' && phase !== 'lobby') pose = pose === 'prone' ? 'prone' : 'stand';
    else if (pose === 'prone') pose = 'stand';
    p.pose = pose; p.air = !!s.air;
  });

  socket.on('tex', d => {
    const p = players[socket.id];
    if (!p || !d || !PARTS.includes(d.part) || !Array.isArray(d.faces) || d.faces.length < 1 || d.faces.length > 2) return;
    if (!d.faces.every(f => typeof f === 'string' && f.length < 250000 && f.startsWith('data:image/png;base64,'))) return;
    if (phase === 'seeking' || phase === 'reveal' || phase === 'loading') return;
    p.tex[d.part] = d.faces;
    socket.broadcast.emit('tex', { id: p.id, part: d.part, faces: d.faces });
  });

  socket.on('tag', id => {
    const s = players[socket.id], t = players[id];
    if (phase !== 'seeking' || !s || !t || s.role !== 'seeker' || t.role !== 'hider' || t.found) return;
    if (Math.hypot(s.x - t.x, s.z - t.z) > 24) return;
    t.found = true; t.burySince = 0;
    if (t.clone) { delete t.clone; io.emit('clone-del', id); }
    if (t.exposed) { t.exposed = false; io.emit('expose', { id, on: false }); }
    io.emit('found', { id, nick: t.nick });
    roster();
    checkEnd();
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (!p) return;
    delete players[socket.id];
    io.emit('player-remove', socket.id);
    io.emit('clone-del', socket.id);
    if (phase === 'loading' || phase === 'hiding' || phase === 'seeking' || phase === 'reveal') {
      if (p.role === 'seeker') endGame('술래가 나갔어요. 숨는 팀 승리!');
      else if (phase === 'reveal' && p.role === 'hider' && !p.found) endGame('도망자가 나갔어요. 숨는 팀 승리!');
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
  else if (phase === 'seeking') setPhase('reveal', REVEAL_SEC, `공개 타임! ${REVEAL_SEC}초 동안 도망자는 움직일 수 없어요. 술래는 얼마나 잘 숨었는지 구경하세요`);
  else if (phase === 'reveal') endGame('시간 종료! 숨는 팀 승리');
  else {
    Object.values(players).forEach(p => { p.role = 'hider'; p.found = false; p.ready = false; });
    seekerId = null;
    setPhase('lobby', 0, '대기실로 돌아왔어요');
  }
}, 1000);

setInterval(() => {
  const list = Object.values(players);
  if (list.length) io.volatile.emit('states', list.map(p => ({ id: p.id, x: p.x, z: p.z, y: p.y, pit: p.pit, run: p.run, ry: p.ry, pose: p.pose, air: !!p.air })));
}, 70);

// 파묻힘 공개 판정
setInterval(() => {
  const now = Date.now();
  for (const p of Object.values(players))
    if (p.burySince && !p.exposed && now - p.burySince >= BURY_SEC * 1000) { p.exposed = true; io.emit('expose', { id: p.id, on: true }); }
}, 250);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('listening on', PORT));
