const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const sql = require('mssql');

// Cấu hình kết nối
const dbConfigSecond = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true
  },
  connectionTimeout: 30000,
  requestTimeout: 60000
};

let cachedPool = null;

async function getConnection() {
  try {
    if (cachedPool && cachedPool.connected) {
      return cachedPool;
    }

    console.log('🔄 Đang kết nối đến SQL Server...');
    cachedPool = await sql.connect(dbConfigSecond);
    console.log('✅ Đã kết nối SQL Server thành công!');
    return cachedPool;

  } catch (err) {
    console.error('❌ Không thể kết nối SQL Server:', err.message);
    throw err;
  }
}

module.exports = {
  sql,
  getConnection
};
