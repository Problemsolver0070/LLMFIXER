# The Fixer (Opto SaaS) — System Architecture

## 1. System overview

**Project name:** Opto (deployed via The Fixer)
**Purpose:** A model-agnostic API gateway that reduces LLM token consumption by up to 90% via context-on-demand and dual-model optimization, while maintaining full session recall.
**Target audience:** Power users, AI agent developers (Aider, Cursor, LangChain).
**Deployment:** Google Cloud (Cloud Run, Cloud SQL, Cloud Storage).

---

## 2. Backend (proxy layer)

### 2.1 Core technologies

- **Runtime:** Node.js 20 (Express.js)
- **Database:** PostgreSQL 15 (Google Cloud SQL) via `pg` connection pooling
- **Blob storage:** Google Cloud Storage (`@google-cloud/storage`)
- **LLM integrations:** `axios` (OpenAI), `@anthropic-ai/sdk`, `@google/genai`

### 2.2 Request pipeline (`index.js`, `router.js`)

1. **Ingress:** accepts requests on `/v1/chat/completions` (OpenAI spec) and `/v1/messages` (Anthropic spec).
2. **Auth middleware:** validates `Authorization: Bearer opto_...`. Hashes the key to derive a `user_id`.
3. **Credential hydration:** queries `user_credentials` for BYOK or Google OAuth tokens.
4. **Multi-modal stubbing:** scans payload for base64 images, uploads to GCS, replaces with `[IMAGE_STUB: img_hash.jpg]`.
5. **Vault write:** saves the stubbed payload to PostgreSQL, partitioned by `user_id`.
6. **Briefing fetch:** retrieves the pre-computed dense briefing (summary) and drops the historical payload.
7. **Execution:** routes the optimized payload to the requested model.
8. **Streaming interceptor:** a state machine over SSE chunks. If the LLM calls the `search_conversation_history` tool, the stream pauses, the DB query runs, the result is passed back to the LLM, and the stream resumes.
9. **Async background worker:** after the response finishes, a background task uses `gpt-4o-mini` to compute the dense briefing for the next turn, keeping latency off the critical path.

### 2.3 Database schema (PostgreSQL)

- **`sessions`** — active conversations (`id`, `user_id`, `current_briefing`)
- **`messages`** — ground-truth history (`id`, `session_id`, `user_id`, `role`, `content`)
- **`analytics`** — dashboard/billing data (`user_id`, `model`, `naive_tokens`, `optimized_tokens`, `tokens_saved`, `estimated_savings_cents`)
- **`user_credentials`** — BYOK and OAuth tokens (`user_id`, `openai_key`, `anthropic_key`, `google_refresh_token`, etc.)

---

## 3. Frontend (planned for `thefixer.in`)

### 3.1 Core technologies

- **Framework:** Next.js 14 (App Router, React)
- **Styling:** Tailwind CSS + Framer Motion
- **Auth:** NextAuth.js (Google / GitHub SSO)
- **Payments:** PayPal REST SDK

### 3.2 Pages and journey

1. **Landing (`/`):** explanation of token savings, animated terminal showing Cursor/Aider integration, savings calculator.
2. **About (`/about`):** the philosophy behind context-on-demand.
3. **Contact (`/contact`):** sales and support form.
4. **Auth (`/login`, `/signup`):** OAuth flows.
5. **Dashboard (`/dashboard`):**
   - **API keys:** generate and copy `OPTO_API_KEY`.
   - **Integrations:** BYOK fields for OpenAI / Anthropic, or "Connect Google Cloud" OAuth for Vertex AI.
   - **Analytics:** charts pulling from the `analytics` table — tokens and dollars saved.
   - **Billing:** PayPal subscription management.

### 3.3 Billing model

- **Free trial:** $5 worth of optimized tokens or 7 days of proxy access.
- **Subscription:** monthly fee (e.g. $20) via PayPal Subscriptions, unlimited traffic through the optimizer (user pays upstream via BYOK).

---

## 4. Security and compliance

- **Tenant isolation:** every query is scoped by a `user_id` derived from a hashed API key.
- **Credential encryption:** BYOK keys in `user_credentials` to be encrypted at rest via Google Cloud KMS (not yet implemented).
- **Ephemeral memory:** cron job deletes `messages` older than 7 days for SOC2/GDPR compliance.
- **Upstream protection:** exponential backoff on 429/502 to avoid crashing autonomous agents.
