# SimliClient

Simli WebRTC frontend client

### Installation

```bash
npm install simli-client
```

### Methods
- `Initialize(config: SimliClientConfig)`: Initializes the SimliClient with the provided configuration.
- `start()`: Sets up the WebRTC connection and prepares for streaming.
- `sendAudioData(audioData: Uint8Array)`: Sends audio data to the server.
- `close()`: Closes the WebRTC connection and cleans up resources.

### Docs
[Setup guide](https://docs.simli.com/api-reference/simli-client)