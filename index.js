require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const vault = require('./vault');
const optimizer = require('./optimizer');
const ProviderRouter = require('./router');
const Translator = require('./translator');
const Analytics = require('./analytics');
const MultiModal = require('./multimodal');
const Auth = require('./auth');
const encryption = require('./encryption');

const app = express();
// Trust the Container Apps front-end proxy so req.ip reflects the real client.
app.set('trust proxy', 1);
app.use(bodyParser.json({ limit: '50mb' }));

// Rate-limit bypass for the dashboard UI and its stats feed.
const skipUIRoutes = (req) => req.path.startsWith('/dashboard') || req.path.startsWith('/api/stats');

// Pre-auth IP shield: protects against floods of bad-auth attempts.
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 500,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: skipUIRoutes,
    handler: (req, res) => res.status(429).json({
        error: { type: 'rate_limit_exceeded', scope: 'ip', message: 'Too many requests from this IP. Slow down and retry shortly.' }
    })
}));

// --- Authentication & Centralized Credential Middleware ---
app.use(async (req, res, next) => {
    // Ignore dashboard route
    if (req.path.startsWith('/dashboard') || req.path.startsWith('/api/stats')) return next();

    // 1. Validate OPTO SaaS API Key
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Unauthorized: Missing or invalid OPTO_API_KEY in Authorization header." });
    }
    const optoKey = authHeader.split(' ')[1];

    if (!optoKey.startsWith('opto_')) {
        return res.status(401).json({ error: "Unauthorized: Invalid OPTO_API_KEY. Must start with 'opto_'" });
    }

    const crypto = require('crypto');
    req.userId = crypto.createHash('sha256').update(optoKey).digest('hex').substring(0, 16);

    // 2. Hydrate Credentials from Centralized DB
    const dbCreds = await vault.getUserCredentials(req.userId);
    
    // Fallback logic: 
    // 1. Database
    // 2. Custom header (in case they want to override locally)
    // 3. Process.env (For our master optimizer account)
    req.providerKeys = {
        openai: (dbCreds && dbCreds.openai_key) || req.headers['x-openai-key'] || process.env.OPENAI_API_KEY,
        anthropic: (dbCreds && dbCreds.anthropic_key) || req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY,
        gemini: (dbCreds && dbCreds.google_refresh_token) ? dbCreds : (req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY)
    };

    next();
});

// Per-user generous rate limit (keyed by hashed opto_ key's user_id)
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.userId || req.ip,
    skip: skipUIRoutes,
    handler: (req, res) => res.status(429).json({
        error: { type: 'rate_limit_exceeded', scope: 'user', message: 'You are sending requests too fast. Please retry in a moment.' }
    })
}));

// Serve the dashboard
app.use('/dashboard', express.static(path.join(__dirname, 'public')));

app.get('/api/stats', async (req, res) => {
    try {
        // MVP: passing 'ADMIN_VIEW' to see all. In prod, require auth and pass req.userId
        const stats = await vault.getGlobalStats('ADMIN_VIEW');
        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// The Tool Definition we inject into every request
const SEARCH_HISTORY_TOOL = {
    type: "function",
    function: {
        name: "search_conversation_history",
        description: "Searches the complete, raw conversation history for exact quotes, specific code snippets, or past decisions. Use this if the Dense Briefing lacks the specific detail you need.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The keyword, variable name, or topic to search for in the history."
                }
            },
            required: ["query"]
        }
    }
};

const VIEW_IMAGE_TOOL = {
    type: "function",
    function: {
        name: "view_image",
        description: "Retrieves the actual image data for a given [IMAGE_STUB: filename]. Use this ONLY if you explicitly need to see the pixels of the image to answer the user's current question.",
        parameters: {
            type: "object",
            properties: {
                stub_id: {
                    type: "string",
                    description: "The filename of the stub (e.g. img_abc123.jpg)"
                }
            },
            required: ["stub_id"]
        }
    }
};

