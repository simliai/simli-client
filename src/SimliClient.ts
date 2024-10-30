import { EventEmitter } from "events";
import { AudioProcessor } from "./AudioWorklet";
export interface SimliClientConfig {
  apiKey: string;
  faceID: string;
  handleSilence: boolean;
  maxSessionLength: number;
  maxIdleTime: number;
  videoRef: React.RefObject<HTMLVideoElement>;
  audioRef: React.RefObject<HTMLAudioElement>;
}

export class SimliClient extends EventEmitter {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private dcInterval: NodeJS.Timeout | null = null;
  private candidateCount: number = 0;
  private prevCandidateCount: number = -1;
  private apiKey: string = "";
  private faceID: string = "";
  private handleSilence: boolean = true;
  private videoRef: React.RefObject<HTMLVideoElement> | null = null;
  private audioRef: React.RefObject<HTMLAudioElement> | null = null;
  private errorReason: string | null = null;
  private sessionInitialized: boolean = false;
  private inputStreamTrack: MediaStreamTrack | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private audioWorklet: AudioWorkletNode | null = null;
  private audioBuffer: Int16Array | null = null;
  private maxSessionLength: number = 3600;
  private maxIdleTime: number = 600;
  private pingSendTimes: Map<string, number> = new Map();
  private webSocket: WebSocket | null = null;
  constructor() {
    super();
  }

  public Initialize(config: SimliClientConfig) {
    this.apiKey = config.apiKey;
    this.faceID = config.faceID;
    this.handleSilence = config.handleSilence;
    this.maxSessionLength = config.maxSessionLength;
    this.maxIdleTime = config.maxIdleTime;
    if (typeof window !== "undefined") {
      this.videoRef = config.videoRef;
      this.audioRef = config.audioRef;
    } else {
      console.warn(
        "Running in Node.js environment. Some features may not be available."
      );
    }
  }

  private async getIceServers() {
    try {
      const response = await fetch("https://api.simli.ai/getIceServers", {
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({
          apiKey: this.apiKey,
        }),
      });
      if (response.status != 200) {
        console.error("error fetching ice servers");
        // fallback to google stun server if fetch fails
        return [{ urls: ["stun:stun.l.google.com:19302"] }];
      }
      const responseJSON = await response.json();
      const iceServers = responseJSON;
      if (!iceServers || iceServers.length === 0) {
        console.error("error fetching ice servers");
        // fallback to google stun server if fetch fails
        return [{ urls: ["stun:stun.l.google.com:19302"] }];
      }
      return iceServers;
    } catch (error) {
      console.error("error fetching ice servers:", error);
      // fallback to google stun server if fetch fails
      return [{ urls: ["stun:stun.l.google.com:19302"] }];
    }
  }

  private async createPeerConnection() {
    const config = {
      sdpSemantics: "unified-plan",
      iceServers: await this.getIceServers(),
    };
    console.log("Server running: ", config.iceServers);

    this.pc = new window.RTCPeerConnection(config);

    if (this.pc) {
      this.setupPeerConnectionListeners();
    }
  }

  private setupPeerConnectionListeners() {
    if (!this.pc) return;

    this.pc.addEventListener("icegatheringstatechange", () => {
      console.log("ICE gathering state changed: ", this.pc?.iceGatheringState);
    });

    this.pc.addEventListener("iceconnectionstatechange", () => {
      console.log(
        "ICE connection state changed: ",
        this.pc?.iceConnectionState
      );
    });

    this.pc.addEventListener("signalingstatechange", () => {
      console.log("Signaling state changed: ", this.pc?.signalingState);
    });

    this.pc.addEventListener("track", (evt) => {
      console.log("Track event: ", evt.track.kind);
      if (evt.track.kind === "video" && this.videoRef?.current) {
        this.videoRef.current.srcObject = evt.streams[0];
      } else if (evt.track.kind === "audio" && this.audioRef?.current) {
        this.audioRef.current.srcObject = evt.streams[0];
      }
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate === null) {
        console.log(JSON.stringify(this.pc?.localDescription));
      } else {
        console.log(event.candidate);
        this.candidateCount += 1;
      }
    };
  }

