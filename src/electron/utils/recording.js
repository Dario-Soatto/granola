const { spawn } = require("node:child_process");
const { checkPermissions } = require("./permission");
const { createClient } = require('@deepgram/sdk');

let recordingProcess = null;
let deepgramClient = null;
let deepgramConnection = null;
let audioFormat = null;
let currentAudioSource = 'system'; // Track which source is currently active

// Initialize DeepGram client
function initializeDeepGram() {
  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY environment variable is required');
  }
  
  deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
  console.log('DeepGram client initialized');
}

// Start DeepGram streaming connection
function startDeepGramStream(audioSource = 'system') {
  if (!deepgramClient) {
    initializeDeepGram();
  }

  // Store the audio source for transcription routing
  currentAudioSource = audioSource;

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
  deepgramConnection = deepgramClient.listen.live(deepgramConfig);

  // Handle DeepGram responses
  deepgramConnection.on('open', () => {
    console.log(`DeepGram connection opened for ${audioSource}`);
  });

  deepgramConnection.on('Results', (data) => {
    const result = data.channel.alternatives[0];
    if (result && result.transcript) {
      const transcriptionData = {
        text: result.transcript,
        is_final: data.is_final,
        confidence: result.confidence,
        timestamp: new Date().toISOString(),
        source: currentAudioSource // Include source information
      };

      console.log(`DeepGram ${currentAudioSource} ${data.is_final ? 'FINAL' : 'interim'}:`, result.transcript);

      // Send transcription to clients via Socket.io with source information
      if (global.io) {
        global.io.emit('transcription-chunk', transcriptionData);
      }
    }
  });

  deepgramConnection.on('Metadata', (data) => {
    console.log(`DeepGram ${currentAudioSource} metadata:`, data);
  });

  deepgramConnection.on('Error', (error) => {
    console.error(`DeepGram ${currentAudioSource} error:`, error);
    
    // Emit error to web clients
    if (global.io) {
      global.io.emit('transcription-error', { message: error.message, source: currentAudioSource });
    }
  });

  deepgramConnection.on('Close', () => {
    console.log(`DeepGram ${currentAudioSource} connection closed`);
  });

  return deepgramConnection;
}

