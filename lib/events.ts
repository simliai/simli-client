interface SimliClientEvents {
    start: () => void;
    stop: () => void;
    error: (detail: string) => void;
    ack: () => void;
    connection_info: (serialized_info: string) => void;
    video_info: (serialized_info: string) => void;
    destination: (serialized_info: string) => void;
    speaking: () => void;
    silent: () => void;
    /**
     * The server's reply to setCamera, setBackground or setForeground: a camera value
     * outside its supported range (applied all the same, "WARNING: ..."), or a change
     * it ignored. The session goes on.
     */
    warning: (message: string) => void;
    unknown: (message: string) => void;
    startup_error: (message: string) => void
}
export type { SimliClientEvents }