// Anthropic Ingress Endpoint
app.post('/v1/messages', async (req, res) => {
    try {
        const anthropicPayload = req.body;
        
        if (!anthropicPayload.messages || anthropicPayload.messages.length === 0) {
            return res.status(400).json({ error: { type: "invalid_request_error", message: "messages are required" } });
        }

        const standardPayload = Translator.anthropicRequestToStandard(anthropicPayload);
        const messages = standardPayload.messages;
        const sessionId = req.headers['x-session-id'] || generateSessionId(messages);

        await executeCorePipeline(standardPayload, messages, sessionId, req.userId, req.providerKeys, anthropicPayload.model, res, true);

    } catch (error) {
        console.error("Anthropic Ingress Error:", error?.response?.data || error);
        res.status(500).json({ error: { type: "api_error", message: "Proxy Layer Error: " + error.message } });
    }
});

// Extracted core pipeline to be shared between ingress endpoints
async function executeCorePipeline(originalPayload, messages, sessionId, userId, providerKeys, requestedModel, res, isAnthropicIngress = false) {
    // 1. Multi-Modal Stubbing Phase
    const stubbedMessages = await MultiModal.extractAndStubMessages(messages);

    // 2. The Vault: Store absolute ground truth (Securely partitioned by userId)
    await vault.storeMessages(sessionId, userId, stubbedMessages);

    // 3. ZERO-LATENCY Optimization Phase
    // Fetch the pre-computed briefing from the database (instant)
    let denseBriefing = await vault.getBriefing(sessionId, userId);
    
    const systemPrompt = stubbedMessages.find(m => m.role === 'system');
    const currentUserMessage = stubbedMessages[stubbedMessages.length - 1];
    const previousAssistantMessage = stubbedMessages.length > 2 ? stubbedMessages[stubbedMessages.length - 2] : null;

    // We only optimize the CURRENT prompt on the critical path, as this requires the user's immediate input.
    // This is a fast LLM call (e.g. gpt-4o-mini) that usually takes < 400ms.
    const optimizerKey = providerKeys.openai;
    let optimizedPromptContent = currentUserMessage.content;
    
    if (currentUserMessage.role === 'user') {
         optimizedPromptContent = await optimizer.optimizeCurrentPrompt(currentUserMessage, optimizerKey);
    }

    // 4. Payload Reconstruction
    const optimizedMessages = [];
    if (systemPrompt) optimizedMessages.push(systemPrompt);
    
    if (denseBriefing) {
        optimizedMessages.push({
            role: 'system',
            content: `--- CURRENT STATE OF THE WORLD (DENSE BRIEFING) ---\n${denseBriefing}\n\nNOTE: The full history is hidden. Use the 'search_conversation_history' tool if you need exact details from the past. Use 'view_image' if you need to see an image stub.`
        });
    } else {
        const historyToPass = stubbedMessages.slice(systemPrompt ? 1 : 0, stubbedMessages.length - 1);
        optimizedMessages.push(...historyToPass);
    }

    if (previousAssistantMessage && previousAssistantMessage.role === 'assistant' && denseBriefing) {
        optimizedMessages.push(previousAssistantMessage);
    }

    // Special logic for the CURRENT user message:
    // If they just attached an image, we MUST send the actual raw image to the target model so it can answer the prompt.
    // We only stub out images from history. So we pull the final message from the ORIGINAL un-stubbed array.
    const originalCurrentUserMessage = messages[messages.length - 1];
    optimizedMessages.push({
        ...originalCurrentUserMessage,
        content: originalCurrentUserMessage.role === 'user' ? optimizedPromptContent : originalCurrentUserMessage.content
        // Note: For MVP, if optimizedPromptContent is a string but original was an array (with an image), 
        // we might lose the image here. In a production system, we'd only optimize the text block of the array.
    });

    // 5. Tool Injection
    const internalTools = [SEARCH_HISTORY_TOOL, VIEW_IMAGE_TOOL];
    const payloadToFrontier = {
        ...originalPayload,
        messages: optimizedMessages,
        tools: originalPayload.tools ? [...originalPayload.tools, ...internalTools] : internalTools
    };

    // 6. Execution & Tool Interception
    const targetModel = requestedModel || 'gpt-4o';
    console.log(`[PROXY] Core Pipeline targeting ${targetModel}. Stream: ${!!originalPayload.stream}`);
    
    // Analytics estimation
    const naiveTokens = Analytics.estimateMessageArrayTokens(messages);
    const optimizedTokens = Analytics.estimateMessageArrayTokens(optimizedMessages);
    const savingsCents = Analytics.calculateSavingsCents(naiveTokens, optimizedTokens, targetModel);
    
    await vault.logAnalytics(sessionId, userId, targetModel, naiveTokens, optimizedTokens, savingsCents);

    if (originalPayload.stream) {
        // Handle Streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        await executeStreamWithToolHandling(payloadToFrontier, sessionId, userId, providerKeys, targetModel, res, isAnthropicIngress);
        
        // BACKGROUND: Kick off briefing calculation for the NEXT turn
        vault.triggerBackgroundBriefing(sessionId, userId, optimizerKey, optimizer);
        
    } else {
        // Handle Non-Streaming
        try {
            const response = await executeWithToolHandling(payloadToFrontier, sessionId, userId, providerKeys, targetModel);
            if (isAnthropicIngress) {
                res.json(Translator.standardResponseToAnthropic(response));
            } else {
                res.json(response);
            }
        } catch (err) {
            // Send polite normalized JSON error to the client instead of HTML vomit
            const errorBody = err.message.startsWith('{') ? JSON.parse(err.message) : { message: err.message };
            res.status(errorBody.status || 500).json({ error: errorBody });
        }
        
        // BACKGROUND: Kick off briefing calculation for the NEXT turn
        vault.triggerBackgroundBriefing(sessionId, userId, optimizerKey, optimizer);
    }
}

