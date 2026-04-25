#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Configuration
const PROXY_PORT = 8000;
const PROXY_URL = `http://localhost:${PROXY_PORT}`;
const PROXY_DIR = path.join(__dirname);
const PROXY_SCRIPT = path.join(PROXY_DIR, 'index.js');

/**
 * Checks if the proxy server is already running.
 */
function isProxyRunning() {
    return new Promise((resolve) => {
        const req = http.get(`${PROXY_URL}/v1/models`, (res) => {
            // Even if it 404s, the server is up and responding
            resolve(true);
        }).on('error', () => {
            resolve(false);
        });
        req.setTimeout(1000, () => {
            req.abort();
            resolve(false);
        });
    });
}

/**
 * Starts the proxy server as a detached background process.
 */
function startProxy() {
    console.log(`\x1b[36m[opto]\x1b[0m Starting Optimization Layer in background on port ${PROXY_PORT}...`);
    
    // Check if .env exists
    if (!fs.existsSync(path.join(PROXY_DIR, '.env'))) {
        console.error(`\x1b[31m[opto] Error: No .env file found in ${PROXY_DIR}\x1b[0m`);
        console.error(`\x1b[33mPlease create one with OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.\x1b[0m`);
        process.exit(1);
    }

    const out = fs.openSync(path.join(PROXY_DIR, 'opto_out.log'), 'a');
    const err = fs.openSync(path.join(PROXY_DIR, 'opto_err.log'), 'a');

    const subprocess = spawn('node', [PROXY_SCRIPT], {
        detached: true,
        stdio: ['ignore', out, err],
        cwd: PROXY_DIR,
        env: process.env // Pass current env vars (might contain keys)
    });

    subprocess.unref(); // Allow the parent (this CLI) to exit independently of the child
    
    return new Promise(resolve => setTimeout(resolve, 1500)); // Give it a moment to boot
}

/**
 * Executes the user's command with injected environment variables.
 */
async function runCommand(commandArgs) {
    if (commandArgs.length === 0) {
        console.log(`\x1b[33mUsage: opto <command>\x1b[0m`);
        console.log(`Example: opto cursor .`);
        console.log(`Example: opto npx claude-code`);
        process.exit(0);
    }

    const command = commandArgs[0];
    const args = commandArgs.slice(1);

    // Inject the magical environment variables
    const injectedEnv = {
        ...process.env,
        // Override OpenAI standard endpoints
        OPENAI_BASE_URL: `${PROXY_URL}/v1`,
        // Override Anthropic native endpoints (supported by Claude Code, etc)
        ANTHROPIC_BASE_URL: `${PROXY_URL}`,
        // Some tools use alternate env vars
        OPENAI_API_BASE: `${PROXY_URL}/v1`, 
        // Flag to let downstream code know it's being optimized
        OPTO_LAYER_ACTIVE: "true"
    };

    console.log(`\x1b[32m[opto] Optimization Layer active. Launching: ${command} ${args.join(' ')}\x1b[0m`);

    // Spawn the user's command
    const child = spawn(command, args, {
        stdio: 'inherit', // Pipe input/output directly to the user's terminal
        env: injectedEnv,
        shell: true // Allows things like `npm run ...` to work easily
    });

    child.on('close', (code) => {
        process.exit(code);
    });
}

async function main() {
    const running = await isProxyRunning();
    
    if (!running) {
        await startProxy();
    } else {
         console.log(`\x1b[36m[opto]\x1b[0m Optimization Layer already running.`);
    }

    const args = process.argv.slice(2);
    await runCommand(args);
}

main();