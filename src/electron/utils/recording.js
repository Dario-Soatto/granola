const { spawn } = require("node:child_process");
const { checkPermissions } = require("./permission");
const { createClient } = require('@deepgram/sdk');

// Global DeepGram client (shared)
let deepgramClient = null;

// Recording state for each audio source
const recordingStates = {
  system: {
    process: null,
    deepgramConnection: null,
    audioFormat: null,
    audioStreamParser: null,
    isActive: false
  },
  microphone: {
    process: null,
    deepgramConnection: null,
    audioFormat: null,
    audioStreamParser: null,
    isActive: false
  }
};

// Initialize DeepGram client (shared between both sources)
function initializeDeepGram() {
  if (!deepgramClient) {
    if (!process.env.DEEPGRAM_API_KEY) {
      throw new Error('DEEPGRAM_API_KEY environment variable is required');
    }
    
    deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
    console.log('DeepGram client initialized');
  }
}

// Start DeepGram streaming connection for a specific source
function startDeepGramStream(audioSource) {
  if (!deepgramClient) {
    initializeDeepGram();
  }

  // DeepGram streaming configuration
  const deepgramConfig = {
    model: 'nova-2',
    language: 'en-US',
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 1000,
    vad_events: true,
    encoding: 'linear16',
    sample_rate: 16000,
    channels: 1
  };

  console.log(`Starting DeepGram streaming connection for ${audioSource}...`);
  const connection = deepgramClient.listen.live(deepgramConfig);

  // Handle DeepGram responses
  connection.on('open', () => {
    console.log(`DeepGram connection opened for ${audioSource}`);
  });

  connection.on('Results', (data) => {
    const result = data.channel.alternatives[0];
    if (result && result.transcript) {
      const transcriptionData = {
        text: result.transcript,
        is_final: data.is_final,
        confidence: result.confidence,
        timestamp: new Date().toISOString(),
        source: audioSource
      };

      console.log(`DeepGram ${audioSource} ${data.is_final ? 'FINAL' : 'interim'}:`, result.transcript);

      // Send transcription to clients via Socket.io with source information
      if (global.io) {
        global.io.emit('transcription-chunk', transcriptionData);
      }
    }
  });

  connection.on('Metadata', (data) => {
    console.log(`DeepGram ${audioSource} metadata:`, data);
  });

  connection.on('Error', (error) => {
    console.error(`DeepGram ${audioSource} error:`, error);
    
    // Emit error to web clients
    if (global.io) {
      global.io.emit('transcription-error', { message: error.message, source: audioSource });
    }
  });

  connection.on('Close', () => {
    console.log(`DeepGram ${audioSource} connection closed`);
  });

  return connection;
}

// Stop DeepGram streaming for a specific source
function stopDeepGramStream(audioSource) {
  const state = recordingStates[audioSource];
  if (state.deepgramConnection) {
    console.log(`Closing DeepGram connection for ${audioSource}...`);
    state.deepgramConnection.finish();
    state.deepgramConnection = null;
  }
}

// Parse binary audio stream from Swift with source identification
class AudioStreamParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
  }

  processData(data) {
    // Append new data to buffer
    this.buffer = Buffer.concat([this.buffer, data]);

    const audioChunks = [];

    // Process complete packets
    while (this.buffer.length >= 4) {
      // If we don't know the expected length, read it
      if (this.expectedLength === null) {
        this.expectedLength = this.buffer.readUInt32BE(0);
        this.buffer = this.buffer.subarray(4);
      }

      // Check if we have a complete packet (including source identifier)
      if (this.buffer.length >= this.expectedLength) {
        // Extract the source identifier (first byte)
        const sourceId = this.buffer.readUInt8(0);
        
        // Extract the audio data (remaining bytes)
        const audioData = this.buffer.subarray(1, this.expectedLength);
        
        // Determine source type
        const source = sourceId === 0x01 ? 'system' : 'microphone';
        
        audioChunks.push({
          source: source,
          data: audioData,
          sourceId: sourceId
        });

        // Remove processed data from buffer
        this.buffer = this.buffer.subarray(this.expectedLength);
        this.expectedLength = null;
      } else {
        // Not enough data yet, wait for more
        break;
      }
    }

    return audioChunks;
  }
}

