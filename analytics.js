/**
 * Analytics Utility
 * Estimates original token counts and calculates dollar savings.
 */

// Rough rates per 1M Input Tokens (in USD)
const MODEL_RATES = {
    'gpt-4o': 5.00,
    'gpt-4-turbo': 10.00,
    'gpt-3.5-turbo': 0.50,
    'claude-3-5-sonnet': 3.00,
    'claude-3-opus': 15.00,
    'claude-3-haiku': 0.25,
    'gemini-1.5-pro': 3.50,
    'gemini-1.5-flash': 0.35,
    'default': 5.00 // fallback
};

function getRatePerMillion(modelStr) {
    for (const key of Object.keys(MODEL_RATES)) {
        if (modelStr.toLowerCase().includes(key)) {
            return MODEL_RATES[key];
        }
    }
    return MODEL_RATES['default'];
}

function estimateTokens(text) {
    // Rough heuristic: 1 token ~= 4 chars in English
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

function estimateMessageArrayTokens(messages) {
    let totalLength = 0;
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            totalLength += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            // Complex objects
            totalLength += JSON.stringify(msg.content).length;
        }
    }
    return Math.ceil(totalLength / 4);
}

function calculateSavingsCents(naiveTokens, optimizedTokens, model) {
    const ratePerMillion = getRatePerMillion(model);
    const savedTokens = Math.max(0, naiveTokens - optimizedTokens);
    
    // Convert to cents
    const savingsDollars = (savedTokens / 1000000) * ratePerMillion;
    return savingsDollars * 100;
}

module.exports = {
    estimateTokens,
    estimateMessageArrayTokens,
    calculateSavingsCents
};