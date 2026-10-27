import { SimliClientEvents } from "../events";
import { Logger } from "../Logger";
import { BaseSignaling } from "../signaling/BaseSignaling";

type EventCallback = (...args: any[]) => void;
type EventMap = Map<string, Set<EventCallback>>;

interface BaseTransport {
    videoElementAnchor: HTMLVideoElement
    audioElementAnchor: HTMLAudioElement
    signalingConnection: BaseSignaling
    session_token: string
    events: EventMap;
    logger: Logger;
    connect(): Promise<void>;
    disconnect(): void;
    on<K extends keyof SimliClientEvents>(
        event: K,
        callback: SimliClientEvents[K]
    ): void;

    off<K extends keyof SimliClientEvents>(
        event: K,
        callback: SimliClientEvents[K],
    ): void;

    emit<K extends keyof SimliClientEvents>(
        event: K,
        ...args: Parameters<SimliClientEvents[K]>
    ): void;

}

// The server's replies to CAM_, BG_ and FG_ (camera_notice and asset_notice in its
// asyncapi): applied with a warning, or ignored. None of them end the session.
const NOTICES = [
    /^WARNING: /,
    /^Invalid camera override received$/,
    /^Selected model does not support (camera overrides|a custom (background|foreground))$/,
    /^Invalid (background|foreground) message: /,
    /^(background|foreground) .+ is not one of your uploaded (backgrounds|foregrounds), ignoring$/,
    /^Couldn't load (background|foreground) .+, ignoring$/,
]

function register_destination(logger: Logger, serialized_info: string) {
    const parsed = JSON.parse(serialized_info)
    logger.destination = parsed.destination
    logger.session_id = parsed.session_id
}
async function handleMessage(transport: BaseTransport, message: MessageEvent): Promise<void> {
    const firstToken = (message.data as string).toUpperCase().split(" ")[0]
    switch (firstToken) {
        case "START": {
            // SOFT IGNORE
            break
        }
        case "ACK": {
            transport.emit("ack")
            break;
        }
        case "STOP": {
            transport.disconnect();
            transport.emit("stop")
            break;
        }
        case "CLOSING":
        case "RATE":
        case "ERROR":
        case "ERROR:": {
            transport.disconnect()
            transport.emit("error", message.data as string)
            break
        }
        case "SPEAK": {
            transport.emit("speaking");
            break
        }
        case "SILENT": {
            transport.emit("silent");
            break
        }
        default: {
            if (firstToken.includes("SDP") || firstToken.includes("LIVEKIT")) {
                transport.emit("connection_info", message.data)
            } else if (firstToken.includes("VIDEO_METADATA")) {
                transport.emit("video_info", message.data)
            } else if (firstToken.includes("ENDFRAME")) {
                transport.emit("stop")
                transport.disconnect()
            } else if (firstToken.includes("DESTINATION")) {
                transport.emit("destination", message.data)
            } else if (NOTICES.some((notice) => notice.test(message.data))) {
                transport.emit("warning", message.data)
            } else {
                transport.emit("unknown", message.data)
            }
        }

    }
}

export { handleMessage, register_destination };
export type {
    BaseTransport, EventCallback, EventMap
};
