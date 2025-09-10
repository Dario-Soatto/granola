const { spawn } = require("node:child_process");
const { checkPermissions } = require("./permission");
const { createClient } = require('@deepgram/sdk');

let recordingProcess = null;
let deepgramClient = null;
let deepgramConnection = null;
let audioFormat = null;

// Initialize DeepGram client
function initializeDeepGram() {
  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY environment variable is required');
  }
  
  deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
  console.log('DeepGram client initialized');
}

// Start DeepGram streaming connection
function startDeepGramStream() {
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

  console.log('Starting DeepGram streaming connection...');
  deepgramConnection = deepgramClient.listen.live(deepgramConfig);

  // Handle DeepGram responses
  deepgramConnection.on('open', () => {
    console.log('DeepGram connection opened');
  });

  deepgramConnection.on('Results', (data) => {
    const result = data.channel.alternatives[0];
    if (result && result.transcript) {
      const transcriptionData = {
        text: result.transcript,
        is_final: data.is_final,
        confidence: result.confidence,
        timestamp: new Date().toISOString()
      };

      console.log(`DeepGram ${data.is_final ? 'FINAL' : 'interim'}:`, result.transcript);

      // Send transcription to clients via Socket.io
      if (global.io) {
        global.io.emit('transcription-chunk', transcriptionData);
      }
    }
  });

  deepgramConnection.on('Metadata', (data) => {
    console.log('DeepGram metadata:', data);
  });

  deepgramConnection.on('Error', (error) => {
    console.error('DeepGram error:', error);
    
    // Emit error to web clients
    if (global.io) {
      global.io.emit('transcription-error', { message: error.message });
    }
  });

  deepgramConnection.on('Close', () => {
    console.log('DeepGram connection closed');
  });

  return deepgramConnection;
}

// Stop DeepGram streaming
function stopDeepGramStream() {
  if (deepgramConnection) {
    console.log('Closing DeepGram connection...');
    deepgramConnection.finish();
    deepgramConnection = null;
  }
}

// Parse binary audio stream from Swift
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

      // Check if we have a complete audio packet
      if (this.buffer.length >= this.expectedLength) {
        // Extract the audio data
        const audioData = this.buffer.subarray(0, this.expectedLength);
        audioChunks.push(audioData);

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

const initStreaming = () => {
  return new Promise((resolve, reject) => {
    console.log('Starting audio streaming process...');
    
    // Start Swift recorder in streaming mode
    recordingProcess = spawn("./src/swift/Recorder", ["--stream"]);
    
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

                // Start DeepGram streaming
                try {
                  startDeepGramStream();
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
                    audioFormat: audioFormat
                  });
                }

                // Update global recording state
                if (global.recordingState) {
                  global.recordingState.isRecording = true;
                  global.recordingState.startTime = timestamp;
                  global.recordingState.outputPath = 'streaming';
                }

                resolve({ success: true, streaming: true, timestamp, audioFormat });
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
              }

              return;
            }

            // Handle error cases
            if (response.code === "PERMISSION_DENIED") {
              if (!hasResolved) {
                clearTimeout(timeout);
                hasResolved = true;
                reject(new Error('Screen recording permission denied. Please grant permission in System Preferences > Privacy & Security > Screen Recording.'));
              }
              return;
            }

            // Handle other error codes...
            const errorCodes = {
              "NO_DISPLAY_FOUND": "No display found for recording. Please ensure your display is connected and active.",
              "CAPTURE_FAILED": response.error ? `Failed to start screen capture: ${response.error}` : 'Failed to start screen capture',
              "CONTENT_FETCH_FAILED": response.error ? `Failed to fetch screen content: ${response.error}` : 'Failed to fetch screen content',
              "STREAM_ERROR": response.error ? `Stream error: ${response.error}` : 'Recording stream encountered an error',
              "INVALID_ARGUMENTS": 'Invalid arguments provided to recorder'
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

      // Parse the length-prefixed audio packets
      const audioChunks = audioStreamParser.processData(data);
      
      // Forward each audio chunk to DeepGram
      for (const audioChunk of audioChunks) {
        try {
          deepgramConnection.send(audioChunk);
        } catch (error) {
          console.error('Error sending audio to DeepGram:', error);
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

module.exports.startRecording = async () => {
  console.log('Starting streaming recording...');

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
    const result = await initStreaming();
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
