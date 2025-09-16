# Audio Stream Transcriber

A real-time audio transcription application built on Electron that captures system audio on macOS and provides live transcription using DeepGram's streaming API.

## Overview

This project extends the excellent [Electron System Audio Capture & Recording for MacOS](https://github.com/lukeyaegerjones/electron-system-audio-recorder) to add real-time transcription capabilities. It provides a seamless way to capture and transcribe system audio with minimal user setup beyond standard permissions.

## Features

- **System Audio Capture**: Clean macOS system audio recording using Swift integration
- **Real-time Transcription**: Live audio transcription powered by DeepGram's streaming API
- **Multiple Interfaces**: Both Electron desktop app and web interface options
- **Native Experience**: Minimal setup with familiar macOS permission handling
- **WebSocket Streaming**: Real-time communication between audio capture and transcription services

## Prerequisites

- macOS (required for system audio capture)
- Node.js
- DeepGram API key for transcription services

## Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd audio-stream-transcriber
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure DeepGram API**
   Create a `.env` file in the root directory:
   ```
   DEEPGRAM_API_KEY=your_deepgram_api_key_here
   ```

4. **Build Swift components**
   ```bash
   npm run swift:make
   ```

## Usage

### Desktop Application (Electron)
```bash
npm run dev
```

### Web Interface
```bash
npm run web
```
Then open `http://localhost:3000` in your browser.

## Project Structure

```
src/
├── electron/          # Electron main process and renderers
│   ├── main.js        # Main Electron process
│   ├── screens/       # UI screens (recording, permissions)
│   └── utils/         # Permission and recording utilities
├── server/            # Express server for web interface
│   └── app.js         # WebSocket and HTTP server
├── swift/             # Swift audio capture implementation
│   └── Recorder.swift # Core audio recording functionality
└── web/               # Web interface files
    ├── app.js         # Client-side JavaScript
    └── index.html     # Web UI
```

## Scripts

- `npm run dev` - Start Electron development app
- `npm run web` - Start web server
- `npm run swift:make` - Compile Swift audio recorder
- `npm run electron:package` - Package Electron app
- `npm run electron:make` - Create distributable builds

## Credits & Acknowledgments

This project builds upon the foundational work of the **Electron System Audio Capture & Recording for MacOS** project:

- **Original Concept**: Luke/YAE - Created the initial vision for clean macOS system audio capture in Electron
- **Swift Implementation**: Sebastian Wąsik - Developed the core Swift audio capture functionality
- **LinkedIn**: [Sebastian Wąsik](https://www.linkedin.com/in/sebastian-w%C4%85sik-b23840174/)

The original project addressed the limitations in Electron's documentation for macOS system audio capture and provided a clean, native-feeling solution with minimal user setup requirements.

## License

MIT License - This project maintains the open-source spirit of the original work, encouraging adoption and advancement of Electron-based audio applications.

## Support

This is an open-source project built for the community. While we'll do our best to help with issues, please understand that support is provided on a best-effort basis.

## Tags

macOS, System Audio Capture, Electron, Real-time Transcription, DeepGram, Swift, Audio Processing, WebSocket Streaming
