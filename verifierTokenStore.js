const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'verifier.json');
const TOKEN_FILE = path.join(__dirname, 'tokenStore.json');

// ===== Verifier Store =====
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

// ===== Token Store =====
function saveToken(newData) {
  let oldData = {};
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      oldData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8') || '{}');
    } catch (e) {
      console.warn('Không đọc được token cũ:', e.message);
    }
  }

  const merged = {
    ...oldData,
    ...newData,
    updated_at: new Date().toISOString()
  };

  fs.writeFileSync(TOKEN_FILE, JSON.stringify(merged, null, 2));
  console.log('Token đã được cập nhật vào tokenStore.json');
}

function getToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  const content = fs.readFileSync(TOKEN_FILE, 'utf-8');
  return JSON.parse(content);
}

module.exports = {
  saveVerifier,
  getVerifier,
  saveToken,
  getToken
};
