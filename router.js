const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const Auth = require('./auth');

// Note: Removed global lazy-load clients. 
// In a Centralized SaaS, clients must be instantiated per-request 
// using the specific user's hydrated API key from the database.

/**
 * Normalizes our proxy tool into Anthropic format
 */
const ANTHROPIC_SEARCH_TOOL = {
    name: "search_conversation_history",
    description: "Searches the complete, raw conversation history for exact quotes, specific code snippets, or past decisions. Use this if the Dense Briefing lacks the specific detail you need.",
    input_schema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The keyword, variable name, or topic to search for in the history."
            }
        },
        required: ["query"]
    }
};

/**
 * Normalizes our proxy tool into Gemini format
 */
const GEMINI_SEARCH_TOOL = {
    functionDeclarations: [
        {
            name: "search_conversation_history",
            description: "Searches the complete, raw conversation history for exact quotes, specific code snippets, or past decisions.",
            parameters: {
                type: "OBJECT",
                properties: {
                    query: {
                        type: "STRING",
                        description: "The keyword, variable name, or topic to search for in the history."
                    }
                },
                required: ["query"]
            }
        }
    ]
};

class ProviderRouter {
    /**
     * Executes the payload against the requested model provider.
     * Returns a normalized OpenAI format response AND any tool calls we need to intercept.
     */
    static async execute(payload, targetModel, providerKeys, retries = 2) {
        try {
            if (targetModel.startsWith('claude')) {
                return await this._executeAnthropic(payload, targetModel, providerKeys.anthropic);
            } else if (targetModel.startsWith('gemini')) {
                return await this._executeGemini(payload, targetModel, providerKeys.gemini);
            } else {
                return await this._executeOpenAI(payload, targetModel, providerKeys.openai);
            }
        } catch (error) {
            // Intelligent Upstream Error Normalization and Retry Logic
            const status = error.response ? error.response.status : (error.status || 500);
            
            // 429 Too Many Requests or 502/503/504 Server Errors are retriable
            if ((status === 429 || status >= 500) && retries > 0) {
                console.warn(`[ROUTER] Upstream Error ${status} from ${targetModel}. Retrying in 2 seconds... (${retries} retries left)`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return await this.execute(payload, targetModel, providerKeys, retries - 1);
            }

            // If we run out of retries or it's a 400 Bad Request, throw a clean, normalized error
            console.error(`[ROUTER] Fatal Upstream Error from ${targetModel}:`, error?.response?.data || error.message);
            
            const normalizedError = {
                type: "upstream_provider_error",
                model: targetModel,
                status: status,
                message: error?.response?.data?.error?.message || error.message || "Unknown upstream failure"
            };
            
            throw new Error(JSON.stringify(normalizedError));
        }
    }

    static async _executeOpenAI(payload, model, apiKey) {
        if (!apiKey) throw new Error("OPENAI_API_KEY missing from request/env");
        
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            ...payload,
            model: model
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            responseType: payload.stream ? 'stream' : 'json'
        });

        if (payload.stream) {
            return { isStream: true, stream: response.data, provider: 'openai' };
        }

        const msg = response.data.choices[0].message;
        
