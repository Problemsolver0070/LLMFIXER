# Opto SaaS: Master Architecture Specification

## 1. Executive Summary
Opto is a Model-Agnostic Optimization Layer (API Gateway) for Large Language Models. It sits between developer tools (Cursor, Aider, Claude Code, SDKs) and frontier LLM providers (OpenAI, Anthropic, Google Vertex AI). 

Its primary function is to eliminate "N+1 Context Accumulation" in long developer sessions, reducing token costs by up to 90% while actually *increasing* model accuracy and instruction adherence through a paradigm called **Context-On-Demand**.

## 2. The Core Request Lifecycle
When a developer's agent sends a request to the Opto Gateway, the following pipeline executes:

1. **Ingress & Translation:** The Gateway accepts requests in both standard OpenAI format (`/v1/chat/completions`) and Anthropic native format (`/v1/messages`).
2. **Authentication & Hydration:** The Gateway validates the user's `OPTO_API_KEY`, queries the PostgreSQL `user_credentials` table, and securely hydrates the actual upstream provider keys (or dynamically mints Google Cloud OAuth Access Tokens) required for the target model.
3. **Multi-Modal Stubbing:** Massive base64 image strings are intercepted, uploaded to Google Cloud Storage, and replaced with tiny text stubs (`[IMAGE_STUB: img_123.jpg]`) to save tokens.
4. **The Vault (Perfect Recall):** The stubbed payload is securely partitioned by `user_id` and saved to Cloud SQL (PostgreSQL).
5. **Zero-Latency Injection:** The Gateway retrieves a *pre-computed* "Dense Briefing" of the user's history from the database, appends it to the current prompt, and drops the massive raw history.
6. **Tool Injection:** The Gateway silently injects internal tools into the payload (`search_conversation_history`, `view_image`).
7. **Execution & Egress:** The minimized payload is sent to the target LLM. The response is streamed back to the user seamlessly.

## 3. The Streaming Interceptor (The "Silent Hook")
To support native IDEs, the proxy handles Server-Sent Events (SSE) streams natively.
* If the LLM returns text or calls a *user's* tool (like `edit_file`), the bytes are instantly piped to the developer's terminal.
* If the LLM calls an *Opto Internal Tool* (e.g., `search_conversation_history`), the Interceptor state-machine buffers the chunk, pauses the stream to the client, executes the query against PostgreSQL/GCS, returns the data to the LLM mid-stream, and seamlessly resumes the user's stream. 

## 4. Background Asynchronous Processing
Opto achieves zero-latency by removing optimization from the critical path.
* When a stream successfully finishes, the proxy spawns a non-blocking background thread (`vault.triggerBackgroundBriefing`).
* This thread uses a fast, cheap LLM (e.g., `gpt-4o-mini`) to read the newly updated history and compute a highly dense summary.
* This summary is saved to PostgreSQL, meaning it is instantly ready for the user's *next* turn.

## 5. Infrastructure & Deployment (Google Cloud)
* **Compute:** Google Cloud Run (Serverless, auto-scaling, HTTP/2 streaming support).
* **Database:** Google Cloud SQL (PostgreSQL 15) utilizing strict pooling (`max: 20`, `idleTimeoutMillis: 30000`) to survive massive bursts of parallel autonomous agent requests without dropping connections.
* **Blob Storage:** Google Cloud Storage for multi-modal offloading.
* **Analytics:** All token usage and dollar savings are estimated mathematically and logged to the `analytics` table per user.

## 6. Model Agnosticism
Opto enforces strict agnosticism via the `ProviderRouter`. The user's client tool remains completely unaware of the underlying infrastructure. A user can request `claude-3-5-sonnet` via an OpenAI-SDK-based tool, and Opto will translate the schemas, handle Anthropic's proprietary Tool Use blocks, and return standard OpenAI JSON.