const { GoogleAuth } = require('google-auth-library');

/**
 * Dynamically resolves a Google Cloud Access Token using the user's stored refresh token
 * or service account credentials. 
 */
async function resolveGoogleAccessToken(credentials) {
    if (!credentials) return null;

    try {
        // If they provided a Service Account JSON equivalent
        if (credentials.google_client_email && credentials.google_refresh_token) {
            // In a real OAuth flow, this would use a standard refresh token dance.
            // For MVP, we simulate creating a client from stored SA keys.
            const auth = new GoogleAuth({
                credentials: {
                    client_email: credentials.google_client_email,
                    private_key: credentials.google_refresh_token, // (Storing private key in refresh_token col for MVP ease)
                },
                scopes: ['https://www.googleapis.com/auth/cloud-platform']
            });
            const client = await auth.getClient();
            const token = await client.getAccessToken();
            return { token: token.token, project_id: credentials.google_project_id };
        }
    } catch (e) {
        console.error("Failed to resolve Google Token:", e.message);
    }
    return null;
}

module.exports = {
    resolveGoogleAccessToken
};