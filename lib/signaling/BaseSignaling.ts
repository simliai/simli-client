import { Logger } from "../Logger";

type ClientSignals = "DONE" | "SKIP"
interface BaseSignaling {
    logger: Logger
    connect(connected: () => void): Promise<void>;
    disconnect(): void;
    sendSignal(data: ClientSignals): void;
    sendAudioData(audioData: Uint8Array): void;
    sendAudioDataImmediate(audioData: Uint8Array): void;
}
export type { BaseSignaling, ClientSignals }