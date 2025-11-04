// add to package.json
// "start": ".\\node_modules\\electron\\dist\\electron.exe ."
// npx electron-builder

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

const name = "";

// Start the server
function startServer() {
  try {
    const fs = require('fs');

    // Determine the correct path to server.js
    let serverPath;
    if (app.isPackaged) {
      // In packaged app, unpacked files are in app.asar.unpacked
      serverPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'server.js');
      console.log('Packaged app - checking path:', serverPath);
      console.log('File exists?', fs.existsSync(serverPath));

      // If that doesn't exist, try the asar path
      if (!fs.existsSync(serverPath)) {
        serverPath = path.join(process.resourcesPath, 'app', 'server.js');
        console.log('Trying alternate path:', serverPath);
        console.log('File exists?', fs.existsSync(serverPath));
      }
    } else {
      // In development, go up from App folder to root
      serverPath = path.join(__dirname, '..', 'server.js');
      console.log('Development mode - server path:', serverPath);
    }

    console.log('Starting server from:', serverPath);

    // Check if file exists before requiring
    if (!fs.existsSync(serverPath)) {
      throw new Error(`Server file not found at: ${serverPath}`);
    }

    require(serverPath);
    console.log('Server started successfully');
  } catch (error) {
    console.error('❌ Error starting server:', error.message);
    console.error('Stack:', error.stack);

    // Show error dialog to user
    const { dialog } = require('electron');
    dialog.showErrorBox('Server Error', `Failed to start server:\n${error.message}\n\nCheck DevTools console for details.`);
  }
}

function createWindow () {
  let win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'site', 'icon.png')
  })

  // Use absolute path for loading the HTML file
  const htmlPath = path.join(__dirname, 'site', 'index.html');
  console.log('Loading HTML from:', htmlPath);

  win.loadFile(htmlPath).catch(err => {
    console.error('Failed to load HTML:', err);
  });

  win.setMenu(null);

  // Open DevTools for debugging (temporarily enabled for packaged app too)
  // win.webContents.openDevTools();
}

// IPC handler for directory selection
ipcMain.handle('select-directory', async (event) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Video Directory'
  });

  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

app.on('ready', () => {
  // Start the server first
  startServer();

  // Wait a moment for the server to start, then create window
  setTimeout(createWindow, 1000);
})

/*

  package.json

  "build":{
    "win": {
      "icon": "site/icon.png"
    }
  }


*/