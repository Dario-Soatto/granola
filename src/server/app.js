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

// Store recording state - enhanced for dual audio sources
let recordingState = {
  system: {
    isRecording: false,
    startTime: null,
    streaming: false,
    audioFormat: null
  },
  microphone: {
    isRecording: false,
    startTime: null,
    streaming: false,
    audioFormat: null
  },
  // Legacy properties for backward compatibility
  isRecording: false,
  startTime: null,
  streaming: false,
  audioFormat: null
};

// Make io and recordingState available globally for recording.js
global.io = io;
global.recordingState = recordingState;

// Helper function to update legacy state properties
function updateLegacyState() {
  recordingState.isRecording = recordingState.system.isRecording || recordingState.microphone.isRecording;
  recordingState.startTime = recordingState.system.startTime || recordingState.microphone.startTime;
  recordingState.streaming = recordingState.system.streaming || recordingState.microphone.streaming;
  recordingState.audioFormat = recordingState.system.audioFormat || recordingState.microphone.audioFormat;
}

// API Routes
app.get('/api/status', (req, res) => {
  updateLegacyState();
  res.json({
    // Current state with dual source support
    system: recordingState.system,
    microphone: recordingState.microphone,
    // Legacy properties for backward compatibility
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

// System Audio Recording (existing endpoint - updated)
app.post('/api/recording/start', async (req, res) => {
  try {
    // Check for DeepGram API key
    if (!process.env.DEEPGRAM_API_KEY) {
      return res.status(500).json({ 
        error: 'DEEPGRAM_API_KEY environment variable is required' 
      });
    }

    console.log('API: Starting system audio streaming recording...');

    // Update recording state
    recordingState.system.isRecording = true;
    recordingState.system.startTime = Date.now();
    recordingState.system.streaming = true;

    // Start system audio streaming recording
    const result = await startRecording('system');
    
    console.log('API: System audio streaming started successfully');
    
    // Update state with result
    recordingState.system.audioFormat = result.audioFormat;
    updateLegacyState();
    
    res.json({ 
      success: true, 
      source: 'system',
      startTime: recordingState.system.startTime,
      streaming: true,
      audioFormat: result.audioFormat,
      message: 'System audio streaming recording started successfully'
    });
  } catch (error) {
    console.error('API: System audio recording start error:', error.message);
    
    recordingState.system.isRecording = false;
    recordingState.system.startTime = null;
    recordingState.system.streaming = false;
    updateLegacyState();
    
    // Emit error to all connected clients
    io.emit('recording-error', { message: error.message, source: 'system' });
    
    res.status(500).json({ 
      error: error.message,
      source: 'system',
      success: false 
    });
  }
});

// Microphone Recording (new endpoint)
app.post('/api/recording/microphone/start', async (req, res) => {
  try {
    // Check for DeepGram API key
    if (!process.env.DEEPGRAM_API_KEY) {
      return res.status(500).json({ 
        error: 'DEEPGRAM_API_KEY environment variable is required' 
      });
    }

    console.log('API: Starting microphone streaming recording...');

    // Update recording state
    recordingState.microphone.isRecording = true;
    recordingState.microphone.startTime = Date.now();
    recordingState.microphone.streaming = true;

    // Start microphone streaming recording
    const result = await startRecording('microphone');
    
    console.log('API: Microphone streaming started successfully');
    
    // Update state with result
    recordingState.microphone.audioFormat = result.audioFormat;
    updateLegacyState();
    
    res.json({ 
      success: true, 
      source: 'microphone',
      startTime: recordingState.microphone.startTime,
      streaming: true,
      audioFormat: result.audioFormat,
      message: 'Microphone streaming recording started successfully'
    });
  } catch (error) {
    console.error('API: Microphone recording start error:', error.message);
    
    recordingState.microphone.isRecording = false;
    recordingState.microphone.startTime = null;
    recordingState.microphone.streaming = false;
    updateLegacyState();
    
    // Emit error to all connected clients
    io.emit('recording-error', { message: error.message, source: 'microphone' });
    
    res.status(500).json({ 
      error: error.message,
      source: 'microphone',
      success: false 
    });
  }
});

// Stop System Audio Recording
app.post('/api/recording/stop', (req, res) => {
  try {
    stopRecording();
    
    recordingState.system.isRecording = false;
    recordingState.system.startTime = null;
    recordingState.system.streaming = false;
    recordingState.system.audioFormat = null;
    updateLegacyState();
    
    // Emit to all connected clients
    io.emit('recording-stopped', { source: 'system' });
    
    res.json({ success: true, source: 'system' });
  } catch (error) {
    res.status(500).json({ error: error.message, source: 'system' });
  }
});

// Stop Microphone Recording
app.post('/api/recording/microphone/stop', (req, res) => {
  try {
    stopRecording();
    
    recordingState.microphone.isRecording = false;
    recordingState.microphone.startTime = null;
    recordingState.microphone.streaming = false;
    recordingState.microphone.audioFormat = null;
    updateLegacyState();
    
    // Emit to all connected clients
    io.emit('recording-stopped', { source: 'microphone' });
    
    res.json({ success: true, source: 'microphone' });
  } catch (error) {
    res.status(500).json({ error: error.message, source: 'microphone' });
  }
});

// Stop All Recording
app.post('/api/recording/stop-all', (req, res) => {
  try {
    stopRecording();
    
    // Reset all recording states
    recordingState.system.isRecording = false;
    recordingState.system.startTime = null;
    recordingState.system.streaming = false;
    recordingState.system.audioFormat = null;
    
    recordingState.microphone.isRecording = false;
    recordingState.microphone.startTime = null;
    recordingState.microphone.streaming = false;
    recordingState.microphone.audioFormat = null;
    
    updateLegacyState();
    
    // Emit to all connected clients
    io.emit('recording-stopped', { source: 'all' });
    
    res.json({ success: true, source: 'all' });
  } catch (error) {
    res.status(500).json({ error: error.message, source: 'all' });
  }
});

// Check specific permissions
app.get('/api/permissions/:type', async (req, res) => {
  try {
    const permissionType = req.params.type;
    
    if (permissionType === 'system') {
      const hasPermission = await checkPermissions();
      res.json({ hasPermission, type: 'system' });
    } else if (permissionType === 'microphone') {
      // For now, we'll assume microphone permission checking will be handled by the Swift binary
      // This could be enhanced later with a dedicated microphone permission check
      res.json({ hasPermission: true, type: 'microphone', note: 'Microphone permission checked at runtime' });
    } else {
      res.status(400).json({ error: 'Invalid permission type. Use "system" or "microphone"' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  updateLegacyState();
  res.json({ 
    status: 'ok',
    deepgram: !!process.env.DEEPGRAM_API_KEY,
    recording: {
      system: recordingState.system.isRecording,
      microphone: recordingState.microphone.isRecording,
      any: recordingState.isRecording
    },
    streaming: {
      system: recordingState.system.streaming,
      microphone: recordingState.microphone.streaming,
      any: recordingState.streaming
    }
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  updateLegacyState();
  // Send current state to newly connected client
  socket.emit('state-update', {
    system: recordingState.system,
    microphone: recordingState.microphone,
    // Legacy properties
    isRecording: recordingState.isRecording,
    startTime: recordingState.startTime,
    streaming: recordingState.streaming,
    audioFormat: recordingState.audioFormat
  });
  
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
