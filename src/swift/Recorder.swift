import AVFoundation
import ScreenCaptureKit
import Foundation

enum AudioSource {
    case system
    case microphone
}

class RecorderCLI: NSObject, SCStreamDelegate, SCStreamOutput {
    static var screenCaptureStream: SCStream?
    var contentEligibleForSharing: SCShareableContent?
    let semaphoreRecordingStopped = DispatchSemaphore(value: 0)
    var streamFunctionTimeout: TimeInterval = 3.0
    var recordingStarted = false
    
    // Audio streaming properties
    var audioFormat: AVAudioFormat?
    let stderrHandle = FileHandle.standardError
    
    // Microphone recording properties
    var audioEngine: AVAudioEngine?
    var microphoneNode: AVAudioInputNode?
    var audioSource: AudioSource = .system
    
    override init() {
        super.init()
        processCommandLineArguments()
    }

    func processCommandLineArguments() {
        let arguments = CommandLine.arguments
        
        // Check for permission request
        if arguments.contains("--check-permissions") {
            if arguments.contains("--microphone") {
                PermissionsRequester.requestMicrophoneAccess { granted in
                    if granted {
                        ResponseHandler.returnResponse(["code": "PERMISSION_GRANTED", "source": "microphone"])
                    } else {
                        ResponseHandler.returnResponse(["code": "PERMISSION_DENIED", "source": "microphone"])
                    }
                }
            } else {
                PermissionsRequester.requestScreenCaptureAccess { granted in
                    if granted {
                        ResponseHandler.returnResponse(["code": "PERMISSION_GRANTED", "source": "system"])
                    } else {
                        ResponseHandler.returnResponse(["code": "PERMISSION_DENIED", "source": "system"])
                    }
                }
            }
            return
        }
        
        // Determine audio source
        if arguments.contains("--microphone") {
            audioSource = .microphone
            if !arguments.contains("--stream") {
                ResponseHandler.returnResponse(["code": "INVALID_ARGUMENTS", "error": "Use --stream with --microphone to start microphone streaming"])
                return
            }
        } else if arguments.contains("--stream") {
            audioSource = .system
        } else {
            ResponseHandler.returnResponse(["code": "INVALID_ARGUMENTS", "error": "Use --stream for system audio or --stream --microphone for microphone audio"])
            return
        }
    }

    func executeRecordingProcess() {
        switch audioSource {
        case .system:
            self.updateAvailableContent()
        case .microphone:
            self.setupMicrophoneRecording()
        }
        
        setupInterruptSignalHandler()
        setupStreamFunctionTimeout()
        semaphoreRecordingStopped.wait()
    }

    func setupInterruptSignalHandler() {
        let interruptSignalHandler: @convention(c) (Int32) -> Void = { signal in
            if signal == SIGINT {
                RecorderCLI.terminateRecording()
                let timestamp = Date()
                let formattedTimestamp = ISO8601DateFormatter().string(from: timestamp)
                ResponseHandler.returnResponse(["code": "RECORDING_STOPPED", "timestamp": formattedTimestamp])
            }
        }
        signal(SIGINT, interruptSignalHandler)
    }

    func setupStreamFunctionTimeout() {
        DispatchQueue.global().asyncAfter(deadline: .now() + streamFunctionTimeout) { [weak self] in
            guard let self = self else { return }
            
            if !self.recordingStarted {
                // If recording hasn't started yet, send started message anyway
                let timestamp = Date()
                let formattedTimestamp = ISO8601DateFormatter().string(from: timestamp)
                self.recordingStarted = true
                ResponseHandler.returnResponse([
                    "code": "RECORDING_STARTED", 
                    "timestamp": formattedTimestamp,
                    "streaming": true,
                    "source": self.audioSource == .system ? "system" : "microphone"
                ], shouldExitProcess: false)
            }
        }
    }

    // MARK: - System Audio Recording (existing functionality)
    
