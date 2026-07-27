// ===== DAILY PLANNER — CLOUD SYNC (Firebase Firestore) =====
// 맥 & 아이폰 실시간 동기화 모듈

window.PlannerSync = (() => {
  const CFG_KEY  = 'planner_sync_cfg';   // Firebase 설정 저장 키
  const ID_KEY   = 'planner_sync_id';    // 동기화 ID 저장 키
  const COL      = 'sync';               // Firestore collection 이름

  let _db      = null;
  let _syncId  = null;
  let _unsub   = null;         // Firestore 리스너 해제 함수
  let _onRemote = null;        // 원격 변경 수신 콜백

  // ─── 설정 영속 저장 ───
  const loadCfg = () => {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); }
    catch (e) { return null; }
  };

  const saveCfg = (cfg, id) => {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    localStorage.setItem(ID_KEY, id);
  };

  const loadId = () => localStorage.getItem(ID_KEY) || null;

  const genId = () =>
    'p' + Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8);

  // ─── Firebase 연결 ───
  async function connect(cfg, id, onRemoteChange) {
    try {
      // 기존 리스너 해제
      if (_unsub) { _unsub(); _unsub = null; }

      // Firebase 초기화 (중복 방지)
      if (!firebase.apps.length) {
        firebase.initializeApp(cfg);
      }
      _db = firebase.firestore();
      _syncId = id;
      _onRemote = onRemoteChange;

      // 오프라인 캐싱 활성화
      try {
        await _db.enablePersistence({ synchronizeTabs: false });
      } catch (e) { /* 이미 활성화되었거나 미지원 */ }

      // 실시간 리스너 시작
      _startListener();
      setStatus('synced');
      return true;
    } catch (err) {
      console.error('[Sync] 연결 실패:', err);
      setStatus('error');
      return false;
    }
  }

  function _startListener() {
    if (!_db || !_syncId) return;
    _unsub = _db.collection(COL).doc(_syncId).onSnapshot(
      snap => {
        if (snap.exists && typeof _onRemote === 'function') {
          setStatus('synced');
          _onRemote(snap.data());
        }
      },
      err => {
        setStatus('error');
        console.warn('[Sync] 리스너 오류:', err.message);
      }
    );
  }

  // ─── 데이터 Push (로컬 → 클라우드) ───
  async function push(globalData, dateStr, dayData) {
    if (!_db || !_syncId) return;
    setStatus('syncing');
    try {
      const update = {
        global: {
          timetable : globalData.timetable  || {},
          important : globalData.important  || [],
          todos     : globalData.todos      || []
        },
        updatedAt : firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy : navigator.userAgent.includes('iPhone') ||
                    navigator.userAgent.includes('iPad')   ? 'mobile' : 'desktop'
      };

      // 날짜별 데이터 병합 (중첩 객체 사용 - merge: true가 깊은 병합 수행)
      if (dateStr && dayData) {
        update.days = {
          [dateStr]: dayData
        };
      }

      await _db.collection(COL).doc(_syncId).set(update, { merge: true });
      setStatus('synced');
    } catch (e) {
      console.error('[Sync] Push 실패:', e);
      setStatus('error');
    }
  }

  // ─── 데이터 Pull (클라우드 → 로컬, 1회) ───
  async function pull() {
    if (!_db || !_syncId) return null;
    try {
      const snap = await _db.collection(COL).doc(_syncId).get();
      return snap.exists ? snap.data() : null;
    } catch (e) {
      console.error('[Sync] Pull 실패:', e);
      return null;
    }
  }

  // ─── 연결 해제 ───
  function disconnect() {
    if (_unsub) { _unsub(); _unsub = null; }
    _db = null;
    _syncId = null;
    _onRemote = null;
    setStatus('off');
  }

  function isConnected() { return !!_db && !!_syncId; }

  // ─── 동기화 상태 뱃지 업데이트 ───
  function setStatus(state) {
    const el = document.getElementById('syncStatusBadge');
    if (!el) return;
    const map = {
      synced  : ['☁️ 동기화됨', 'synced'],
      syncing : ['⬆ 동기화 중', 'syncing'],
      error   : ['⚠ 오류', 'error'],
      off     : ['', 'off']
    };
    const [text, cls] = map[state] || ['', 'off'];
    el.textContent = text;
    el.className   = 'sync-badge ' + cls;
  }

  return { connect, push, pull, disconnect, isConnected,
           loadCfg, saveCfg, loadId, genId, setStatus };
})();
