const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../../verifier.json');
const TOKEN_FILE = path.join(__dirname, '../../tokenStore.json');

//lưu verifier
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

//lưu access_token
function saveToken(newData) {
  const tokenData = {
    access_token: newData.access_token,
    refresh_token: newData.refresh_token,
    expires_in: newData.expires_in,
    updated_at: new Date().toISOString()
  };

  try {
    // Lưu token vào tokenStore.json
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
  } catch (error) {
    console.error('Lỗi khi lưu token:', error.message);
  }
}

function getToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;

  const content = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    console.error('Lỗi khi parse token từ file:', error.message);
    return null;
  }
}

//kiểm tra exp của token
function getTokenExpiryTime(updatedAt, expiresIn) {
  const updatedAtDate = new Date(updatedAt);
  return updatedAtDate.getTime() + expiresIn * 1000; 
}

function isTokenExpired() {
  const tokenData = getToken();
  if (!tokenData || !tokenData.updated_at || !tokenData.expires_in) {
    console.warn('Không tìm thấy thông tin token hợp lệ.');
    return true;
  }

  const expiryTime = getTokenExpiryTime(tokenData.updated_at, tokenData.expires_in);
  const currentTime = Date.now();
  return currentTime >= expiryTime; 
}

async function getAccessToken() {
  const tokenData = getToken();

  if (!tokenData) {
    console.warn('Không tìm thấy token. Bạn cần đăng nhập hoặc lấy token mới.');
    return null;
  }

  if (isTokenExpired()) {
    console.log('Token đã hết hạn. Đang tiến hành refresh token...');

    const refreshToken = tokenData.refresh_token;
    try {
      const newAccessToken = await require('../wwwroot/refreshToken').refreshAccessToken(refreshToken);

      const updatedTokenData = {
        ...tokenData,
        access_token: newAccessToken,
        updated_at: new Date().toISOString(),
      };

      saveToken(updatedTokenData);

      console.log('Token mới đã được lấy và lưu thành công.');
      return newAccessToken;
    } catch (error) {
      console.error('Lỗi khi refresh token:', error.message);
      return null;
    }
  }

  console.log('Access token vẫn còn hạn, tiếp tục sử dụng.');
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
 