import { useState, useEffect, useRef, useCallback } from "react";
import { RealtimeClient } from "@openai/realtime-api-beta";
// @ts-expect-error - External library without type definitions
import { WavRecorder, WavStreamPlayer } from "./lib/wavtools/index.js";

import "./App.css";

const clientRef = { current: null as RealtimeClient | null };
const wavRecorderRef = { current: null as WavRecorder | null };
const wavStreamPlayerRef = { current: null as WavStreamPlayer | null };

export function App() {
  const params = new URLSearchParams(window.location.search);
  const RELAY_SERVER_URL = params.get("wss");
  const [_connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");

  // ── Screenshot canvas ref ──────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [firstFrame, setFirstFrame] = useState(false);

  if (!clientRef.current) {
    clientRef.current = new RealtimeClient({
      url: RELAY_SERVER_URL || undefined,
    });
  }
  if (!wavRecorderRef.current) {
    wavRecorderRef.current = new WavRecorder({ sampleRate: 24000 });
  }
  if (!wavStreamPlayerRef.current) {
    wavStreamPlayerRef.current = new WavStreamPlayer({ sampleRate: 24000 });
  }

  const isConnectedRef = useRef(false);

  const connectConversation = useCallback(async () => {
    if (isConnectedRef.current) return;
    isConnectedRef.current = true;
    setConnectionStatus("connecting");
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    if (!client || !wavRecorder || !wavStreamPlayer) return;

    try {
      await wavRecorder.begin();
      await wavStreamPlayer.connect();
      await client.connect();

      setConnectionStatus("connected");

      client.on("error", (event: any) => {
        console.error(event);
        setConnectionStatus("disconnected");
      });

      client.on("disconnected", () => {
        setConnectionStatus("disconnected");
      });

      client.sendUserMessageContent([{ type: "input_text", text: "The prospect is on the call. Begin the demo now — start by saying a quick hello, then immediately call the login tool to log in and start showing the product." }]);

      // client.updateSession({ turn_detection: { type: "server_vad" } }); // moved to useEffect

      if (wavRecorder.recording) await wavRecorder.pause();
      if (!wavRecorder.recording) {
        await wavRecorder.record((data: { mono: Int16Array }) =>
          client.appendInputAudio(data.mono)
        );
      }

    } catch (error) {
      console.error("Connection error:", error);
      setConnectionStatus("disconnected");
    }
  }, []);

  const errorMessage = !RELAY_SERVER_URL
    ? 'Missing required "wss" parameter in URL'
    : (() => {
      try {
        new URL(RELAY_SERVER_URL);
        return null;
      } catch {
        return 'Invalid URL format for "wss" parameter';
      }
    })();

  // ── Audio + realtime setup ─────────────────────────────────────────────────
  useEffect(() => {
    if (!errorMessage) {
      connectConversation();
      const wavStreamPlayer = wavStreamPlayerRef.current;
      const client = clientRef.current;
      if (!client || !wavStreamPlayer) return;

      // NOTE: Do NOT call client.updateSession() here.
      // The Python relay server already configures the session with tools,
      // instructions, and turn_detection in connect_to_openai().
      // Sending another session.update from the client would overwrite it
      // and break the Playwright tool call interception.

      client.on("error", (event: any) => console.error(event));
      client.on("conversation.interrupted", async () => {
        const trackSampleOffset = await wavStreamPlayer.interrupt();
        if (trackSampleOffset?.trackId) {
          const { trackId, offset } = trackSampleOffset;
          await client.cancelResponse(trackId, offset);
        }
      });
      client.on("conversation.updated", async ({ item, delta }: any) => {
        client.conversation.getItems();
        if (delta?.audio) {
          wavStreamPlayer.add16BitPCM(delta.audio, item.id);
        }
        if (item.status === "completed" && item.formatted.audio?.length) {
          const wavFile = await WavRecorder.decode(
            item.formatted.audio,
            24000,
            24000
          );
          item.formatted.file = wavFile;
        }
      });

      return () => { client.reset(); };
    }
  }, [errorMessage]);

  // ── Screenshot stream setup ────────────────────────────────────────────────
  useEffect(() => {
    if (!RELAY_SERVER_URL) return;

    // Build ws://... or wss://... URL for the /screen endpoint
    const screenUrl = RELAY_SERVER_URL.replace(/\/$/, "") + "/screen";
    const ws = new WebSocket(screenUrl);
    ws.binaryType = "arraybuffer";

    ws.onmessage = async (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const blob = new Blob([e.data], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();

      if (!firstFrame) setFirstFrame(true);
    };

    ws.onerror = (e) => console.error("Screen stream error", e);

    return () => ws.close();
  }, [RELAY_SERVER_URL]);

  return (
    <div className="app-container">

      {/* ── Screenshot canvas — fills entire viewport ── */}
      <canvas
        ref={canvasRef}
        width={1280}
        height={800}
        style={{
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          background: "#09090b",
          // Hide until first frame arrives to avoid flash
          opacity: firstFrame ? 1 : 0,
          transition: "opacity 0.4s ease",
        }}
      />

    </div>
  );
}

export default App;