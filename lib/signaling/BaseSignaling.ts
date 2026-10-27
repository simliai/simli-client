import { Logger } from "../Logger";

type ClientSignals = "DONE" | "SKIP" | `BG_${string}` | `FG_${string}`
interface BaseSignaling {
    logger: Logger
    connect(connected: () => void): Promise<void>;
    disconnect(): void;
    sendSignal(data: ClientSignals): void;
    sendAudioData(audioData: Uint8Array): void;
    sendAudioDataImmediate(audioData: Uint8Array): void;
    sendCamera(values: number[], lerpSeconds: number | null): void;
}
export type { BaseSignaling, ClientSignals }