// src/index.ts
import { SimliClientEvents } from './events';
import { BaseTransport, EventCallback, EventMap } from './transports/BaseTransport';
import { LivekitTransport } from './transports/LivekitTransport';
import { P2PTransport } from './transports/P2PTransport';
import { Logger, LogLevel } from './Logger';

const AudioProcessor = (buffer: number) => {
    if (buffer <= 0) {
        throw "Invalid Buffer Size, Can't be negative"
    }
    if (Math.floor(buffer) - buffer != 0) {
        throw "Invalid Buffer Size, Can't be a float"
    }
    return `
        class AudioProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.buffer = new Int16Array(${buffer});
            this.bufferIndex = 0;
        }

          process(inputs, outputs, parameters) {
            const input = inputs[0];
            const inputChannel = input[0];
            if (inputChannel) {
              for (let i = 0; i < inputChannel.length; i++) {
                this.buffer[this.bufferIndex] = Math.max(-32768, Math.min(32767, Math.round(inputChannel[i] * 32767)));
                this.bufferIndex++;

                if (this.bufferIndex === this.buffer.length){
                  this.port.postMessage({type: 'audioData', data: this.buffer.slice(0, this.bufferIndex)});
                  this.bufferIndex = 0;
                }
              }
            }
            return true;
          }
        }

        registerProcessor('audio-processor', AudioProcessor);
      `};

// Camera offsets on top of the avatar's own framing, Trinity-2 faces only.
// Every field is neutral when left out. A value outside its supported range
// is still applied, with a warning in the token response.
interface CameraSetting {
    /** Moves the avatar right, in half canvas widths. Supported range -10 to 10. */
    pos_x_off?: number;
    /** Moves the avatar down, in half canvas heights. Supported range -10 to 10. */
    pos_y_off?: number;
    /** Metres the camera backs away from the avatar (negative moves in). Supported range -5 to 5. */
    pos_z_off?: number;
    /** Degrees the camera tilts up (pitch). Supported range -180 to 180. */
    rot_x_off?: number;
    /** Degrees the camera pans right (yaw). Supported range -180 to 180. */
    rot_y_off?: number;
    /** Degrees the camera rolls clockwise. Supported range -180 to 180. */
    rot_z_off?: number;
    /** Multiplies the avatar's zoom; 1 is no change. Supported range above 0, up to 4. */
    zoom?: number;
    /** Degrees the camera orbits up over the avatar's head (elevation). Supported range -80 to 80. */
    orbit_x_off?: number;
    /** Degrees the camera orbits round to its right (azimuth). Supported range -180 to 180. */
    orbit_y_off?: number;
}

// Custom event handler types
interface SimliSessionRequest {
    faceId: string;
    /** Defaults to true. */
    handleSilence?: boolean;
    /** Seconds. Defaults to 3600. */
    maxSessionLength?: number;
    /** Seconds. Defaults to 300. */
    maxIdleTime?: number;
    /** @deprecated Ignored by the server, every session runs fasttalk. */
    model?: "fasttalk" | "artalk";
    sessionAggregator?: string | null;
    /** Defaults to 0. */
    startFrame?: number;
    /** Defaults to "pcm16". */
    audioInputFormat?: string;
    /**
     * Width of the streamed video in pixels, Trinity-2 faces only. At least 512,
     * and with streaming_height one of 1:1, 16:9 or 9:16. Defaults to 768.
     */
    streaming_width?: number;
    /** Height of the streamed video in pixels. See streaming_width. Defaults to 768. */
    streaming_height?: number;
    /** Where the avatar sits across the canvas, 0 (left) to 1 (right). Trinity-2 only. Defaults to 0.5. */
    avatar_position_x?: number;
    /** Where the avatar sits down the canvas, 0 (top) to 1 (bottom). Trinity-2 only. Defaults to 1. */
    avatar_position_y?: number;
    /** The camera the session starts with. Trinity-2 only. Leave it out to keep the avatar's framing. */
    camera?: CameraSetting | null;
    /**
     * One of your uploaded backgrounds, by the id POST /assets/backgrounds returned,
     * shown behind the avatar and cropped to fill the canvas. Trinity-2 only.
     * Leave it out for the avatar's own. Change it live with setBackground.
     */
    background_id?: string | null;
    /**
     * One of your uploaded foregrounds, by the id POST /assets/foregrounds returned,
     * laid over the avatar through its transparency. Trinity-2 only. Leave it out
     * for the avatar's own. Change it live with setForeground.
     */
    foreground_id?: string | null;
}
interface TokenRequestData {
    config: SimliSessionRequest
    apiKey: string
}

