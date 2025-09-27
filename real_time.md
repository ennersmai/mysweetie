
---

### **Design Document: Real-Time Conversational Feature (V3)**

This version incorporates specific implementation details from the Groq and Rime.ai API documentation.

### **1. Introduction**

This document outlines the system design for adding a real-time, hands-free conversational feature to the AI companion application. The goal is to create a seamless, call-like experience where the user can initiate a voice session and converse naturally with the AI.

**Core Requirements:**
*   **"Call" Initiation:** The user starts the session by pressing a single "call" button.
*   **Hands-Free Interaction:** Server-side Voice Activity Detection (VAD) will manage conversational turn-taking.
*   **Interruptibility (Barge-in):** The user can interrupt the AI at any time. When the user speaks, the AI's audio playback stops immediately, and the system processes the user's new input.

This will be achieved using persistent WebSocket connections for low-latency, bidirectional communication with the client, Groq's streaming ASR, and Rime.ai's streaming TTS.

### **2. High-Level Architecture**

The architecture is centered around the `callService`, which acts as a proxy and orchestrator. It manages a persistent WebSocket connection with the client and dynamically opens and closes WebSocket connections to the Groq and Rime.ai services as needed.

*   **`callController.ts`:** Manages the client-facing WebSocket connection lifecycle.
*   **`callService.ts`:** The core orchestrator. It manages conversational state, VAD, interruption logic, and the proxying of data between the client and the third-party AI services.
*   **External Services:**
    *   **Groq API:** For streaming speech-to-text.
    *   **Rime.ai Arcana API:** For streaming text-to-speech.

### **3. Components and State Management**

#### **3.1. `callController.ts`**
*   **Responsibility:** Manages the WebSocket connection with the client application. It passes incoming audio data to the `callService` and sends outgoing audio and commands from the `callService` back to the client.

#### **3.2. `callService.ts`**
*   **Responsibility:** The brain of the operation.
*   **State Management:** Maintains the conversation state: `IDLE`, `USER_SPEAKING`, `AI_PROCESSING`, `AI_SPEAKING`.
*   **VAD Integration:** Continuously analyzes the audio stream from the client to detect speech, enabling hands-free interaction and interruption.
*   **Interruption Logic:** While in the `AI_SPEAKING` state, if the VAD detects user speech, the service will immediately close the Rime.ai WebSocket connection and send a `stop_playback` command to the client before handling the new user input.
*   **Service Orchestration:** Manages the lifecycle of connections to Groq and Rime.ai.

### **4. Detailed Flow of an Interruptible Conversation**

1.  **Initiation:** The user taps the "call" button. The client establishes a WebSocket to the `callController` and begins streaming raw audio. The `callService` state is `IDLE`.
2.  **User Speaks:** The VAD in `callService` detects speech. The state changes to `USER_SPEAKING`. The `callService` opens a WebSocket to Groq and begins forwarding the user's audio.
3.  **User Finishes Speaking:** The VAD detects silence. The state changes to `AI_PROCESSING`. The `callService` sends an `end_of_stream` message to Groq to get the final transcript. This text is then sent to `chatService`.
4.  **AI Responds:** The `chatService` returns a text response. The state changes to `AI_SPEAKING`. The `callService` opens a WebSocket to Rime.ai, sending the text.
5.  **AI Audio Stream:** `callService` receives audio chunks from Rime.ai and immediately relays them to the client for playback.
6.  **User Interrupts (Barge-in):** While the AI is speaking, the VAD in `callService` detects user speech.
    *   `callService` immediately closes the WebSocket connection to Rime.ai.
    *   It sends a `{ "type": "command", "command": "stop_playback" }` message to the client.
    *   The state changes to `USER_SPEAKING`, and the flow returns to Step 2 to process the new input.
7.  **Termination:** The user taps "end call." The client closes the WebSocket connection.

---

### **5. Detailed API Integration and Data Flow**

