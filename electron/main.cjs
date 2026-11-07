const { app, BrowserWindow } = require('electron');
const path = require('node:path');

if (process.getuid && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#101114',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.argv.includes('--dev')) {
    window.loadURL('http://localhost:5173');
  } else {
    window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
