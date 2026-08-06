// ===== FITNESS PLANNER — AUTO WORKOUT LOG =====
// 50세 남성 근성장 + 점진적 과부하 자동 추적 시스템

'use strict';

// ===== DRAG STATE =====
let dragState = null;

const DAYS_KR = ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'];
const DAYS_EN = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
const NUM_TODO_DEFAULT = 5;

// ─────────────────────────────────────────────
//  STORAGE
//  • planner_global           → todos (전역)
//  • planner_checklist_labels → 체크리스트 커스텀 항목 레이블 (전역, 날짜 무관)
//  • planner_YYYY-MM-DD       → memo + workout (날짜별)
// ─────────────────────────────────────────────
const GLOBAL_KEY = 'planner_global';
const CHECKLIST_LABELS_KEY = 'planner_checklist_labels';

// 체크리스트 레이블 전용 저장/불러오기
function saveChecklistLabels(labels) {
  localStorage.setItem(CHECKLIST_LABELS_KEY, JSON.stringify(labels || []));
}
function loadChecklistLabels() {
  try {
    const raw = localStorage.getItem(CHECKLIST_LABELS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  // 구버전 호환: planner_global에 customCheckLabels가 있으면 마이그레이션
  try {
    const raw = localStorage.getItem(GLOBAL_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p.customCheckLabels) && p.customCheckLabels.length > 0) {
        saveChecklistLabels(p.customCheckLabels);
        return p.customCheckLabels;
      }
    }
  } catch (e) {}
  return [];
}

// ===== FITNESS CONFIG =====
const MAX_SETS      = 5;
const DEFAULT_REPS  = 12;
const WEIGHT_STEP   = 2.5;   // 자동 증량 단위 (kg)
const MIN_REST_DAYS = 2;     // 같은 부위 최소 휴식일
const HISTORY_SEARCH_DAYS = 14; // 기록 검색 범위
const REST_DURATION = 120;   // 세트 간 휴식 시간 (초)

// ===== 휴식 타이머 — 백그라운드(화면 꺼짐) 대응 버전 =====
// 전략: setInterval 대신 시작 시각(Date.now())을 기준으로 남은 시간 계산
// 화면이 다시 켜질 때 visibilitychange 이벤트로 경과 시간을 재계산
// 사용자 설정 휴식 시간 — 모듈 레벨 변수로 유지 (DOM 의존 없음)
let _currentDuration = (() => {
  try {
    const saved = parseInt(localStorage.getItem('_timerDuration'));
    return (saved && saved > 0) ? saved : REST_DURATION;
  } catch(e) { return REST_DURATION; }
})();

function _getCustomDuration() { return _currentDuration; }
function _setCustomDuration(sec) {
  _currentDuration = sec;
  try { localStorage.setItem('_timerDuration', String(sec)); } catch(e) {}
}

let _timerInterval = null;
let _timerState    = 'idle';  // 'idle' | 'active' | 'alarm'
let _timerStartAt  = 0;       // Date.now() 기준 시작 시각
let _timerSeconds  = _currentDuration; // 현재 표시용 남은 초
let _audioCtx      = null;    // iOS: 유저 제스처 시점에 미리 unlock
let _countdownBeepedAt = new Set(); // 카운트다운 비프 중복 방지

// Screen Wake Lock — 타이머 실행 중 화면 꺼짐 방지 (iOS 16.4+ PWA 지원)
let _wakeLock = null;
async function _requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      _wakeLock = await navigator.wakeLock.request('screen');
      _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    }
  } catch(e) { _wakeLock = null; }
}
function _releaseWakeLock() {
  try { if (_wakeLock) { _wakeLock.release(); _wakeLock = null; } } catch(e) {}
}

// iOS Audio 정책: 유저 터치 시점에 AudioContext를 생성·resume해 두어야
// 나중에 타이머가 자동으로 알람을 울릴 수 있음
// ===== iOS 백그라운드 오디오 유지 (유튜브 뮤직 공존 & WebKit 절전모드 차단) =====
let _silentWebAudioNode = null;

// 1. 유저 터치 시 AudioContext 초기화 및 잠금 해제
function _unlockAudio() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    // iOS 오디오 정책 잠금 해제용 1샘플 버퍼
    const buf = _audioCtx.createBuffer(1, 1, 22050);
    const src = _audioCtx.createBufferSource();
    src.buffer = buf; src.connect(_audioCtx.destination); src.start(0);
  } catch(e) {}
}

// 2. 타이머 동작 중 iOS Web Audio 지속 신호 (30Hz, 0.003 gain)
// - HTML5 <audio>나 MediaSession을 사용하지 않으므로 유튜브 뮤직/애플 뮤직이 절대 멈추지 않음!
// - 0.003 gain(-50dB)은 사람이 들을 수 없지만 WebKit의 Silence Pruning(무음 감지 자동 절전)을 완벽 차단!
function _startBgAudioKeeper() {
  try {
    const ctx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    if (!_silentWebAudioNode) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.003; // 사람이 들을 수 없는 극소 볼륨 (WebKit 무음 절전모드 방지 임계값 이상)
      osc.frequency.value = 30; // 30Hz 초저역 주파수
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      _silentWebAudioNode = { osc, gain };
    }
  } catch(e) {}
}

function _stopBgAudioKeeper() {
  try {
    if (_silentWebAudioNode) {
      _silentWebAudioNode.osc.stop();
      _silentWebAudioNode.osc.disconnect();
      _silentWebAudioNode.gain.disconnect();
      _silentWebAudioNode = null;
    }
  } catch(e) {}
}

function _fmtTime(s) {
  const v = Math.max(0, Math.floor(s));
  return `${String(Math.floor(v / 60)).padStart(2,'0')}:${String(v % 60).padStart(2,'0')}`;
}

function _syncTimerDOM() {
  const card    = document.getElementById('restTimerCard');
  const display = document.getElementById('timerDisplay');
  const hint    = document.getElementById('timerHint');
  if (!card) return;
  card.className = 'rest-timer-card' + (_timerState === 'idle' ? '' : ` ${_timerState}`);
  if (display) display.textContent = _fmtTime(_timerSeconds);
  if (hint) hint.textContent =
    _timerState === 'idle'   ? '세트 체크 시 자동 시작' :
    _timerState === 'active' ? '휴식 중... 다음 세트를 준비하세요' :
                               '⏰ 휴식 완료! 화면을 터치해 끄기';
}

