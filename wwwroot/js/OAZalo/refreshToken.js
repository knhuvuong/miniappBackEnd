const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const axios = require('axios');
const qs = require('qs');
const { saveToken } = require('../OAZalo/verifierTokenStore');

const APP_ID = process.env.ZALO_APP_ID;
console.log("Zalo app id:" + APP_ID)
const SECRET_KEY = process.env.ZALO_APP_SECRET;

async function refreshAccessToken(currentRefreshToken) {
  try {
    const data = qs.stringify({
      app_id: APP_ID,
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken
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
    console.log("response trả về:" + tokenData)

    saveToken(tokenData);

    console.log('Refresh thành công. Access token mới đã được lưu!');
    return tokenData;

  } catch (err) {
    console.error('Lỗi khi refresh token:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = refreshAccessToken;
