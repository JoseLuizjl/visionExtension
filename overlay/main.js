const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const POS_FILE = path.join(app.getPath('userData'), 'overlay-pos.json');
const WIDTH = 420;
const HEIGHT = 320;

function loadPosition() {
  try {
    return JSON.parse(fs.readFileSync(POS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function savePosition(pos) {
  try {
    fs.writeFileSync(POS_FILE, JSON.stringify(pos));
  } catch {
    // não é crítico se não conseguir salvar — só volta pro canto padrão
  }
}

let win;

function createWindow() {
  const saved = loadPosition();
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: saved ? saved.x : screenW - WIDTH - 20,
    y: saved ? saved.y : screenH - HEIGHT - 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    // Nunca vira a janela ativa — arrastar, atualizar, receber resposta ou
    // ser teletransportada pelo atalho não tira o foco de onde você está.
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Nível 'screen-saver' é o que mantém o card visível por cima de apps em
  // tela cheia/vídeo (o alwaysOnTop "normal" some nesses casos no Windows).
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Invisível em compartilhamento de tela (Discord, Meet, Zoom, navegador…),
  // mas continua visível só no seu monitor (WDA_EXCLUDEFROMCAPTURE no Windows).
  win.setContentProtection(true);

  win.loadFile('index.html');

  if (process.env.OVERLAY_DEBUG) {
    win.webContents.on('console-message', (event) => {
      console.log('[renderer]', event.message);
    });
  }

  let saveTimer = null;
  win.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const [x, y] = win.getPosition();
      savePosition({ x, y });
    }, 300);
  });
}

// Move o card para perto do ponteiro do mouse, sem tirar o foco de nada —
// setPosition() só reposiciona a janela, não a mostra nem a foca.
function teleportToCursor() {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;

  let x = Math.round(cursor.x - WIDTH / 2);
  let y = Math.round(cursor.y - HEIGHT / 2);
  x = Math.max(dx, Math.min(x, dx + dw - WIDTH));
  y = Math.max(dy, Math.min(y, dy + dh - HEIGHT));

  win.setPosition(x, y);
  savePosition({ x, y });
}

app.whenReady().then(() => {
  createWindow();

  const okM = globalShortcut.register('CommandOrControl+Shift+M', teleportToCursor);
  const okO = globalShortcut.register('CommandOrControl+Shift+O', () => {
    if (win) win.webContents.send('scroll-down');
  });
  const okY = globalShortcut.register('CommandOrControl+Shift+Y', () => {
    if (win) win.webContents.send('scroll-up');
  });
  const okG = globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (win) win.webContents.send('trigger-capture');
  });

  if (!okM || !okO || !okY || !okG) {
    console.warn('Aviso: algum atalho global não pôde ser registrado (outro app já está usando essa combinação?)');
  }
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

ipcMain.on('overlay-close', () => app.quit());
