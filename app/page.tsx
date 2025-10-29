"use client";

import { useState, useRef, useEffect } from "react";
import { sendMessage } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css"; // Light theme for syntax highlighting

interface Message {
  sender: "user" | "bot";
  text: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage: Message = { sender: "user", text: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    try {
      const response = await sendMessage(input);
      const botMessage: Message = {
        sender: "bot",
        text: response.reply || "No reply from server.",
      };
      setMessages((prev) => [...prev, botMessage]);
    } catch (error) {
      console.error("Error:", error);
      setMessages((prev) => [
        ...prev,
        { sender: "bot", text: "⚠️ Could not connect to backend." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-gray-100 to-white text-gray-900 p-4">
      <h1 className="text-3xl sm:text-4xl font-extrabold mb-6 text-center text-blue-600">
        💬 MeChat
      </h1>

      {/* Chat Container */}
      <div className="w-full max-w-3xl bg-white border border-gray-300 rounded-2xl p-4 h-[75vh] overflow-y-auto mb-4 shadow-md">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`my-2 flex ${
              msg.sender === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`p-3 rounded-2xl shadow-sm break-words inline-block ${
                msg.sender === "user"
                  ? "bg-gray-200 text-gray-900 text-right"
                  : "bg-white text-gray-900 border border-gray-200 w-auto"
              }`}
              style={{
                maxWidth: "80%", // prevent overflow on long texts
                wordWrap: "break-word",
                whiteSpace: "pre-wrap",
              }}
            >
              {msg.sender === "bot" ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                >
                  {msg.text}
                </ReactMarkdown>
              ) : (
                <p className="text-sm sm:text-base leading-relaxed">
                  {msg.text}
                </p>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <p className="text-gray-400 text-center italic mt-2">Thinking...</p>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input Section */}
      <div className="flex w-full max-w-3xl">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          className="flex-1 p-3 rounded-l-xl border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400"
          placeholder="Type your message..."
        />
        <button
          onClick={handleSend}
          disabled={loading}
          className="bg-blue-500 px-5 rounded-r-xl text-white font-semibold hover:bg-blue-600 transition disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