function _triggerAlarm() {
  _timerState = 'alarm';
  _timerSeconds = 0;
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  _releaseWakeLock(); // 알람 시 화면 잠금 해제 허용
  _syncTimerDOM();
  // 진동 5번 (각 400ms, 간격 200ms) — Android만 지원
  try {
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400, 200, 400, 200, 400]);
  } catch(e) {}
  // 비프음 5회 (1초 간격) — DynamicsCompressor로 3배 증폭 + 트리플 주파수 레이어
  try {
    const ctx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    // DynamicsCompressorNode를 디지털 앰프로 활용 (gain=1.0 한계를 돌파)
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(-50, ctx.currentTime);
    comp.knee.setValueAtTime(0, ctx.currentTime);
    comp.ratio.setValueAtTime(1, ctx.currentTime);
    comp.attack.setValueAtTime(0, ctx.currentTime);
    comp.release.setValueAtTime(0.01, ctx.currentTime);
    const masterGain = ctx.createGain();
    masterGain.gain.value = 3.0; // ★ 3배 증폭
    masterGain.connect(comp);
    comp.connect(ctx.destination);
    [0, 1, 2, 3, 4].forEach(i => {
      // 레이어 1: 880Hz 기본 톤 (square wave = 풍부한 배음)
      const osc1 = ctx.createOscillator();
      const g1   = ctx.createGain();
      osc1.connect(g1); g1.connect(masterGain);
      osc1.frequency.value = 880; osc1.type = 'square';
      g1.gain.setValueAtTime(0.7, ctx.currentTime + i);
      g1.gain.linearRampToValueAtTime(0, ctx.currentTime + i + 0.8);
      osc1.start(ctx.currentTime + i);
      osc1.stop(ctx.currentTime + i + 0.85);
      // 레이어 2: 1760Hz 하모닉 (고주파 명확성)
      const osc2 = ctx.createOscillator();
      const g2   = ctx.createGain();
      osc2.connect(g2); g2.connect(masterGain);
      osc2.frequency.value = 1760; osc2.type = 'sine';
      g2.gain.setValueAtTime(0.5, ctx.currentTime + i);
      g2.gain.linearRampToValueAtTime(0, ctx.currentTime + i + 0.6);
      osc2.start(ctx.currentTime + i);
      osc2.stop(ctx.currentTime + i + 0.65);
      // 레이어 3: 440Hz 서브톤 (두께감·임팩트)
      const osc3 = ctx.createOscillator();
      const g3   = ctx.createGain();
      osc3.connect(g3); g3.connect(masterGain);
      osc3.frequency.value = 440; osc3.type = 'sawtooth';
      g3.gain.setValueAtTime(0.4, ctx.currentTime + i);
      g3.gain.linearRampToValueAtTime(0, ctx.currentTime + i + 0.7);
      osc3.start(ctx.currentTime + i);
      osc3.stop(ctx.currentTime + i + 0.75);
    });
  } catch(e) {}
  // 잠금화면 알림 (권한 있을 때)
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification('⏰ 휴식 완료!', { body: '다음 세트를 시작하세요! 💪', icon: 'assets/icon-192.png' }); } catch(e){}
  }
  _stopBgAudioKeeper(); // 알람 울린 뒤 오디오 유지 발진기 종료
}

function startRestTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  // ★ iOS 핵심: 유저 터치 이벤트 안에서 AudioContext 미리 unlock
  _unlockAudio();
  // DOM 조회 없이 모듈 변수에서 직접 읽기 — 타이밍 문제 없음
  const dur = _currentDuration;
  _timerStartAt = Date.now();
  _timerState   = 'active';
  _timerSeconds = dur;
  _countdownBeepedAt.clear();
  // 시작 시각 + 이 세션의 duration을 localStorage에 저장 (화면 꺼짐 복원용)
  try {
    localStorage.setItem('_restStartAt', String(_timerStartAt));
    localStorage.setItem('_restDurSnapshot', String(dur));
  } catch(e) {}
  _syncTimerDOM();

  // 알림 권한 요청 (최초 1회)
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // 화면 꺼짐 방지 (Screen Wake Lock — iOS 16.4+ PWA 지원)
  _requestWakeLock();
  // 인스타그램/다른 앱 전환 시에도 타이머가 안 멈추도록 무음 오디오 루프 재생
  _startBgAudioKeeper();

  // 타이머 카드로 자동 스크롤
  const card = document.getElementById('restTimerCard');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // setInterval은 UI 갱신 및 카운트다운 비프 (경과 시간은 Date.now() 기준으로 계산)
  _timerInterval = setInterval(() => {
    const elapsed = (Date.now() - _timerStartAt) / 1000;
    _timerSeconds = Math.max(0, dur - elapsed);
    const remaining = Math.ceil(_timerSeconds);
    if (remaining <= 3 && remaining > 0 && !_countdownBeepedAt.has(remaining)) {
      _countdownBeepedAt.add(remaining);
      _playCountdownBeep();
    }
    if (_timerSeconds <= 0) {
      _triggerAlarm();
    } else {
      _syncTimerDOM();
    }
  }, 250);
}

function resetRestTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  _timerSeconds = _getCustomDuration();
  _timerState   = 'idle';
  _countdownBeepedAt.clear();
  _releaseWakeLock(); // 리셋 시 Wake Lock 해제
  _stopBgAudioKeeper(); // 리셋 시 백그라운드 오디오 루프 해제
  try { localStorage.removeItem('_restStartAt'); localStorage.removeItem('_restDurSnapshot'); } catch(e){}
  _syncTimerDOM();
}

// 카운트다운 비프 (3·2·1초 전) — DynamicsCompressor로 3배 증폭
function _playCountdownBeep() {
  try {
    const ctx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(-50, ctx.currentTime);
    comp.knee.setValueAtTime(0, ctx.currentTime);
    comp.ratio.setValueAtTime(1, ctx.currentTime);
    comp.attack.setValueAtTime(0, ctx.currentTime);
    comp.release.setValueAtTime(0.01, ctx.currentTime);
    const masterGain = ctx.createGain();
    masterGain.gain.value = 3.0; // ★ 3배 증폭
    masterGain.connect(comp);
    comp.connect(ctx.destination);
    // 듀얼 레이어: 1100Hz + 2200Hz
    const osc1 = ctx.createOscillator();
    const g1   = ctx.createGain();
    osc1.connect(g1); g1.connect(masterGain);
    osc1.frequency.value = 1100; osc1.type = 'square';
    g1.gain.setValueAtTime(0.6, ctx.currentTime);
    g1.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.35);
    const osc2 = ctx.createOscillator();
    const g2   = ctx.createGain();
    osc2.connect(g2); g2.connect(masterGain);
    osc2.frequency.value = 2200; osc2.type = 'sine';
    g2.gain.setValueAtTime(0.4, ctx.currentTime);
    g2.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
    osc2.start(ctx.currentTime);
    osc2.stop(ctx.currentTime + 0.3);
  } catch(e) {}
  try { if (navigator.vibrate) navigator.vibrate(120); } catch(e) {}
}

// 화면이 다시 켜질 때(visibilitychange) → 경과 시간 재계산 + Wake Lock 재요청
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (_timerState !== 'active') return;
  // Wake Lock은 화면 꺼지면 자동 해제되므로 다시 켜질 때 재요청
  if (!_wakeLock) _requestWakeLock();
  _startBgAudioKeeper();
  const dur = (() => {
    try { const s = parseInt(localStorage.getItem('_restDurSnapshot')); return (s > 0) ? s : _getCustomDuration(); } catch(e) { return _getCustomDuration(); }
  })();
  const elapsed = (Date.now() - _timerStartAt) / 1000;
  _timerSeconds = Math.max(0, dur - elapsed);
  if (_timerSeconds <= 0) {
    _triggerAlarm();
  } else {
    _syncTimerDOM();
  }
});

