# The Fixer (Opto SaaS) - Complete System Architecture & Documentation

## 1. System Overview
**Project Name:** Opto (Deployed via The Fixer)
**Purpose:** A Model-Agnostic Optimization API Gateway that reduces LLM token consumption by up to 90% via "Context-On-Demand" and dual-model optimization, while maintaining perfect session recall.
**Target Audience:** Power users, AI agent developers (Aider, Cursor, LangChain).
**Deployment Environment:** Google Cloud Platform (Cloud Run, Cloud SQL, Cloud Storage).

---

## 2. Backend Infrastructure (The Proxy Layer)

### 2.1 Core Technologies
* **Runtime:** Node.js 20 (Express.js)
* **Database:** PostgreSQL 15 (Google Cloud SQL) via `pg` connection pooling.
* **Blob Storage:** Google Cloud Storage (`@google-cloud/storage`).
* **LLM Integrations:** `axios` (OpenAI), `@anthropic-ai/sdk`, `@google/genai`.

### 2.2 The Request Pipeline (`index.js` & `router.js`)
1. **Ingress:** Accepts requests on `/v1/chat/completions` (OpenAI spec) and `/v1/messages` (Anthropic spec).
2. **Auth Middleware:** Validates `Authorization: Bearer opto_...`. Hashes the key to derive a secure `user_id`.
3. **Credential Hydration:** Queries `user_credentials` table to retrieve the user's specific BYOK (Bring Your Own Key) or Google OAuth tokens.
4. **Multi-Modal Stubbing:** Scans payload for base64 images, uploads them to GCS, and replaces them with `[IMAGE_STUB: img_hash.jpg]`.
5. **The Vault (Perfect Recall):** Saves the stubbed payload to PostgreSQL partitioned by `user_id`.
6. **Zero-Latency Briefing:** Fetches the pre-computed "Dense Briefing" (summary) from the DB and drops the massive historical payload.
7. **Execution:** Routes the optimized payload to the requested model.
8. **The Streaming Interceptor:** A state machine that intercepts SSE streaming chunks. If the LLM calls an internal tool (`search_conversation_history`), it pauses the stream, executes the DB query, passes the data back to the LLM, and resumes the stream invisibly.
9. **Async Background Worker:** Once the response finishes, a background thread fires up `gpt-4o-mini` to compute the "Dense Briefing" for the *next* turn, ensuring zero latency on the critical path.

### 2.3 The Database Schema (PostgreSQL)
*   **`sessions`**: Tracks active conversations (`id`, `user_id`, `current_briefing`).
*   **`messages`**: The raw, ground-truth history (`id`, `session_id`, `user_id`, `role`, `content`).
*   **`analytics`**: Used for the dashboard/billing (`user_id`, `model`, `naive_tokens`, `optimized_tokens`, `tokens_saved`, `estimated_savings_cents`).
*   **`user_credentials`**: The Centralized Vault for BYOK and OAuth (`user_id`, `openai_key`, `anthropic_key`, `google_refresh_token`, etc.).

---

## 3. Frontend Architecture (Planned for `thefixer.in`)

### 3.1 Core Technologies
* **Framework:** Next.js 14 (App Router, React).
* **Styling:** Tailwind CSS + Framer Motion (for slick, tech-focused animations).
* **Authentication:** NextAuth.js (supporting Google/GitHub SSO).
* **Payments:** PayPal REST SDK.

### 3.2 Key Pages & User Journey
1. **Landing Page (`/`)**: Hero section explaining 90% token savings, animated terminal showing Cursor/Aider integration, interactive savings calculator.
2. **About (`/about`)**: The philosophy of Context-On-Demand and power-user tooling.
3. **Contact (`/contact`)**: Enterprise sales and support form.
4. **Authentication (`/login`, `/signup`)**: OAuth flows.
5. **The User Dashboard (`/dashboard`)**:
   * **API Keys:** Generate and copy their `OPTO_API_KEY`.
   * **Integrations:** Input fields for their OpenAI/Anthropic keys (BYOK) or a "Connect Google Cloud" OAuth button for Vertex AI.
   * **Analytics:** Live charts pulling from the Proxy's `analytics` PostgreSQL table showing tokens saved and dollars saved.
   * **Billing:** PayPal integration to manage their SaaS subscription tier.

### 3.3 The Billing Model (PayPal Integration)
* **Free Trial:** Users get $5.00 worth of "optimized tokens" (calculated via our proxy analytics) or 7 days of proxy access for free.
* **Subscription:** A flat monthly fee (e.g., $20/mo) via PayPal Subscriptions to route unlimited traffic through the optimizer (with the user paying upstream via BYOK).

---

## 4. Security & Compliance
* **Tenant Isolation:** All database queries require a `user_id` derived from a cryptographically hashed API key.
* **Credential Encryption:** (To be implemented) BYOK API keys in `user_credentials` must be encrypted at rest using Google Cloud KMS before being stored in PostgreSQL.
* **Ephemeral Memory:** Background cron job to delete `messages` older than 7 days to maintain SOC2/GDPR compliance.
* **Upstream Protection:** Proxy implements exponential backoff to handle upstream 429/502 errors gracefully without crashing the user's local autonomous agents.