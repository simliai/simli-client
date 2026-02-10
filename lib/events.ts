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
    unknown: (message: string) => void;
    startup_error: (message: string) => void
}
export type { SimliClientEvents }