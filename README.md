# 🦎 메챠 카멜레온 (백룸)

Node.js + Socket.io + Three.js 멀티플레이 술래잡기. 숨기 2분 → 찾기 5분, 모두 '게임 시작'에 동의하면 시작, 술래는 랜덤 1명.

## 로컬 실행
```
npm install
npm start   # http://localhost:3000
```
(2명 이상 필요 — 브라우저 탭 2개로 테스트 가능)

## GitHub → Railway 배포
1. `git init && git add . && git commit -m "init"` 후 GitHub 저장소 생성 → `git remote add origin <주소> && git push -u origin main`
2. railway.app → New Project → Deploy from GitHub repo → 저장소 선택
3. 서비스 → Settings → Networking → Generate Domain
(PORT는 Railway가 자동 주입, 별도 설정 불필요)

## 대기실 / 시작
대기실 화면 왼쪽의 '게임 시작' 버튼(전원 동의) → 검은 화면 Loading... 5초 → 백룸에서 시작.

## 대기실
접속하면 백룸과 분리된 대기실에서 자유롭게 돌아다닐 수 있고, 모두 시작에 동의하면 백룸으로 이동합니다.

## 조작
WASD 이동 · Shift 시점 잠금 켜기/끄기 · R 포즈 바(숫자키 0~8) · E 꾸미기(색칠) · 술래는 클릭으로 잡기