interface SimliSessionToken {
    session_token: string;
    /**
     * Starting camera fields outside their supported range, and background_id /
     * foreground_id dropped as not your account's (the avatar's own is used).
     * The token is minted regardless.
     */
    warnings: string[];
}

type TransportMode = "livekit" | "p2p"
type SignalingMode = "websockets"
type session_token = string

const ASSET_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
// No upload has the nil UUID; sent as BG_/FG_ it goes back to the avatar's own.
const NO_ASSET_ID = "00000000-0000-0000-0000-000000000000"

async function generateSimliSessionToken(
    request: TokenRequestData,
    SimliURL: string = "https://api.simli.ai",
): Promise<SimliSessionToken> {
    const url = `${SimliURL}/compose/token`;
    const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify(request.config),
        headers: {
            "Content-Type": "application/json",
            "x-simli-api-key": request.apiKey
        },
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw errorText;
    }

    const resJSON = await response.json();
    return resJSON;
}

async function generateIceServers(
    apiKey: string,
    SimliURL: string = "https://api.simli.ai",
): Promise<RTCIceServer[]> {
    try {
        const url = `${SimliURL}/compose/ice`;
        const response: any = await fetch(url, {
            headers: {
                "Content-Type": "application/json",
                "x-simli-api-key": apiKey,
            },
            method: "GET",
        })

        if (!response.ok) {
            throw new Error(`SIMLI: HTTP error! status: ${response.status}`);
        }

        const iceServers = await response.json();
        if (!iceServers || iceServers.length === 0) {
            throw new Error("SIMLI: No ICE servers returned");
        }
        return iceServers;
    } catch (error) {
        return [{ urls: ["stun:stun.l.google.com:19302"] }];
    }
}

class SimliClient {

