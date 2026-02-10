export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    ERROR = 2,
    CRITICAL = 3
}

export class Logger {
    private currentLevel: LogLevel;
    destination: string | null;
    session_id: string | null;

    constructor(
        level: LogLevel = LogLevel.INFO,
    ) {
        this.currentLevel = level;
        this.destination = null;
        this.session_id = null;
    }

    private formatMessage(level: string, message: string): string {
        const timestamp = new Date().toISOString();
        const destination = this.destination ?? 'not_received';
        const sessionId = this.session_id ?? 'not_received';

        return `SimliClient | ${timestamp} | ${level} | ${destination}/${sessionId} | ${message}`;
    }

    private log(level: LogLevel, levelName: string, message: string, ...args: any[]): void {
        if (level < this.currentLevel) {
            return;
        }

        const formattedMessage = this.formatMessage(levelName, message);

        switch (level) {
            case LogLevel.DEBUG:
            case LogLevel.INFO:
                console.log(formattedMessage, ...args);
                break;
            case LogLevel.ERROR:
            case LogLevel.CRITICAL:
                console.error(formattedMessage, ...args);
                break;
        }
    }

    public debug(message: string, ...args: any[]): void {
        this.log(LogLevel.DEBUG, 'DEBUG', message, ...args);
    }

    public info(message: string, ...args: any[]): void {
        this.log(LogLevel.INFO, 'INFO', message, ...args);
    }

    public error(message: string, ...args: any[]): void {
        this.log(LogLevel.ERROR, 'ERROR', message, ...args);
    }

    public critical(message: string, ...args: any[]): void {
        this.log(LogLevel.CRITICAL, 'CRITICAL', message, ...args);
    }

    public setLevel(level: LogLevel): void {
        this.currentLevel = level;
    }

    public getLevel(): LogLevel {
        return this.currentLevel;
    }
}
