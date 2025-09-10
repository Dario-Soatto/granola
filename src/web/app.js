class DualAudioRecorderApp {
    constructor() {
        this.socket = io();
        
        // State for each audio source
        this.state = {
            system: {
                isRecording: false,
                startTime: null,
                timerInterval: null,
                finalTranscription: '',
                interimTranscription: ''
            },
            microphone: {
                isRecording: false,
                startTime: null,
                timerInterval: null,
                finalTranscription: '',
                interimTranscription: ''
            }
        };
        
        // Chronological transcription history for combined view
        this.chronologicalTranscriptions = [];
        this.currentInterimTranscriptions = {
            system: { text: '', timestamp: null },
            microphone: { text: '', timestamp: null }
        };
        
        this.currentTab = 'system';
        this.isElectron = this.detectElectron();
        
        this.initializeElements();
        this.setupEventListeners();
        this.setupSocketListeners();
        this.checkPermissions();
        this.loadInitialState();
    }

    detectElectron() {
        return typeof window !== 'undefined' && window.process && window.process.type;
    }

    initializeElements() {
        // Tab elements
        this.tabButtons = {
            system: document.getElementById('tab-system'),
            microphone: document.getElementById('tab-microphone'),
            combined: document.getElementById('tab-combined')
        };

        // Panel elements
        this.panels = {
            system: document.getElementById('panel-system'),
            microphone: document.getElementById('panel-microphone'),
            combined: document.getElementById('panel-combined')
        };

        // System audio elements
        this.systemElements = {
            startBtn: document.getElementById('system-start-btn'),
            stopBtn: document.getElementById('system-stop-btn'),
            recordingStatus: document.getElementById('system-recording-status'),
            elapsedTime: document.getElementById('system-elapsed-time'),
            outputPath: document.getElementById('system-output-path'),
            transcriptionSection: document.getElementById('system-transcription-section'),
            transcriptionText: document.getElementById('system-transcription-text'),
            transcriptionStatus: document.getElementById('system-transcription-status'),
            audioFormat: document.getElementById('system-audio-format')
        };

        // Microphone elements
        this.microphoneElements = {
            startBtn: document.getElementById('microphone-start-btn'),
            stopBtn: document.getElementById('microphone-stop-btn'),
            recordingStatus: document.getElementById('microphone-recording-status'),
            elapsedTime: document.getElementById('microphone-elapsed-time'),
            outputPath: document.getElementById('microphone-output-path'),
            transcriptionSection: document.getElementById('microphone-transcription-section'),
            transcriptionText: document.getElementById('microphone-transcription-text'),
            transcriptionStatus: document.getElementById('microphone-transcription-status'),
            audioFormat: document.getElementById('microphone-audio-format')
        };

        // Combined elements
        this.combinedElements = {
            startBothBtn: document.getElementById('start-both-btn'),
            stopAllBtn: document.getElementById('stop-all-btn'),
            transcriptionText: document.getElementById('combined-transcription-text'),
            systemStatus: document.getElementById('combined-system-status'),
            microphoneStatus: document.getElementById('combined-microphone-status')
        };

        // Permission elements
        this.permissionStatus = document.getElementById('permission-status');
        this.permissionGranted = document.getElementById('permission-granted');
        this.permissionDenied = document.getElementById('permission-denied');
    }

    setupEventListeners() {
        // System audio controls
        this.systemElements.startBtn.addEventListener('click', () => this.startRecording('system'));
        this.systemElements.stopBtn.addEventListener('click', () => this.stopRecording('system'));

        // Microphone controls
        this.microphoneElements.startBtn.addEventListener('click', () => this.startRecording('microphone'));
        this.microphoneElements.stopBtn.addEventListener('click', () => this.stopRecording('microphone'));

        // Combined controls - updated for concurrent operations
        this.combinedElements.startBothBtn.addEventListener('click', () => this.startBoth());
        this.combinedElements.stopAllBtn.addEventListener('click', () => this.stopAll());
    }

    setupSocketListeners() {
        this.socket.on('state-update', (state) => {
            this.updateUI(state);
        });

        this.socket.on('recording-started', (data) => {
            const source = data.source || 'system';
            this.handleRecordingStarted(source, data);
        });

        this.socket.on('recording-stopped', (data) => {
            if (data.source === 'all') {
                // Handle stop-all case
                data.stoppedSources?.forEach(source => {
                    this.handleRecordingStopped(source);
                });
            } else {
                const source = data.source || 'system';
                this.handleRecordingStopped(source);
            }
        });

        this.socket.on('permission-denied', () => {
            this.showPermissionError();
        });

        this.socket.on('recording-error', (data) => {
            const source = data.source || 'unknown';
            this.handleRecordingError(source, data.message);
        });

        this.socket.on('transcription-chunk', (data) => {
            // Handle transcription based on the source information
            const source = data.source || 'system';
            this.handleTranscriptionChunk(source, data);
        });

        this.socket.on('transcription-error', (data) => {
            const source = data.source || 'system';
            console.error(`Transcription error for ${source}:`, data.message);
            
            // Update the appropriate transcription status
            const elements = source === 'microphone' ? this.microphoneElements : this.systemElements;
            if (elements.transcriptionStatus) {
                elements.transcriptionStatus.textContent = `Transcription error: ${data.message}`;
            }
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
            const response = await fetch('/api/permissions/system');
            const data = await response.json();
            
            this.permissionStatus.classList.remove('hidden');
            
            if (data.hasPermission) {
                this.permissionGranted.classList.remove('hidden');
                this.permissionDenied.classList.add('hidden');
            } else {
                this.showPermissionError();
            }
        } catch (error) {
            console.error('Error checking permissions:', error);
        }
    }

    showPermissionError() {
        this.permissionStatus.classList.remove('hidden');
        this.permissionGranted.classList.add('hidden');
        this.permissionDenied.classList.remove('hidden');
        this.systemElements.startBtn.disabled = true;
        this.microphoneElements.startBtn.disabled = true;
        this.combinedElements.startBothBtn.disabled = true;
    }

    async startRecording(source) {
        const endpoint = source === 'microphone' ? '/api/recording/microphone/start' : '/api/recording/start';
        const elements = source === 'microphone' ? this.microphoneElements : this.systemElements;
        
        try {
            // Update UI immediately for better responsiveness
            elements.startBtn.disabled = true;
            elements.startBtn.textContent = 'Starting...';

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || `Failed to start ${source} recording`);
            }

            console.log(`${source} recording started:`, data);

        } catch (error) {
            console.error(`Error starting ${source} recording:`, error);
            alert(`Error starting ${source} recording: ` + error.message);
            
            // Reset UI on error
            elements.startBtn.disabled = false;
            elements.startBtn.textContent = source === 'microphone' ? '🎤 Start Microphone' : '🖥️ Start System Audio';
        }
    }

    async stopRecording(source) {
        const endpoint = source === 'microphone' ? '/api/recording/microphone/stop' : '/api/recording/stop';
        
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || `Failed to stop ${source} recording`);
            }

            console.log(`${source} recording stopped:`, data);

        } catch (error) {
            console.error(`Error stopping ${source} recording:`, error);
            alert(`Error stopping ${source} recording: ` + error.message);
        }
    }

    async startBoth() {
        this.combinedElements.startBothBtn.disabled = true;
        this.combinedElements.startBothBtn.textContent = 'Starting Both...';
        
        try {
            console.log('Starting both audio sources...');
            
            const response = await fetch('/api/recording/start-both', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to start both recordings');
            }

            console.log('Both recordings started:', data);

            // Show results to user
            if (data.errors && Object.keys(data.errors).length > 0) {
                const errorMessages = Object.entries(data.errors)
                    .map(([source, error]) => `${source}: ${error}`)
                    .join('\n');
                alert(`Partial success. Some sources failed:\n${errorMessages}`);
            } else {
                console.log('Both audio sources started successfully');
            }

        } catch (error) {
            console.error('Error starting both recordings:', error);
            alert('Error starting both recordings: ' + error.message);
        } finally {
            // Reset button state
            this.updateCombinedControls();
        }
    }

    async stopAll() {
        this.combinedElements.stopAllBtn.disabled = true;
        this.combinedElements.stopAllBtn.textContent = 'Stopping All...';
        
        try {
            const response = await fetch('/api/recording/stop-all', {
                method: 'POST',
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to stop all recordings');
            }

            console.log('All recordings stopped:', data);

        } catch (error) {
            console.error('Error stopping all recordings:', error);
            alert('Error stopping all recordings: ' + error.message);
        } finally {
            // Reset button state
            this.updateCombinedControls();
        }
    }

    handleRecordingStarted(source, data) {
        this.state[source].isRecording = true;
        this.state[source].startTime = data.startTime;
        
        const elements = source === 'microphone' ? this.microphoneElements : this.systemElements;
        
        elements.startBtn.disabled = true;
        elements.stopBtn.disabled = false;
        elements.recordingStatus.classList.remove('hidden');
        elements.transcriptionSection.classList.remove('hidden');
        elements.startBtn.textContent = 'Recording...';
        
        if (data.streaming) {
            elements.outputPath.textContent = 'Streaming to DeepGram';
            if (data.audioFormat) {
                const format = data.audioFormat;
                elements.audioFormat.textContent = `${format.sample_rate}Hz, ${format.channels}ch`;
            }
        }
        
        // Clear previous transcription for this source
        this.state[source].finalTranscription = '';
        this.state[source].interimTranscription = '';
        elements.transcriptionText.textContent = '';
        elements.transcriptionStatus.textContent = 'Listening for speech...';
        
        // Clear interim transcription for this source in combined view
        this.currentInterimTranscriptions[source] = { text: '', timestamp: null };
        
        this.startTimer(source);
        this.updateCombinedStatus();
        this.updateCombinedControls();
    }

    handleRecordingStopped(source) {
        this.state[source].isRecording = false;
        this.state[source].startTime = null;
        
        const elements = source === 'microphone' ? this.microphoneElements : this.systemElements;
        
        elements.startBtn.disabled = false;
        elements.stopBtn.disabled = true;
        elements.recordingStatus.classList.add('hidden');
        elements.startBtn.textContent = source === 'microphone' ? '🎤 Start Microphone' : '🖥️ Start System Audio';
        elements.transcriptionStatus.textContent = 'Recording stopped';
        
        // Clear interim transcription for this source
        this.currentInterimTranscriptions[source] = { text: '', timestamp: null };
        this.updateCombinedTranscription();
        
        this.stopTimer(source);
        this.updateCombinedStatus();
        this.updateCombinedControls();
    }

    handleRecordingError(source, message) {
        alert(`${source} Recording Error: ` + message);
        this.state[source].isRecording = false;
        this.updateRecordingUI(source);
        this.updateCombinedControls();
    }

    updateUI(state) {
        // Handle new dual-source state structure
        if (state.system && state.microphone) {
            this.updateSourceState('system', state.system);
            this.updateSourceState('microphone', state.microphone);
        } else {
            // Legacy single-source state - assume it's system audio
            this.updateSourceState('system', state);
        }
        
        this.updateCombinedStatus();
        this.updateCombinedControls();
    }

    updateSourceState(source, sourceState) {
        this.state[source].isRecording = sourceState.isRecording;
        this.state[source].startTime = sourceState.startTime;
        
        const elements = source === 'microphone' ? this.microphoneElements : this.systemElements;
        
        if (sourceState.streaming) {
            elements.outputPath.textContent = 'Streaming to DeepGram';
            if (sourceState.audioFormat) {
                const format = sourceState.audioFormat;
                elements.audioFormat.textContent = `${format.sample_rate}Hz, ${format.channels}ch`;
            }
        }
        
        this.updateRecordingUI(source);
        
        if (this.state[source].isRecording && this.state[source].startTime) {
            this.startTimer(source);
        }
    }

    updateRecordingUI(source) {
        const elements = source === 'microphone' ? this.microphoneElements : this.systemElements;
        const sourceState = this.state[source];
        
        if (sourceState.isRecording) {
            elements.startBtn.disabled = true;
            elements.stopBtn.disabled = false;
            elements.recordingStatus.classList.remove('hidden');
            elements.transcriptionSection.classList.remove('hidden');
            elements.startBtn.textContent = 'Recording...';
        } else {
            elements.startBtn.disabled = false;
            elements.stopBtn.disabled = true;
            elements.recordingStatus.classList.add('hidden');
            elements.startBtn.textContent = source === 'microphone' ? '🎤 Start Microphone' : '🖥️ Start System Audio';
        }
    }

    updateCombinedStatus() {
        const systemStatus = this.state.system.isRecording ? 'Recording' : 'Stopped';
        const microphoneStatus = this.state.microphone.isRecording ? 'Recording' : 'Stopped';
        
        this.combinedElements.systemStatus.textContent = systemStatus;
        this.combinedElements.microphoneStatus.textContent = microphoneStatus;
        
        // Update status colors
        this.combinedElements.systemStatus.className = this.state.system.isRecording ? 'ml-2 font-medium text-green-600' : 'ml-2 font-medium text-gray-500';
        this.combinedElements.microphoneStatus.className = this.state.microphone.isRecording ? 'ml-2 font-medium text-green-600' : 'ml-2 font-medium text-gray-500';
    }

    updateCombinedControls() {
        const systemActive = this.state.system.isRecording;
        const microphoneActive = this.state.microphone.isRecording;
        const anyActive = systemActive || microphoneActive;
        const bothActive = systemActive && microphoneActive;

        // Start Both button
        if (bothActive) {
            this.combinedElements.startBothBtn.disabled = true;
            this.combinedElements.startBothBtn.textContent = '✅ Both Active';
        } else if (anyActive) {
            this.combinedElements.startBothBtn.disabled = false;
            this.combinedElements.startBothBtn.textContent = systemActive ? '🎤 Add Microphone' : '🖥️ Add System Audio';
        } else {
            this.combinedElements.startBothBtn.disabled = false;
            this.combinedElements.startBothBtn.textContent = '🚀 Start Both';
        }

        // Stop All button
        this.combinedElements.stopAllBtn.disabled = !anyActive;
        if (bothActive) {
            this.combinedElements.stopAllBtn.textContent = '⏹️ Stop Both';
        } else if (anyActive) {
            this.combinedElements.stopAllBtn.textContent = systemActive ? '⏹️ Stop System' : '⏹️ Stop Microphone';
        } else {
            this.combinedElements.stopAllBtn.textContent = '⏹️ Stop All';
        }
    }

    startTimer(source) {
        this.stopTimer(source);
        
        const elements = source === 'microphone' ? this.microphoneElements : this.systemElements;
        
        this.state[source].timerInterval = setInterval(() => {
            if (this.state[source].startTime) {
                const elapsed = Math.floor((Date.now() - this.state[source].startTime) / 1000);
                const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
                const seconds = (elapsed % 60).toString().padStart(2, '0');
                elements.elapsedTime.textContent = `${minutes}:${seconds}`;
            }
        }, 1000);
    }

    stopTimer(source) {
        if (this.state[source].timerInterval) {
            clearInterval(this.state[source].timerInterval);
            this.state[source].timerInterval = null;
        }
        
        const elements = source === 'microphone' ? this.microphoneElements : this.systemElements;
        elements.elapsedTime.textContent = '00:00';
    }

    handleTranscriptionChunk(source, data) {
        const elements = source === 'microphone' ? this.microphoneElements : this.systemElements;
        const sourceState = this.state[source];
        
        elements.transcriptionSection.classList.remove('hidden');
        
        // Handle individual source transcription display
        if (data.is_final) {
            sourceState.finalTranscription += data.text + ' ';
            sourceState.interimTranscription = '';
            elements.transcriptionStatus.textContent = 'Listening for speech...';
            
            // Add to chronological history for combined view
            this.chronologicalTranscriptions.push({
                source: source,
                text: data.text,
                timestamp: new Date(data.timestamp).getTime(),
                is_final: true
            });
            
            // Clear interim for this source
            this.currentInterimTranscriptions[source] = { text: '', timestamp: null };
            
        } else {
            sourceState.interimTranscription = data.text;
            elements.transcriptionStatus.textContent = 'Processing speech...';
            
            // Update interim transcription for combined view
            this.currentInterimTranscriptions[source] = {
                text: data.text,
                timestamp: new Date(data.timestamp).getTime()
            };
        }
        
        // Update individual source display
        const displayText = sourceState.finalTranscription + sourceState.interimTranscription;
        elements.transcriptionText.textContent = displayText;
        
        // Update combined view with chronological ordering
        this.updateCombinedTranscription();
        
        // Auto-scroll individual source
        const transcriptionDisplay = document.getElementById(`${source}-transcription-display`);
        if (transcriptionDisplay) {
            transcriptionDisplay.scrollTop = transcriptionDisplay.scrollHeight;
        }
        
        if (data.confidence && data.is_final) {
            console.log(`${source} transcription confidence: ${(data.confidence * 100).toFixed(1)}%`);
        }
    }

    updateCombinedTranscription() {
        // Create a chronological list combining final and interim transcriptions
        const allTranscriptions = [];
        
        // Add all final transcriptions
        this.chronologicalTranscriptions.forEach(trans => {
            allTranscriptions.push(trans);
        });
        
        // Add current interim transcriptions
        Object.keys(this.currentInterimTranscriptions).forEach(source => {
            const interim = this.currentInterimTranscriptions[source];
            if (interim.text && interim.timestamp) {
                allTranscriptions.push({
                    source: source,
                    text: interim.text,
                    timestamp: interim.timestamp,
                    is_final: false
                });
            }
        });
        
        // Sort by timestamp
        allTranscriptions.sort((a, b) => a.timestamp - b.timestamp);
        
        // Build the combined text with source labels
        let combinedText = '';
        
        if (allTranscriptions.length === 0) {
            combinedText = 'Combined transcription will appear here when either source is active...';
        } else {
            allTranscriptions.forEach(trans => {
                const sourceLabel = trans.source === 'system' ? '🖥️ System' : '🎤 Microphone';
                const finalityIndicator = trans.is_final ? '' : ' (...)';
                combinedText += `${sourceLabel}: ${trans.text}${finalityIndicator}\n`;
            });
            
            // Remove trailing newline
            combinedText = combinedText.trim();
        }
        
        this.combinedElements.transcriptionText.textContent = combinedText;
        
        // Auto-scroll combined view
        const combinedDisplay = document.getElementById('combined-transcription-display');
        if (combinedDisplay) {
            combinedDisplay.scrollTop = combinedDisplay.scrollHeight;
        }
    }

    // Clear chronological transcription history when recordings start
    clearCombinedTranscriptionHistory() {
        this.chronologicalTranscriptions = [];
        this.currentInterimTranscriptions = {
            system: { text: '', timestamp: null },
            microphone: { text: '', timestamp: null }
        };
        this.updateCombinedTranscription();
    }
}