    session_token: string;
    transport: TransportMode = "livekit";
    signaling: SignalingMode = "websockets"
    videoElement: HTMLVideoElement
    audioElement: HTMLAudioElement
    audioBufferSize: number = 3000
    private connection: BaseTransport
    private connectionTimeout: NodeJS.Timeout
    private connectionResolve: () => void
    private connectionReject: (message: string) => void
    private connectionPromise: Promise<void>
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private audioWorklet: AudioWorkletNode | null = null;
    private readonly MAX_RETRY_ATTEMPTS = 10;
    private RETRY_DELAY = 2000;
    private readonly CONNECTION_TIMEOUT_MS = 15000;
    private retryAttempt: number = 0;
    private SimliWSURL: string = "wss://api.simli.ai";
    private audioContext: AudioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)({
            sampleRate: 16000,
        });
    private logger: Logger;
    private iceServers: RTCIceServer[] | null;
    private persistent_events: EventMap;
    private failReason: string | null = null;
    private shouldStop: boolean = false;

    // Type-safe event methods
    public on<K extends keyof SimliClientEvents>(
        event: K,
        callback: SimliClientEvents[K]
    ): void {
        if (!this.persistent_events.has(event)) {
            this.persistent_events.set(event, new Set());
        }
        this.persistent_events.get(event)?.add(callback as EventCallback);
        this.logger.debug("Registered Callback for Event: " + event)
        this.connection.on(event, callback)
    }

    public off<K extends keyof SimliClientEvents>(
        event: K,
        callback: SimliClientEvents[K],
    ): void {
        if (!this.persistent_events.has(event)) {
            throw "Event Not Regsitered"
        }
        this.persistent_events.get(event)?.delete(callback as EventCallback);
        this.connection.off(event, callback)
    }

    constructor(
        session_token: session_token,
        videoElement: HTMLVideoElement,
        audioElement: HTMLAudioElement,
        iceServers: RTCIceServer[] | null,
        logLevel: LogLevel = LogLevel.DEBUG,
        transport_mode: TransportMode = "p2p",
        signaling: SignalingMode = "websockets",
        SimliWSURL: string = "wss://api.simli.ai",
        audioBufferSize: number = 3000,
    ) {
        if (audioBufferSize <= 0) {
            throw "Invalid Buffer Size, Can't be negative"
        }
        if (Math.floor(audioBufferSize) - audioBufferSize != 0) {
            throw "Invalid Buffer Size, Can't be a float"
        }
        if (!(SimliWSURL.startsWith("ws://") || SimliWSURL.startsWith("wss://")) || SimliWSURL.endsWith("/")) {
            throw "Invalid Simli WS URL"
        }
        this.audioBufferSize = audioBufferSize
        this.session_token = session_token
        this.transport = transport_mode
        this.signaling = signaling
        this.SimliWSURL = SimliWSURL
        this.videoElement = videoElement
        this.audioElement = audioElement
        this.iceServers = iceServers
        this.logger = new Logger(logLevel);

        let resolveFn: () => void;
        let rejectFn: () => void;

        this.connectionPromise = new Promise<void>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });

        this.connectionResolve = resolveFn!;
        this.connectionReject = rejectFn!;
        this.persistent_events = new Map()
        this.connectionTimeout = setTimeout(() => this.connectionReject("CONNECTION TIMED OUT"), this.CONNECTION_TIMEOUT_MS)

        switch (this.transport) {
            case "livekit":
                this.connection = new LivekitTransport(this.SimliWSURL, this.session_token, videoElement, audioElement, this.logger, this.connectionReject)
                break;
            case "p2p":
                if (!iceServers || iceServers.length == 0) {
                    throw "Ice Servers Required for P2P Mode"
                }
                this.connection = new P2PTransport(this.SimliWSURL, this.session_token, true, iceServers, videoElement, audioElement, this.logger, this.connectionReject)
                break
            default:
                throw new Error("Not Implemented Yet")

        }
        this.connection.on("start", () => {
            this.connectionResolve()
            clearTimeout(this.connectionTimeout)
        })
        this.connection.on("unknown", (message) => this.logger.debug("UNKOWN MESSAGE FROM SERVER: " + message))
        this.connection.on("error", (message) => { this.failReason = message; this.connectionReject(message) })

    }

    private resetConnections(videoElement: HTMLVideoElement, audioElement: HTMLAudioElement, iceServers: RTCIceServer[] | null) {
        this.failReason = null
        let resolveFn: () => void;
        let rejectFn: () => void;

        this.connectionPromise = new Promise<void>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });

        this.connectionResolve = resolveFn!;
        this.connectionReject = rejectFn!;
        this.connectionTimeout = setTimeout(() => this.connectionReject("Connection Timed Out"), this.CONNECTION_TIMEOUT_MS)

        switch (this.transport) {
            case "livekit":
                this.connection = new LivekitTransport(this.SimliWSURL, this.session_token, videoElement, audioElement, this.logger, this.connectionReject)
                break;
            case "p2p":
                if (!iceServers || iceServers.length == 0) {
                    throw "Ice Servers Required for P2P Mode"
                }
                this.connection = new P2PTransport(this.SimliWSURL, this.session_token, true, iceServers, videoElement, audioElement, this.logger, this.connectionReject)
                break
            default:
                throw new Error("Not Implemented Yet")

        }
        this.connection.on("start", () => {
            this.connectionResolve()
            clearTimeout(this.connectionTimeout)
        })
        this.connection.on("error", (message) => { this.retryAttempt = this.MAX_RETRY_ATTEMPTS; this.connectionReject(message) })
        this.connection.on("unknown", (message) => this.logger.debug("UNKOWN MESSAGE FROM SERVER: " + message))
        // Re-register all user event handlers on the new connection
        this.persistent_events.forEach((callbacks, event) => {
            callbacks.forEach((callback) => {
                this.connection.on(event as keyof SimliClientEvents, callback);
            });
        });
    }
    async start(): Promise<void> {
        if (this.shouldStop) {
            throw new Error("Disconnect Already Called, Can't reuse same SimliClient multiple times create a new SimliClient Object")
        }
        try {
            await this.connection.connect()
            await this.connectionPromise
            this.retryAttempt = 0
        } catch (error) {
            if (this.failReason) {
                throw error
            }
            if (this.retryAttempt >= this.MAX_RETRY_ATTEMPTS)
                throw new Error("Too Many Retry Attempts Failed to connect")
            if (this.shouldStop) {
                this.shouldStop = false
                throw new Error("Called Disconnect Before A Connecction succeeded")
            }
            this.logger.error("FAILED: " + error)
            await this.connection.disconnect()
            await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
            this.retryAttempt += 1
            if (this.retryAttempt > 2)
                this.transport = "livekit"
            this.resetConnections(this.videoElement, this.audioElement, this.iceServers)
            await this.start()
        }
    }

    async stop() {
        this.shouldStop = true
        await this.connection.disconnect()
    }

    listenToMediastreamTrack(stream: MediaStreamTrack) {
        const source = this.audioContext.createMediaStreamSource(
            new MediaStream([stream]),
        );
        this.sourceNode = source;
        this.attachSourceToWorklet(this.audioContext, source);
    }

    listenToAudioElement(audioEl: HTMLAudioElement) {
        const source = this.audioContext.createMediaElementSource(audioEl);
        // No connection to audioContext.destination on purpose: createMediaElementSource
        // reroutes the element's audio into the graph, so leaving the destination
        // unconnected silences the <audio> while samples still flow to Simli.
        this.attachSourceToWorklet(this.audioContext, source);
    }

    private attachSourceToWorklet(
        audioContext: AudioContext,
        source: AudioNode,
    ) {
        audioContext.audioWorklet
            .addModule(
                URL.createObjectURL(
                    new Blob([AudioProcessor(this.audioBufferSize)], {
                        type: "application/javascript",
                    }),
                ),
            )
            .then(() => {
                this.audioWorklet = new AudioWorkletNode(
                    audioContext,
                    "audio-processor",
                );
                if (this.audioWorklet === null) {
                    throw new Error("SIMLI: AudioWorklet not initialized");
                }
                source.connect(this.audioWorklet);
                this.audioWorklet.port.onmessage = (event) => {
                    if (event.data.type === "audioData") {
                        this.connection.signalingConnection.sendAudioData(new Uint8Array(event.data.data.buffer));
                    }
                };
            })
    }


    public ClearBuffer = () => {
        this.connection.signalingConnection.sendSignal("SKIP");
    };
    sendAudioData(audioData: Uint8Array) {
        this.connection.signalingConnection.sendAudioData(audioData);
    }

    sendAudioDataImmediate(audioData: Uint8Array) {
        this.connection.signalingConnection.sendAudioDataImmediate(audioData);
    }

    /**
     * Puts one of your uploaded backgrounds behind the avatar, Trinity-2 faces only,
     * by the id POST /assets/backgrounds returned; null goes back to the avatar's own.
     * It applies a moment later, once loaded, and the last one sent wins. A refusal
     * (not your upload, couldn't load, not Trinity-2) arrives as an "unknown" event.
     */
    setBackground(backgroundId: string | null) {
        this.connection.signalingConnection.sendSignal(`BG_${this.assetId(backgroundId)}`);
    }

    /**
     * Lays one of your uploaded foregrounds over the avatar, Trinity-2 faces only,
     * by the id POST /assets/foregrounds returned; null takes it away. Otherwise as
     * setBackground.
     */
    setForeground(foregroundId: string | null) {
        this.connection.signalingConnection.sendSignal(`FG_${this.assetId(foregroundId)}`);
    }

    private assetId(id: string | null): string {
        if (id === null) {
            return NO_ASSET_ID
        }
        if (!ASSET_ID_PATTERN.test(id)) {
            throw "Invalid asset id, expected the 36 character id returned by POST /assets"
        }
        return id
    }

}

export { SimliClient, generateSimliSessionToken, generateIceServers, Logger, LogLevel }
export type { SimliSessionRequest, SimliSessionToken, CameraSetting };
