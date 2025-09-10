import AVFoundation
import ScreenCaptureKit
import Foundation

class RecorderCLI: NSObject, SCStreamDelegate, SCStreamOutput {
    static var screenCaptureStream: SCStream?
    var contentEligibleForSharing: SCShareableContent?
    let semaphoreRecordingStopped = DispatchSemaphore(value: 0)
    var streamFunctionTimeout: TimeInterval = 3.0
    var recordingStarted = false
    
    // Audio streaming properties
    var audioFormat: AVAudioFormat?
    let stderrHandle = FileHandle.standardError
    
    override init() {
        super.init()
        processCommandLineArguments()
    }

    func processCommandLineArguments() {
        let arguments = CommandLine.arguments
        
        // Check for permission request
        if arguments.contains("--check-permissions") {
            PermissionsRequester.requestScreenCaptureAccess { granted in
                if granted {
                    ResponseHandler.returnResponse(["code": "PERMISSION_GRANTED"])
                } else {
                    ResponseHandler.returnResponse(["code": "PERMISSION_DENIED"])
                }
            }
            return
        }
        
        // For streaming, we don't need path or filename arguments
        if !arguments.contains("--stream") {
            ResponseHandler.returnResponse(["code": "INVALID_ARGUMENTS", "error": "Use --stream to start audio streaming"])
            return
        }
    }

    func executeRecordingProcess() {
        self.updateAvailableContent()
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
                    "streaming": true
                ], shouldExitProcess: false)
            }
        }
    }

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
        
        // Stream the raw audio data to stdout
        streamAudioData(from: audioBuffer)
    }
    
    func streamAudioData(from buffer: AVAudioPCMBuffer) {
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
        
        // Write length prefix (4 bytes) followed by audio data
        var lengthBytes = UInt32(audioDataBytes.count).bigEndian
        let lengthData = Data(bytes: &lengthBytes, count: 4)
        
        // Write to stdout (Node.js will read this)
        FileHandle.standardOutput.write(lengthData)
        FileHandle.standardOutput.write(audioDataBytes)
        
        // Debug info to stderr (so it doesn't interfere with audio stream)
        if frameLength > 0 {
            let debugInfo = "Streamed \(audioDataBytes.count) bytes (\(frameLength) frames)\n"
            if let debugData = debugInfo.data(using: .utf8) {
                stderrHandle.write(debugData)
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        ResponseHandler.returnResponse(["code": "STREAM_ERROR", "error": error.localizedDescription], shouldExitProcess: false)
        RecorderCLI.terminateRecording()
        semaphoreRecordingStopped.signal()
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

