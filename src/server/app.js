const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { checkPermissions } = require('../electron/utils/permission');
const { startRecording, stopRecording, isRecordingActive, getActiveSources } = require('../electron/utils/recording');

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

// Store recording state - enhanced for concurrent dual audio sources
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
  }
};

// Make io and recordingState available globally for recording.js
global.io = io;
global.recordingState = recordingState;

// Helper function to update recording state for a specific source
function updateRecordingState(source, isRecording, startTime = null, audioFormat = null) {
  if (recordingState[source]) {
    recordingState[source].isRecording = isRecording;
    recordingState[source].startTime = startTime;
    recordingState[source].streaming = isRecording;
    recordingState[source].audioFormat = audioFormat;
  }
}

// API Routes
app.get('/api/status', (req, res) => {
  // Get real-time status from the recording utility
  const activeSources = getActiveSources();
  
  // Update our state based on actual recording status
  Object.keys(recordingState).forEach(source => {
    const isActive = activeSources.includes(source);
    if (recordingState[source].isRecording !== isActive) {
      recordingState[source].isRecording = isActive;
      recordingState[source].streaming = isActive;
    }
  });

  res.json({
    // Current state with dual source support
    system: recordingState.system,
    microphone: recordingState.microphone,
    // Summary information
    activeCount: activeSources.length,
    activeSources: activeSources,
    // Legacy properties for backward compatibility
    isRecording: recordingState.system.isRecording || recordingState.microphone.isRecording,
    startTime: recordingState.system.startTime || recordingState.microphone.startTime,
    streaming: recordingState.system.streaming || recordingState.microphone.streaming,
    audioFormat: recordingState.system.audioFormat || recordingState.microphone.audioFormat
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

// System Audio Recording (updated for concurrent support)
app.post('/api/recording/start', async (req, res) => {
  try {
    // Check for DeepGram API key
    if (!process.env.DEEPGRAM_API_KEY) {
      return res.status(500).json({ 
        error: 'DEEPGRAM_API_KEY environment variable is required' 
      });
    }

    // Check if system recording is already active
    if (isRecordingActive('system')) {
      return res.status(400).json({
        error: 'System audio recording is already active',
        source: 'system',
        success: false
      });
    }

    console.log('API: Starting system audio streaming recording...');

    // Update recording state
    updateRecordingState('system', true, Date.now());

    // Start system audio streaming recording
    const result = await startRecording('system');
    
    console.log('API: System audio streaming started successfully');
    
    // Update state with result
    updateRecordingState('system', true, result.timestamp, result.audioFormat);
    
    res.json({ 
      success: true, 
      source: 'system',
      startTime: result.timestamp,
      streaming: true,
      audioFormat: result.audioFormat,
      message: 'System audio streaming recording started successfully'
    });
  } catch (error) {
    console.error('API: System audio recording start error:', error.message);
    
    updateRecordingState('system', false);
    
    // Emit error to all connected clients
    io.emit('recording-error', { message: error.message, source: 'system' });
    
    res.status(500).json({ 
      error: error.message,
      source: 'system',
      success: false 
    });
  }
});

// Microphone Recording (updated for concurrent support)
app.post('/api/recording/microphone/start', async (req, res) => {
  try {
    // Check for DeepGram API key
    if (!process.env.DEEPGRAM_API_KEY) {
      return res.status(500).json({ 
        error: 'DEEPGRAM_API_KEY environment variable is required' 
      });
    }

    // Check if microphone recording is already active
    if (isRecordingActive('microphone')) {
      return res.status(400).json({
        error: 'Microphone recording is already active',
        source: 'microphone',
        success: false
      });
    }

    console.log('API: Starting microphone streaming recording...');

    // Update recording state
    updateRecordingState('microphone', true, Date.now());

    // Start microphone streaming recording
    const result = await startRecording('microphone');
    
    console.log('API: Microphone streaming started successfully');
    
    // Update state with result
    updateRecordingState('microphone', true, result.timestamp, result.audioFormat);
    
    res.json({ 
      success: true, 
      source: 'microphone',
      startTime: result.timestamp,
      streaming: true,
      audioFormat: result.audioFormat,
      message: 'Microphone streaming recording started successfully'
    });
  } catch (error) {
    console.error('API: Microphone recording start error:', error.message);
    
    updateRecordingState('microphone', false);
    
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
    if (!isRecordingActive('system')) {
      return res.status(400).json({
        error: 'System audio recording is not active',
        source: 'system',
        success: false
      });
    }

    stopRecording('system');
    
    updateRecordingState('system', false);
    
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
    if (!isRecordingActive('microphone')) {
      return res.status(400).json({
        error: 'Microphone recording is not active',
        source: 'microphone',
        success: false
      });
    }

    stopRecording('microphone');
    
    updateRecordingState('microphone', false);
    
    // Emit to all connected clients
    io.emit('recording-stopped', { source: 'microphone' });
    
    res.json({ success: true, source: 'microphone' });
  } catch (error) {
    res.status(500).json({ error: error.message, source: 'microphone' });
  }
});

// Start Both Sources Simultaneously
app.post('/api/recording/start-both', async (req, res) => {
  try {
    // Check for DeepGram API key
    if (!process.env.DEEPGRAM_API_KEY) {
      return res.status(500).json({ 
        error: 'DEEPGRAM_API_KEY environment variable is required' 
      });
    }

    console.log('API: Starting both audio sources simultaneously...');

    const results = {};
    const errors = {};

    // Start system audio if not already active
    if (!isRecordingActive('system')) {
      try {
        updateRecordingState('system', true, Date.now());
        const systemResult = await startRecording('system');
        updateRecordingState('system', true, systemResult.timestamp, systemResult.audioFormat);
        results.system = systemResult;
        console.log('API: System audio started successfully');
      } catch (error) {
        updateRecordingState('system', false);
        errors.system = error.message;
        console.error('API: System audio start failed:', error.message);
      }
    } else {
      results.system = { message: 'Already active' };
    }

    // Start microphone if not already active
    if (!isRecordingActive('microphone')) {
      try {
        updateRecordingState('microphone', true, Date.now());
        const microphoneResult = await startRecording('microphone');
        updateRecordingState('microphone', true, microphoneResult.timestamp, microphoneResult.audioFormat);
        results.microphone = microphoneResult;
        console.log('API: Microphone started successfully');
      } catch (error) {
        updateRecordingState('microphone', false);
        errors.microphone = error.message;
        console.error('API: Microphone start failed:', error.message);
      }
    } else {
      results.microphone = { message: 'Already active' };
    }

    const hasErrors = Object.keys(errors).length > 0;
    const hasSuccess = Object.keys(results).length > 0;

    if (hasErrors && !hasSuccess) {
      // Complete failure
      res.status(500).json({
        success: false,
        errors: errors,
        message: 'Failed to start any audio sources'
      });
    } else {
      // Partial or complete success
      res.json({
        success: true,
        results: results,
        errors: hasErrors ? errors : undefined,
        message: hasErrors ? 'Partial success - some sources failed to start' : 'Both audio sources started successfully'
      });
    }

  } catch (error) {
    console.error('API: Start both error:', error.message);
    res.status(500).json({ 
      error: error.message,
      success: false 
    });
  }
});

// Stop All Recording
app.post('/api/recording/stop-all', (req, res) => {
  try {
    const activeSources = getActiveSources();
    
    if (activeSources.length === 0) {
      return res.json({
        success: true,
        message: 'No active recordings to stop',
        stoppedSources: []
      });
    }

    console.log(`API: Stopping all active recordings: ${activeSources.join(', ')}`);

    // Stop all recordings
    stopRecording(); // No parameter stops all sources
    
    // Reset all recording states
    Object.keys(recordingState).forEach(source => {
      updateRecordingState(source, false);
    });
    
    // Emit to all connected clients
    io.emit('recording-stopped', { source: 'all', stoppedSources: activeSources });
    
    res.json({ 
      success: true, 
      source: 'all',
      stoppedSources: activeSources,
      message: `Stopped ${activeSources.length} active recording(s)`
    });
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

// Get current recording status for specific source
app.get('/api/recording/:source/status', (req, res) => {
  const source = req.params.source;
  
  if (!recordingState[source]) {
    return res.status(400).json({ error: `Invalid source: ${source}` });
  }

  const isActive = isRecordingActive(source);
  
  res.json({
    source: source,
    isRecording: isActive,
    isActive: isActive,
    ...recordingState[source]
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  const activeSources = getActiveSources();
  
  res.json({ 
    status: 'ok',
    deepgram: !!process.env.DEEPGRAM_API_KEY,
    recording: {
      system: isRecordingActive('system'),
      microphone: isRecordingActive('microphone'),
      activeCount: activeSources.length,
      activeSources: activeSources
    },
    streaming: {
      system: recordingState.system.streaming,
      microphone: recordingState.microphone.streaming,
      any: recordingState.system.streaming || recordingState.microphone.streaming
    }
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Get current active sources
  const activeSources = getActiveSources();
  
  // Update state based on actual recording status
  Object.keys(recordingState).forEach(source => {
    const isActive = activeSources.includes(source);
    recordingState[source].isRecording = isActive;
    recordingState[source].streaming = isActive;
  });
  
  // Send current state to newly connected client
  socket.emit('state-update', {
    system: recordingState.system,
    microphone: recordingState.microphone,
    activeSources: activeSources,
    // Legacy properties
    isRecording: recordingState.system.isRecording || recordingState.microphone.isRecording,
    startTime: recordingState.system.startTime || recordingState.microphone.startTime,
    streaming: recordingState.system.streaming || recordingState.microphone.streaming,
    audioFormat: recordingState.system.audioFormat || recordingState.microphone.audioFormat
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