  async start() {
    await this.createPeerConnection();

    const parameters = { ordered: true };
    this.dc = this.pc!.createDataChannel("chat", parameters);

    this.setupDataChannelListeners();
    this.pc?.addTransceiver("audio", { direction: "recvonly" });
    this.pc?.addTransceiver("video", { direction: "recvonly" });

    await this.negotiate();
  }

  private setupDataChannelListeners() {
    if (!this.dc) return;

    this.dc.addEventListener("close", () => {
      console.log("Data channel closed");
      this.emit("disconnected");
      this.stopDataChannelInterval();
    });
  }

  private startDataChannelInterval() {
    this.stopDataChannelInterval(); // Clear any existing interval
    this.dcInterval = setInterval(() => {
      this.sendPingMessage();
    }, 1000);
  }

  private stopDataChannelInterval() {
    if (this.dcInterval) {
      clearInterval(this.dcInterval);
      this.dcInterval = null;
    }
  }

  private sendPingMessage() {
    if (this.webSocket && this.webSocket.readyState === this.webSocket.OPEN) {
      const message = "ping " + Date.now();
      this.pingSendTimes.set(message, Date.now());
      console.log("Sending: " + message);
      try {
        this.webSocket?.send(message);
      } catch (error) {
        console.error("Failed to send message:", error);
        this.stopDataChannelInterval();
      }
    } else {
      console.warn(
        "Data channel is not open. Current state:",
        this.webSocket?.readyState
      );
      if (this.errorReason !== null) {
        console.error("Error Reason: ", this.errorReason);
      }
      this.stopDataChannelInterval();
    }
  }

  private async initializeSession() {
    const metadata = {
      faceId: this.faceID,
      isJPG: false,
      apiKey: this.apiKey,
      syncAudio: true,
      handleSilence: this.handleSilence,
      maxSessionLength: this.maxSessionLength,
      maxIdleTime: this.maxIdleTime,
    };

    try {
      const response = await fetch(
        "https://api.simli.ai/startAudioToVideoSession",
        {
          method: "POST",
          body: JSON.stringify(metadata),
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      const resJSON = await response.json();
      if (this.webSocket && this.webSocket.readyState === this.webSocket.OPEN) {
        this.webSocket?.send(resJSON.session_token);
      } else {
        this.emit("failed");
        this.errorReason =
          "Session Init failed: Simli API returned Code:" +
          response.status +
          "\n" +
          JSON.stringify(resJSON);
        console.error(
          "Data channel not open when trying to send session token " +
          this.errorReason
        );
        await this.pc?.close();
      }
    } catch (error) {
      this.emit("failed");
      this.errorReason = "Session Init failed: :" + error;
      console.error("Failed to initialize session:", error);
      await this.pc?.close();
    }
  }

  private async negotiate() {
    if (!this.pc) {
      throw new Error("PeerConnection not initialized");
    }

    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      await this.waitForIceGathering();

      const localDescription = this.pc.localDescription;
      if (!localDescription) return;

      const ws = new WebSocket("https://api.simli.ai/StartWebRTCSession");
      this.webSocket = ws;
      ws.addEventListener("open", async () => {
        await ws.send(JSON.stringify(this.pc?.localDescription))
        await this.initializeSession();

        this.startDataChannelInterval();

      });
      let answer = null;
      ws.addEventListener("message", async (evt) => {
        console.log("Received message: ", evt.data);
        if (evt.data === "START") {
          this.sessionInitialized = true;
          this.emit("connected");
          return;
        }
        else if (evt.data === "STOP") {
          stop();
          return;
        }
        else if (evt.data.substring(0, 4) === "pong") {
          const pingTime = this.pingSendTimes.get(evt.data.replace("pong", "ping"));
          if (pingTime)
            console.log("Simli Latency: ", Date.now() - pingTime);
        }
        else if (evt.data === "ACK") {
          console.log("Received ACK");
        }
        else {
          try {
            const message = JSON.parse(evt.data);
            if (message.type && message.type === "answer") {
              answer = message;
            }

          } catch (e) {
            console.log(e);
          }
        }
      });
      ws.addEventListener("close", () => {
        console.log("Websocket closed");
        this.emit("failed")

      });
      while (answer === null) {
        await new Promise((r) => setTimeout(r, 10));
      }
      console.log(answer);
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
      console.error("Negotiation failed:", e);
      this.errorReason = "Negotiation failed: " + e;
      this.emit("failed");
      this.pc.close();
    }
  }

  private async waitForIceGathering(): Promise<void> {
    if (!this.pc) return;

    if (this.pc.iceGatheringState === "complete") {
      return;
    }

    return new Promise<void>((resolve) => {
      const checkIceCandidates = () => {
        if (
          this.pc?.iceGatheringState === "complete" ||
          this.candidateCount === this.prevCandidateCount
        ) {
          console.log(this.pc?.iceGatheringState, this.candidateCount);
          resolve();
        } else {
          this.prevCandidateCount = this.candidateCount;
          setTimeout(checkIceCandidates, 250);
        }
      };

      checkIceCandidates();
    });
  }

  listenToMediastreamTrack(stream: MediaStreamTrack) {

    this.inputStreamTrack = stream;
    const audioContext: AudioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)({
        sampleRate: 16000,
      });
    this.initializeAudioWorklet(audioContext, stream);
  }

