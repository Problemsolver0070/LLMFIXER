/**
 * Utilities to translate between native Anthropic payloads and our internal standard (OpenAI-like)
 */

function anthropicRequestToStandard(anthropicBody) {
    const standardMessages = [];

    // Anthropic passes system prompt at the root
    if (anthropicBody.system) {
        // System can be a string or array of blocks
        let systemContent = "";
        if (typeof anthropicBody.system === 'string') {
            systemContent = anthropicBody.system;
        } else if (Array.isArray(anthropicBody.system)) {
            systemContent = anthropicBody.system.map(b => b.text).join('\n');
        }
        
        standardMessages.push({
            role: 'system',
            content: systemContent
        });
    }

    // Convert messages
    for (const msg of anthropicBody.messages || []) {
        const standardMsg = { role: msg.role };
        
        if (typeof msg.content === 'string') {
            standardMsg.content = msg.content;
        } else if (Array.isArray(msg.content)) {
            let textContent = "";
            let toolCalls = [];
            let toolResults = [];

            for (const block of msg.content) {
                if (block.type === 'text') {
                    textContent += block.text;
                } else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: {
                            name: block.name,
                            arguments: JSON.stringify(block.input)
                        }
                    });
                } else if (block.type === 'tool_result') {
                     // In Anthropic, tool_result is sent by 'user'
                     standardMsg.role = 'tool';
                     standardMsg.tool_call_id = block.tool_use_id;
                     standardMsg.content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                }
            }

            if (textContent) standardMsg.content = textContent;
            if (toolCalls.length > 0) standardMsg.tool_calls = toolCalls;
        }
        
        standardMessages.push(standardMsg);
    }

    const standardTools = anthropicBody.tools ? anthropicBody.tools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema
        }
    })) : undefined;

    return {
        model: anthropicBody.model,
        messages: standardMessages,
        tools: standardTools,
        max_tokens: anthropicBody.max_tokens,
        temperature: anthropicBody.temperature,
        stream: anthropicBody.stream
    };
}

function standardResponseToAnthropic(standardResponse) {
    const choice = standardResponse.choices[0];
    const message = choice.message;

    const contentBlocks = [];
    if (message.content) {
        contentBlocks.push({ type: "text", text: message.content });
    }

    if (message.tool_calls) {
        for (const tc of message.tool_calls) {
            contentBlocks.push({
                type: "tool_use",
                id: tc.id,
                name: tc.function.name,
                input: JSON.parse(tc.function.arguments)
            });
        }
    }

    return {
        id: standardResponse.id,
        type: "message",
        role: "assistant",
        model: standardResponse.model || "unknown",
        content: contentBlocks,
        stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: standardResponse.usage?.prompt_tokens || 0,
            output_tokens: standardResponse.usage?.completion_tokens || 0
        }
    };
}

module.exports = {
    anthropicRequestToStandard,
    standardResponseToAnthropic
};