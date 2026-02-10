// src/index.ts
import { SimliClientEvents } from './Events';
import { BaseTransport, EventCallback, EventMap } from './Transports/BaseTransport';
import { LivekitTransport } from './Transports/LivekitTransport';
import { P2PTransport } from './Transports/P2PTransport';
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

// Custom event handler types
interface SimliSessionRequest {
    faceId: string;
    handleSilence: boolean;
    maxSessionLength: number;
    maxIdleTime: number;
    model?: "fasttalk" | "artalk";
}
interface TokenRequestData {
    config: SimliSessionRequest
    apiKey: string
}

interface SimliSessionToken {
    session_token: string;
}

type TransportMode = "livekit" | "p2p"
type SignalingMode = "websockets"
type session_token = string

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
        this.initializeAudioWorklet(this.audioContext, stream);
    }

    private initializeAudioWorklet(
        audioContext: AudioContext,
        stream: MediaStreamTrack,
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
                this.sourceNode = audioContext.createMediaStreamSource(
                    new MediaStream([stream]),
                );
                if (this.audioWorklet === null) {
                    throw new Error("SIMLI: AudioWorklet not initialized");
                }
                this.sourceNode.connect(this.audioWorklet);
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

}

export { SimliClient, generateSimliSessionToken, generateIceServers, Logger, LogLevel }
export type { SimliSessionRequest };