    func updateAvailableContent() {
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, error in
            guard let self = self else { return }
            
            if let error = error {
                ResponseHandler.returnResponse(["code": "CONTENT_FETCH_FAILED", "error": error.localizedDescription])
                return
            }
            
            self.contentEligibleForSharing = content
            self.setupRecordingEnvironment()
        }
    }

    func setupRecordingEnvironment() {
        guard let firstDisplay = contentEligibleForSharing?.displays.first else {
            ResponseHandler.returnResponse(["code": "NO_DISPLAY_FOUND"])
            return
        }

        let screenContentFilter = SCContentFilter(display: firstDisplay, excludingApplications: [], exceptingWindows: [])
        Task { await initiateRecording(with: screenContentFilter) }
    }

    func initiateRecording(with filter: SCContentFilter) async {
        let streamConfiguration = SCStreamConfiguration()
        configureStream(streamConfiguration)

        do {
            RecorderCLI.screenCaptureStream = SCStream(filter: filter, configuration: streamConfiguration, delegate: self)
            try RecorderCLI.screenCaptureStream?.addStreamOutput(self, type: .audio, sampleHandlerQueue: .global())
            try await RecorderCLI.screenCaptureStream?.startCapture()
        } catch {
            ResponseHandler.returnResponse(["code": "CAPTURE_FAILED", "error": error.localizedDescription])
        }
    }

    func configureStream(_ configuration: SCStreamConfiguration) {
        // Minimal video capture (we only want audio)
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale.max)
        configuration.showsCursor = false
        
        // Audio configuration optimized for speech transcription
        configuration.capturesAudio = true
        configuration.sampleRate = 16000  // 16kHz is optimal for speech recognition
        configuration.channelCount = 1    // Mono is sufficient for transcription
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        // Send recording started message on first audio sample
        if !self.recordingStarted {
            self.recordingStarted = true
            let timestamp = Date()
            let formattedTimestamp = ISO8601DateFormatter().string(from: timestamp)
            
            // Send audio format info to Node.js
            if let formatDescription = sampleBuffer.formatDescription {
                let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
                if let asbd = asbd {
                    let audioInfo = [
                        "code": "RECORDING_STARTED",
                        "timestamp": formattedTimestamp,
                        "streaming": true,
                        "source": "system",
                        "audio_format": [
                            "sample_rate": asbd.pointee.mSampleRate,
                            "channels": asbd.pointee.mChannelsPerFrame,
                            "bits_per_channel": asbd.pointee.mBitsPerChannel,
                            "format_id": asbd.pointee.mFormatID
                        ]
                    ] as [String : Any]
                    
                    ResponseHandler.returnResponse(audioInfo, shouldExitProcess: false)
                }
            }
        }
        
        // Convert sample buffer to raw PCM data and stream it
        guard let audioBuffer = sampleBuffer.asPCMBuffer, sampleBuffer.isValid else { return }
        
        // Stream the raw audio data to stdout with source identification
        streamAudioData(from: audioBuffer, source: .system)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        ResponseHandler.returnResponse(["code": "STREAM_ERROR", "error": error.localizedDescription], shouldExitProcess: false)
        RecorderCLI.terminateRecording()
        semaphoreRecordingStopped.signal()
    }

    // MARK: - Microphone Recording (new functionality)
    
    func setupMicrophoneRecording() {
        audioEngine = AVAudioEngine()
        
        guard let audioEngine = audioEngine else {
            ResponseHandler.returnResponse(["code": "MICROPHONE_SETUP_FAILED", "error": "Failed to create audio engine"])
            return
        }
        
        microphoneNode = audioEngine.inputNode
        
        guard let microphoneNode = microphoneNode else {
            ResponseHandler.returnResponse(["code": "MICROPHONE_SETUP_FAILED", "error": "Failed to get microphone input node"])
            return
        }
        
        // Use the microphone's native format to avoid sample rate mismatch
        let inputFormat = microphoneNode.inputFormat(forBus: 0)
        
        // Store the native format for reporting
        self.audioFormat = inputFormat
        
        // Install tap using the native format
        microphoneNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] (buffer, time) in
            guard let self = self else { return }
            
            // Send recording started message on first audio sample
            if !self.recordingStarted {
                self.recordingStarted = true
                let timestamp = Date()
                let formattedTimestamp = ISO8601DateFormatter().string(from: timestamp)
                
                let audioInfo = [
                    "code": "RECORDING_STARTED",
                    "timestamp": formattedTimestamp,
                    "streaming": true,
                    "source": "microphone",
                    "audio_format": [
                        "sample_rate": inputFormat.sampleRate,
                        "channels": inputFormat.channelCount,
                        "bits_per_channel": 16, // We convert to Int16
                        "format_id": kAudioFormatLinearPCM
                    ]
                ] as [String : Any]
                
                ResponseHandler.returnResponse(audioInfo, shouldExitProcess: false)
            }
            
            // Convert to our target format if needed and stream the microphone audio data
            self.streamMicrophoneAudioData(from: buffer, originalFormat: inputFormat)
        }
        
        // Start the audio engine
        do {
            try audioEngine.start()
        } catch {
            ResponseHandler.returnResponse(["code": "MICROPHONE_START_FAILED", "error": error.localizedDescription])
        }
    }
    
    func streamMicrophoneAudioData(from buffer: AVAudioPCMBuffer, originalFormat: AVAudioFormat) {
        // If the buffer is already in a compatible format, use it directly
        if originalFormat.sampleRate == 16000 && originalFormat.channelCount == 1 {
            streamAudioData(from: buffer, source: .microphone)
            return
        }
        
        // Otherwise, we need to convert the audio format
        // For now, we'll resample and convert to mono if needed
        guard let convertedBuffer = convertAudioBuffer(buffer, 
                                                      from: originalFormat, 
                                                      toSampleRate: 16000, 
                                                      toChannels: 1) else {
            return
        }
        
        streamAudioData(from: convertedBuffer, source: .microphone)
    }
    
    func convertAudioBuffer(_ inputBuffer: AVAudioPCMBuffer, 
                           from inputFormat: AVAudioFormat, 
                           toSampleRate targetSampleRate: Double, 
                           toChannels targetChannels: UInt32) -> AVAudioPCMBuffer? {
        
        // Create target format
        guard let targetFormat = AVAudioFormat(standardFormatWithSampleRate: targetSampleRate, 
                                              channels: AVAudioChannelCount(targetChannels)) else {
            return nil
        }
        
        // Create converter
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            return nil
        }
        
        // Calculate output buffer size
        let inputFrameCount = inputBuffer.frameLength
        let outputFrameCount = UInt32(Double(inputFrameCount) * targetSampleRate / inputFormat.sampleRate)
        
        // Create output buffer
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputFrameCount) else {
            return nil
        }
        
        // Perform conversion
        var error: NSError?
        let inputBlock: AVAudioConverterInputBlock = { inNumPackets, outStatus in
            outStatus.pointee = .haveData
            return inputBuffer
        }
        
        converter.convert(to: outputBuffer, error: &error, withInputFrom: inputBlock)
        
        if error != nil {
            return nil
        }
        
        return outputBuffer
    }
    
    func streamAudioData(from buffer: AVAudioPCMBuffer, source: AudioSource) {
        guard let floatChannelData = buffer.floatChannelData else { return }
        
        let frameLength = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        
        // Convert Float32 to Int16 for better compression and compatibility
        var int16Data = [Int16]()
        int16Data.reserveCapacity(frameLength * channelCount)
        
        for frame in 0..<frameLength {
            for channel in 0..<channelCount {
                let floatSample = floatChannelData[channel][frame]
                // Convert float (-1.0 to 1.0) to int16 (-32768 to 32767)
                let int16Sample = Int16(max(-32768, min(32767, floatSample * 32767.0)))
                int16Data.append(int16Sample)
            }
        }
        
        // Create binary packet with length prefix for Node.js to parse
        let audioDataBytes = int16Data.withUnsafeBufferPointer { buffer in
            Data(buffer: buffer)
        }
        
        // Add source identifier byte (0x01 for system, 0x02 for microphone)
        let sourceIdentifier: UInt8 = source == .system ? 0x01 : 0x02
        let sourceData = Data([sourceIdentifier])
        
        // Write length prefix (4 bytes) + source (1 byte) + audio data
        var lengthBytes = UInt32(audioDataBytes.count + 1).bigEndian // +1 for source byte
        let lengthData = Data(bytes: &lengthBytes, count: 4)
        
        // Write to stdout (Node.js will read this)
        FileHandle.standardOutput.write(lengthData)
        FileHandle.standardOutput.write(sourceData)
        FileHandle.standardOutput.write(audioDataBytes)
        
        // Debug info to stderr (so it doesn't interfere with audio stream)
        if frameLength > 0 {
            let sourceName = source == .system ? "system" : "microphone"
            let debugInfo = "Streamed \(audioDataBytes.count) bytes (\(frameLength) frames) from \(sourceName)\n"
            if let debugData = debugInfo.data(using: .utf8) {
                stderrHandle.write(debugData)
            }
        }
    }

    static func terminateRecording() {
        screenCaptureStream?.stopCapture()
        screenCaptureStream = nil
    }
}

