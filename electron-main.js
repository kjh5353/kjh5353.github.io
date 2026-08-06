const { app, BrowserWindow, Menu, shell, nativeTheme } = require('electron');
const path = require('path');

nativeTheme.themeSource = 'dark';

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 600,
    minHeight: 500,
    title: 'Daily Planner',
    backgroundColor: '#0f1117',
    titleBarStyle: 'hiddenInset',   // macOS 트래픽 라이트 버튼 유지, 제목 숨김
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
  });

  win.loadFile('index.html');

  // 로딩 완료 후 부드럽게 표시
  win.once('ready-to-show', () => {
    win.show();
  });

  // 개발 도구 (필요시 주석 해제)
  // win.webContents.openDevTools();

  return win;
}

// macOS 앱 메뉴
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: 'Daily Planner 정보' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Daily Planner 숨기기' },
        { role: 'hideOthers', label: '기타 숨기기' },
        { role: 'unhide', label: '모두 표시' },
        { type: 'separator' },
        { role: 'quit', label: '종료' }
      ]
    }] : []),
    {
      label: '파일',
      submenu: [
        isMac ? { role: 'close', label: '창 닫기' } : { role: 'quit', label: '종료' }
      ]
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '다시 실행' },
        { type: 'separator' },
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '전체 선택' },
      ]
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '새로 고침' },
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' }
      ]
    },
    {
      label: '창',
      submenu: [
        { role: 'minimize', label: '최소화' },
        { role: 'zoom', label: '최대화' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front', label: '맨 앞으로' },
        ] : [])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  // macOS: Dock 아이콘 클릭 시 창 재생성
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS 이외에서는 모든 창 닫히면 종료
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
