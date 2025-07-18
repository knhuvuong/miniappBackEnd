const fs = require('fs');
const path = require('path');
const { getConnection } = require('../db');

const filePath = path.join(__dirname, '../../verifier.json');

function readStore() {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
}

function writeStore(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function saveVerifier(state, code_verifier) {
  const store = readStore();
  store[state] = code_verifier;
  writeStore(store);
}

function getVerifier(state) {
  return readStore()[state];
}

async function getToken() {
  try {
    const pool = await getConnection();
    const result = await pool.request()
      .query('SELECT * FROM Zalo_Token WHERE id = 1');

    const tokenData = result.recordset[0];

    if (
      tokenData &&
      tokenData.access_token &&
      tokenData.refresh_token &&
      tokenData.access_token.trim() !== '' &&
      tokenData.refresh_token.trim() !== ''
    ) {
      return tokenData;
    } else {
      console.warn('Token không hợp lệ hoặc thiếu access_token / refresh_token');
      return null;
    }
  } catch (err) {
    console.error('Lỗi khi lấy token từ DB:', err.message);
    return null;
  }
}

async function saveToken(newData) {
  const { access_token, refresh_token, expires_in } = newData;
  const updated_at = new Date().toISOString();

  try {
    const pool = await getConnection();

    await pool.request()
      .input('id', 1)
      .input('access_token', access_token)
      .input('refresh_token', refresh_token)
      .input('expires_in', expires_in)
      .input('updated_at', updated_at)
      .query(`
        IF EXISTS (SELECT 1 FROM Zalo_Token WHERE id = @id)
        BEGIN
          UPDATE Zalo_Token
          SET access_token = @access_token,
              refresh_token = @refresh_token,
              expires_in = @expires_in,
              updated_at = @updated_at
          WHERE id = @id
        END
        ELSE
        BEGIN
          INSERT INTO Zalo_Token (access_token, refresh_token, expires_in, updated_at)
          VALUES (@access_token, @refresh_token, @expires_in, @updated_at)
        END
      `);

    console.log('✅ Token đã được lưu hoặc cập nhật vào database.');
  } catch (error) {
    console.error('❌ Lỗi khi lưu token:', error.message);
  }
}

function getTokenExpiryTime(updatedAt, expiresIn) {
  const updatedAtDate = new Date(updatedAt);
  return updatedAtDate.getTime() + expiresIn * 1000;
}

async function isTokenExpired() {
  const tokenData = await getToken();
  // console.log("token từ db:", JSON.stringify(tokenData, null, 2));  
  if (!tokenData || !tokenData.updated_at || !tokenData.expires_in) {
    console.warn('Không có token hợp lệ trong DB.');
    return true;
  }

  const expiryTime = getTokenExpiryTime(tokenData.updated_at, tokenData.expires_in);
  return Date.now() >= expiryTime;
}

async function getAccessToken() {
  const tokenData = await getToken();
  if (!tokenData) {
    console.warn('Không có access token trong DB.');
    return null;
  }

  if (await isTokenExpired()) {
    console.log('🔄 Token hết hạn, đang refresh...');
    const refreshToken = tokenData.refresh_token;

    try {
      const { access_token, refresh_token, expires_in } =
        await require('../wwwroot/refreshToken').refreshAccessToken(refreshToken);

      const updatedTokenData = {
        access_token,
        refresh_token: refresh_token || tokenData.refresh_token,
        expires_in: expires_in || tokenData.expires_in,
      };

      await saveToken(updatedTokenData);
      return access_token;
    } catch (err) {
      console.error('Lỗi khi refresh:', err.message);
      return null;
    }
  }

  return tokenData.access_token;
}

module.exports = {
  saveVerifier,
  getVerifier,
  saveToken,
  getToken,
  getAccessToken,
  isTokenExpired
};
