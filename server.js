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

const dbConfigSecond = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};

app.get('/', async (req, res) => {
    try {
        const pool = new sql.ConnectionPool(dbConfigSecond);
        await pool.connect();
        res.status(200).send('Kết nối thành công!');
    } catch (err) {
        console.error('Lỗi kết nối SQL Server:', err);
        res.status(500).send('Lỗi kết nối SQL Server');
    }
});

//tìm kiếm thông tin cựu sinh viên trong db
app.get('/api/SinhViens/search', async (req, res) => {
    const { keyword, page = 1, pageSize = 20 } = req.query;
    try {
        const pool = new sql.ConnectionPool(dbConfigSecond);
        await pool.connect();

        const request = pool.request();

        let query = 'SELECT MaSV, TenDayDu, Nam, TenNganh FROM SinhVienTotNghiep WHERE 1=1';

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

        let totalCountQuery = 'SELECT COUNT(*) AS totalCount FROM SinhVienTotNghiep WHERE 1=1';

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

//tìm kiếm thông tin cựu sinh viên đăng nhập zalo
app.get('/api/SinhViens/Zalo/search', async (req, res) => {
    const { keyword, page = 1, pageSize = 20 } = req.query;
    try {
        const pool = new sql.ConnectionPool(dbConfigSecond);
        await pool.connect();

        const request = pool.request();

        let query = 'SELECT ID, MSSV, HoTen, AnhDaiDien, Khoa FROM ZaloAccount WHERE 1=1';

        if (keyword) {
            if (!isNaN(keyword)) {
                query += ' AND (MSSV LIKE @keyword OR Khoa LIKE @keyword)';
                request.input('keyword', sql.NVarChar, `%${keyword}%`);
            } else {
                query += ' AND (HoTen LIKE @keyword)';
                request.input('keyword', sql.NVarChar, `%${keyword}%`);
            }
        }

        const offset = (page - 1) * pageSize;
        query += ` ORDER BY MSSV OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`;

        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, pageSize);

        let totalCountQuery = 'SELECT COUNT(*) AS totalCount FROM ZaloAccount WHERE 1=1';

        if (keyword) {
            if (!isNaN(keyword)) {
                totalCountQuery += ' AND (MSSV LIKE @keyword OR Khoa LIKE @keyword)';
            } else {
                totalCountQuery += ' AND (HoTen LIKE @keyword)';
            }
        }

        const result = await request.query(query);
        const totalCountResult = await request.query(totalCountQuery);
        const totalCount = totalCountResult.recordset[0].totalCount;
        const totalPages = Math.ceil(totalCount / pageSize);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy sinh viên phù hợp');
        }

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

//danh sách csv 
app.get('/api/SinhViens/list', async (req, res) => {
    const { page = 1, pageSize = 5 } = req.query;

    if (isNaN(page) || isNaN(pageSize) || page <= 0 || pageSize <= 0) {
        return res.status(400).send('Page và pageSize phải là số nguyên dương.');
    }

    try {
        const pool = new sql.ConnectionPool(dbConfigSecond);
        await pool.connect();

        const request = pool.request();

        let query = 'SELECT * FROM ZaloAccount';

        const offset = (page - 1) * pageSize;
        query += ` ORDER BY ID OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`;

        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, pageSize);

        const result = await request.query(query);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy bản tin nào!');
        }

        const totalCountQuery = 'SELECT COUNT(*) AS totalCount FROM ZaloAccount';
        const totalCountResult = await request.query(totalCountQuery);
        const totalCount = totalCountResult.recordset[0].totalCount;

        const totalPages = Math.ceil(totalCount / pageSize);

        res.json({
            profiles: result.recordset,
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

//thông tin của 1 user (truyền zaloId vào)
app.get('/api/SinhViens/info', async (req, res) => {
    const { ZaloID } = req.query;
    console.log(ZaloID);

    if (!ZaloID) {
        return res.status(400).json({ error: 'ZaloID không được để trống!' });
    }

    try {
        const pool = new sql.ConnectionPool(dbConfigSecond);
        await pool.connect();

        const request = pool.request();

        request.input('ZaloID', sql.VarChar, ZaloID);

        const query = 'SELECT * FROM ZaloAccount WHERE ZaloID = @ZaloID';
        const result = await request.query(query);

        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy thông tin với ZaloID này!' });
        }

        res.json({ profile: result.recordset[0] });
    } catch (err) {
        console.error('SQL Server Error:', err.message);
        res.status(500).json({ error: 'Lỗi kết nối SQL Server', details: err.message });
    }
});

//cập nhật thông tin
app.post('/api/SinhViens/CapNhatThongTin', async (req, res) => {
    const { MSSV, HoTen, Sdt, Email, Khoa, ZaloID, AnhDaiDien } = req.body;

    if (!MSSV || !HoTen || !Sdt || !Email || !Khoa || !ZaloID || !AnhDaiDien) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    try {
        const pool = new sql.ConnectionPool(dbConfigSecond);
        await pool.connect();

        const result = await pool.request().query(`
            SELECT @@SERVERNAME AS ServerName, DB_NAME() AS DatabaseName
        `);

        console.log('Server đang kết nối:', result.recordset[0]);

        const request = pool.request();

        request.input('ZaloID', sql.NVarChar, ZaloID);

        const checkZaloID = await request.query(`SELECT 1 FROM ZaloAccount WHERE ZaloID = @ZaloID`);

        if (checkZaloID.recordset.length > 0) {
            //tồn tại ZaloID cập nhật
            await request
                .input('MSSV', sql.Int, MSSV)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('Sdt', sql.NVarChar, Sdt)
                .input('Email', sql.NVarChar, Email)
                .input('Khoa', sql.NVarChar, Khoa)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .query(`
                    UPDATE ZaloAccount
                    SET MSSV = @MSSV, HoTen = @HoTen, Sdt = @Sdt, Email = @Email, Khoa = @Khoa, AnhDaiDien = @AnhDaiDien
                    WHERE ZaloID = @ZaloID
                `);

            res.status(200).send('Cập nhật thông tin thành công');
        } else {
            //không tồn tại ZaloID thêm mới
            await request
                .input('MSSV', sql.Int, MSSV)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('Sdt', sql.NVarChar, Sdt)
                .input('Email', sql.NVarChar, Email)
                .input('Khoa', sql.NVarChar, Khoa)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .query(`
                    INSERT INTO ZaloAccount (MSSV, HoTen, Sdt, Email, Khoa, ZaloID, AnhDaiDien)
                    VALUES (@MSSV, @HoTen, @Sdt, @Email, @Khoa, @ZaloID, @AnhDaiDien)
                `);

            res.status(201).send('Thêm mới thông tin thành công');
        }
    } catch (err) {
        console.error('Lỗi chi tiết:', err);
        res.status(500).send('Lỗi khi cập nhật');
    }
});

//5 bản tin mới nhất
app.get('/api/BanTinMoiNhat', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfigSecond);
        const result = await pool.request().query('SELECT TOP 5 * FROM BanTin ORDER BY NgayTao DESC');
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi kết nối SQL Server');
    }
});

//danh sách bản tin
app.get('/api/TatCaBanTin', async (req, res) => {
    const { page = 1, pageSize = 10 } = req.query;

    if (isNaN(page) || isNaN(pageSize) || page <= 0 || pageSize <= 0) {
        return res.status(400).send('Page và pageSize phải là số nguyên dương.');
    }

    try {
        const pool = await sql.connect(dbConfigSecond);
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

//chi tiết bản tin
app.get('/api/ChiTietBanTin', async (req, res) => {
    const { id } = req.query;

    if (!id) {
        return res.status(400).send('Thiếu ID bản tin');
    }

    try {
        const pool = await sql.connect(dbConfigSecond);
        const result = await pool
            .request()
            .input('ID', sql.Int, id)
            .query('SELECT TieuDe, NoiDung, NgayTao FROM BanTin WHERE ID = @ID');

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy bản tin');
        }

        res.json(result.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi kết nối SQL Server');
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