This section details the specific protocols and formats required by Groq and Rime.ai. A consistent audio format of **`pcm_s16le` at a `16000 Hz` sample rate** should be used across the entire pipeline to prevent costly resampling.

#### **5.1. Backend-to-Groq (Transcription)**

The `callService` will manage this connection when the user is speaking.

*   **1. Connection:** Open a WebSocket to `wss://api.groq.com/v1/speech-to-text/stream`.
    *   **Header:** `Authorization: Bearer <GROQ_API_KEY>`
*   **2. Configuration:** Immediately after connecting, send a single JSON message:
    ```json
    {
      "type": "config",
      "model": "whisper-large-v3",
      "language": "en-US",
      "sample_rate": 16000,
      "encoding": "pcm_s16le"
    }
    ```*   **3. Audio Streaming:** Forward the raw `pcm_s16le` audio chunks received from the client directly to the Groq WebSocket as binary frames.
*   **4. Receiving Transcripts:** Listen for JSON messages from Groq. Use `result.type === 'final'` to get the complete transcript. Optional: use `interim` results to display real-time transcription on the client UI.
*   **5. Termination:** When VAD detects silence, send a final JSON message to gracefully close the stream: `{"type": "end_of_stream"}`.

#### **5.2. Backend-to-Rime.ai Arcana (TTS)**

The `callService` will manage this connection when the AI is speaking.

*   **1. Connection:** Open a WebSocket to `wss://arcana.rime.ai/v1/stream`.
    *   **Header:** `X-Rime-API-Key: <RIME_API_KEY>`
*   **2. Configuration:** Immediately after connecting, send a single JSON message containing the AI's response text and desired audio format.
    ```json
    {
      "text": "Hello, this is the AI's response.",
      "speaker": "mabel",
      "samplingRate": 16000,
      "audioEncoding": "pcm_s16le"
    }
    ```
*   **3. Receiving Audio:** Rime.ai will immediately begin sending back a stream of raw `pcm_s16le` audio chunks as binary frames.
*   **4. Relaying:** Relay these binary audio frames directly to the client through its WebSocket.
*   **5. Interruption/Termination:** If the user interrupts, the `callService` will simply **close this WebSocket connection abruptly**. This is the signal to stop TTS generation.

#### **5.3. Client-to-Backend WebSocket Protocol**

*   **Client -> Server:** A continuous stream of raw **binary audio data (`pcm_s16le`, 16kHz)**. No JSON wrapping is needed for the audio itself, maximizing efficiency.
*   **Server -> Client:**
    *   **Binary Frames:** Raw `pcm_s16le` audio chunks to be played.
    *   **JSON Messages:**
        ```json
        // To instruct the client to stop playback immediately
        { "type": "command", "command": "stop_playback" }

        // Optional: To show what the user is saying in real-time
        { "type": "transcript_update", "is_final": false, "text": "Hello I was wondering..." }
        ```

### **6. Frontend (Client) Requirements**

*   **Audio Handling:** This is the most critical client-side component.
    *   **Capture:** The client **must** capture microphone audio and encode it as **`pcm_s16le` at 16000 Hz**. The **Web Audio API** (using an `AudioWorklet`) is strongly recommended for this, as standard `MediaRecorder` APIs may not provide the necessary format and control.
    *   **Streaming:** Stream the raw PCM data continuously to the backend WebSocket.
*   **Audio Playback:**
    *   Implement an audio player, again using the **Web Audio API**, that can receive raw PCM chunks, queue them, and play them back seamlessly with minimal latency.
    *   This player must expose a function to **immediately stop and clear its audio buffer** when it receives the `stop_playback` command from the server.
*   **UI/UX:**
    *   Implement "call" and "end call" buttons.
    *   Provide visual feedback for the call state (e.g., "listening," "AI speaking," "connecting").
    *   (Optional) Display the live transcription text received from the `transcript_update` message.