  private initializeAudioWorklet(
    audioContext: AudioContext,
    stream: MediaStreamTrack
  ) {
    audioContext.audioWorklet
      .addModule(
        URL.createObjectURL(
          new Blob([AudioProcessor], { type: "application/javascript" })
        )
      )
      .then(() => {
        this.audioWorklet = new AudioWorkletNode(
          audioContext,
          "audio-processor"
        );
        this.sourceNode = audioContext.createMediaStreamSource(
          new MediaStream([stream])
        );
        if (this.audioWorklet === null) {
          throw new Error("AudioWorklet not initialized");
        }
        this.sourceNode.connect(this.audioWorklet);
        this.audioWorklet.port.onmessage = (event) => {
          if (event.data.type === "audioData") {
            this.sendAudioData(new Uint8Array(event.data.data.buffer));
          }
        };
      });
  }

  sendAudioData(audioData: Uint8Array) {
    if (this.sessionInitialized === false) {
      console.log("Session not initialized. Ignoring audio data.");
      return;
    }
    if (this.webSocket && this.webSocket.readyState === this.webSocket.OPEN) {
      try {
        if (this.sessionInitialized) {
          this.webSocket?.send(audioData);
        } else {
          console.log(
            "Data channel open but session is being initialized. Ignoring audio data."
          );
        }
      } catch (error) {
        console.error("Failed to send audio data:", error);
      }
    } else {
      console.error(
        "Data channel is not open. Current state:",
        this.dc?.readyState,
        "Error Reason: ",
        this.errorReason
      );
    }
  }

  close() {
    this.emit("disconnected");
    this.stopDataChannelInterval();

    // close data channel
    if (this.dc) {
      this.dc.close();
    }
    this.webSocket?.close();

    // close transceivers
    if (this.pc?.getTransceivers) {
      this.pc.getTransceivers().forEach((transceiver) => {
        if (transceiver.stop) {
          transceiver.stop();
        }
      });
    }

    // close local audio / video
    this.pc?.getSenders().forEach((sender) => {
      sender.track?.stop();
    });

    // close peer connection
    this.pc?.close();
  }

  public ClearBuffer = () => {
    if (this.webSocket && this.webSocket.readyState === this.webSocket.OPEN) {
      this.webSocket?.send("SKIP");
    }
  };
}
