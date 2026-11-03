import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fetch from 'node-fetch';

import { readSecret, SECRET_KEYS } from './endpoints/secrets.js';

/**
 * The Authorization header for a Vertex AI request, by its auth mode.
 * @param {import('express').Request} request
 * @returns {Promise<{authHeader: string, authType: 'proxy'|'express'|'full'}>}
 */
export async function getVertexAIAuth(request) {
    const authMode = request.body.vertexai_auth_mode || 'express';

    if (request.body.reverse_proxy) {
        return {
            authHeader: `Bearer ${request.body.proxy_password}`,
            authType: 'proxy',
        };
    }

    if (authMode === 'express') {
        const apiKey = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI);
        if (apiKey) {
            return {
                authHeader: `Bearer ${apiKey}`,
                authType: 'express',
            };
        }
        throw new Error('API key is required for Vertex AI Express mode');
    } else if (authMode === 'full') {
        // Get service account JSON from backend storage
        const serviceAccountJson = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT);

        if (serviceAccountJson) {
            try {
                const serviceAccount = JSON.parse(serviceAccountJson);
                const jwtToken = await generateJWTToken(serviceAccount);
                const accessToken = await getAccessToken(jwtToken);
                return {
                    authHeader: `Bearer ${accessToken}`,
                    authType: 'full',
                };
            } catch (error) {
                console.error('Failed to authenticate with service account:', error);
                throw new Error(`Service account authentication failed: ${error.message}`);
            }
        }
        throw new Error('Service Account JSON is required for Vertex AI Full mode');
    }

    throw new Error(`Unsupported Vertex AI authentication mode: ${authMode}`);
}

/**
 * Generates a JWT token for Google Cloud authentication using service account credentials.
 * @param {object} serviceAccount Service account JSON object
 * @returns {Promise<string>} JWT token
 */
async function generateJWTToken(serviceAccount) {
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 3600; // 1 hour

    const header = {
        alg: 'RS256',
        typ: 'JWT',
    };

    const payload = {
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: expiry,
    };

    const headerBase64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${headerBase64}.${payloadBase64}`;

    // Create signature using private key
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(serviceAccount.private_key, 'base64url');

    return `${signatureInput}.${signature}`;
}

async function getAccessToken(jwtToken) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwtToken,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to get access token: ${error}`);
    }

    /** @type {any} */
    const data = await response.json();
    return data.access_token;
}

/**
 * Extracts the project ID from a Service Account JSON object.
 * @param {object} serviceAccount Service account JSON object
 * @returns {string} Project ID
 * @throws {Error} If project ID is not found in the service account
 */
export function getProjectIdFromServiceAccount(serviceAccount) {
    if (!serviceAccount || typeof serviceAccount !== 'object') {
        throw new Error('Invalid service account object');
    }

    const projectId = serviceAccount.project_id;
    if (!projectId || typeof projectId !== 'string') {
        throw new Error('Project ID not found in service account JSON');
    }

    return projectId;
}