// 앱 재시작 시 localStorage에서 진행 중이던 타이머 복원
try {
  const saved = localStorage.getItem('_restStartAt');
  if (saved) {
    const dur     = (() => { try { const s = parseInt(localStorage.getItem('_restDurSnapshot')); return (s > 0) ? s : _getCustomDuration(); } catch(e) { return _getCustomDuration(); } })();
    const elapsed = (Date.now() - Number(saved)) / 1000;
    if (elapsed < dur) {
      _timerStartAt = Number(saved);
      _timerState   = 'active';
      _timerSeconds = Math.max(0, dur - elapsed);
      _countdownBeepedAt.clear();
      _timerInterval = setInterval(() => {
        const el  = (Date.now() - _timerStartAt) / 1000;
        _timerSeconds = Math.max(0, dur - el);
        const remaining = Math.ceil(_timerSeconds);
        if (remaining <= 3 && remaining > 0 && !_countdownBeepedAt.has(remaining)) {
          _countdownBeepedAt.add(remaining);
          _playCountdownBeep();
        }
        if (_timerSeconds <= 0) { _triggerAlarm(); } else { _syncTimerDOM(); }
      }, 250);
    } else {
      localStorage.removeItem('_restStartAt');
      localStorage.removeItem('_restDurSnapshot');
    }
  }
} catch(e) {}


// ===== 요일별 운동 안내 (표 기반) =====
const DAILY_GUIDE = {
  // 아침 공통
  morning: {
    title: '🌅 아침 맨몸운동',
    items: [
      '맨몸스쿼트 3~5세트 (세트 간 60~90초 휴식)',
      '너무 쉬우면 천천히 내려가기 + 아래서 1초 정지',
    ]
  },
  // 점심 공통
  lunch: {
    title: '☀️ 점심 활동',
    items: [
      '식사 후 10~15분 걷기 (혈당 상승 완화)',
      '60~90분마다 2~3분 일어나서 움직이기 (혈당·피로 관리)',
    ]
  },
  // 퇴근 후 — 요일별 (0=일,1=월,...,6=토)
  after: {
    1: { title: '월 — 상체 푸시', desc: '상체 푸시 기구운동 + 푸시업 2~3세트 마무리', purpose: '근성장' },
    2: { title: '화 — 회복', desc: '걷기 20~30분 + 스트레칭', purpose: '회복 및 혈당 관리' },
    3: { title: '수 — 하체', desc: '하체 기구운동 + 가벼운 유산소 10~15분', purpose: '근성장 + 대사활동' },
    4: { title: '목 — 회복', desc: '스트레칭 + 가벼운 걷기', purpose: '회복' },
    5: { title: '금 — 상체 풀', desc: '상체 풀 기구운동 + 푸시업 2세트 마무리', purpose: '근성장' },
    6: { title: '토 — BJJ / 유산소', desc: 'BJJ 또는 가벼운 유산소 / 피로 시 휴식', purpose: '컨디션 조절' },
    0: { title: '일 — 완전 휴식', desc: '완전 휴식 또는 산책', purpose: '회복' },
  }
};

// ===== 운동 정의 =====
// ─ 근비대 3대 운동(스쿼트·데드리프트·벤치프레스) 중심 설계 ─
// 매일 하는 맨몸운동 (항상 표시)
const DAILY_EXERCISES_GROUP = {
  id: 'daily', name: '매일 맨몸운동', icon: '🌅', color: '#4ade80',
  alwaysShow: true,
  exercises: [
    { id: 'bw_squat',  name: '맨몸 스쿼트',  defaultWeight: 0, defaultSets: 5 },
    { id: 'push_up',   name: '푸시업 (맨몸)', defaultWeight: 0, defaultSets: 3 },
  ]
};

// 요일별 기구 운동 그룹 (0=일,1=월,...,6=토)
// ┌ 월: 벤치프레스 중심 — 가슴·삼두
// ├ 화: 회복
// ├ 수: 스쿼트·데드리프트 중심 — 하체·전신
// ├ 목: 회복
// ├ 금: 데드리프트 변형·등 — 상체 풀
// ├ 토: 보조 운동 or 유산소
// └ 일: 완전 휴식
const DOW_WORKOUT_PLAN = {
  1: [ // 월 — 가슴 / 삼두 (벤치프레스 중심)
    {
      id: 'chest_push', name: '가슴 · 삼두', icon: '🏋️', color: '#6c8eff',
      exercises: [
        { id: 'bench_press',      name: '바벨 벤치프레스',       defaultWeight: 60 },
        { id: 'incline_bench',    name: '인클라인 벤치프레스',    defaultWeight: 50 },
        { id: 'pec_fly',          name: '펙덱 플라이',            defaultWeight: 20 },
        { id: 'tricep_pushdown',  name: '트라이셉 푸시다운',      defaultWeight: 15 },
        { id: 'overhead_press',   name: '오버헤드 프레스 (숄더)', defaultWeight: 40 },
      ]
    }
  ],
  2: [], // 화 — 회복
  3: [ // 수 — 하체 (스쿼트 · 데드리프트 중심)
    {
      id: 'legs_big', name: '하체 · 전신', icon: '🦵', color: '#4ade80',
      exercises: [
        { id: 'barbell_squat',  name: '바벨 스쿼트',      defaultWeight: 80  },
        { id: 'romanian_dl',    name: '루마니안 데드리프트', defaultWeight: 80  },
        { id: 'leg_press',      name: '레그프레스',        defaultWeight: 100 },
        { id: 'leg_curl',       name: '레그 컬',           defaultWeight: 30  },
        { id: 'leg_ext',        name: '레그 익스텐션',     defaultWeight: 30  },
      ]
    }
  ],
  4: [], // 목 — 회복
  5: [ // 금 — 등 / 이두 (데드리프트 · 풀 중심)
    {
      id: 'back_pull', name: '등 · 이두', icon: '🦾', color: '#c084fc',
      exercises: [
        { id: 'deadlift',       name: '바벨 데드리프트',   defaultWeight: 100 },
        { id: 'barbell_row',    name: '바벨 벤트오버 로우', defaultWeight: 60  },
        { id: 'lat_pulldown',   name: '랫 풀다운',         defaultWeight: 50  },
        { id: 'seated_row',     name: '시티드 케이블 로우', defaultWeight: 40  },
        { id: 'barbell_curl',   name: '바벨 컬',           defaultWeight: 30  },
      ]
    }
  ],
  6: [ // 토 — 보조 운동 (어깨 · 팔 · 코어)
    {
      id: 'aux_sat', name: '어깨 · 팔 · 코어', icon: '💪', color: '#fb923c',
      exercises: [
        { id: 'shoulder_press_db', name: '덤벨 숄더프레스',  defaultWeight: 12 },
        { id: 'lateral_raise',     name: '레터럴 레이즈',    defaultWeight: 8  },
        { id: 'hammer_curl',       name: '해머 컬',          defaultWeight: 10 },
        { id: 'face_pull',         name: '페이스 풀',        defaultWeight: 15 },
        { id: 'plank',             name: '플랭크 (초)',       defaultWeight: 0  },
      ]
    }
  ],
  0: [], // 일 — 완전 휴식
};

// 모든 가능한 운동 목록 (저장용)
const EXERCISE_GROUPS = [
  DAILY_EXERCISES_GROUP,
  ...Object.values(DOW_WORKOUT_PLAN).flat()
];

// 중복 제거된 모든 운동 목록
function getAllExercises() {
  const seen = new Set();
  return EXERCISE_GROUPS.flatMap(g => g.exercises).filter(ex => {
    if (seen.has(ex.id)) return false;
    seen.add(ex.id); return true;
  });
}

// 오늘 요일에 표시할 그룹 목록 (매일 그룹 + 요일별 그룹)
function getTodayGroups(dow) {
  const dayGroups = DOW_WORKOUT_PLAN[dow] || [];
  return [DAILY_EXERCISES_GROUP, ...dayGroups];
}

function defaultWorkout() {
  return {
    meds     : { bp: false, glucose: false, supp1: false, supp2: false },
    exercises: getAllExercises().map(ex => ({
      id: ex.id, weight: '', setChecks: new Array(MAX_SETS).fill(false), repsPerSet: ''
    }))
  };
}

