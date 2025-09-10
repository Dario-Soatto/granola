const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
require('dotenv').config();

const { checkPermissions } = require("./utils/permission");
const { startRecording, stopRecording } = require("./utils/recording");

// Import and start Express server
const { server, io, recordingState } = require("../server/app");

let mainWindow;
const EXPRESS_PORT = 3000;

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      devTools: true,
    },
  });

  // Check for DeepGram API key before starting
  if (!process.env.DEEPGRAM_API_KEY) {
    console.error('ERROR: DEEPGRAM_API_KEY environment variable is required');
    
    const response = await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Configuration Error",
      message: "DeepGram API key is required for real-time transcription.",
      detail: "Please set the DEEPGRAM_API_KEY environment variable and restart the application.",
      buttons: ["Exit"]
    });
    
    app.quit();
    return;
  }

  // DEBUG: Check permissions before starting server
  console.log('Checking permissions...');
  try {
    const hasPermission = await checkPermissions();
    console.log('Permission check result:', hasPermission);
  } catch (error) {
    console.error('Permission check failed:', error);
  }

  // Start Express server
  server.listen(EXPRESS_PORT, () => {
    console.log(`Express server running on http://localhost:${EXPRESS_PORT}`);
    console.log('DeepGram API key configured ✓');
  });

  // Load the Express app in Electron
  mainWindow.loadURL(`http://localhost:${EXPRESS_PORT}`);

  // Set global reference for recording utilities
  global.mainWindow = mainWindow;
  global.io = io;
  global.recordingState = recordingState;
};

// Simplified IPC handlers for streaming
ipcMain.on("start-recording", async () => {
  try {
    recordingState.isRecording = true;
    recordingState.startTime = Date.now();
    recordingState.streaming = true;

    const result = await startRecording();
    
    // Emit to web clients
    io.emit('recording-started', {
      startTime: recordingState.startTime,
      streaming: true,
      audioFormat: result.audioFormat
    });
  } catch (error) {
    recordingState.isRecording = false;
    recordingState.streaming = false;
    console.error('Recording start error:', error);
    
    // Show error dialog
    dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Recording Error",
      message: "Failed to start recording",
      detail: error.message,
      buttons: ["OK"]
    });
  }
});

ipcMain.on("stop-recording", () => {
  stopRecording();
  
  recordingState.isRecording = false;
  recordingState.startTime = null;
  recordingState.streaming = false;
  
  // Emit to web clients
  io.emit('recording-stopped');
});

ipcMain.handle("check-permissions", async () => {
  const isPermissionGranted = await checkPermissions();

  if (!isPermissionGranted) {
    const response = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Permission Denied",
      message: "You need to grant permission for screen recording to capture system audio.",
      detail: "Would you like to open System Preferences now?",
      buttons: ["Open System Preferences", "Cancel"],
    });

    if (response.response === 0) {
      shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    }
  }
  
  return isPermissionGranted;
});

// Handle app lifecycle
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Graceful shutdown
app.on('before-quit', () => {
  console.log('Application shutting down...');
  if (recordingState.isRecording) {
    stopRecording();
  }
});