// Update the original OpenAI endpoint to use the core pipeline
app.post('/v1/chat/completions', async (req, res) => {
    try {
        const originalPayload = req.body;
        const messages = originalPayload.messages;
        
        if (!messages || messages.length === 0) {
            return res.status(400).json({ error: "Messages array is required." });
        }

        const sessionId = req.headers['x-session-id'] || generateSessionId(messages);
        
        await executeCorePipeline(originalPayload, messages, sessionId, req.userId, req.providerKeys, originalPayload.model, res, false);

    } catch (error) {
        console.error("OpenAI Ingress Error:", error?.response?.data || error);
        res.status(500).json({ error: "Proxy Layer Error", details: error.message });
    }
});

// Helper functions
async function executeStreamWithToolHandling(payload, sessionId, userId, providerKeys, targetModel, res, isAnthropicIngress, depth = 0) {
    if (depth > 3) {
        res.write('data: {"error": "Max tool execution depth exceeded"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
    }

    let routerResponse;
    try {
        routerResponse = await ProviderRouter.execute(payload, targetModel, providerKeys);
    } catch (err) {
        // Stream Error Handling
        const errorBody = err.message.startsWith('{') ? JSON.parse(err.message) : { message: err.message };
        res.write(`data: {"error": ${JSON.stringify(errorBody)}}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
    }

    // If it's not actually a stream (some models fail back to JSON), handle it
    if (!routerResponse.isStream) {
        // Fallback to non-streaming logic
        console.warn("[PROXY] Model returned JSON despite stream request.");
        const finalObj = isAnthropicIngress ? Translator.standardResponseToAnthropic(routerResponse.normalizedResponse) : routerResponse.normalizedResponse;
        res.write(`data: ${JSON.stringify(finalObj)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
    }

    const stream = routerResponse.stream;
    
    // State machine for tool interception
    let isInterceptingInternalTool = false;
    let internalToolCallBuffer = "";
    let internalToolCallId = "";
    let internalToolName = "";
    let assistantMessageBuffer = ""; // To re-append if we call a tool

    stream.on('data', async (chunk) => {
        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
            if (line === 'data: [DONE]') continue; // Handled at end
            if (!line.startsWith('data: ')) continue;

            try {
                const data = JSON.parse(line.slice(6));
                const delta = data.choices[0].delta;

                // Track text for our history if we need to call a tool later
                if (delta.content) {
                    assistantMessageBuffer += delta.content;
                }

                // Detect Tool Calls
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (tc.function && (tc.function.name === 'search_conversation_history' || tc.function.name === 'view_image')) {
                            // Start intercepting! Do NOT send to client.
                            isInterceptingInternalTool = true;
                            internalToolCallId = tc.id || internalToolCallId;
                            internalToolName = tc.function.name;
                        }
                        
                        if (isInterceptingInternalTool && tc.function && tc.function.arguments) {
                            // Buffer the arguments as they stream in
                            internalToolCallBuffer += tc.function.arguments;
                        }
                    }
                }

                // If we are NOT intercepting, pass the chunk to the client immediately
                if (!isInterceptingInternalTool) {
                    // Translate chunk if necessary (OpenAI chunk -> Anthropic Event Stream)
                    // For MVP simplicity, we assume client can handle standard OpenAI chunks if we send them
                    // A true production proxy requires translating OpenAI SSE chunks to Anthropic SSE chunks here.
                    res.write(`${line}\n\n`);
                }

            } catch (e) {
                // Ignore parse errors on partial chunks, though SSE usually sends full JSON lines
            }
        }
    });

    stream.on('end', async () => {
        if (isInterceptingInternalTool) {
            console.log(`[PROXY] Target model invoked Context-On-Demand tool '${internalToolName}'. Buffering complete.`);
            try {
                const args = JSON.parse(internalToolCallBuffer);
                let result = "";

                if (internalToolName === 'search_conversation_history') {
                    result = await vault.searchHistory(sessionId, userId, args.query);
                } else if (internalToolName === 'view_image') {
                    const base64Data = await MultiModal.getBlob(args.stub_id);
                    if (base64Data) {
                        result = `Image Data Recovered.`;
                    } else {
                        result = "Image not found on disk.";
                    }
                }
                
                // Construct the payload to resume
                payload.messages.push({
                    role: "assistant",
                    content: assistantMessageBuffer || null,
                    tool_calls: [{
                        id: internalToolCallId,
                        type: "function",
                        function: {
                            name: internalToolName,
                            arguments: internalToolCallBuffer
                        }
                    }]
                });

                payload.messages.push({
                    tool_call_id: internalToolCallId,
                    role: "tool",
                    name: internalToolName,
                    content: result
                });

                console.log(`[PROXY] Returning data to target model, resuming stream...`);
                await executeStreamWithToolHandling(payload, sessionId, userId, providerKeys, targetModel, res, isAnthropicIngress, depth + 1);
                
            } catch (err) {
                console.error("[PROXY] Failed to parse internal tool call buffer:", err);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        } else {
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });

    stream.on('error', (err) => {
        console.error("Stream Error:", err);
        res.end();
    });
}

async function executeWithToolHandling(payload, sessionId, userId, providerKeys, targetModel, depth = 0) {
    if (depth > 3) throw new Error("Max tool execution depth exceeded.");

    // Route execution to specific provider while getting back unified format
    const routerResponse = await ProviderRouter.execute(payload, targetModel, providerKeys);
    
    // Check if the model called OUR injected tool
    if (routerResponse.toolCalls && routerResponse.toolCalls.length > 0) {
        const toolResults = [];
        let handleInternalTool = false;

        for (const toolCall of routerResponse.toolCalls) {
            if (toolCall.name === 'search_conversation_history' || toolCall.name === 'view_image') {
                handleInternalTool = true;
                const args = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : toolCall.arguments;
                console.log(`[PROXY] Target model invoked Context-On-Demand: ${toolCall.name}`);
                
                let result = "";
                if (toolCall.name === 'search_conversation_history') {
                    result = await vault.searchHistory(sessionId, userId, args.query);
                } else if (toolCall.name === 'view_image') {
                     const base64Data = await MultiModal.getBlob(args.stub_id);
                     result = base64Data ? "Image recovered successfully" : "Image not found.";
                }
                
                toolResults.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    name: toolCall.name,
                    content: result
                });
            }
        }

        if (handleInternalTool) {
            // Append the assistant's tool call request and our tool responses
            payload.messages.push(routerResponse.originalMessageObject);
            payload.messages.push(...toolResults);
            
            console.log(`[PROXY] Returning Vault data to target model, re-executing...`);
            return executeWithToolHandling(payload, sessionId, userId, providerKeys, targetModel, depth + 1);
        }
    }

    // Return standardized OpenAI response back to user
    return routerResponse.normalizedResponse;
}

function generateSessionId(messages) {
    // Naive session hashing for stateless clients. 
    // Combines first message content length to guess uniqueness.
    if (messages.length === 0) return uuidv4();
    const firstMsg = messages[0].content;
    const hash = typeof firstMsg === 'string' ? Buffer.from(firstMsg.substring(0, 50)).toString('base64') : uuidv4();
    return `session_${hash}`;
}

// Initialize encryption (loads BYOK master key from Key Vault) before serving traffic.
encryption.init()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`[OPT-LAYER] Proxy listening on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('[CRYPTO] Failed to initialize encryption — refusing to serve:', err);
        process.exit(1);
    });