// Global functions for tab switching and utility actions
function switchTab(tabName) {
    const app = window.audioApp;
    if (!app) return;
    
    app.currentTab = tabName;
    
    // Update tab buttons
    Object.keys(app.tabButtons).forEach(key => {
        const button = app.tabButtons[key];
        if (key === tabName) {
            button.className = 'tab-button py-2 px-1 border-b-2 font-medium text-sm whitespace-nowrap border-blue-500 text-blue-600';
        } else {
            button.className = 'tab-button py-2 px-1 border-b-2 font-medium text-sm whitespace-nowrap border-transparent text-gray-500 hover:text-gray-700';
        }
    });
    
    // Update panel visibility
    Object.keys(app.panels).forEach(key => {
        const panel = app.panels[key];
        if (key === tabName) {
            panel.classList.remove('hidden');
        } else {
            panel.classList.add('hidden');
        }
    });
}

function clearTranscription(source) {
    const app = window.audioApp;
    if (!app) return;
    
    if (source === 'combined') {
        app.clearCombinedTranscriptionHistory();
    } else {
        const elements = source === 'microphone' ? app.microphoneElements : app.systemElements;
        app.state[source].finalTranscription = '';
        app.state[source].interimTranscription = '';
        elements.transcriptionText.textContent = `${source === 'microphone' ? 'Microphone' : 'System audio'} transcription will appear here...`;
        elements.transcriptionText.className += ' text-gray-400 italic';
        
        // Also clear from combined view history
        app.chronologicalTranscriptions = app.chronologicalTranscriptions.filter(trans => trans.source !== source);
        app.currentInterimTranscriptions[source] = { text: '', timestamp: null };
        app.updateCombinedTranscription();
    }
}

function copyTranscription(source) {
    const app = window.audioApp;
    if (!app) return;
    
    let text = '';
    if (source === 'combined') {
        text = app.combinedElements.transcriptionText.textContent;
    } else {
        const elements = source === 'microphone' ? app.microphoneElements : app.systemElements;
        text = elements.transcriptionText.textContent;
    }
    
    navigator.clipboard.writeText(text).then(() => {
        // Could add a toast notification here
        console.log(`${source} transcription copied to clipboard`);
    });
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.audioApp = new DualAudioRecorderApp();
});