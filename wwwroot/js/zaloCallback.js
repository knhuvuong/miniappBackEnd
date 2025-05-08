const express = require('express');
const axios = require('axios');
const qs = require('qs');
const { getVerifier, saveToken } = require('../js/verifierTokenStore');
const app = express();

const APP_ID = process.env.ZALO_APP_ID;
const SECRET_KEY = process.env.ZALO_APP_SECRET;

app.get('/zalo/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  const code_verifier = getVerifier(state);
  if (!code_verifier) {
    return res.status(400).send('Invalid or expired state');
  }

  try {
    const data = qs.stringify({
      code,
      app_id: APP_ID,
      grant_type: 'authorization_code',
      code_verifier
    });

    const response = await axios.post(
      'https://oauth.zaloapp.com/v4/oa/access_token',
      data,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'secret_key': SECRET_KEY
        }
      }
    );

    const tokenData = response.data;
    saveToken(tokenData);

    console.log('ACCESS TOKEN:', tokenData.access_token);
    console.log('REFRESH TOKEN:', tokenData.refresh_token);
    console.log('Hết hạn sau (giây):', tokenData.expires_in);
    
    res.send('Lấy access token thành công!');

  } catch (error) {
    console.error('Error khi gọi API lấy access token:', error.response?.data || error.message);
    res.status(500).send('Lỗi khi lấy access token');
  }
});

module.exports = app;
