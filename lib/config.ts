
interface SimliClientConfig {
    faceID: string;
    handleSilence: boolean;
    maxSessionLength: number;
    maxIdleTime: number;
    enableSFU: boolean;
    /** @deprecated Ignored by the server, every session runs fasttalk. */
    model: "fasttalk" | "artalk";
}
export type { SimliClientConfig }