        return {
            isStream: false,
            normalizedResponse: response.data,
            originalMessageObject: msg,
            toolCalls: msg.tool_calls ? msg.tool_calls.map(tc => ({
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments),
                provider: 'openai'
            })) : []
        };
    }

    static async _executeAnthropic(payload, model, apiKey) {
        if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing from request/env");
        const anthropic = new Anthropic({ apiKey: apiKey });

        // Translate OpenAI Messages to Anthropic Messages
        let systemPrompt = "";
        const anthropicMessages = [];

        for (const msg of payload.messages) {
            if (msg.role === 'system') {
                systemPrompt += msg.content + "\n";
            } else if (msg.role === 'tool') {
                 // Map OpenAI tool result to Anthropic tool_result
                 anthropicMessages.push({
                     role: "user",
                     content: [
                         {
                             type: "tool_result",
                             tool_use_id: msg.tool_call_id,
                             content: msg.content
                         }
                     ]
                 });
            } else if (msg.role === 'assistant' && msg.tool_calls) {
                // Map Assistant tool call
                const contentBlocks = [];
                if (msg.content) contentBlocks.push({ type: "text", text: msg.content });
                
                for(const tc of msg.tool_calls) {
                    contentBlocks.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: JSON.parse(tc.function.arguments)
                    })
                }
                anthropicMessages.push({ role: "assistant", content: contentBlocks });
            } else {
                // Standard user/assistant text
                anthropicMessages.push({ role: msg.role, content: msg.content });
            }
        }

        const anthropicPayload = {
            model: model,
            max_tokens: payload.max_tokens || 4096,
            system: systemPrompt.trim() || undefined,
            messages: anthropicMessages,
            tools: payload.tools ? payload.tools.map(t => {
                if(t.function.name === 'search_conversation_history') return ANTHROPIC_SEARCH_TOOL;
                // If user passed other tools, map them here (simplified for MVP)
                return t;
            }) : [ANTHROPIC_SEARCH_TOOL]
        };

        const response = await anthropic.messages.create(anthropicPayload);

        // Extract tool calls if any
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const textBlock = response.content.find(b => b.type === 'text');

        // Build OpenAI compliant output
        const openaiMessage = {
            role: "assistant",
            content: textBlock ? textBlock.text : null,
        };

        if (toolUseBlocks.length > 0) {
            openaiMessage.tool_calls = toolUseBlocks.map(tb => ({
                id: tb.id,
                type: "function",
                function: {
                    name: tb.name,
                    arguments: JSON.stringify(tb.input)
                }
            }));
        }

        return {
            normalizedResponse: {
                id: `msg_${Date.now()}`,
                choices: [{ message: openaiMessage }]
            },
            originalMessageObject: openaiMessage,
            toolCalls: toolUseBlocks.map(tb => ({
                id: tb.id,
                name: tb.name,
                arguments: tb.input,
                provider: 'anthropic'
            }))
        };
    }

    static async _executeGemini(payload, model, apiKeyOrCreds) {
        if (!apiKeyOrCreds) throw new Error("GEMINI credentials missing from database/request");
        
        let gemini;
        // Check if it's an API Key string or a Google Auth Credential Object
        if (typeof apiKeyOrCreds === 'string') {
            gemini = new GoogleGenAI({ apiKey: apiKeyOrCreds });
        } else {
            // Dynamic OAuth Resolution for Vertex AI
            const authResult = await Auth.resolveGoogleAccessToken(apiKeyOrCreds);
            if (!authResult) throw new Error("Failed to resolve Google Access Token");
            
            gemini = new GoogleGenAI({ 
                vertexai: {
                    project: authResult.project_id,
                    location: 'us-central1'
                },
                auth: authResult.token // Note: Actual SDK integration might require auth client object depending on version
            });
        }

        let systemInstruction = undefined;
        const contents = [];

        for (const msg of payload.messages) {
            if (msg.role === 'system') {
                systemInstruction = systemInstruction ? systemInstruction + "\n" + msg.content : msg.content;
            } else if (msg.role === 'tool') {
                contents.push({
                    role: "function",
                    parts: [{ functionResponse: { name: msg.name || "search_conversation_history", response: { result: msg.content } } }]
                });
            } else if (msg.role === 'assistant' && msg.tool_calls) {
                const parts = [];
                if (msg.content) parts.push({ text: msg.content });
                for(const tc of msg.tool_calls) {
                     parts.push({ functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) }});
                }
                contents.push({ role: "model", parts });
            } else {
                contents.push({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text: msg.content }] });
            }
        }

        const request = {
            model: model,
            contents: contents,
            systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
            tools: payload.tools ? [GEMINI_SEARCH_TOOL] : [GEMINI_SEARCH_TOOL]
        };

        if (payload.stream) {
            const stream = await gemini.models.generateContentStream(request);
            
            // Create a custom NodeJS Readable Stream that normalizes Gemini chunks into OpenAI SSE format
            const { Readable } = require('stream');
            const normalizedStream = new Readable({
                read() {}
            });

            (async () => {
                try {
                    let callIdx = 0;
                    for await (const chunk of stream) {
                        const candidates = chunk.candidates || [];
                        if (candidates.length === 0) continue;
                        
                        const parts = candidates[0].content?.parts || [];
                        
                        for (const part of parts) {
                            if (part.text) {
                                const openaiChunk = {
                                    choices: [{ delta: { content: part.text } }]
                                };
                                normalizedStream.push(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                            } else if (part.functionCall) {
                                const openaiChunk = {
                                    choices: [{
                                        delta: {
                                            tool_calls: [{
                                                id: `call_${callIdx++}`,
                                                function: {
                                                    name: part.functionCall.name,
                                                    arguments: JSON.stringify(part.functionCall.args)
                                                }
                                            }]
                                        }
                                    }]
                                };
                                normalizedStream.push(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                            }
                        }
                    }
                    normalizedStream.push('data: [DONE]\n\n');
                    normalizedStream.push(null); // End stream
                } catch (err) {
                    console.error("Gemini Stream Error:", err);
                    normalizedStream.destroy(err);
                }
            })();

            return { isStream: true, stream: normalizedStream, provider: 'gemini' };
        }

        // Non-streaming logic
        const response = await gemini.models.generateContent(request);
        const candidates = response.candidates || [];
        if (candidates.length === 0) throw new Error("No Gemini candidates returned");

        const firstCandidate = candidates[0];
        const functionCalls = firstCandidate.content.parts.filter(p => p.functionCall).map(p => p.functionCall);
        const textParts = firstCandidate.content.parts.filter(p => p.text).map(p => p.text).join("");

        const openaiMessage = {
            role: "assistant",
            content: textParts || null
        };

        if (functionCalls.length > 0) {
             openaiMessage.tool_calls = functionCalls.map((fc, idx) => ({
                 id: `call_${idx}`,
                 type: "function",
                 function: { name: fc.name, arguments: JSON.stringify(fc.args) }
             }));
        }

        return {
            isStream: false,
            normalizedResponse: {
                id: `msg_${Date.now()}`,
                choices: [{ message: openaiMessage }]
            },
            originalMessageObject: openaiMessage,
            toolCalls: functionCalls.map((fc, idx) => ({
                id: `call_${idx}`,
                name: fc.name,
                arguments: JSON.stringify(fc.args), // Normalize to string for consistency
                provider: 'gemini'
            }))
        };
    }
}

module.exports = ProviderRouter;