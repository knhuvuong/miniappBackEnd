const express = require('express');
const bodyParser = require('body-parser');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config(); 

const app = express();
app.use(bodyParser.json());

app.use(cors({
    origin: ['http://localhost:3000', 'https://h5.zalo.me', 'zbrowser://h5.zalo.me'], 
    methods: ['GET', 'POST', 'PUT', 'DELETE'], 
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

const dbConfig = {
    user: process.env.DB_USER,                
    password: process.env.DB_PASSWORD,        
    server: process.env.DB_SERVER,            
    database: process.env.DB_DATABASE,        
    options: {
        encrypt: process.env.DB_ENCRYPT === 'true', 
    },
};

//tìm kiếm thông tin sinh viên
app.get('/api/SinhViens/search', async (req, res) => {
    const { keyword, page = 1, pageSize = 20 } = req.query;
    try {
        const pool = await sql.connect(dbConfig);
        const request = pool.request();

        let query = 'SELECT MaSV, TenDayDu, Nam, TenNganh FROM SinhVien_Edu_TotNghiep_27042024 WHERE 1=1';

        if (keyword) {
            if (!isNaN(keyword)) {
                query += ' AND (MaSV LIKE @keyword OR Nam LIKE @keyword)';
                request.input('keyword', sql.NVarChar, `%${keyword}%`);
            } else {
                query += ' AND (TenNganh LIKE @keyword OR TenDayDu LIKE @keyword)';
                request.input('keyword', sql.NVarChar, `%${keyword}%`);
            }
        }

        const offset = (page - 1) * pageSize;
        query += ` ORDER BY MaSV OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`;

        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, pageSize);

        // Use 'let' to modify the query string
        let totalCountQuery = 'SELECT COUNT(*) AS totalCount FROM SinhVien_Edu_TotNghiep_27042024 WHERE 1=1';
        
        if (keyword) {
            if (!isNaN(keyword)) {
                totalCountQuery += ' AND (MaSV LIKE @keyword OR Nam LIKE @keyword)';
            } else {
                totalCountQuery += ' AND (TenNganh LIKE @keyword OR TenDayDu LIKE @keyword)';
            }
        }

        const result = await request.query(query);
        const totalCountResult = await request.query(totalCountQuery);
        const totalCount = totalCountResult.recordset[0].totalCount;
        const totalPages = Math.ceil(totalCount / pageSize);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy sinh viên phù hợp');
        }

        // Send the response with pagination info
        res.json({
            students: result.recordset,
            totalCount,
            page,
            pageSize,
            totalPages
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi kết nối SQL Server');
    }
});

//5 bản tin mới nhất
app.get('/api/BanTinMoiNhat', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request().query('SELECT TOP 5 * FROM BanTin ORDER BY NgayTao DESC');
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi kết nối SQL Server');
    }
});

//danh sách bản tin
app.get('/api/TatCaBanTin', async (req, res) => {
    const { page = 1, pageSize = 5 } = req.query;

    if (isNaN(page) || isNaN(pageSize) || page <= 0 || pageSize <= 0) {
        return res.status(400).send('Page và pageSize phải là số nguyên dương.');
    }

    try {
        const pool = await sql.connect(dbConfig);
        const request = pool.request();

        let query = 'SELECT * FROM BanTin';

        const offset = (page - 1) * pageSize;
        query += ` ORDER BY ID OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`;

        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, pageSize);

        const result = await request.query(query);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy bản tin nào!');
        }

        const totalCountQuery = 'SELECT COUNT(*) AS totalCount FROM BanTin';
        const totalCountResult = await request.query(totalCountQuery);
        const totalCount = totalCountResult.recordset[0].totalCount;

        const totalPages = Math.ceil(totalCount / pageSize);

        res.json({
            articles: result.recordset,
            totalCount, 
            page,       
            pageSize,   
            totalPages  
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi kết nối SQL Server');
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

