require('dotenv').config();
const crypto = require('crypto');
const { saveVerifier } = require('./verifierTokenStore');

function generatePKCE() {
  const code_verifier = crypto.randomBytes(64).toString('base64url').slice(0, 43);
  const code_challenge = crypto
    .createHash('sha256')
    .update(code_verifier)
    .digest('base64url');
  return { code_verifier, code_challenge };
}

const APP_ID = process.env.ZALO_APP_ID;
const REDIRECT_URI = process.env.REDIRECT_URI; 

const state = crypto.randomUUID();
const { code_verifier, code_challenge } = generatePKCE();

// lưu verifier
saveVerifier(state, code_verifier);

const authorizeUrl = `https://oauth.zaloapp.com/v4/oa/permission?` +
  `app_id=${APP_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&code_challenge=${code_challenge}` +
  `&state=${state}` +
  `&code_challenge_method=S256`;

console.log('Gửi URL này cho admin OA để cấp quyền:\n');
console.log(authorizeUrl);