function defaultTodos() {
  return Array.from({ length: NUM_TODO_DEFAULT }, () => ({ text: '', status: null }));
}

// ===== STATE =====
let currentDate = new Date();
currentDate.setHours(0, 0, 0, 0);

// ===== UTILS =====
function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `planner_${y}-${m}-${d}`;
}

function hasDayRecord(date) {
  return localStorage.getItem(dateKey(date)) !== null;
}

// ===== STORAGE =====
function loadGlobalData() {
  const raw = localStorage.getItem(GLOBAL_KEY);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && p.todos) return {
        todos: p.todos,
        customCheckLabels: Array.isArray(p.customCheckLabels) ? p.customCheckLabels : []
      };
    } catch (e) {}
  }
  return { todos: defaultTodos(), customCheckLabels: [] };
}

function saveGlobalData(global) {
  // customCheckLabels는 항상 최신 전역 데이터에서 가져와 병합
  const existing = loadGlobalData();
  const merged = Object.assign({}, existing, global);
  localStorage.setItem(GLOBAL_KEY, JSON.stringify(merged));
}

// 전역 레이블 목록만 업데이트 (체크 상태 영향 없음) — 전용 키에 저장
function saveGlobalCheckLabels(labels) {
  saveChecklistLabels(labels);
}

function loadDayRecord(date) {
  const raw = localStorage.getItem(dateKey(date));
  if (raw) {
    try {
      const p = JSON.parse(raw);
      const workout = p.workout || defaultWorkout();
      // 날짜 기록에 customChecks가 없으면 전역 레이블로 채움 (체크 상태 false)
      if (!workout.customChecks || workout.customChecks.length === 0) {
        workout.customChecks = loadChecklistLabels().map(label => ({ label, checked: false }));
      } else {
        // 전역 레이블과 동기화: 전역에 있지만 날짜 기록에 없는 항목 추가
        const globalLabels = loadChecklistLabels();
        const existingLabels = workout.customChecks.map(c => c.label);
        globalLabels.forEach(label => {
          if (!existingLabels.includes(label)) {
            workout.customChecks.push({ label, checked: false });
          }
        });
      }
      return {
        timetable: p.timetable || {},
        memo   : typeof p.memo === 'string' ? p.memo : '',
        workout
      };
    } catch (e) {}
  }
  // 새 날짜: 전용 키에서 레이블 불러와 customChecks 초기화
  const workout = defaultWorkout();
  workout.customChecks = loadChecklistLabels().map(label => ({ label, checked: false }));
  return { timetable: {}, memo: '', workout };
}

function saveDayRecord(date, timetable, memo, workout) {
  const k = dateKey(date);
  let existing = {};
  try { existing = JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) {}
  existing.timetable = timetable;
  existing.memo    = memo;
  existing.workout = workout;
  localStorage.setItem(k, JSON.stringify(existing));
}

// ===== 과거 기록 검색 (효율적 캐시) =====
function buildRecentHistory() {
  const history = {};  // exerciseId → { weight, setChecks, repsPerSet, daysAgo }
  const allIds = new Set(getAllExercises().map(e => e.id));

  for (let i = 1; i <= HISTORY_SEARCH_DAYS; i++) {
    const d = new Date(currentDate);
    d.setDate(d.getDate() - i);
    const rec = loadDayRecord(d);
    if (!rec.workout || !rec.workout.exercises) continue;

    rec.workout.exercises.forEach(ex => {
      if (!history[ex.id] && allIds.has(ex.id) && ex.setChecks && ex.setChecks.some(Boolean)) {
        history[ex.id] = { ...ex, daysAgo: i };
      }
    });

    if (Object.keys(history).length >= allIds.size) break;
  }
  return history;
}

// 그룹별 마지막 운동일 계산
function getGroupRestDays(history, forDate) {
  // forDate가 없으면 currentDate 사용, 로컬 요일 기준
  const d = forDate || currentDate;
  // Use local date to get day-of-week correctly (avoids UTC offset issues)
  const localDateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayDow = new Date(localDateStr + 'T12:00:00').getDay(); // noon avoids DST issues
  return EXERCISE_GROUPS.map(group => {
    let minDaysAgo = Infinity;
    group.exercises.forEach(ex => {
      const h = history[ex.id];
      if (h && h.daysAgo < minDaysAgo) minDaysAgo = h.daysAgo;
    });
    const isToday = Array.isArray(group.days) && group.days.includes(todayDow);
    return {
      ...group,
      lastDaysAgo : minDaysAgo === Infinity ? null : minDaysAgo,
      recommended : isToday,
      isToday,
      todayDow,
      restLabel   : minDaysAgo === Infinity ? '기록 없음' :
                    minDaysAgo === 1 ? '어제 운동' : `${minDaysAgo}일 전 운동`
    };
  });
}

// ===== 자동 워크아웃 플랜 생성 =====
function generateTodayPlan() {
  const workout = defaultWorkout();
  const history = buildRecentHistory();
  const allExercises = getAllExercises();

  allExercises.forEach((exCfg, idx) => {
    const last = history[exCfg.id];

    if (last) {
      const lastWeight = parseFloat(last.weight) || exCfg.defaultWeight;
      const lastReps   = parseInt(last.repsPerSet) || DEFAULT_REPS;
      const completed  = (last.setChecks || []).filter(Boolean).length;
      const total      = (last.setChecks || []).length || MAX_SETS;
      const ratio      = completed / total;

      let targetWeight, targetReps;

      if (ratio >= 0.8) {
        targetWeight = lastWeight + WEIGHT_STEP;
        targetReps   = lastReps;
      } else if (ratio >= 0.6) {
        targetWeight = lastWeight;
        targetReps   = Math.min(lastReps + 1, 15);
      } else if (ratio >= 0.4) {
        targetWeight = lastWeight;
        targetReps   = lastReps;
      } else {
        targetWeight = Math.max(lastWeight - WEIGHT_STEP, 0);
        targetReps   = lastReps;
      }

      workout.exercises[idx].weight     = String(targetWeight);
      workout.exercises[idx].repsPerSet = String(targetReps);
    } else {
      workout.exercises[idx].weight     = String(exCfg.defaultWeight);
      workout.exercises[idx].repsPerSet = String(DEFAULT_REPS);
    }
  });

  return workout;
}

// ===== SAVE (DEBOUNCED) =====
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const { todos, timetable, memo, workout } = collectData();
    // customChecks 레이블을 전용 키에 즉시 저장 (날짜 변경 후에도 항목 유지)
    const customCheckLabels = (workout.customChecks || []).map(c => c.label);
    saveChecklistLabels(customCheckLabels);
    const globalData = { todos };
    const dayData    = { timetable, memo, workout };
    const dStr       = dateKey(currentDate);

    saveGlobalData(globalData);
    saveDayRecord(currentDate, timetable, memo, workout);

    if (typeof PlannerSync !== 'undefined' && PlannerSync.isConnected()) {
      await PlannerSync.push(globalData, dStr, dayData);
    }
    showSaveToast();
  }, 5000);
}

function collectData() {
  const todos = [];
  document.querySelectorAll('.todo-item').forEach(el => {
    todos.push({
      text: el.querySelector('.todo-text').value,
      status: el.dataset.status || null
    });
  });
  const timetable = collectTimetableData();
  const memo    = document.getElementById('memoArea').value;
  const workout = collectWorkoutData();
  return { todos, timetable, memo, workout };
}

