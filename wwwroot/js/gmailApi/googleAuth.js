require('dotenv').config();
const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');
const express = require('express');
const SCOPE = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
const TOKEN_PATH = path.join(process.cwd(), '../credentials/token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), '../credentials/credentials.json');

async function loadAndSaveCredentials() {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (error) {
        return null;
    }
}

async function saveCredentials(client) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.web || keys.installed;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
}

async function authorize() {
    let client = await loadAndSaveCredentials();
    if (client) {
        return client;
    }

    client = await authenticate({
        scopes: SCOPE,
        keyfilePath: CREDENTIALS_PATH,
    });

    if (client.credentials) {
        await saveCredentials(client);
    }

    return client;
}

module.exports = authorize;