const initStreaming = (audioSource) => {
  return new Promise((resolve, reject) => {
    console.log(`Starting ${audioSource} audio streaming process...`);
    
    const state = recordingStates[audioSource];
    
    // Check if this source is already active
    if (state.isActive) {
      reject(new Error(`${audioSource} recording is already active`));
      return;
    }
    
    // Build command arguments based on audio source
    const args = ['--stream'];
    if (audioSource === 'microphone') {
      args.push('--microphone');
    }
    
    // Start Swift recorder with appropriate arguments
    state.process = spawn("./src/swift/Recorder", args);
    state.audioStreamParser = new AudioStreamParser();
    state.isActive = true;
    
    let hasResolved = false;

    const timeout = setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        console.error(`${audioSource} recording process timed out after 10 seconds`);
        cleanupRecording(audioSource);
        reject(new Error(`${audioSource} recording process timed out - this may indicate a permissions issue`));
      }
    }, 10000);

    // Handle JSON status messages from stderr
    state.process.stderr.on("data", (data) => {
      try {
        const lines = data.toString().split("\n").filter((line) => line.trim() !== "");
        
        for (const line of lines) {
          // Skip debug messages that aren't JSON
          if (line.startsWith('Streamed ')) {
            continue;
          }

          try {
            const response = JSON.parse(line);
            console.log(`Swift ${audioSource} recorder status:`, response);
            
            if (response.code === "RECORDING_STARTED") {
              if (!hasResolved) {
                clearTimeout(timeout);
                hasResolved = true;
                
                state.audioFormat = response.audio_format;
                const timestamp = new Date(response.timestamp).getTime();
                const source = response.source || audioSource;

                // Start DeepGram streaming for this source
                try {
                  state.deepgramConnection = startDeepGramStream(source);
                } catch (error) {
                  console.error(`Failed to start DeepGram for ${audioSource}:`, error);
                  cleanupRecording(audioSource);
                  reject(error);
                  return;
                }

                // Send to web clients via Socket.io
                if (global.io) {
                  global.io.emit('recording-started', {
                    startTime: timestamp,
                    streaming: true,
                    audioFormat: state.audioFormat,
                    source: source
                  });
                }

                resolve({ success: true, streaming: true, timestamp, audioFormat: state.audioFormat, source });
              }
              return;
            }
            
            if (response.code === "RECORDING_STOPPED") {
              const timestamp = new Date(response.timestamp).getTime();

              // Stop DeepGram streaming for this source
              stopDeepGramStream(audioSource);
              cleanupRecording(audioSource);

              // Send to web clients via Socket.io
              if (global.io) {
                global.io.emit('recording-stopped', { source: audioSource });
              }

              return;
            }

            // Handle error cases
            if (response.code === "PERMISSION_DENIED") {
              if (!hasResolved) {
                clearTimeout(timeout);
                hasResolved = true;
                const permissionType = response.source === 'microphone' ? 'microphone' : 'screen recording';
                const errorMessage = `${permissionType} permission denied. Please grant permission in System Preferences > Privacy & Security.`;
                cleanupRecording(audioSource);
                reject(new Error(errorMessage));
              }
              return;
            }

            // Handle other error codes...
            const errorCodes = {
              "NO_DISPLAY_FOUND": "No display found for recording. Please ensure your display is connected and active.",
              "CAPTURE_FAILED": response.error ? `Failed to start screen capture: ${response.error}` : 'Failed to start screen capture',
              "CONTENT_FETCH_FAILED": response.error ? `Failed to fetch screen content: ${response.error}` : 'Failed to fetch screen content',
              "STREAM_ERROR": response.error ? `Stream error: ${response.error}` : 'Recording stream encountered an error',
              "INVALID_ARGUMENTS": 'Invalid arguments provided to recorder',
              "MICROPHONE_SETUP_FAILED": response.error ? `Microphone setup failed: ${response.error}` : 'Failed to setup microphone recording',
              "MICROPHONE_START_FAILED": response.error ? `Microphone start failed: ${response.error}` : 'Failed to start microphone recording'
            };

            if (errorCodes[response.code] && !hasResolved) {
              clearTimeout(timeout);
              hasResolved = true;
              cleanupRecording(audioSource);
              reject(new Error(errorCodes[response.code]));
              return;
            }

          } catch (parseError) {
            // Not JSON, probably debug output - ignore
            console.log(`Swift ${audioSource} recorder debug:`, line);
          }
        }
      } catch (error) {
        console.error(`Error processing Swift ${audioSource} recorder stderr:`, error);
      }
    });

    // Handle binary audio data from stdout
    state.process.stdout.on("data", (data) => {
      if (!state.deepgramConnection) {
        console.log(`Received ${audioSource} audio data but DeepGram not connected yet, buffering...`);
        return;
      }

      // Parse the audio packets with source identification
      const audioChunks = state.audioStreamParser.processData(data);
      
      // Forward each audio chunk to DeepGram
      for (const audioChunk of audioChunks) {
        try {
          console.log(`Processing audio chunk from ${audioChunk.source} (${audioChunk.data.length} bytes)`);
          state.deepgramConnection.send(audioChunk.data);
        } catch (error) {
          console.error(`Error sending ${audioChunk.source} audio to DeepGram:`, error);
        }
      }
    });

    state.process.on("error", (error) => {
      if (!hasResolved) {
        clearTimeout(timeout);
        hasResolved = true;
        console.error(`${audioSource} recording process error:`, error);
        cleanupRecording(audioSource);
        reject(new Error(`Failed to start ${audioSource} recording process: ${error.message}`));
      }
    });

    state.process.on("exit", (code, signal) => {
      console.log(`${audioSource} recording process exited with code:`, code, 'signal:', signal);
      
      // Clean up this source
      stopDeepGramStream(audioSource);
      cleanupRecording(audioSource);
      
      if (!hasResolved) {
        clearTimeout(timeout);
        hasResolved = true;
        
        if (code === 0) {
          reject(new Error(`${audioSource} recording process completed without starting recording. This may indicate a permissions issue.`));
        } else {
          reject(new Error(`${audioSource} recording process exited with error code ${code}`));
        }
      }
    });
  });
};