class PermissionsRequester {
    static func requestScreenCaptureAccess(completion: @escaping (Bool) -> Void) {
        if !CGPreflightScreenCaptureAccess() {
            let result = CGRequestScreenCaptureAccess()
            completion(result)
        } else {
            completion(true)
        }
    }
    
    static func requestMicrophoneAccess(completion: @escaping (Bool) -> Void) {
        // On macOS, we use AVAudioEngine permission model
        // The system will automatically prompt for microphone permission when we try to access it
        // For now, we'll return true and let the system handle the permission prompt
        
        // Check if we can create an AVAudioEngine and access input node
        let audioEngine = AVAudioEngine()
        let inputNode = audioEngine.inputNode
        
        // Try to install a temporary tap to trigger permission request
        let format = inputNode.inputFormat(forBus: 0)
        
        do {
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { _, _ in
                // This tap will trigger the microphone permission prompt if needed
            }
            
            try audioEngine.start()
            
            // If we get here, permission was granted
            audioEngine.stop()
            inputNode.removeTap(onBus: 0)
            completion(true)
            
        } catch {
            // Permission denied or other error
            completion(false)
        }
    }
}

class ResponseHandler {
    static func returnResponse(_ response: [String: Any], shouldExitProcess: Bool = true) {
        // Send JSON responses to stderr to keep stdout clean for audio data
        if let jsonData = try? JSONSerialization.data(withJSONObject: response),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            let message = jsonString + "\n"
            if let messageData = message.data(using: .utf8) {
                FileHandle.standardError.write(messageData)
            }
        }

        if shouldExitProcess {
            exit(0)
        }
    }
}

// Extension to convert CMSampleBuffer to AVAudioPCMBuffer
extension CMSampleBuffer {
    var asPCMBuffer: AVAudioPCMBuffer? {
        try? self.withAudioBufferList { audioBufferList, _ -> AVAudioPCMBuffer? in
            guard let absd = self.formatDescription?.audioStreamBasicDescription else { return nil }
            guard let format = AVAudioFormat(standardFormatWithSampleRate: absd.mSampleRate, channels: absd.mChannelsPerFrame) else { return nil }
            return AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: audioBufferList.unsafePointer)
        }
    }
}

let app = RecorderCLI()
app.executeRecordingProcess()