function collectTimetableData() {
  const tt = {};
  document.querySelectorAll('.diet-row').forEach(row => {
    const meal = row.dataset.meal;
    const checked = row.querySelector('.diet-cb').checked;
    const text = row.querySelector('.diet-input').value;
    if (checked || text) tt[meal] = { checked, text };
  });
  return tt;
}

function collectWorkoutData() {
  const meds = {
    bp     : document.getElementById('medBp')?.checked      || false,
    glucose: document.getElementById('medGlucose')?.checked  || false,
    supp1  : document.getElementById('medSupp1')?.checked    || false,
    supp2  : document.getElementById('medSupp2')?.checked    || false
  };

  // 커스텀 체크 항목 수집
  const customChecks = [];
  document.querySelectorAll('.custom-check').forEach(cb => {
    const idx = parseInt(cb.dataset.customIdx);
    const label = cb.closest('.med-item')?.querySelector('.med-label')?.textContent || '';
    customChecks.push({ label, checked: cb.checked });
  });

  const exercises = [];
  document.querySelectorAll('.workout-exercise').forEach(el => {
    const checks = [];
    el.querySelectorAll('.set-cb').forEach(cb => checks.push(cb.checked));
    exercises.push({
      id: el.dataset.exId,
      weight    : el.querySelector('.ex-weight-input')?.value || '',
      setChecks : checks,
      repsPerSet: el.querySelector('.ex-reps-input')?.value || ''
    });
  });
  return { meds, exercises, customChecks };
}

// ===== DATE UI =====
function formatDateDisplay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

function updateDateUI() {
  const dw = currentDate.getDay();
  document.getElementById('dateDisplay').textContent = formatDateDisplay(currentDate);
  const y = currentDate.getFullYear();
  const m = currentDate.getMonth() + 1;
  const d = currentDate.getDate();
  document.getElementById('pageDateFull').textContent = `${y}년 ${m}월 ${d}일 ${DAYS_KR[dw]}`;
  const pill = document.getElementById('pageDayPill');
  pill.textContent = DAYS_EN[dw];
  pill.className = 'page-day-pill' + (dw === 0 ? ' sun' : dw === 6 ? ' sat' : '');
}

// ===== TODO LIST =====
function renderTodos(globalData) {
  const container = document.getElementById('todoItems');
  container.innerHTML = '';
  globalData.todos.forEach((todo, i) => appendTodoItem(container, todo, i));
}