// Stop DeepGram streaming
function stopDeepGramStream() {
  if (deepgramConnection) {
    console.log(`Closing DeepGram connection for ${currentAudioSource}...`);
    deepgramConnection.finish();
    deepgramConnection = null;
  }
  currentAudioSource = 'system'; // Reset to default
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

const initStreaming = (audioSource = 'system') => {
  return new Promise((resolve, reject) => {
    console.log(`Starting ${audioSource} audio streaming process...`);
    
    // Build command arguments based on audio source
    const args = ['--stream'];
    if (audioSource === 'microphone') {
      args.push('--microphone');
    }
    
    // Start Swift recorder with appropriate arguments
    recordingProcess = spawn("./src/swift/Recorder", args);
    
    let hasResolved = false;
    let audioStreamParser = new AudioStreamParser();

    const timeout = setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        console.error('Recording process timed out after 10 seconds');
        if (recordingProcess) {
          recordingProcess.kill('SIGKILL');
          recordingProcess = null;
        }
        reject(new Error('Recording process timed out - this may indicate a system permissions issue'));
      }
    }, 10000);

    // Handle JSON status messages from stderr
    recordingProcess.stderr.on("data", (data) => {
      try {
        const lines = data.toString().split("\n").filter((line) => line.trim() !== "");
        
        for (const line of lines) {
          // Skip debug messages that aren't JSON
          if (line.startsWith('Streamed ')) {
            continue;
          }

          try {
            const response = JSON.parse(line);
            console.log('Swift recorder status:', response);
            
            if (response.code === "RECORDING_STARTED") {
              if (!hasResolved) {
                clearTimeout(timeout);
                hasResolved = true;
                
                audioFormat = response.audio_format;
                const timestamp = new Date(response.timestamp).getTime();
                const source = response.source || 'system'; // Fallback for backward compatibility

                // Start DeepGram streaming with the correct source
                try {
                  startDeepGramStream(source);
                } catch (error) {
                  console.error('Failed to start DeepGram:', error);
                  reject(error);
                  return;
                }

                // Send to Electron window if it exists
                if (global.mainWindow && global.mainWindow.webContents) {
                  global.mainWindow.webContents.send("recording-status", "START_RECORDING", timestamp, "streaming");
                }

                // Send to web clients via Socket.io
                if (global.io) {
                  global.io.emit('recording-started', {
                    startTime: timestamp,
                    streaming: true,
                    audioFormat: audioFormat,
                    source: source
                  });
                }

                // Update global recording state
                if (global.recordingState) {
                  global.recordingState.isRecording = true;
                  global.recordingState.startTime = timestamp;
                  global.recordingState.outputPath = 'streaming';
                  global.recordingState.source = source;
                }

                resolve({ success: true, streaming: true, timestamp, audioFormat, source });
              }
              return;
            }
            
            if (response.code === "RECORDING_STOPPED") {
              const timestamp = new Date(response.timestamp).getTime();

              // Stop DeepGram streaming
              stopDeepGramStream();

              // Send to Electron window if it exists
              if (global.mainWindow && global.mainWindow.webContents) {
                global.mainWindow.webContents.send("recording-status", "STOP_RECORDING", timestamp, "streaming");
              }

              // Send to web clients via Socket.io
              if (global.io) {
                global.io.emit('recording-stopped');
              }

              // Update global recording state
              if (global.recordingState) {
                global.recordingState.isRecording = false;
                global.recordingState.startTime = null;
                global.recordingState.source = null;
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
              reject(new Error(errorCodes[response.code]));
              return;
            }

          } catch (parseError) {
            // Not JSON, probably debug output - ignore
            console.log('Swift recorder debug:', line);
          }
        }
      } catch (error) {
        console.error('Error processing Swift recorder stderr:', error);
      }
    });

    // Handle binary audio data from stdout
    recordingProcess.stdout.on("data", (data) => {
      if (!deepgramConnection) {
        console.log('Received audio data but DeepGram not connected yet, buffering...');
        return;
      }

      // Parse the audio packets with source identification
      const audioChunks = audioStreamParser.processData(data);
      
      // Forward each audio chunk to DeepGram
      for (const audioChunk of audioChunks) {
        try {
          console.log(`Processing audio chunk from ${audioChunk.source} (${audioChunk.data.length} bytes)`);
          deepgramConnection.send(audioChunk.data);
        } catch (error) {
          console.error(`Error sending ${audioChunk.source} audio to DeepGram:`, error);
        }
      }
    });

    recordingProcess.on("error", (error) => {
      if (!hasResolved) {
        clearTimeout(timeout);
        hasResolved = true;
        console.error('Recording process error:', error);
        reject(new Error(`Failed to start recording process: ${error.message}`));
      }
    });

    recordingProcess.on("exit", (code, signal) => {
      console.log('Recording process exited with code:', code, 'signal:', signal);
      
      // Clean up DeepGram connection
      stopDeepGramStream();
      
      if (!hasResolved) {
        clearTimeout(timeout);
        hasResolved = true;
        
        if (code === 0) {
          reject(new Error('Recording process completed without starting recording. This may indicate a permissions or system audio issue.'));
        } else {
          reject(new Error(`Recording process exited with error code ${code}`));
        }
      }
    });
  });
};

// Enhanced startRecording function with audio source parameter
module.exports.startRecording = async (audioSource = 'system') => {
  console.log(`Starting ${audioSource} streaming recording...`);

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

  // Try to start streaming
  try {
    const result = await initStreaming(audioSource);
    console.log('Streaming started successfully:', result);
    return result;
  } catch (error) {
    console.error('Failed to start streaming:', error.message);
    
    // Clean up any leftover process
    if (recordingProcess) {
      recordingProcess.kill('SIGKILL');
      recordingProcess = null;
    }

    // Clean up DeepGram
    stopDeepGramStream();

    // Update recording state
    if (global.recordingState) {
      global.recordingState.isRecording = false;
      global.recordingState.startTime = null;
      global.recordingState.source = null;
    }

    // Emit error to web clients
    if (global.io) {
      global.io.emit('recording-error', { message: error.message });
    }

    throw error;
  }
};

module.exports.stopRecording = () => {
  console.log('Stopping streaming recording');
  
  if (recordingProcess !== null) {
    recordingProcess.kill("SIGINT");
    recordingProcess = null;
  }
  
  // Also stop DeepGram connection
  stopDeepGramStream();
};
