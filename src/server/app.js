const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { checkPermissions } = require('../electron/utils/permission');
const { startRecording, stopRecording } = require('../electron/utils/recording');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../web')));

// Store recording state - simplified for streaming
let recordingState = {
  isRecording: false,
  startTime: null,
  streaming: false,
  audioFormat: null
};

// Make io and recordingState available globally for recording.js
global.io = io;
global.recordingState = recordingState;

// API Routes
app.get('/api/status', (req, res) => {
  res.json({
    isRecording: recordingState.isRecording,
    startTime: recordingState.startTime,
    streaming: recordingState.streaming,
    audioFormat: recordingState.audioFormat
  });
});

app.get('/api/permissions', async (req, res) => {
  try {
    const hasPermission = await checkPermissions();
    res.json({ hasPermission });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/recording/start', async (req, res) => {
  try {
    // Check for DeepGram API key
    if (!process.env.DEEPGRAM_API_KEY) {
      return res.status(500).json({ 
        error: 'DEEPGRAM_API_KEY environment variable is required' 
      });
    }

    console.log('API: Starting streaming recording...');

    // Update recording state
    recordingState.isRecording = true;
    recordingState.startTime = Date.now();
    recordingState.streaming = true;

    // Start streaming recording
    const result = await startRecording();
    
    console.log('API: Streaming started successfully');
    
    res.json({ 
      success: true, 
      startTime: recordingState.startTime,
      streaming: true,
      audioFormat: result.audioFormat,
      message: 'Streaming recording started successfully'
    });
  } catch (error) {
    console.error('API: Recording start error:', error.message);
    
    recordingState.isRecording = false;
    recordingState.startTime = null;
    recordingState.streaming = false;
    
    // Emit error to all connected clients
    io.emit('recording-error', { message: error.message });
    
    res.status(500).json({ 
      error: error.message,
      success: false 
    });
  }
});

app.post('/api/recording/stop', (req, res) => {
  try {
    stopRecording();
    
    recordingState.isRecording = false;
    recordingState.startTime = null;
    recordingState.streaming = false;
    recordingState.audioFormat = null;
    
    // Emit to all connected clients
    io.emit('recording-stopped');
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    deepgram: !!process.env.DEEPGRAM_API_KEY,
    recording: recordingState.isRecording,
    streaming: recordingState.streaming
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send current state to newly connected client
  socket.emit('state-update', recordingState);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Serve the main web interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/index.html'));
});

// Export server for Electron integration
module.exports = { app, server, io, recordingState };

// Start server if running directly
if (require.main === module) {
  // Check for required environment variables
  if (!process.env.DEEPGRAM_API_KEY) {
    console.error('ERROR: DEEPGRAM_API_KEY environment variable is required');
    console.error('Please set your DeepGram API key: export DEEPGRAM_API_KEY=your_key_here');
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`Express server running on http://localhost:${PORT}`);
    console.log('DeepGram API key configured ✓');
  });
}
