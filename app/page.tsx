"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";

export default function AIChatLayout() {
  const [transcript, setTranscript] = useState("");
  const [input, setInput] = useState("");
  const [recording, setRecording] = useState(false);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [conversationHistory, setConversationHistory] = useState<
    Array<{ type: "user" | "ai"; text: string }>
  >([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const fullTranscriptRef = useRef<string>("");
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const audioQueueRef = useRef<Blob[]>([]);
  const isSendingRef = useRef(false);

  // Keeps the original shared audio stream (tab share) — reuse for subsequent restarts
  const firstStreamRef = useRef<MediaStream | null>(null);

  // Web Audio API for silence detection
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Float32Array | null>(null);

  // Silence detection state
  const silenceStartRef = useRef<number | null>(null);
  const silenceDetectedRef = useRef(false);
  const isRestartingRef = useRef(false);
  const isStoppedByUserRef = useRef(false);
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
  // ---------------- Auto-scroll effects ----------------
  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [transcript]);

  useEffect(() => {
    conversationRef.current?.scrollTo({
      top: conversationRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [conversationHistory]);

  // ---------------- Cleanup previous recorder safely ----------------
  const cleanupPreviousRecorder = () => {
    const prev = mediaRecorderRef.current;
    if (prev) {
      try {
        prev.ondataavailable = null;
        prev.onstop = null;

        if (prev.state !== "inactive") {
          try {
            prev.stop();
          } catch (e) {
            console.warn("Error stopping previous MediaRecorder:", e);
          }
        }
      } finally {
        mediaRecorderRef.current = null;
      }
    }
  };

  // ---------------- Start listening + setup analyser ----------------
  const startAutoListening = async () => {
    try {
      if (!firstStreamRef.current) {
        console.log("Requesting tab share for the first time...");

        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });

        if (!stream.getAudioTracks().length) {
          alert("❌ No audio detected. Make sure you selected 'Share tab audio'.");
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        firstStreamRef.current = stream;
        setVideoStream(stream);
        if (videoRef.current) videoRef.current.srcObject = stream;
        setRecording(true);
        isStoppedByUserRef.current = false;

        // Setup WebAudio analyser once and keep it running
        setupAnalyser(stream);
      }

      // If a recorder is already running, do nothing
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        console.log("MediaRecorder already running");
        return;
      }

      // Create a fresh MediaStream from the same audio tracks
      const audioStream = new MediaStream(firstStreamRef.current.getAudioTracks());

      // Create new MediaRecorder for this live segment
      const mediaRecorder = new MediaRecorder(audioStream, {
        mimeType: "audio/webm;codecs=opus",
      });

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e: BlobEvent) => {
        if (!e.data || e.data.size === 0) {
          console.log("Empty dataavailable event");
          return;
        }

        // push final segment (from start -> stop)
        audioQueueRef.current.push(new Blob([e.data], { type: "audio/webm" }));
        processAudioQueue();
      };

      mediaRecorder.onstop = () => {
        console.log("MediaRecorder stopped (segment ended)");
        // clear the ref here — startAutoListening will create a new recorder when restart occurs
        mediaRecorderRef.current = null;
      };

      // Start recording full segment; we'll stop it when silence is detected
      mediaRecorder.start(); // continuous until we call stop()
      console.log("🎙 MediaRecorder started for fresh segment (will stop on silence)");
    } catch (err) {
      console.error("Failed to start auto listening:", err);
      alert("❌ Could not start screen/tab audio capture.");
    }
  };

  // ---------------- Stop current recorder (only used for silence restart or final stop) ----------------
  const stopAutoListening = () => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      try {
        mr.stop();
      } catch (err) {
        console.warn("Failed to stop MediaRecorder:", err);
      }
    }
    console.log("Stopped current recorder (if any)");
  };

  // ---------------- Process queue (send to backend) ----------------
  const processAudioQueue = async () => {
    if (isSendingRef.current) return;
    isSendingRef.current = true;

    while (audioQueueRef.current.length > 0) {
      const chunk = audioQueueRef.current.shift()!;
      await sendAudioToBackend(chunk);
    }

    isSendingRef.current = false;
  };

  // ---------------- Stop everything completely (user stops) ----------------
  const stopEverythingCompletely = () => {
    console.log("Stopping everything...");

    // Prevent automatic restart
    isStoppedByUserRef.current = true;

    // Stop current recorder
    stopAutoListening();

    // Stop analyser + audio context
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch (e) {
        console.warn("Error closing AudioContext:", e);
      }
      audioCtxRef.current = null;
      analyserRef.current = null;
      dataArrayRef.current = null;
    }

    if (firstStreamRef.current) {
      firstStreamRef.current.getTracks().forEach((track) => track.stop());
      console.log("All shared tab tracks stopped.");
      firstStreamRef.current = null;
    }

    if (videoRef.current) videoRef.current.srcObject = null;

    setRecording(false);
    setVideoStream(null);

    console.log("All recording + tab sharing fully stopped.");
  };

  // ---------------- Send audio blob to backend ----------------
  const sendAudioToBackend = async (blob: Blob) => {
    setIsProcessing(true);
    console.log("Sending chunk to backend, size:", blob.size);

    const formData = new FormData();
    formData.append("file", blob, `chunk_${Date.now()}.webm`);

    try {
      const res = await fetch(`${API_BASE}/api/transcribe/`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Backend error:", res.status, errText);
        return;
      }

      const data = await res.json();
      const text = (data.transcription || data.text || "").trim();

      if (text) {
        fullTranscriptRef.current += (fullTranscriptRef.current ? " " : "") + text;
        setTranscript(fullTranscriptRef.current);

        if (text.includes("?")) {
          const question = fullTranscriptRef.current.trim();
          setConversationHistory((p) => [...p, { type: "user", text: question }]);
          await sendToAI(question);
          fullTranscriptRef.current = "";
          setTranscript("");
        }
      }
    } catch (err) {
      console.error("Transcribe error:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  // ---------------- Send message to AI ----------------
  const sendToAI = async (message: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/chat/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      if (!res.ok) {
        setConversationHistory((p) => [
          ...p,
          { type: "ai", text: `❌ AI Error: ${res.status}` },
        ]);
        return;
      }

      const data = await res.json();
      const reply = data.reply || "No response.";
      setConversationHistory((p) => [...p, { type: "ai", text: reply }]);
    } catch (err) {
      console.error("AI Error:", err);
      setConversationHistory((p) => [
        ...p,
        { type: "ai", text: "❌ Cannot reach AI service." },
      ]);
    }
  };

  const handleSend = () => {
    if (!input.trim()) return;
    setConversationHistory((p) => [...p, { type: "user", text: input }]);
    sendToAI(input);
    setInput("");
  };

  useEffect(() => {
  const handleSpacePress = (e: KeyboardEvent) => {
    // ⛔ If user is typing inside an input or textarea → do NOT override space behavior
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) {
      return; // allow normal spacebar
    }

    // Otherwise → use spacebar as "send transcript"
    if (e.code === "Space") {
      e.preventDefault();

      const text = fullTranscriptRef.current.trim();
      if (!text) return;

      setConversationHistory((p) => [...p, { type: "user", text }]);
      sendToAI(text);

      fullTranscriptRef.current = "";
      setTranscript("");
    }
  };

  window.addEventListener("keydown", handleSpacePress);
  return () => window.removeEventListener("keydown", handleSpacePress);
}, []);


  // ---------------- WebAudio: setup analyser ----------------
  const setupAnalyser = (stream: MediaStream) => {
    try {
      if (audioCtxRef.current) return; // already set

      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;

      source.connect(analyser);

      // Float32 array for time domain
      const dataArray = new Float32Array(analyser.fftSize);
      dataArrayRef.current = dataArray;

      // Start the detection loop
      detectSilenceLoop();
    } catch (err) {
      console.error("Failed to setup analyser:", err);
    }
  };

  // ---------------- Silence detection loop ----------------
  const detectSilenceLoop = () => {
    try {
      const analyser = analyserRef.current!;
      const dataArray = new Float32Array(analyser.fftSize);
      if (!analyser || !dataArray) return;

      analyser.getFloatTimeDomainData(dataArray);
      // compute RMS
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sumSquares += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sumSquares / dataArray.length);

      // threshold and duration (tweakable)
      const silenceThreshold = 0.01; // RMS below this => silence (tweak if too sensitive)
      const silenceDuration = 800; // ms of continuous silence required to trigger restart

      const now = performance.now();

      if (rms < silenceThreshold) {
        // silence
        if (!silenceDetectedRef.current) {
          silenceDetectedRef.current = true;
          silenceStartRef.current = now;
        } else {
          const started = silenceStartRef.current || now;
          if (now - started > silenceDuration) {
            // Only attempt restart if not already restarting and recorder is running
            if (!isRestartingRef.current && mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
              isRestartingRef.current = true;
              console.log("🔇 Silence detected - restarting recorder segment");

              // Stop current recorder. ondataavailable will push the final blob.
              try {
                mediaRecorderRef.current.onstop = () => {
                  console.log("Recorder stopped because of silence. Will restart if allowed.");
                  mediaRecorderRef.current = null;

                  // small delay to avoid races
                  setTimeout(() => {
                    isRestartingRef.current = false;
                    if (!isStoppedByUserRef.current) {
                      startAutoListening().catch((e) => console.error(e));
                    }
                  }, 50);
                };

                mediaRecorderRef.current.stop();
              } catch (err) {
                console.warn("Error stopping mediaRecorder on silence:", err);
                isRestartingRef.current = false;
              }

              // reset silence detector so we don't retrigger immediately
              silenceDetectedRef.current = false;
              silenceStartRef.current = null;
            }
          }
        }
      } else {
        // speech detected -> reset silence timer
        silenceDetectedRef.current = false;
        silenceStartRef.current = null;
      }

      // continue loop if not fully stopped by user
      if (!isStoppedByUserRef.current) requestAnimationFrame(detectSilenceLoop);
    } catch (err) {
      console.error("detectSilenceLoop error:", err);
    }
  };

  // ---------------- Cleanup on unmount ----------------
  useEffect(() => {
    return () => {
      try {
        stopEverythingCompletely();
      } catch (e) {}
    };
  }, []);

  return (
    <div className="flex flex-col md:flex-row w-full min-h-screen p-6 gap-6 bg-gradient-to-br from-gray-900 via-gray-800 to-black text-white">

      {/* LEFT PANEL */}
      <div className="flex flex-col md:w-1/2 w-full bg-white/10 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-5 space-y-6 overflow-hidden">

        {/* Video */}
        <div className="relative w-full h-80 rounded-2xl overflow-hidden border border-white/20 shadow-lg">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />

          {!recording && (
            <button
              onClick={startAutoListening}
              className="absolute bottom-4 right-4 px-5 py-3 rounded-xl font-semibold bg-gradient-to-r from-green-500 to-emerald-600 hover:scale-105 transition-all shadow-xl"
            >
              🎙 Start Listening
            </button>
          )}

          {recording && (
            <button
              onClick={stopEverythingCompletely}
              className="absolute bottom-4 right-4 px-5 py-3 rounded-xl font-semibold bg-gradient-to-r from-red-500 to-red-700 hover:scale-105 transition-all shadow-xl animate-pulse"
            >
              ⏹ Stop
            </button>
          )}
        </div>

        {/* Transcript */}
        <div
          ref={transcriptRef}
          className="flex-1 bg-black/30 backdrop-blur-md rounded-xl border border-white/10 p-4 text-sm leading-relaxed overflow-y-auto min-h-[220px] shadow-inner"
        >
          {recording && !transcript && !isProcessing && (
            <div className="text-yellow-300 font-semibold animate-pulse">
              🎧 Listening... transcript will appear here.
            </div>
          )}

          {isProcessing && (
            <div className="text-blue-300 font-semibold animate-pulse">
              ⏳ Processing audio...
            </div>
          )}

          {transcript && <div className="text-gray-100 whitespace-pre-wrap">{transcript}</div>}

          {!recording && !transcript && (
            <div className="text-gray-400">
              Click <b>Start Listening</b> and select a tab with audio.
            </div>
          )}
        </div>

        {/* Manual Input */}
        <div className="flex items-center">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask something..."
            className="flex-1 px-4 py-3 rounded-l-xl bg-white/10 border border-white/10 text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button
  onClick={handleSend}
  className="h-12 w-12 ml-1 rounded-full bg-gradient-to-r from-purple-500 to-indigo-600 flex items-center justify-center hover:scale-110 transition-all shadow-lg"
>
  ➤
</button>

        </div>
      </div>

      {/* RIGHT CHAT PANEL */}
      <div className="flex flex-col md:w-1/2 w-full bg-white/10 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-5 overflow-hidden max-h-[95vh]">

        <div className="flex items-center justify-between mb-4">
                  <img
            src="/logo.png"
            alt="Logo"
            className="h-12 w-auto object-contain"
          />

          <button
            onClick={() => setConversationHistory([])}
            className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 transition-all text-sm text-gray-200"
          >
            Clear
          </button>
        </div>

        <div ref={conversationRef} className="flex-1 overflow-y-auto p-3 space-y-4">
          {conversationHistory.length === 0 ? (
            <p className="text-gray-400 text-center mt-10">Chat responses will appear here...</p>
          ) : (
            conversationHistory.map((item, idx) => (
              <div key={idx} className={`flex ${item.type === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={` px-4 py-3 rounded-2xl shadow-xl ${
                    item.type === "user"
                      ? "bg-gradient-to-r max-w-[70%] from-blue-600 to-indigo-700 text-white"
                      : "bg-white/10 max-w-[100%] backdrop-blur-md text-gray-100 border border-white/10"
                  }`}
                >
                  {item.type === "ai" ? (
                    <div className="prose prose-sm prose-invert max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {item.text}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap">{item.text}</p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
