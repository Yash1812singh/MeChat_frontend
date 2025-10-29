// lib/api.ts
import axios from "axios";

export interface ChatResponse {
  reply: string;
}

export async function sendMessage(message: string): Promise<ChatResponse> {
  try {
    // Ensure the API base URL is available
    const baseURL = process.env.NEXT_PUBLIC_API_BASE;

    if (!baseURL) {
      throw new Error("API base URL not defined in NEXT_PUBLIC_API_BASE");
    }

    // Make the POST request
    const response = await axios.post(`${baseURL}/api/chat/`, {
      message, // key: message, value: user input
    });

    // Expecting backend to return { reply: "..." }
    return response.data;
  } catch (error: any) {
    console.error("Backend error:", error.response?.data || error.message);
    throw new Error("Failed to connect to backend");
  }
}

