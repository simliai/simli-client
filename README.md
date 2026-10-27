# SimliClient

Browser client for Simli's real-time avatars. You send audio, and it plays the avatar's video and audio in a `<video>` and an `<audio>` element.

- [JavaScript SDK guide](https://docs.simli.com/api-reference/javascript)
- [Trinity-2 avatars](https://docs.simli.com/api-reference/trinity-2): video size and shape, avatar position, [camera](https://docs.simli.com/api-reference/trinity-2/camera), [backgrounds and foregrounds](https://docs.simli.com/api-reference/trinity-2/backgrounds)

## Installation

```bash
npm install simli-client
```

## Quick start (LiveKit mode, the default)

### 1. Mint a session token on your server

Your API key must never reach the browser. Mint a session token on your backend and send only the token to the page. `generateSimliSessionToken` runs in Node 18+ (it uses `fetch`):

```ts
// server.ts runs on your backend, where SIMLI_API_KEY stays secret
import express from "express";
import { generateSimliSessionToken } from "simli-client";

const app = express();

app.post("/simli-token", async (_req, res) => {
    const { session_token } = await generateSimliSessionToken({
        apiKey: process.env.SIMLI_API_KEY!,
        config: {
            faceId: "bf13113a-355a-4d97-8b90-4edccd1da7b2",
            maxSessionLength: 600, // seconds
            maxIdleTime: 180, // seconds
        },
    });
    res.json({ session_token });
});

app.listen(3000);
```

On other backends, POST the same JSON config to `https://api.simli.ai/compose/token` with your key in the `x-simli-api-key` header.

### 2. Connect from the browser

```html
<video id="simli-video" autoplay playsinline></video>
<audio id="simli-audio" autoplay></audio>
```

```ts
import { SimliClient, LogLevel } from "simli-client";

const video = document.getElementById("simli-video") as HTMLVideoElement;
const audio = document.getElementById("simli-audio") as HTMLAudioElement;

const { session_token } = await fetch("/simli-token", { method: "POST" }).then((r) => r.json());

// null: LiveKit mode needs no ICE servers
const client = new SimliClient(session_token, video, audio, null, LogLevel.INFO);

client.on("speaking", () => console.log("avatar is talking"));
client.on("stop", () => console.log("session ended"));

try {
    await client.start(); // resolves once the first video frame is on screen
} catch (reason) {
    // e.g. "ERROR: INVALID_FACE_ID": the server refused the session
    console.error("Simli could not start:", reason);
}

// pcm16Chunk: a Uint8Array of 16-bit PCM, 16 kHz, mono audio
client.sendAudioData(pcm16Chunk);

// Later, to hang up
await client.stop();
```

Create the client just before you call `start()`: the constructor already opens the signaling connection. A client is good for one session. To reconnect, mint a new token and create a new `SimliClient`.

## Trinity-2: a 16:9 session

A Trinity-2 face takes framing fields in its token request. This one streams a 1280x720 (16:9) video, with the avatar centred at the bottom and the camera zoomed in a little:

```ts
// On your server
const { session_token, warnings } = await generateSimliSessionToken({
    apiKey: process.env.SIMLI_API_KEY!,
    config: {
        faceId: "bf13113a-355a-4d97-8b90-4edccd1da7b2",
        streaming_width: 1280,
        streaming_height: 720,
        avatar_position_x: 0.5,
        avatar_position_y: 1,
        camera: { zoom: 1.2 },
        // background_id: "<id returned by POST /assets/backgrounds>",
    },
});
// warnings lists out-of-range camera values and background/foreground ids
// that were dropped. The token is minted regardless.
```

Width and height must each be at least 512 and make a 1:1, 16:9 or 9:16 frame. Other faces ignore these fields, but they are still checked.

While the session runs, you can move the camera and swap the uploaded background or foreground. Each `setCamera` call replaces the whole camera, the starting one included, so fields you leave out go back to neutral:

```ts
// Before start(): out-of-range camera values and ignored changes arrive here
client.on("warning", (message) => console.warn(message));

// Glide over 2 seconds: zoom in, and orbit 20 degrees round to the camera's right.
// Then switch the background.
client.setCamera({ zoom: 1.5, orbit_y_off: 20 }, { lerpSeconds: 2 });
client.setBackground("6f1c2a9e-1b2c-4d3e-8f90-0123456789ab");

// Later, cut back to the avatar's own framing and background, and take the foreground away
client.setCamera(null);
client.setBackground(null);
client.setForeground(null);
```

See [Trinity-2 avatars](https://docs.simli.com/api-reference/trinity-2) for how to make a Trinity-2 face, and for the framing, camera and background details.

## Errors and retries

- **The server refuses the session**, for example for an expired token, an unknown face or a rate limit. `start()` rejects at once with the server's message, a string such as `"ERROR: SESSION_TOKEN_EXPIRED"` or `"ERROR: INVALID_FACE_ID"`. It does not retry.
- **The network fails**: the websocket can't connect or drops, the LiveKit room can't be joined, or an attempt takes more than 15 seconds. These are the only failures `start()` retries, up to 10 times, then it rejects with `Error("Too Many Retry Attempts Failed to connect")`. It waits 1 second before the first retry and doubles the wait each time, up to 16 seconds (1, 2, 4, 8, 16, 16 … s), plus up to 20% at random so that many clients don't retry in lockstep. Your event handlers stay registered across retries.
- **Anything else goes wrong before the first frame**, such as a server message this version of the SDK doesn't recognise, or an exception while setting up the connection. `start()` rejects at once with that message or exception, as is, and logs it at error level as `Unknown error from Simli: <message>`. It does not retry. Once the session has started, an unrecognised message doesn't end it: it fires `unknown` and is logged as a warning.
- `generateSimliSessionToken` throws the response body when the API answers with an error status. Examples are an invalid face id, missing billing information, no minutes left, and an unsupported video size (`422`).

## API

The package exports `SimliClient`, `generateSimliSessionToken`, `generateIceServers` and `LogLevel`, plus the types `SimliSessionRequest`, `SimliSessionToken` and `CameraSetting`.

### `generateSimliSessionToken(request, SimliURL?)`

```ts
generateSimliSessionToken(
    request: { config: SimliSessionRequest; apiKey: string },
    SimliURL: string = "https://api.simli.ai",
): Promise<SimliSessionToken>
```

Run it on your server. It throws the response body text on a non-2xx response.

```ts
interface SimliSessionRequest {
    faceId: string;
    handleSilence?: boolean; // default true. Set false when streaming with listenToMediastreamTrack
    maxSessionLength?: number; // seconds, default 3600
    maxIdleTime?: number; // seconds, default 300
    sessionAggregator?: string | null;
    startFrame?: number; // default 0
    audioInputFormat?: string; // default "pcm16", the only format supported

    // Trinity-2 faces only
    streaming_width?: number; // pixels, at least 512, default 768
    streaming_height?: number; // pixels, at least 512, default 768. With width: 1:1, 16:9 or 9:16
    avatar_position_x?: number; // 0 (left) to 1 (right), default 0.5
    avatar_position_y?: number; // 0 (top) to 1 (bottom), default 1
    camera?: CameraSetting | null; // starting camera, leave out to keep the avatar's framing
    background_id?: string | null; // an id from POST /assets/backgrounds
    foreground_id?: string | null; // an id from POST /assets/foregrounds
}

interface SimliSessionToken {
    session_token: string;
    warnings: string[]; // out-of-range camera values, dropped background/foreground ids
}

// Offsets on top of the avatar's own framing. Every field left out is neutral.
// Values outside the supported range are still applied, with a warning.
interface CameraSetting {
    pos_x_off?: number; // moves the avatar right, in half canvas widths, -10 to 10
    pos_y_off?: number; // moves the avatar down, in half canvas heights, -10 to 10
    pos_z_off?: number; // metres the camera backs away (negative moves in), -5 to 5
    rot_x_off?: number; // degrees the camera tilts up, -180 to 180
    rot_y_off?: number; // degrees the camera pans right, -180 to 180
    rot_z_off?: number; // degrees the camera rolls clockwise, -180 to 180
    zoom?: number; // multiplies the avatar's zoom, 1 is no change, above 0 up to 4
    orbit_x_off?: number; // degrees the camera orbits up over the head, -80 to 80
    orbit_y_off?: number; // degrees the camera orbits round to its right, -180 to 180
}
```

### `generateIceServers(apiKey, SimliURL?)`

```ts
generateIceServers(apiKey: string, SimliURL: string = "https://api.simli.ai"): Promise<RTCIceServer[]>
```

Fetches ICE servers for P2P mode. It takes your API key, so run it on your server. It never throws: if the request fails, it returns Google's public STUN server.

### `new SimliClient(...)`

```ts
new SimliClient(
    session_token: string,
    videoElement: HTMLVideoElement,
    audioElement: HTMLAudioElement,
    iceServers: RTCIceServer[] | null, // P2P only, pass null for LiveKit
    logLevel: LogLevel = LogLevel.DEBUG,
    transport_mode: "livekit" | "p2p" = "livekit",
    signaling: "websockets" = "websockets",
    SimliWSURL: string = "wss://api.simli.ai",
    audioBufferSize: number = 3000,
)
```

- `logLevel`: `LogLevel.DEBUG`, `INFO`, `ERROR` or `CRITICAL`. `DEBUG` logs every message and audio chunk, so use `INFO` or `ERROR` in production. Warnings, such as `warning` events and unrecognised messages, are logged at `INFO` and `DEBUG`.
- `SimliWSURL`: must start with `ws://` or `wss://`, with no trailing `/`.
- `audioBufferSize`: samples per chunk sent by `listenToMediastreamTrack` and `listenToAudioElement`. Must be a positive integer. 3000 samples is 187.5 ms at 16 kHz.

The constructor throws on an invalid `audioBufferSize` or `SimliWSURL`, and in `"p2p"` mode when `iceServers` is null or empty.

### Methods

| Method | Description |
| --- | --- |
| `start(): Promise<void>` | Connects and resolves when the first video frame is on screen. See [Errors and retries](#errors-and-retries). It throws if the client was already stopped. |
| `stop(): Promise<void>` | Ends the session and closes the connection. The client can't be started again. |
| `sendAudioData(audioData: Uint8Array)` | Sends 16-bit PCM, 16 kHz, mono audio. It plays after any audio already queued. Throws if the connection isn't open. |
| `sendAudioDataImmediate(audioData: Uint8Array)` | Drops any queued audio and plays this chunk right away. |
| `ClearBuffer()` | Drops any queued audio, so the avatar stops talking. Use it when the user interrupts. |
| `listenToMediastreamTrack(track: MediaStreamTrack)` | Streams an audio track, such as a microphone or a TTS WebRTC track, to Simli. |
| `listenToAudioElement(audioEl: HTMLAudioElement)` | Streams what an `<audio>` element plays to Simli, and mutes that element locally. You hear the avatar through `audioElement` instead. An element can only be captured once. |
| `setBackground(backgroundId: string \| null)` | Trinity-2 only. Shows one of your uploaded backgrounds behind the avatar. `null` goes back to the avatar's own. It applies a moment later, once loaded, and the last call wins. Throws if the id isn't a 36-character UUID. A refusal arrives as a `warning` event. |
| `setForeground(foregroundId: string \| null)` | Trinity-2 only. Lays one of your uploaded foregrounds over the avatar. `null` removes it. Otherwise it works like `setBackground`. |
| `setCamera(camera: CameraSetting \| null, options?: { lerpSeconds?: number })` | Trinity-2 only. Moves the camera, as offsets on top of the avatar's own framing. Each call replaces the whole camera, the starting one included: fields left out are neutral, and `null` goes back to the avatar's own framing. It cuts, unless `lerpSeconds` is above 0: then it glides there over that many seconds, from wherever the camera is now. A value outside its supported range is applied all the same, with a `warning` event. Throws on a value that isn't a finite number, and if the connection isn't open. |
| `on(event, callback)` | Registers an event handler. Register handlers before `start()`. They stay registered across retries. |
| `off(event, callback)` | Removes an event handler. Throws if that event never had a handler. |

### Events

```ts
client.on("error", (detail) => console.error(detail));
```

| Event | Callback | Fires when |
| --- | --- | --- |
| `start` | `() => void` | The first video frame is on screen, and `start()` resolves. |
| `stop` | `() => void` | The server ended the session. The connection is closed. |
| `error` | `(detail: string) => void` | The server reported an error or closed the session with a reason, in a message starting `ERROR`, `RATE` or `CLOSING`. The connection is closed. During `start()`, `start()` rejects with the same `detail`. |
| `startup_error` | `(message: string) => void` | The signaling websocket failed, for example on a network error or a refused connection, and `message` is `"Websocket Failed"`. Or the LiveKit room couldn't be joined, and `message` is `"LiveKit join failed: <reason>"`. It fires on each failed attempt, and `start()` retries. |
| `speaking` | `() => void` | The avatar started speaking. |
| `silent` | `() => void` | The avatar stopped speaking. |
| `ack` | `() => void` | The server acknowledged a message, such as an audio chunk. |
| `video_info` | `(serialized_info: string) => void` | Video metadata arrived, as JSON: `{"video_metadata": {"fps", "width", "height"}}`. |
| `destination` | `(serialized_info: string) => void` | The server assigned the session, as JSON: `{"destination", "session_id"}`. Include it when you report an issue. |
| `connection_info` | `(serialized_info: string) => void` | The WebRTC answer or the LiveKit room details arrived. For internal use. |
| `warning` | `(message: string) => void` | The server answered `setCamera`, `setBackground` or `setForeground`. Either a camera value is outside its supported range and was applied all the same (`"WARNING: camera zoom 6.0 is outside its supported range (0.0, 4.0]; applied as is"`), or the change was ignored (`"Invalid camera override received"`, `"background <id> is not one of your uploaded backgrounds, ignoring"`, `"Selected model does not support camera overrides"` on a face that isn't Trinity-2). The session goes on. Before 3.2.0 these arrived as `unknown`. |
| `unknown` | `(message: string) => void` | Any other server message. Before the first frame it also makes `start()` reject (see [Errors and retries](#errors-and-retries)). After that the session goes on. |

## P2P mode (opt-in)

P2P mode connects straight to Simli over WebRTC, without LiveKit. It needs ICE servers, and strict firewalls can block it. LiveKit is the default and the recommended mode. Versions up to 3.1.0 defaulted to P2P, so pass `"p2p"` explicitly to keep using it.

```ts
// On your server, alongside the session token
import { generateIceServers } from "simli-client";
const iceServers = await generateIceServers(process.env.SIMLI_API_KEY!);
```

```ts
// In the browser, with the session_token and iceServers your server returned
const client = new SimliClient(session_token, video, audio, iceServers, LogLevel.INFO, "p2p");
await client.start();
```

If three P2P attempts in a row fail, `start()` makes the remaining retries in LiveKit mode.

## License

MIT