function appendTodoItem(container, todo, index) {
  const item = document.createElement('div');
  item.className = 'todo-item';
  item.dataset.status = todo.status || '';
  if (todo.status) item.classList.add(`status-${todo.status}`);

  const handle = document.createElement('div');
  handle.className = 'drag-handle';
  handle.title = '드래그하여 순서 변경';
  handle.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
    <circle cx="3" cy="3" r="1.5"/><circle cx="7" cy="3" r="1.5"/>
    <circle cx="3" cy="8" r="1.5"/><circle cx="7" cy="8" r="1.5"/>
    <circle cx="3" cy="13" r="1.5"/><circle cx="7" cy="13" r="1.5"/>
  </svg>`;
  handle.addEventListener('mousedown', e => startDrag(e, item));

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.className = 'todo-text';
  textInput.value = todo.text || '';
  textInput.placeholder = `할 일 ${index + 1}`;
  textInput.addEventListener('input', scheduleSave);

  const statusBtns = document.createElement('div');
  statusBtns.className = 'todo-status-btns';
  const statuses = [
    { key:'ok',     cls:'ok-btn',     icon:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' },
    { key:'delay',  cls:'delay-btn',  icon:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>' },
    { key:'cancel', cls:'cancel-btn', icon:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' }
  ];
  statuses.forEach(({ key, cls, icon }) => {
    const btn = document.createElement('button');
    btn.className = `status-btn ${cls}`;
    btn.innerHTML = icon;
    btn.title = key.charAt(0).toUpperCase() + key.slice(1);
    if (todo.status === key) btn.classList.add('active');
    btn.addEventListener('click', () => {
      const s = item.dataset.status === key ? '' : key;
      item.dataset.status = s;
      item.className = 'todo-item' + (s ? ` status-${s}` : '');
      statusBtns.querySelectorAll('.status-btn').forEach(b => b.classList.remove('active'));
      if (s) btn.classList.add('active');
      scheduleSave();
    });
    statusBtns.appendChild(btn);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'todo-delete';
  deleteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  deleteBtn.title = '삭제';
  deleteBtn.addEventListener('click', () => { item.remove(); scheduleSave(); });

  item.append(handle, textInput, statusBtns, deleteBtn);
  container.appendChild(item);
}

// ===== DRAG AND DROP =====
function startDrag(e, item) {
  e.preventDefault();
  const container = document.getElementById('todoItems');
  const rect = item.getBoundingClientRect();
  const ghost = item.cloneNode(true);
  ghost.id = 'drag-ghost';
  Object.assign(ghost.style, {
    position:'fixed', left:rect.left+'px', top:rect.top+'px',
    width:rect.width+'px', height:rect.height+'px', margin:'0', opacity:'0.92',
    pointerEvents:'none', zIndex:'9999', borderRadius:'8px',
    background:'var(--bg-elevated)',
    boxShadow:'0 8px 32px rgba(0,0,0,0.6), 0 0 0 1.5px var(--accent)',
    transform:'scale(1.015)',
  });
  document.body.appendChild(ghost);
  item.classList.add('dragging');
  dragState = { item, ghost, offsetY: e.clientY-rect.top, targetIndex: [...container.querySelectorAll('.todo-item')].indexOf(item), container };
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}
function onDragMove(e) {
  if (!dragState) return;
  dragState.ghost.style.top = (e.clientY-dragState.offsetY)+'px';
  const others = [...dragState.container.querySelectorAll('.todo-item:not(.dragging)')];
  let t = others.length;
  for (let i=0;i<others.length;i++) { const r=others[i].getBoundingClientRect(); if(e.clientY<r.top+r.height/2){t=i;break;} }
  dragState.targetIndex = t;
  let line = dragState.container.querySelector('.drop-indicator');
  if (!line) { line=document.createElement('div'); line.className='drop-indicator'; }
  t>=others.length ? dragState.container.appendChild(line) : dragState.container.insertBefore(line, others[t]);
}
function onDragEnd() {
  if (!dragState) return;
  const {ghost,item,targetIndex,container}=dragState;
  ghost.remove();
  const line=container.querySelector('.drop-indicator'); if(line)line.remove();
  item.classList.remove('dragging');
  const others=[...container.querySelectorAll('.todo-item')];
  if(targetIndex>=others.length){container.appendChild(item);}
  else{const tgt=others.find((el,i)=>el!==item&&i>=targetIndex);tgt?container.insertBefore(item,tgt):container.appendChild(item);}
  document.removeEventListener('mousemove',onDragMove);
  document.removeEventListener('mouseup',onDragEnd);
  dragState=null; scheduleSave();
}

document.getElementById('addTodoBtn').addEventListener('click', () => {
  const c = document.getElementById('todoItems');
  appendTodoItem(c, {text:'',status:null}, c.querySelectorAll('.todo-item').length);
  c.querySelectorAll('.todo-text').forEach((el,i,a)=>{if(i===a.length-1)el.focus();});
  scheduleSave();
});

// ===== MEMO =====
function renderMemo(memo) { document.getElementById('memoArea').value = memo; }
document.getElementById('memoArea').addEventListener('input', scheduleSave);

// ===== DIET =====
const DIET_MEALS = ['아침', '점심', '저녁', '회식', '간식'];

function renderTimetable(timetable) {
  const container = document.getElementById('timetableBody');
  if (!container) return;
  container.innerHTML = '';
  DIET_MEALS.forEach((meal) => {
    const val = timetable[meal] || { checked: false, text: '' };
    // 구버전(문자열만 있던 시절) 호환성 처리
    const checked = typeof val === 'object' ? val.checked : false;
    const text = typeof val === 'object' ? val.text : val;

    const row = document.createElement('div');
    row.className = 'diet-row';
    row.dataset.meal = meal;
    row.innerHTML = `
      <label class="diet-cb-label">
        <input type="checkbox" class="diet-cb" ${checked ? 'checked' : ''}>
        <span class="diet-name">${meal}</span>
      </label>
      <input type="text" class="diet-input" value="${text}" placeholder="식단 내용 입력...">
    `;
    row.querySelector('.diet-input').addEventListener('input', scheduleSave);
    row.querySelector('.diet-cb').addEventListener('change', scheduleSave);
    container.appendChild(row);
  });
}

// ===== RENDER WORKOUT =====
function renderWorkout(workoutData) {
  const body = document.getElementById('workoutBody');
  body.innerHTML = '';

  const w = workoutData || defaultWorkout();
  const meds = w.meds || { bp: false, glucose: false, supp1: false, supp2: false };
  const customChecks = w.customChecks || [];
  const history = buildRecentHistory();
  const groupInfo = getGroupRestDays(history, currentDate);

  // ── 체크 리스트 (3열 체크박스 + 커스텀 항목 추가) ──
  const medsCard = document.createElement('div');
  medsCard.className = 'health-card';
  let customItemsHtml = customChecks.map((item, idx) => `
      <label class="med-item">
        <input type="checkbox" class="med-cb custom-check" data-custom-idx="${idx}" ${item.checked ? 'checked' : ''}>
        <span class="med-label">${item.label}</span>
        <button class="meds-del-btn custom" data-del-idx="${idx}" title="삭제">✕</button>
      </label>`).join('');
  medsCard.innerHTML = `
    <div class="health-title">✅ 체크 리스트</div>
    <div class="meds-grid" id="medsGrid">
      <label class="med-item">
        <input type="checkbox" class="med-cb" id="medBp" ${meds.bp ? 'checked' : ''}>
        <span class="med-label">혈압</span>
      </label>
      <label class="med-item">
        <input type="checkbox" class="med-cb" id="medGlucose" ${meds.glucose ? 'checked' : ''}>
        <span class="med-label">혈당</span>
      </label>
      ${customItemsHtml}
      <div class="meds-add-btn" id="addCheckItemBtn" title="항목 추가">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        +추가
      </div>
    </div>`;
  medsCard.querySelectorAll('.med-cb').forEach(cb =>
    cb.addEventListener('change', scheduleSave)
  );
  // '+추가' 버튼 이벤트
  medsCard.querySelector('#addCheckItemBtn').addEventListener('click', () => {
    const label = prompt('체크 항목 이름을 입력하세요:');
    if (label && label.trim()) {
      const trimmedLabel = label.trim();
      // 전역 레이블 목록에 추가 (날짜가 바뀌어도 항목 유지)
      const global = loadGlobalData();
      if (!global.customCheckLabels) global.customCheckLabels = [];
      if (!global.customCheckLabels.includes(trimmedLabel)) {
        global.customCheckLabels.push(trimmedLabel);
        saveGlobalCheckLabels(global.customCheckLabels);
      }
      // 현재 날짜 기록에도 추가
      const dKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth()+1).padStart(2,'0')}-${String(currentDate.getDate()).padStart(2,'0')}`;
      const dayData = JSON.parse(localStorage.getItem('planner_' + dKey) || '{}');
      const workout = dayData.workout || defaultWorkout();
      if (!workout.customChecks) workout.customChecks = [];
      workout.customChecks.push({ label: trimmedLabel, checked: false });
      dayData.workout = workout;
      localStorage.setItem('planner_' + dKey, JSON.stringify(dayData));
      renderWorkout(workout);
    }
  });
  // 삭제 버튼 이벤트
  medsCard.querySelectorAll('.meds-del-btn.custom').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = parseInt(btn.dataset.delIdx);
      const dKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth()+1).padStart(2,'0')}-${String(currentDate.getDate()).padStart(2,'0')}`;
      const dayData = JSON.parse(localStorage.getItem('planner_' + dKey) || '{}');
      const workout = dayData.workout || defaultWorkout();
      if (workout.customChecks && workout.customChecks.length > idx) {
        const removedLabel = workout.customChecks[idx].label;
        workout.customChecks.splice(idx, 1);
        dayData.workout = workout;
        localStorage.setItem('planner_' + dKey, JSON.stringify(dayData));
        // 전역 레이블 목록에서도 삭제 (다음 날부터도 표시 안 됨)
        const global = loadGlobalData();
        global.customCheckLabels = (global.customCheckLabels || []).filter(l => l !== removedLabel);
        saveGlobalCheckLabels(global.customCheckLabels);
        renderWorkout(workout);
      }
    });
  });
  body.appendChild(medsCard);

  // ── 휴식 타이머 카드 ──
  const dur0 = _getCustomDuration();
  const timerCard = document.createElement('div');
  timerCard.id = 'restTimerCard';
  timerCard.className = 'rest-timer-card' + (_timerState === 'idle' ? '' : ` ${_timerState}`);
  timerCard.innerHTML = `
    <div class="timer-icon">⏱️</div>
    <div class="timer-info">
      <div class="timer-label">세트 간 휴식 타이머</div>
      <div class="timer-display" id="timerDisplay">${_fmtTime(_timerSeconds)}</div>
      <div class="timer-hint" id="timerHint">${
        _timerState === 'idle'   ? '세트 체크 시 자동 시작' :
        _timerState === 'active' ? '휴식 중... 다음 세트를 준비하세요' :
                                   '⏰ 휴식 완료! 화면을 터치해 끄기'
      }</div>
      <div class="timer-set-row">
        <label class="timer-set-label">휴식 시간</label>
        <div class="timer-set-inputs">
          <input class="timer-dur-input" id="timerDurSec" type="number"
                 min="10" max="600" value="${dur0}" inputmode="numeric" placeholder="120">
          <span class="timer-dur-sep">초</span>
        </div>
      </div>
    </div>
    <button class="timer-btn" id="timerResetBtn" title="리셋">↺</button>`;

  // 초 입력 시 모듈 변수 즉시 반영 (커스텀 저장 + idle 표시 갱신)
  function _onDurChange() {
    const v = Math.max(10, parseInt(timerCard.querySelector('#timerDurSec').value) || REST_DURATION);
    _setCustomDuration(v);           // ← _currentDuration + localStorage 동시 업데이트
    if (_timerState === 'idle') { _timerSeconds = v; _syncTimerDOM(); }
  }
  timerCard.querySelector('#timerDurSec').addEventListener('input',  _onDurChange);
  timerCard.querySelector('#timerDurSec').addEventListener('change', _onDurChange);

  timerCard.addEventListener('click', () => {
    if (_timerState === 'alarm') resetRestTimer();
  });
  timerCard.querySelector('#timerResetBtn').addEventListener('click', (e) => {
    e.stopPropagation(); resetRestTimer();
  });
  body.appendChild(timerCard);


  // ── 운동 그룹별 렌더링 (오늘 요일에 해당하는 그룹만) ──
  const localStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth()+1).padStart(2,'0')}-${String(currentDate.getDate()).padStart(2,'0')}`;
  const dow = new Date(localStr + 'T12:00:00').getDay();
  const todayGroups = getTodayGroups(dow);

  todayGroups.forEach(group => {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'exercise-group';
    groupDiv.dataset.groupId = group.id;

    // 그룹 헤더
    const groupHeader = document.createElement('div');
    groupHeader.className = 'group-header';
    groupHeader.style.setProperty('--group-color', group.color);
    const badge = group.alwaysShow
      ? `<span class="group-rest-badge daily">매일</span>`
      : `<span class="group-rest-badge today">오늘</span>`;
    groupHeader.innerHTML = `
      <span class="group-icon">${group.icon}</span>
      <span class="group-name">${group.name}</span>
      ${badge}
      <span class="group-progress" data-group-progress></span>`;
    groupDiv.appendChild(groupHeader);

    // 각 운동 행
    group.exercises.forEach(exCfg => {
      const saved  = (w.exercises || []).find(e => e.id === exCfg.id) || {};
      const checks = saved.setChecks || new Array(MAX_SETS).fill(false);
      const weight = saved.weight || '';
      const reps   = saved.repsPerSet || '';
      const last   = history[exCfg.id] || null;

      const row = document.createElement('div');
      row.className = 'workout-exercise';
      row.dataset.exId = exCfg.id;

      // 이전 기록 라인
      let lastRecordHtml = '';
      let progressIcon = '';
      if (last) {
        const lw = parseFloat(last.weight) || 0;
        const lr = parseInt(last.repsPerSet) || 0;
        const lc = (last.setChecks || []).filter(Boolean).length;
        const lt = (last.setChecks || []).length || MAX_SETS;
        const cw = parseFloat(weight) || 0;

        if (cw > lw)      progressIcon = '<span class="progress-icon up">▲</span>';
        else if (cw < lw) progressIcon = '<span class="progress-icon down">▼</span>';
        else              progressIcon = '<span class="progress-icon same">→</span>';

        lastRecordHtml = `<div class="ex-last-record">
          지난: ${lw}kg × ${lr}회 × ${lc}/${lt}세트 (${last.daysAgo}일 전)
          ${progressIcon}
        </div>`;
      }

      // ── 운동 이름 + 체크박스 (같은 줄) ──
      const header = document.createElement('div');
      header.className = 'ex-header';

      // 상단 행: 이름 (좌) + 체크박스 (우)
      const nameChecksRow = document.createElement('div');
      nameChecksRow.className = 'ex-name-checks';

      const nameBlock = document.createElement('div');
      nameBlock.className = 'ex-name-block';
      nameBlock.innerHTML = `
        <span class="ex-name">${exCfg.name}</span>
        ${lastRecordHtml}`;

      // 체크박스 행 (5세트) — 클릭 시 타이머 자동 시작
      const cbRow = document.createElement('div');
      cbRow.className = 'ex-sets-row';
      for (let i = 0; i < MAX_SETS; i++) {
        const cbLabel = document.createElement('label');
        cbLabel.className = 'set-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.className = 'set-cb'; cb.checked = checks[i] || false;
        cb.addEventListener('change', () => {
          if (cb.checked) startRestTimer();
          recalcTotal(row); recalcGroupProgress(groupDiv); updateWorkoutSummary(); scheduleSave();
        });
        const num = document.createElement('span');
        num.className = 'set-num';
        num.textContent = `S${i+1}`;
        cbLabel.append(cb, num);
        cbRow.appendChild(cbLabel);
      }

      nameChecksRow.append(nameBlock, cbRow);

      // 하단 행: 무게 × 횟수 입력
      const inputsRow = document.createElement('div');
      inputsRow.className = 'ex-inputs-row';
      inputsRow.innerHTML = `
        <div class="ex-weight-group">
          <input class="ex-weight-input" type="number" min="0" max="500" step="2.5"
                 placeholder="${exCfg.defaultWeight}" value="${weight}"
                 autocomplete="off" inputmode="decimal">
          <span class="ex-weight-unit">kg</span>
        </div>
        <span class="ex-sep">×</span>
        <div class="ex-reps-group">
          <input class="ex-reps-input" type="number" min="0" max="999"
                 placeholder="${DEFAULT_REPS}" value="${reps}"
                 autocomplete="off" inputmode="numeric">
          <span class="ex-reps-label">회</span>
        </div>
        <div class="ex-total" data-total>—</div>`;

      header.append(nameChecksRow, inputsRow);
      row.appendChild(header);

      row.querySelector('.ex-weight-input').addEventListener('input', () => { recalcTotal(row); scheduleSave(); });
      row.querySelector('.ex-reps-input').addEventListener('input', () => { recalcTotal(row); scheduleSave(); });

      groupDiv.appendChild(row);
      recalcTotal(row);
    });

    body.appendChild(groupDiv);
    recalcGroupProgress(groupDiv);
  });

  // ── 요약 바 ──
  const summary = document.createElement('div');
  summary.className = 'workout-summary';
  summary.id = 'workoutSummary';
  summary.innerHTML = `
    <div class="workout-summary-label">오늘 운동</div>
    <div class="workout-summary-pills" id="workoutPills"></div>`;
  body.appendChild(summary);
  updateWorkoutSummary();
}

