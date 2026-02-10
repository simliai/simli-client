import { RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, RoomEvent, RoomOptions, Track } from "livekit-client";
import { WebSocketSignaling } from "../Signaling/WebSocketSignaling";
import { SimliClientEvents } from "../Events";
import { BaseTransport, EventCallback, EventMap, handleMessage, register_destination } from "./BaseTransport";
import { Logger } from "../Logger";

class LivekitTransport implements BaseTransport {
    videoElementAnchor: HTMLVideoElement
    audioElementAnchor: HTMLAudioElement
    signalingConnection: WebSocketSignaling;
    session_token: string;
    pc: Room
    logger: Logger
    events: EventMap = new Map()
    private websocketPromise: Promise<unknown>;
    private websocketReject: ((reason: string) => void) | null = null;
    constructor(
        simliBaseWSURL: string,
        session_token: string,
        videoElementAnchor: HTMLVideoElement,
        audioElementAnchor: HTMLAudioElement,
        logger: Logger,
        failSignal: (message: string) => void
    ) {
        this.logger = logger
        this.on("startup_error", failSignal)

        this.session_token = session_token
        const wsURL = new URL(simliBaseWSURL + "/compose/webrtc/livekit")
        wsURL.searchParams.set("session_token", session_token)
        this.signalingConnection = new WebSocketSignaling(wsURL, this.logger)
        this.on("destination", (serilized_info) => register_destination(this.logger, serilized_info))
        this.websocketPromise = new Promise(
            (resolve, reject) => {
                this.websocketReject = reject;
                this.signalingConnection.connect(() => {
                    resolve("success")
                    this.logger.debug("LK WebSocket Connected")
                })
            }
        )
        this.signalingConnection.wsConnection.onmessage = (message) => { handleMessage(this, message) }
        this.signalingConnection.wsConnection.onerror = (evt) => {
            this.emit("startup_error", "Websocket Failed");
            if (this.websocketReject) {
                this.websocketReject("Websocket Failed");
                this.websocketReject = null; // Prevent multiple rejections
            }
        }
        const options: RoomOptions = { adaptiveStream: true, dynacast: true }
        this.pc = new Room(options);
        this.on("connection_info", (serialized_info) => this.join_lk_room(serialized_info))
        this.videoElementAnchor = videoElementAnchor
        this.audioElementAnchor = audioElementAnchor

    }
    public on<K extends keyof SimliClientEvents>(
        event: K,
        callback: SimliClientEvents[K]
    ): void {
        if (!this.events.has(event)) {
            this.events.set(event, new Set());
        }
        this.events.get(event)?.add(callback as EventCallback);
        this.logger.debug("Registered Callback for Event: " + event)
    }

    public off<K extends keyof SimliClientEvents>(
        event: K,
        callback: SimliClientEvents[K],
    ): void {
        if (!this.events.has(event)) {
            throw "Event Not Regsitered"
        }
        this.events.get(event)?.delete(callback as EventCallback);
    }

    emit<K extends keyof SimliClientEvents>(
        event: K,
        ...args: Parameters<SimliClientEvents[K]>
    ): void {
        this.logger.debug("Event: " + event)
        this.events.get(event)?.forEach((callback) => {
            callback(...args);
        });
    }

    async connect() {
        this.logger.info("Connecting")
        this.setupConnectionStateHandler()
        await this.websocketPromise
    }

    async disconnect() {
        this.logger.info("Disconnecting")
        try {
            this.signalingConnection.sendSignal("DONE")
        }
        catch {
            this.logger.error("FAILED TO SEND FINAL MESSAGE")
        }
        try {
            this.signalingConnection.disconnect()
        } catch {
            this.logger.error("SIGNALING ALREADY DISCONNECTED")
        }
        try {
            await this.pc.disconnect()
        } catch {
            this.logger.error("LOCAL PEER ALREADY CLOSED")
        }

    }

    private async join_lk_room(serialized_info: string) {
        const info = JSON.parse(serialized_info)
        this.logger.debug(info)
        if (info.livekit_url && info.livekit_token) {
            await this.pc.connect(info.livekit_url, info.livekit_token);
        } else {
            this.disconnect()
            this.emit("error", "Invalid Join Info, Contact Simli For Support")
        }
    }
    private setupConnectionStateHandler() {
        this.pc.on(RoomEvent.Disconnected, () => {
            this.disconnect();
        })

        this.pc.on(RoomEvent.Connected, () => {
        })
        this.pc.on(RoomEvent.TrackSubscribed, (track: RemoteTrack,
            publication: RemoteTrackPublication,
            participant: RemoteParticipant,
        ) => {
            this.logger.debug("Track Received: " + track.kind)
            if (track.kind === Track.Kind.Video) {
                track.attach(this.videoElementAnchor)
                this.videoElementAnchor.requestVideoFrameCallback(() => {
                    this.emit("start");
                });
            } else if (track.kind === Track.Kind.Audio) {
                track.attach(this.audioElementAnchor)
            }
        })
    };


}

export { LivekitTransport }