// Helper function to clean up recording state
function cleanupRecording(audioSource) {
  const state = recordingStates[audioSource];
  
  if (state.process) {
    state.process.kill("SIGINT");
    state.process = null;
  }
  
  state.audioFormat = null;
  state.audioStreamParser = null;
  state.isActive = false;
}

// Enhanced startRecording function with audio source parameter
module.exports.startRecording = async (audioSource = 'system') => {
  console.log(`Starting ${audioSource} streaming recording...`);

  // For microphone, we might want to skip the screen recording permission check
  if (audioSource === 'system') {
    const isPermissionGranted = await checkPermissions();

    if (!isPermissionGranted) {
      const errorMsg = 'Screen recording permission not granted. Please enable it in System Preferences > Privacy & Security > Screen Recording.';
      console.error(errorMsg);
      
      // If we have a main window, show the permission denied screen
      if (global.mainWindow) {
        global.mainWindow.loadFile("./src/electron/screens/permission-denied/screen.html");
      }
      
      // Also emit to web clients
      if (global.io) {
        global.io.emit('permission-denied');
      }

      throw new Error(errorMsg);
    }
  }

  // Try to start streaming
  try {
    const result = await initStreaming(audioSource);
    console.log(`${audioSource} streaming started successfully:`, result);
    return result;
  } catch (error) {
    console.error(`Failed to start ${audioSource} streaming:`, error.message);
    
    // Clean up this specific source
    cleanupRecording(audioSource);
    stopDeepGramStream(audioSource);

    // Emit error to web clients
    if (global.io) {
      global.io.emit('recording-error', { message: error.message, source: audioSource });
    }

    throw error;
  }
};

// Enhanced stopRecording function with audio source parameter
module.exports.stopRecording = (audioSource = null) => {
  if (audioSource) {
    console.log(`Stopping ${audioSource} streaming recording`);
    stopDeepGramStream(audioSource);
    cleanupRecording(audioSource);
  } else {
    console.log('Stopping all streaming recordings');
    // Stop all active recordings
    Object.keys(recordingStates).forEach(source => {
      if (recordingStates[source].isActive) {
        stopDeepGramStream(source);
        cleanupRecording(source);
      }
    });
  }
};

// New function to check if a source is active
module.exports.isRecordingActive = (audioSource) => {
  return recordingStates[audioSource].isActive;
};

// New function to get active sources
module.exports.getActiveSources = () => {
  return Object.keys(recordingStates).filter(source => recordingStates[source].isActive);
};