function recalcTotal(row) {
  const checked = row.querySelectorAll('.set-cb:checked').length;
  const reps    = parseInt(row.querySelector('.ex-reps-input')?.value) || 0;
  const weight  = parseFloat(row.querySelector('.ex-weight-input')?.value) || 0;
  const totalReps = checked * reps;
  const volume    = totalReps * weight;
  const totalEl   = row.querySelector('[data-total]');
  if (totalEl) {
    if (volume > 0)          totalEl.textContent = `${Math.round(volume)}kg`;
    else if (totalReps > 0)  totalEl.textContent = `${totalReps}회`;
    else                     totalEl.textContent = '—';
    totalEl.classList.toggle('has-value', totalReps > 0);
  }
}

function recalcGroupProgress(groupDiv) {
  const rows = groupDiv.querySelectorAll('.workout-exercise');
  let totalSets = 0, doneSets = 0, totalVolume = 0;
  rows.forEach(row => {
    const cbs = row.querySelectorAll('.set-cb');
    const done = row.querySelectorAll('.set-cb:checked').length;
    totalSets += cbs.length;
    doneSets  += done;
    const r = parseInt(row.querySelector('.ex-reps-input')?.value) || 0;
    const w = parseFloat(row.querySelector('.ex-weight-input')?.value) || 0;
    totalVolume += done * r * w;
  });
  const el = groupDiv.querySelector('[data-group-progress]');
  if (el) {
    const volStr = totalVolume > 0 ? ` · ${Math.round(totalVolume)}kg` : '';
    el.textContent = totalSets > 0 ? `${doneSets}/${totalSets}${volStr}` : '';
    el.className = 'group-progress' +
      (doneSets === totalSets && totalSets > 0 ? ' complete' :
       doneSets > 0 ? ' partial' : '');
  }
}

