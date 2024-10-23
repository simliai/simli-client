# SimliClient

Simli WebRTC frontend client

### Installation

```bash
npm install simli-client
```

### Methods
- `Initialize(config: SimliClientConfig)`: Initializes the SimliClient with the provided configuration.
- `start()`: Sets up the WebRTC connection and prepares for streaming.
- `close()`: Closes the WebRTC connection and cleans up resources.
- `sendAudioData(audioData: Uint8Array)`: Sends audio data to the server.
- `listenToMediastreamTrack(stream: MediaStreamTrack)`: Listens to a MediaStreamTrack and sends audio data to the server. *Can be used as an alternative to `sendAudioData`.*
- `ClearBuffer()`: Clears the audio buffer, best used when you want the avatar to stop talking.

### Events
- `connected`
- `disconnected`
- `failed`

### Docs
[Setup guide](https://docs.simli.com/api-reference/simli-client)
