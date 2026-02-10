import { Logger, LogLevel } from "../Logger"
import { BaseSignaling, ClientSignals } from "./BaseSignaling"

class WebSocketSignaling implements BaseSignaling {
    wsURL: string | URL
    wsConnection: WebSocket
    logger: Logger
    constructor(wsURL: string | URL, logger: Logger) {
        this.wsURL = wsURL
        this.wsConnection = new WebSocket(this.wsURL)
        this.wsConnection.addEventListener("message", (message) => (this.logger.debug(message.data)))
        this.logger = logger
    }
    async connect(connected: () => void): Promise<void> {
        this.wsConnection.onopen = connected
    }

    disconnect(): void {
        this.wsConnection.close()
    }
    private send(data: Uint8Array | string) {
        if (this.wsConnection.readyState != WebSocket.OPEN) {
            throw `Invalid State, WS Connection ${this.wsConnection.readyState.toString()}`
        }
        this.wsConnection.send(data)
    }

    sendOffer(offer: RTCSessionDescription): void {
        this.send(JSON.stringify(offer))
    }
    sendSignal(data: ClientSignals): void {
        this.send(data)
    }

    sendAudioData(audioData: Uint8Array) {
        if (this.logger.getLevel() === LogLevel.DEBUG)
            this.logger.debug("Sent Audio of length: " + (audioData.length / 32000).toString())
        this.send(audioData);
    }

    sendAudioDataImmediate(audioData: Uint8Array) {
        if (this.logger.getLevel() === LogLevel.DEBUG)
            this.logger.debug("Sent Audio of length for immediate playback: " + (audioData.length / 32000).toString())
        const asciiStr = "PLAY_IMMEDIATE";
        const encoder = new TextEncoder(); // Default is utf-8
        const strBytes = encoder.encode(asciiStr); // Uint8Array of " World!"
        const buffer = new Uint8Array(strBytes.length + audioData.length);
        buffer.set(strBytes, 0);
        buffer.set(audioData, strBytes.length);
        this.send(buffer);
    }
}
export { WebSocketSignaling }