function updateWorkoutSummary() {
  const pills = document.getElementById('workoutPills');
  if (!pills) return;
  pills.innerHTML = '';
  const bjjDone   = !!document.querySelector('.workout-bjj.done');
  const allCb     = document.querySelectorAll('.workout-exercise .set-cb');
  const doneCb    = document.querySelectorAll('.workout-exercise .set-cb:checked');
  [
    { label: '주짓수', pct: bjjDone ? 1 : 0 },
    { label: `세트 ${doneCb.length}/${allCb.length}`, pct: allCb.length > 0 ? doneCb.length / allCb.length : 0 }
  ].forEach(item => {
    const pill = document.createElement('span');
    pill.className = 'summary-pill ' + (item.pct >= 1 ? 'complete' : item.pct > 0 ? 'partial' : 'none');
    pill.textContent = item.label;
    pills.appendChild(pill);
  });
}

// ===== LOAD DAY =====
function loadDay(date) {
  // 이전 타이머 강제 실행 (페이지 이동 시)
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const { todos, timetable, memo, workout } = collectData();
    const customCheckLabels = (workout.customChecks || []).map(c => c.label);
    saveGlobalData({ todos, customCheckLabels });
    saveDayRecord(currentDate, timetable, memo, workout);
    if (typeof PlannerSync !== 'undefined' && PlannerSync.isConnected()) {
      PlannerSync.push({ todos, customCheckLabels }, dateKey(currentDate), { timetable, memo, workout });
    }
  }

  currentDate = new Date(date);
  currentDate.setHours(0, 0, 0, 0);

  const globalData = loadGlobalData();
  let dayRecord    = loadDayRecord(currentDate);

  updateDateUI();
  renderTodos(globalData);
  renderTimetable(dayRecord.timetable || {});
  renderMemo(dayRecord.memo);
  renderWorkout(dayRecord.workout);

  if (typeof PlannerSync !== 'undefined' && PlannerSync.isConnected()) {
    PlannerSync.pull().then(remote => {
      if (remote) applyRemoteData(remote, false);
    });
  }
}

// ===== CLOUD SYNC =====
function applyRemoteData(remote, applyGlobal = true) {
  if (saveTimer || !remote) return;
  if (applyGlobal && remote.global) saveGlobalData(remote.global);
  const dStr = dateKey(currentDate);
  if (remote.days && remote.days[dStr]) {
    const rd = remote.days[dStr];
    saveDayRecord(currentDate, rd.timetable || {}, rd.memo || '', rd.workout || defaultWorkout());
  }
  const g = loadGlobalData();
  const d = loadDayRecord(currentDate);
  if (applyGlobal) renderTodos(g);
  renderTimetable(d.timetable || {});
  renderMemo(d.memo);
  renderWorkout(d.workout);
}

async function initSyncIfConfigured() {
  if (typeof PlannerSync === 'undefined') return;
  const cfg = PlannerSync.loadCfg();
  const id  = PlannerSync.loadId();
  if (!cfg || !id) return;
  const idInput = document.getElementById('syncIdInput');
  if (idInput) idInput.value = id;
  const cfgInput = document.getElementById('firebaseConfigInput');
  if (cfgInput) cfgInput.value = JSON.stringify(cfg, null, 2);
  const ok = await PlannerSync.connect(cfg, id, data => applyRemoteData(data, true));
  if (ok) {
    updateSyncModalStatus(true);
    const remote = await PlannerSync.pull();
    if (remote) applyRemoteData(remote, true);
  }
}

function updateSyncModalStatus(connected) {
  const dot = document.getElementById('syncModalDot');
  const text = document.getElementById('syncModalStatusText');
  if (!dot || !text) return;
  dot.className = 'sync-modal-dot ' + (connected ? 'connected' : 'off');
  text.textContent = connected ? '☁️ 실시간 동기화 중' : '연결 안 됨';
}

// ===== SAVE TOAST =====
let toastTimer = null;
function showSaveToast() {
  const toast = document.getElementById('saveToast');
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

// ===== NAVIGATION =====
document.getElementById('prevDay').addEventListener('click', () => {
  const d = new Date(currentDate); d.setDate(d.getDate()-1); loadDay(d);
});
document.getElementById('nextDay').addEventListener('click', () => {
  const d = new Date(currentDate); d.setDate(d.getDate()+1); loadDay(d);
});
document.getElementById('todayBtn').addEventListener('click', () => loadDay(new Date()));
document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key==='ArrowLeft')  { e.preventDefault(); document.getElementById('prevDay').click(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='ArrowRight') { e.preventDefault(); document.getElementById('nextDay').click(); }
});

// ===== INIT =====
loadDay(new Date());
initSyncIfConfigured();

// ===== SYNC MODAL =====
(function () {
  const modal=document.getElementById('syncModal'),overlay=document.getElementById('syncOverlay');
  const openBtn=document.getElementById('syncSettingsBtn'),closeBtn=document.getElementById('syncModalClose');
  function open(){modal.classList.add('open');overlay.classList.add('open');
    const i=document.getElementById('syncIdInput');if(i&&!i.value)i.value=PlannerSync.genId();}
  function close(){modal.classList.remove('open');overlay.classList.remove('open');}
  if(openBtn)openBtn.addEventListener('click',open);
  if(closeBtn)closeBtn.addEventListener('click',close);
  if(overlay)overlay.addEventListener('click',close);

  document.querySelectorAll('.sync-tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.sync-tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.sync-tab-content').forEach(c=>c.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab==='setup'?'tabContentSetup':'tabContentGuide')?.classList.remove('hidden');
    });
  });

  document.getElementById('syncIdCopy')?.addEventListener('click',()=>{
    const v=document.getElementById('syncIdInput')?.value;
    if(v)navigator.clipboard.writeText(v).then(()=>{
      const b=document.getElementById('syncIdCopy');const o=b.textContent;b.textContent='✅';setTimeout(()=>b.textContent=o,1500);
    });
  });
  document.getElementById('syncIdGenerate')?.addEventListener('click',()=>{
    const i=document.getElementById('syncIdInput');if(i)i.value=PlannerSync.genId();
  });

  document.getElementById('syncConnectBtn')?.addEventListener('click',async()=>{
    const err=document.getElementById('syncErrorMsg');
    const cfgRaw=document.getElementById('firebaseConfigInput')?.value?.trim();
    const id=document.getElementById('syncIdInput')?.value?.trim();
    err.textContent='';
    if(!cfgRaw||!id){err.textContent='⚠️ Firebase 설정과 동기화 ID를 입력해 주세요.';return;}
    let cfg;try{cfg=JSON.parse(cfgRaw);}catch(e){err.textContent='⚠️ JSON 형식 오류';return;}
    const btn=document.getElementById('syncConnectBtn');btn.disabled=true;btn.textContent='연결 중...';
    const ok=await PlannerSync.connect(cfg,id,data=>applyRemoteData(data,true));
    btn.disabled=false;btn.textContent='☁️ 연결하기';
    if(ok){
      PlannerSync.saveCfg(cfg,id);updateSyncModalStatus(true);
      const remote=await PlannerSync.pull();if(remote)applyRemoteData(remote,true);
      const{todos,memo,workout}=collectData();
      await PlannerSync.push({todos},dateKey(currentDate),{memo,workout});
    }else{err.textContent='⚠️ 연결 실패';}
  });

  document.getElementById('syncDisconnectBtn')?.addEventListener('click',()=>{
    PlannerSync.disconnect();
    localStorage.removeItem('planner_sync_cfg');
    localStorage.removeItem('planner_sync_id');
    updateSyncModalStatus(false);
  });
})();
