const axios = require('axios');
const vault = require('./vault');

// The fast model to use for summarization/briefing.
// In a real scenario, this would be an env var pointing to gpt-4o-mini or claude-3-haiku
const OPTIMIZER_MODEL = process.env.OPTIMIZER_MODEL || "gpt-4o-mini";

async function generateDenseBriefing(messages, apiKey) {
  if (!apiKey) throw new Error("API Key missing for Optimizer");
  
  // If the conversation is short, don't bother summarizing yet.
  if (messages.length <= 4) {
    return null;
  }

  // Extract the history to summarize (exclude system prompt and the very latest messages)
  const historyToSummarize = messages.slice(0, messages.length - 2);
  
  const summarizationPrompt = {
    role: "system",
    content: `You are an expert context compressor for a routing proxy.
Your job is to read the following conversation history and produce a "Dense Briefing".
This briefing will be passed to a frontier model instead of the raw history.

RULES:
1. Extract ALL factual information, constraints, decisions, and exact code module names discussed.
2. State the "Current State of the World" (what has been achieved, what is currently being worked on).
3. Do NOT drop any technical details.
4. Keep it extremely dense and concise. Use bullet points.
5. Drop all pleasantries and conversational filler.`
  };

  const payload = {
    model: OPTIMIZER_MODEL,
    messages: [summarizationPrompt, ...historyToSummarize],
    temperature: 0.1,
    max_tokens: 1000
  };

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error("Error generating dense briefing:", error?.response?.data || error.message);
    return null; // Fallback gracefully
  }
}

async function optimizeCurrentPrompt(currentMessage, apiKey) {
    if (!apiKey) throw new Error("API Key missing for Optimizer");
    const optimizationPrompt = {
        role: "system",
        content: `You are an expert prompt engineer. Your goal is to rewrite the user's prompt so that the target LLM produces the highest quality output using the minimum necessary output tokens.
        
        RULES:
        1. Maintain the exact intent and constraints of the user's request.
        2. Instruct the target model to be extremely concise, drop pleasantries, and only output the required code or answer.
        3. If it's a coding task, instruct the model to only output the specific functions/lines changed, not the entire file unless explicitly requested.`
    };

    const payload = {
        model: OPTIMIZER_MODEL,
        messages: [optimizationPrompt, { role: "user", content: `Original Prompt:\n${currentMessage.content}` }],
        temperature: 0.2
    };

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        });
    
        return response.data.choices[0].message.content;
      } catch (error) {
        console.error("Error optimizing prompt:", error?.response?.data || error.message);
        return currentMessage.content; // Fallback to original
      }
}

module.exports = {
  generateDenseBriefing,
  optimizeCurrentPrompt
};