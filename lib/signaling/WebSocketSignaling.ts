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

    /**
     * Binary: CAM_ + the values as little-endian float32s, in the order the server
     * reads them, then, unless lerpSeconds is null, LERP + lerpSeconds as one more
     * float32. The camera glides over lerpSeconds when it's above 0, and cuts otherwise.
     */
    sendCamera(values: number[], lerpSeconds: number | null) {
        if (this.logger.getLevel() === LogLevel.DEBUG)
            this.logger.debug("Sent camera: " + values.join(", ") + (lerpSeconds !== null ? " over " + lerpSeconds + " s" : ""))
        const encoder = new TextEncoder();
        const lerpAt = 4 + 4 * values.length;
        const buffer = new Uint8Array(lerpAt + (lerpSeconds !== null ? 8 : 0));
        const view = new DataView(buffer.buffer);
        buffer.set(encoder.encode("CAM_"), 0);
        values.forEach((value, i) => view.setFloat32(4 + 4 * i, value, true));
        if (lerpSeconds !== null) {
            buffer.set(encoder.encode("LERP"), lerpAt);
            view.setFloat32(lerpAt + 4, lerpSeconds, true);
        }
        this.send(buffer);
    }
}
export { WebSocketSignaling }