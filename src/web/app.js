class AudioRecorderApp {
    constructor() {
        this.socket = io();
        this.isRecording = false;
        this.startTime = null;
        this.timerInterval = null;
        this.isElectron = this.detectElectron();
        this.interimTranscription = '';
        this.finalTranscription = '';
        
        this.initializeElements();
        this.setupEventListeners();
        this.setupSocketListeners();
        this.checkPermissions();
        this.loadInitialState();
    }

    detectElectron() {
        // Check if we're running inside Electron
        return typeof window !== 'undefined' && window.process && window.process.type;
    }

    initializeElements() {
        // Remove folder/filename elements - no longer needed for streaming
        this.startBtn = document.getElementById('start-btn');
        this.stopBtn = document.getElementById('stop-btn');
        this.recordingStatus = document.getElementById('recording-status');
        this.elapsedTime = document.getElementById('elapsed-time');
        this.outputPath = document.getElementById('output-path');
        this.permissionStatus = document.getElementById('permission-status');
        this.permissionGranted = document.getElementById('permission-granted');
        this.permissionDenied = document.getElementById('permission-denied');
        this.transcriptionSection = document.getElementById('transcription-section');
        this.transcriptionText = document.getElementById('transcription-text');
        this.transcriptionStatus = document.getElementById('transcription-status');
        
        // Add new elements for streaming info
        this.streamingStatus = document.getElementById('streaming-status');
        this.audioFormat = document.getElementById('audio-format');
    }

    setupEventListeners() {
        this.startBtn.addEventListener('click', () => this.startRecording());
        this.stopBtn.addEventListener('click', () => this.stopRecording());
    }

    setupSocketListeners() {
        this.socket.on('state-update', (state) => {
            this.updateUI(state);
        });

        this.socket.on('recording-started', (data) => {
            this.isRecording = true;
            this.startTime = data.startTime;
            this.updateRecordingUI();
            this.startTimer();
            
            // Show streaming info
            if (data.streaming) {
                this.outputPath.textContent = 'Streaming to DeepGram';
                if (data.audioFormat) {
                    const format = data.audioFormat;
                    this.audioFormat.textContent = `${format.sample_rate}Hz, ${format.channels}ch`;
                }
            }
        });

        this.socket.on('recording-stopped', () => {
            this.isRecording = false;
            this.startTime = null;
            this.updateRecordingUI();
            this.stopTimer();
        });

        this.socket.on('permission-denied', () => {
            this.permissionStatus.classList.remove('hidden');
            this.permissionGranted.classList.add('hidden');
            this.permissionDenied.classList.remove('hidden');
            this.startBtn.disabled = true;
        });

        this.socket.on('recording-error', (data) => {
            alert('Recording Error: ' + data.message);
            this.isRecording = false;
            this.updateRecordingUI();
        });

        // Handle real-time transcription from DeepGram
        this.socket.on('transcription-chunk', (data) => {
            this.handleTranscriptionChunk(data);
        });

        this.socket.on('transcription-error', (data) => {
            console.error('Transcription error:', data.message);
            this.transcriptionStatus.textContent = 'Transcription error: ' + data.message;
        });
    }

    async loadInitialState() {
        try {
            const response = await fetch('/api/status');
            const state = await response.json();
            this.updateUI(state);
        } catch (error) {
            console.error('Error loading initial state:', error);
        }
    }

    async checkPermissions() {
        try {
            const response = await fetch('/api/permissions');
            const data = await response.json();
            
            this.permissionStatus.classList.remove('hidden');
            
            if (data.hasPermission) {
                this.permissionGranted.classList.remove('hidden');
                this.permissionDenied.classList.add('hidden');
            } else {
                this.permissionGranted.classList.add('hidden');
                this.permissionDenied.classList.remove('hidden');
                this.startBtn.disabled = true;
            }
        } catch (error) {
            console.error('Error checking permissions:', error);
        }
    }

    async startRecording() {
        try {
            this.startBtn.disabled = true;
            this.startBtn.textContent = 'Starting...';

            const response = await fetch('/api/recording/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to start recording');
            }

            console.log('Streaming recording started:', data);

        } catch (error) {
            console.error('Error starting recording:', error);
            alert('Error starting recording: ' + error.message);
            this.startBtn.disabled = false;
            this.startBtn.textContent = 'Start Recording';
        }
    }

    async stopRecording() {
        try {
            const response = await fetch('/api/recording/stop', {
                method: 'POST',
            });

            if (!response.ok) {
                throw new Error('Failed to stop recording');
            }

        } catch (error) {
            console.error('Error stopping recording:', error);
            alert('Error stopping recording: ' + error.message);
        }
    }

    updateUI(state) {
        this.isRecording = state.isRecording;
        this.startTime = state.startTime;
        
        if (state.streaming) {
            this.outputPath.textContent = 'Streaming to DeepGram';
            if (state.audioFormat) {
                const format = state.audioFormat;
                this.audioFormat.textContent = `${format.sample_rate}Hz, ${format.channels}ch`;
            }
        }
        
        this.updateRecordingUI();
        
        if (this.isRecording && this.startTime) {
            this.startTimer();
        }
    }

    updateRecordingUI() {
        if (this.isRecording) {
            this.startBtn.disabled = true;
            this.stopBtn.disabled = false;
            this.recordingStatus.classList.remove('hidden');
            this.transcriptionSection.classList.remove('hidden');
            this.transcriptionStatus.classList.remove('hidden');
            this.startBtn.textContent = 'Recording...';
            
            // Clear previous transcription
            this.finalTranscription = '';
            this.interimTranscription = '';
            this.transcriptionText.textContent = '';
            this.transcriptionStatus.textContent = 'Listening for speech...';
            
        } else {
            this.startBtn.disabled = false;
            this.stopBtn.disabled = true;
            this.recordingStatus.classList.add('hidden');
            this.startBtn.textContent = 'Start Recording';
            this.transcriptionStatus.textContent = 'Recording stopped';
        }
    }

    startTimer() {
        this.stopTimer(); // Clear any existing timer
        
        this.timerInterval = setInterval(() => {
            if (this.startTime) {
                const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
                const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
                const seconds = (elapsed % 60).toString().padStart(2, '0');
                this.elapsedTime.textContent = `${minutes}:${seconds}`;
            }
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        this.elapsedTime.textContent = '00:00';
    }

    handleTranscriptionChunk(data) {
        // Show transcription section if hidden
        this.transcriptionSection.classList.remove('hidden');
        this.transcriptionStatus.classList.remove('hidden');
        
        if (data.is_final) {
            // Final result - add to permanent transcription
            this.finalTranscription += data.text + ' ';
            this.interimTranscription = ''; // Clear interim
            this.transcriptionStatus.textContent = 'Listening for speech...';
        } else {
            // Interim result - update temporary text
            this.interimTranscription = data.text;
            this.transcriptionStatus.textContent = 'Processing speech...';
        }
        
        // Display combined final + interim text
        const displayText = this.finalTranscription + this.interimTranscription;
        this.transcriptionText.textContent = displayText;
        
        // Auto-scroll to bottom
        const transcriptionDisplay = document.getElementById('transcription-display');
        if (transcriptionDisplay) {
            transcriptionDisplay.scrollTop = transcriptionDisplay.scrollHeight;
        }
        
        // Log confidence if available
        if (data.confidence && data.is_final) {
            console.log(`Transcription confidence: ${(data.confidence * 100).toFixed(1)}%`);
        }
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new AudioRecorderApp();
});