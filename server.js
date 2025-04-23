const express = require('express');
const bodyParser = require('body-parser');
const sql = require('mssql');
const cors = require('cors');
const nodemailer = require("nodemailer");
require('dotenv').config();
const axios = require("axios");
const cron = require('node-cron');

const zaloCallback = require('./zaloCallback');
const refreshAccessToken = require('./refreshToken');
const app = express();
const { getToken } = require('./verifierTokenStore');

cron.schedule('0 0 * * *', async () => {
    const tokenData = getToken();
    console.log(`----------Thực hiện refresh lúc ${new Date().toLocaleString()}----------`);
    if (!tokenData?.refresh_token) return console.log('Chưa có refresh_token để làm mới');

    try {
        await refreshAccessToken(tokenData.refresh_token);
    } catch (err) {
        console.error('Refresh thất bại');
    }
});

const dbConfigSecond = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

const generateOTP = () => {
    return Math.floor(10000 + Math.random() * 90000).toString();
};

app.use(bodyParser.json());

app.use(cors({ origin: "*" }));

app.use('/', zaloCallback);

//gửi otp cập nhật thông tin
app.post("/api/sendOTP", async (req, res) => {
    const { mail, zaloAccId } = req.body;
    console.log(mail, zaloAccId)
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 2 * 60 * 1000); //het han 2'

    if (!mail) {
        return res.status(400).send({ message: "Email không hợp lệ!" });
    }

    const otp = generateOTP();
    const createAtUTC = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const expiresAtUTC = new Date(expiresAt.getTime() + 7 * 60 * 60 * 1000);
    const verify = 0

    try {
        const pool = new sql.ConnectionPool(dbConfigSecond);
        await pool.connect();

        const existingOTP = await pool.request()
            .input('Mail', sql.NVarChar, mail)
            .query(`SELECT 1 FROM Zalo_OTP WHERE Mail = @Mail AND NgayHetHan > GETDATE()`);

        if (existingOTP.recordset.length > 0) {
            return res.status(429).send({ message: "Vui lòng chờ trước khi yêu cầu OTP mới." });
        }

        await pool.request()
            .input('Mail', sql.NVarChar, mail)
            .input('ZaloAcc_ID', sql.Int, zaloAccId)
            .input('OTP', sql.NVarChar, otp)
            .input('NgayTao', sql.DateTime, createAtUTC)
            .input('NgayHetHan', sql.DateTime, expiresAtUTC)
            .input('TrangThai', sql.Bit, verify)
            .query(`INSERT INTO Zalo_OTP (Mail, ZaloAcc_ID, OTP, NgayTao, NgayHetHan, TrangThai) VALUES (@Mail, @ZaloAcc_ID, @OTP, @NgayTao, @NgayHetHan, @TrangThai)`);

        const mailOptions = {
            from: "nhukhanhtv052@gmail.com",
            to: mail,
            subject: "Mã OTP xác thực của bạn",
            text: `Mã OTP của bạn là: ${otp}. Vui lòng không chia sẻ mã này với bất kỳ ai!`,
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.log(error);
                return res.status(500).send({ message: "Lỗi khi gửi OTP qua mail", error });
            }

            console.log("OTP đã được gửi thành công: " + info.response);
            return res.status(200).send({ message: "Thành công", info });
        });

    } catch (error) {
        console.error("Lỗi khi gửi OTP:", error);
        return res.status(500).send({ message: "Lỗi hệ thống", error });
    }
});

//xác nhận otp
app.post("/api/verifyOTP", async (req, res) => {
    const { mail, otp } = req.body;

    try {
        const pool = new sql.ConnectionPool(dbConfigSecond);
        await pool.connect();

        const result = await pool.request()
            .input('Mail', sql.NVarChar, mail)
            .input('OTP', sql.NVarChar, otp)
            .query(`SELECT * FROM Zalo_OTP WHERE Mail = @Mail AND OTP = @OTP AND NgayHetHan > GETDATE() AND TrangThai = 0`);

        if (result.recordset.length === 0) {
            return res.status(400).send({ message: "OTP không hợp lệ, đã hết hạn hoặc đã được sử dụng!" });
        }

        await pool.request()
            .input('Mail', sql.NVarChar, mail)
            .query(`UPDATE Zalo_OTP SET TrangThai = 1 WHERE Mail = @Mail`);

        await pool.request()
            .input('Mail', sql.NVarChar, mail)
            .query(`UPDATE ZaloAccount SET DaXacThuc = 1 WHERE Email = @Mail`);

        return res.status(200).send({ message: "Xác minh OTP thành công!" });

    } catch (error) {
        console.error("Lỗi khi xác minh OTP:", error);
        return res.status(500).send({ message: "Lỗi hệ thống", error });
    }
});

//tìm kiếm thông tin cựu sinh viên trong db
app.get('/api/SinhViens/search', async (req, res) => {
    const { keyword, page = 1, pageSize = 20 } = req.query;
    try {
        const pool = new sql.ConnectionPool(dbConfigSecond);
        await pool.connect();

        const request = pool.request();

        let query = 'SELECT STT, MaSV, MaLop, TenDayDu, Nam, TenNganh FROM SinhVien_Edu_TotNghiep_27042024 WHERE 1=1';

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

        let query = 'SELECT ID, MaSV, HoTen, AnhDaiDien, Khoa FROM ZaloAccount WHERE 1=1';

        if (keyword) {
            if (!isNaN(keyword)) {
                query += ' AND (MaSV LIKE @keyword OR Khoa LIKE @keyword)';
                request.input('keyword', sql.NVarChar, `%${keyword}%`);
            } else {
                query += ' AND (HoTen LIKE @keyword)';
                request.input('keyword', sql.NVarChar, `%${keyword}%`);
            }
        }

        const offset = (page - 1) * pageSize;
        query += ` ORDER BY MaSV OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`;

        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, pageSize);

        let totalCountQuery = 'SELECT COUNT(*) AS totalCount FROM ZaloAccount WHERE 1=1';

        if (keyword) {
            if (!isNaN(keyword)) {
                totalCountQuery += ' AND (MaSV LIKE @keyword OR Khoa LIKE @keyword)';
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
            return res.status(404).send('Không tìm thấy user nào!');
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
    // console.log("Received ZaloID:", ZaloID);

    if (!ZaloID) {
        return res.status(400).json({ error: 'ZaloID không được để trống!' });
    }

    let pool;
    try {
        pool = await sql.connect(dbConfigSecond);

        const query = 'SELECT * FROM ZaloAccount WHERE ZaloID = @ZaloID';
        const result = await pool.request()
            .input('ZaloID', sql.VarChar, ZaloID)
            .query(query);

        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Chưa có thông tin!' });
        }

        res.json({ profile: result.recordset[0] });
    } catch (err) {
        console.error('SQL Server Error:', err.message);
        res.status(500).json({ error: 'Lỗi kết nối SQL Server', details: err.message });
    } finally {
        if (pool) pool.close();
    }
});

app.post('/api/SinhViens/TaoThongTinMoi', async (req, res) => {
    const {
        SVTN_ID, MaSV, MaLop, HoTen, Sdt, Email, Khoa, ChucVu,
        DonViCongTac, ThamNien, DiaChiLienHe, ZaloID, AnhDaiDien
    } = req.body;

    if (!SVTN_ID || !MaSV || !MaLop || !HoTen || !Sdt || !Email || !Khoa || !ZaloID || !AnhDaiDien) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    const NgayTao = new Date();
    const NgayCapNhat = new Date();

    let pool;
    try {
        pool = await sql.connect(dbConfigSecond);

        // 🔍 Tạo request riêng để check tồn tại ZaloID
        const checkRequest = pool.request();
        checkRequest.input('ZaloID', sql.NVarChar, ZaloID);
        const checkZaloID = await checkRequest.query(`
            SELECT ID FROM ZaloAccount WHERE ZaloID = @ZaloID
        `);

        let zaloAccId;

        if (checkZaloID.recordset.length > 0) {
            // ✅ Đã tồn tại - UPDATE
            const updateRequest = pool.request();
            updateRequest.input('ZaloID', sql.NVarChar, ZaloID)
                .input('SVTN_ID', sql.Int, SVTN_ID)
                .input('MaSV', sql.Int, MaSV)
                .input('MaLop', sql.VarChar, MaLop)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('Sdt', sql.NVarChar, Sdt)
                .input('Email', sql.NVarChar, Email)
                .input('Khoa', sql.NVarChar, Khoa)
                .input('ChucVu', sql.NVarChar, ChucVu)
                .input('DonViCongTac', sql.NVarChar, DonViCongTac)
                .input('ThamNien', sql.NVarChar, ThamNien)
                .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .input('NgayTao', sql.DateTime, NgayTao)
                .input('NgayCapNhat', sql.DateTime, NgayCapNhat);

            await updateRequest.query(`
                UPDATE ZaloAccount
                SET SVTN_ID = @SVTN_ID, MaSV = @MaSV, MaLop = @MaLop, HoTen = @HoTen, Sdt = @Sdt, Email = @Email, 
                    Khoa = @Khoa, ChucVu = @ChucVu, DonViCongTac = @DonViCongTac, ThamNien = @ThamNien, 
                    DiaChiLienHe = @DiaChiLienHe, AnhDaiDien = @AnhDaiDien, NgayTao = @NgayTao, 
                    NgayCapNhat = @NgayCapNhat, DaXacThuc = 0
                WHERE ZaloID = @ZaloID
            `);

            zaloAccId = checkZaloID.recordset[0].ID;

        } else {
            // 🚀 Chưa tồn tại - INSERT mới
            const insertRequest = pool.request();
            insertRequest
                .input('SVTN_ID', sql.Int, SVTN_ID)
                .input('MaSV', sql.Int, MaSV)
                .input('MaLop', sql.VarChar, MaLop)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('Sdt', sql.NVarChar, Sdt)
                .input('Email', sql.NVarChar, Email)
                .input('Khoa', sql.NVarChar, Khoa)
                .input('ChucVu', sql.NVarChar, ChucVu)
                .input('DonViCongTac', sql.NVarChar, DonViCongTac)
                .input('ThamNien', sql.NVarChar, ThamNien)
                .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe)
                .input('ZaloID', sql.NVarChar, ZaloID)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .input('NgayTao', sql.DateTime, NgayTao)
                .input('NgayCapNhat', sql.DateTime, NgayCapNhat);

            const insertResult = await insertRequest.query(`
                INSERT INTO ZaloAccount (
                    SVTN_ID, MaSV, MaLop, HoTen, Sdt, Email, Khoa, ChucVu, DonViCongTac, 
                    ThamNien, DiaChiLienHe, ZaloID, AnhDaiDien, NgayTao, NgayCapNhat, DaXacThuc
                )
                OUTPUT INSERTED.ID
                VALUES (
                    @SVTN_ID, @MaSV, @MaLop, @HoTen, @Sdt, @Email, @Khoa, @ChucVu, @DonViCongTac, 
                    @ThamNien, @DiaChiLienHe, @ZaloID, @AnhDaiDien, @NgayTao, @NgayCapNhat, 0
                )
            `);

            zaloAccId = insertResult.recordset[0]?.ID;
        }

        res.status(200).send({
            message: 'Thành công tạo mới user',
            zaloAccId: zaloAccId || null
        });

    } catch (err) {
        console.error("🔥 Lỗi xử lý:", err);
        res.status(500).send('Lỗi khi gửi OTP');
    } finally {
        pool && pool.close();
    }
});

app.delete('/api/SinhViens/ZaloAccount/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (!id) {
        return res.status(400).send("Thiếu ID để xoá.");
    }

    const index = zaloAccounts.findIndex(acc => acc.id === id);

    if (index === -1) {
        return res.status(404).send("Không tìm thấy tài khoản để xoá.");
    }

    zaloAccounts.splice(index, 1);
    return res.status(200).send("Đã xoá tài khoản thành công.");
});

// Cập nhật thông tin sinh viên
app.post('/api/SinhViens/CapNhatThongTin', async (req, res) => {
    const { MaSV, MaLop, HoTen, Sdt, Email, Khoa, ChucVu, DonViCongTac, ThamNien, DiaChiLienHe, ZaloID, AnhDaiDien } = req.body;

    if (!MaSV || !MaLop || !HoTen || !Sdt || !Email || !Khoa || !ZaloID || !AnhDaiDien) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    const NgayCapNhat = new Date();

    let pool;
    try {
        pool = new sql.ConnectionPool(dbConfigSecond);
        await pool.connect();

        const request = pool.request();
        request.input('ZaloID', sql.NVarChar, ZaloID);

        const checkZaloID = await request.query(`SELECT 1 FROM ZaloAccount WHERE ZaloID = @ZaloID`);

        if (checkZaloID.recordset.length > 0) {
            // Nếu ZaloID đã tồn tại, cập nhật thông tin
            await request
                .input('MaSV', sql.Int, MaSV)
                .input('MaLop', sql.VarChar, MaLop)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('Sdt', sql.NVarChar, Sdt)
                .input('Email', sql.NVarChar, Email)
                .input('Khoa', sql.NVarChar, Khoa)
                .input('ChucVu', sql.NVarChar, ChucVu)
                .input('DonViCongTac', sql.NVarChar, DonViCongTac)
                .input('ThamNien', sql.NVarChar, ThamNien)
                .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .input('NgayCapNhat', sql.DateTime, NgayCapNhat)
                .query(`
                    UPDATE ZaloAccount
                    SET MaSV = @MaSV, MaLop = @Malop, HoTen = @HoTen, Sdt = @Sdt, Email = @Email, 
                    Khoa = @Khoa, ChucVu = @ChucVu, DonViCongTac = @DonViCongTac, ThamNien = @ThamNien, 
                    DiaChiLienHe = @DiaChiLienHe, AnhDaiDien = @AnhDaiDien, NgayCapNhat = @NgayCapNhat
                    WHERE ZaloID = @ZaloID
                `);

            res.status(200).send('Cập nhật thông tin thành công');
        } else {
            // Nếu ZaloID chưa tồn tại, thêm mới
            await request
                .input('MaSV', sql.Int, MaSV)
                .input('MaLop', sql.VarChar, MaLop)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('Sdt', sql.NVarChar, Sdt)
                .input('Email', sql.NVarChar, Email)
                .input('Khoa', sql.NVarChar, Khoa)
                .input('ChucVu', sql.NVarChar, ChucVu)
                .input('DonViCongTac', sql.NVarChar, DonViCongTac)
                .input('ThamNien', sql.NVarChar, ThamNien)
                .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .input('NgayCapNhat', sql.DateTime, NgayCapNhat)
                .query(`
                    INSERT INTO ZaloAccount (MaSV, MaLop, HoTen, Sdt, Email, Khoa, ChucVu, DonViCongTac, ThamNien, DiaChiLienHe, ZaloID, AnhDaiDien)
                    VALUES (@MaSV, @Malop, @HoTen, @Sdt, @Email, @Khoa, @ChucVu, @DonViCongTac, @ThamNien, @DiaChiLienHe, @ZaloID, @AnhDaiDien, @NgayCapNhat)
                `);

            res.status(201).send('Thêm mới thông tin thành công');
        }
    } catch (err) {
        console.error('Lỗi chi tiết:', err);
        res.status(500).send('Lỗi khi cập nhật');
    } finally {
        if (pool) {
            await pool.close();
        }
    }
});

// const url = "https://business.openapi.zalo.me/message/template";
// const payload = {
//     phone: Sdt,  
//     template_id: "your_template_id_here",  
//     template_data: {
//         content: `Bạn đã cập nhật thành công thông tin cho mini app Kết Nối Cựu Sinh Viên!`
//     }
// };

// const response = await fetch(url, {
//     method: "POST",
//     headers: {
//         "Content-Type": "application/json",
//         "access_token": "your_access_token_here",
//     },
//     body: JSON.stringify(payload),
// });

// const responseData = await response.json();
// console.log("Phản hồi từ ZNS API:", responseData);

// if (!response.ok) {
//     console.error("Lỗi khi gửi ZNS:", responseData);
// }

// 5 bản tin mới nhất

app.get('/api/BanTinMoiNhatCSV', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfigSecond);
        const result = await pool.request().query('SELECT TOP 5 * FROM Zalo_BanTinCuuSV ORDER BY NgayTao DESC');
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

        let query = 'SELECT * FROM Zalo_BanTinCuuSV';

        const offset = (page - 1) * pageSize;
        query += ` ORDER BY ID OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`;

        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, pageSize);

        const result = await request.query(query);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy bản tin nào!');
        }

        const totalCountQuery = 'SELECT COUNT(*) AS totalCount FROM Zalo_BanTinCuuSV';
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
            .query('SELECT TieuDe, NoiDung, NgayTao FROM Zalo_BanTinCuuSV WHERE ID = @ID');

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy bản tin');
        }

        res.json(result.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi kết nối SQL Server');
    }
});

//góp ý 
app.post('/api/GopY', async (req, res) => {
    const { ZaloId, TieuDe, NoiDung } = req.body;

    if (!ZaloId || !TieuDe || !NoiDung) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    try {
        const pool = await sql.connect(dbConfigSecond);

        const checkZaloIdResult = await pool.request()
            .input('ZaloId', sql.VarChar, ZaloId)
            .query('SELECT ID FROM ZaloAccount WHERE ZaloId = @ZaloId');

        if (checkZaloIdResult.recordset.length === 0) {
            return res.status(400).send('ZaloId không tồn tại');
        }

        const result = await pool.request().query(`
            SELECT @@SERVERNAME AS ServerName, DB_NAME() AS   DatabaseName
        `);

        console.log('Server đang kết nối:', result.recordset[0]);

        const ZaloAcc_ID = checkZaloIdResult.recordset[0].ID;

        await pool.request()
            .input('ZaloAcc_ID', sql.Int, ZaloAcc_ID)
            .input('TieuDe', sql.NVarChar, TieuDe)
            .input('NoiDung', sql.NVarChar, NoiDung)
            .query(`
                INSERT INTO Zalo_ThongTinTuCuuSV (ZaloAcc_ID, TieuDe, NoiDung, NgayTao)
                VALUES (@ZaloAcc_ID, @TieuDe, @NoiDung, GETDATE())
            `);
        res.status(200).send('Góp ý đã được ghi nhận');
    } catch (err) {
        console.error('Lỗi chi tiết:', err);
        res.status(500).send('Lỗi khi cập nhật');
    } finally {
        await sql.close();
    }
});

//bản tin tvu
app.get("/api/BanTinMoiNhat", async (req, res) => {
    const url = "https://mobilegateway.tvu.edu.vn/portal/tvunews?content=true";
    try {
        const response = await axios.get(url);
        res.send(response.data);
    } catch (error) {
        res.status(500).send("Lỗi proxy: " + error.message);
    }
});

//chi tiết bản tin tvu
app.get("/api/ChiTietBanTin", async (req, res) => {
    const url = "https://mobilegateway.tvu.edu.vn/portal/tvunews?content=true";
    try {
        const response = await axios.get(url);
        res.send(response.data);
    } catch (error) {
        res.status(500).send("Lỗi proxy: " + error.message);
    }
});

//----------------------------------------Zalo------------------------------------//

//lấy danh sách followers của OA
app.get('/api/Zalo/followers', async (req, res) => {
    try {
        const offset = parseInt(req.query.offset) || 0;
        const count = parseInt(req.query.count) || 20;

        const tokenData = getToken();
        if (!accessToken) return res.status(401).json({ error: 'Thiếu access_token' });
    
        const response = await axios.get('https://openapi.zalo.me/v2.0/oa/getfollowers', {
            headers: {
                access_token: tokenData.access_token
            },
            params: {
                data: JSON.stringify({ offset, count })
            }
        });

        res.json(response.data);
    } catch (err) {
        console.error('Lỗi lấy followers:', err.response?.data || err.message);
        res.status(500).json({ error: 'Không lấy được danh sách followers' });
    }
});

//lấy thông tin chi tiết của follower
app.get('/api/Zalo/detailfollower', async (req, res) => {
    const { user_id } = req.query;

    try {

        if (!user_id) {
            return res.status(400).json({ error: 'Thiếu user_id trong yêu cầu' });
        }

        const accessToken = "qnlCHiwNAsBN6yr9pvOlRD8SpqVEZKiLgmFfKUZqSGgh59HapCGF5uCmwqoUwNCyrZ-K5Ohv5pl57w9gYSiyFTq5gXMNuYfzuXMuLlxU90oVAxrqzSKx3B8MdMBN_nrEY3ATPztd2qt1BkeSXSjhJ_0U-MMlw6CXknBOSDdtH2UZ8T8EvSPHMempqINYnJ10lI3KBUBpDto0Bf44cTCDLVDSZtppY181vrZpSlg45HRZTf5ugvbr2hTvq2NZd5LZzdAn3eIu54gOHVO0qvaVNuf5X7ANapyFtng2LgQLQWFuNej-bzOpKC0krHg1o5r9sndxC93iSK_r9Sm6ZArIKlX8pGIYnNvtjn3h3EZmQtYo1Vefs8rRUBq0qWBRrpHGm1wcUi3bBrQc5gyWoD0yJjmElnbnHIs_q1pAYYre";

        const response = await axios.get('https://openapi.zalo.me/v2.0/oa/getprofile', {
            headers: {
                access_token: accessToken
            },
            params: {
                data: JSON.stringify({ user_id })
            }
        });

        res.json(response.data);
    } catch (err) {
        console.error('Lỗi lấy thông tin follower:', err.response?.data || err.message);
        res.status(err.response?.status || 500).json({
            error: 'Không lấy được thông tin follower',
            message: err.response?.data || err.message
        });
    }
});

//gửi broadcast
app.post('/api/Zalo/sendbroadcast', async (req, res) => {
    //   const oaAccessToken = getAccessToken(); 
    const oaAccessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";
    const {
        gender,       // 0: tất cả, 1: nam, 2: nữ
        cities,       // Mã tỉnh thành, có thể là chuỗi, vd: "4" (TP.HCM)
        attachment_id // ID bài viết/media đã upload qua CMS hoặc API
    } = req.body;

    if (!attachment_id) {
        return res.status(400).json({ message: 'Thiếu attachment_id nè chị êi 😭' });
    }

    const data = {
        recipient: {
            target: {
                ...(gender && { gender }),
                ...(cities && { cities })
            }
        },
        message: {
            attachment: {
                type: 'template',
                payload: {
                    template_type: 'media',
                    elements: [
                        {
                            media_type: 'article',
                            attachment_id: attachment_id
                        }
                    ]
                }
            }
        }
    };

    try {
        const response = await axios.post('https://openapi.zalo.me/v2.0/oa/message', data, {
            headers: {
                'access_token': oaAccessToken,
                'Content-Type': 'application/json'
            }
        });

        res.status(200).json({
            message: 'Broadcast thành công 🎉',
            zalo_response: response.data
        });
    } catch (error) {
        console.error('Zalo broadcast error:', error.response?.data || error.message);
        res.status(500).json({
            message: 'Gửi broadcast thất bại 💣',
            error: error.response?.data || error.message
        });
    }
});

//tạo bài viết
app.post('/api/Zalo/create-article', async (req, res) => {
    const oaAccessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";

    const { title, author, cover, description, body } = req.body;

    if (!title || !author || !description || !body || !cover) {
        return res.status(400).json({
            message: 'Thiếu các trường bắt buộc: title, author, description, body, cover 😓'
        });
    }

    try {
        const response = await axios.post(
            'https://openapi.zalo.me/v2.0/article/create',
            {
                type: 'normal',
                title: title,
                author: author,
                cover: cover,
                description: description,
                body: body,
                status: 'hide',
                comment: 'hide'
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'access_token': oaAccessToken
                }
            }
        );

        res.status(200).json({
            message: 'Tạo bài viết thành công',
            data: response.data
        });
    } catch (error) {
        console.error('Lỗi khi tạo bài viết:', error.response?.data || error.message);
        res.status(500).json({
            message: 'Không thể tạo bài viết',
            error: error.response?.data || error.message
        });
    }
});

//chỉnh sửa bài viết
app.post("/api/Zalo/update-article", async (req, res) => {
    const oaAccessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";

    try {
        const {
            id,
            type = "normal",
            title,
            author,
            cover,
            description,
            status = "hide",
            body,
            comment = "hide"
        } = req.body;

        const payload = {
            id,
            type,
            title,
            author,
            cover,
            description,
            status,
            body,
            comment
        };

        const response = await axios.post(
            "https://openapi.zalo.me/v2.0/article/update",
            payload,
            {
                headers: {
                    "Content-Type": "application/json",
                    access_token: oaAccessToken
                }
            }
        );

        res.json({
            message: "Cập nhật bài viết thành công!",
            zalo_response: response.data
        });
    } catch (err) {
        console.error("Lỗi cập nhật bài viết Zalo:", err.response?.data || err.message);
        res.status(500).json({
            message: "Cập nhật bài viết thất bại.",
            error: err.response?.data || err.message
        });
    }
});

//xóa bài viết
app.post("/api/Zalo/remove", async (req, res) => {
    const { id } = req.query; // id sẽ được lấy từ query string

    if (!id) {
        return res.status(400).json({ error: 'Thiếu id trong yêu cầu' });
    }

    try {
        const accessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";

        // Gửi yêu cầu API của Zalo với dữ liệu JSON
        const response = await axios.post('https://openapi.zalo.me/v2.0/article/remove', {
            id: id // Truyền id vào body của yêu cầu
        }, {
            headers: {
                "Content-Type": "application/json",
                "access_token": accessToken
            }
        });

        // Trả kết quả từ API Zalo về cho client
        res.json(response.data);
    } catch (err) {
        console.error('Lỗi xóa bài viết:', err.response?.data || err.message);
        res.status(err.response?.status || 500).json({
            error: 'Không thể xóa bài viết',
            message: err.response?.data || err.message
        });
    }
});

//lấy chi tiết bài viết
app.get("/api/Zalo/getdetail", async (req, res) => {
    const { id } = req.query;
    try {

        if (!id) {
            return res.status(400).json({ error: 'Thiếu id trong yêu cầu' });
        }

        const accessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";

        const response = await axios.get('https://openapi.zalo.me/v2.0/article/getdetail', {
            headers: {
                access_token: accessToken
            },
            params: {
                id
            }
        });

        res.json(response.data);
    } catch (err) {
        console.error('Lỗi lấy thông tin bài viết:', err.response?.data || err.message);
        res.status(err.response?.status || 500).json({
            error: 'Không lấy được thông tin bài viết',
            message: err.response?.data || err.message
        });
    }
})

//lấy danh sách bài viết
app.get('/api/Zalo/articles', async (req, res) => {
    // const oaAccessToken = process.env.ZALO_OA_ACCESS_TOKEN;
    const oaAccessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";

    const { offset = 0, limit = 5, type = 'normal' } = req.query;

    try {
        const response = await axios.get('https://openapi.zalo.me/v2.0/article/getslice', {
            headers: {
                'access_token': oaAccessToken
            },
            params: {
                offset,
                limit,
                type
            }
        });

        res.status(200).json({
            message: 'Lấy danh sách bài viết thành công',
            data: response.data
        });
    } catch (error) {
        console.error('Lỗi lấy bài viết:', error.response?.data || error.message);
        res.status(500).json({
            message: 'Không lấy được danh sách bài viết',
            error: error.response?.data || error.message
        });
    }
});

//lấy danh sách template ZNS
app.get('/api/Zalo/templates', async (req, res) => {

    const oaAccessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";

    const {
        offset = 0,
        limit = 100,
        status = 1
    } = req.query;

    try {
        const response = await axios.get('https://business.openapi.zalo.me/template/all', {
            headers: {
                'access_token': oaAccessToken
            },
            params: {
                offset,
                limit,
                status
            }
        });

        res.status(200).json({
            message: 'Lấy danh sách template thành công',
            data: response.data
        });
    } catch (error) {
        console.error('Lỗi lấy template:', error.response?.data || error.message);
        res.status(500).json({
            message: 'Không lấy được template',
            error: error.response?.data || error.message
        });
    }
})

//lấy chi tiết template ZNS
app.get('/api/Zalo/detailtemplates', async (req, res) => {

    const oaAccessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";

    const templateId = req.query.template_id;

    if (!templateId) {
        return res.status(400).json({ message: 'Thiếu template_id' });
    }

    try {
        const response = await axios.get('https://business.openapi.zalo.me/template/info/v2', {
            headers: {
                'Content-Type': 'application/json',
                'access_token': oaAccessToken
            },
            params: {
                template_id: templateId
            }
        });

        res.status(200).json({
            message: `Lấy chi tiết template #${templateId} thành công`,
            data: response.data
        });
    } catch (error) {
        console.error('Lỗi khi lấy chi tiết template:', error.response?.data || error.message);
        res.status(500).json({
            message: 'Không lấy được thông tin template',
            error: error.response?.data || error.message
        });
    }
})

//gửi ZNS (develoment mode), phone phải là của quản trị viên của OA hoặc của mini app
app.post('/api/Zalo/send-devtemplate', async (req, res) => {
    // const oaAccessToken = process.env.ZALO_OA_ACCESS_TOKEN;
    const oaAccessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";

    const {
        phone,
        mode = 'development',
        template_id,
        template_data,
        tracking_id = ''
    } = req.body;

    if (!phone || !template_id || !template_data) {
        return res.status(400).json({
            message: 'Thiếu trường bắt buộc: phone, template_id hoặc template_data'
        });
    }

    try {
        const response = await axios.post(
            'https://business.openapi.zalo.me/message/template',
            {
                phone,
                mode,
                template_id,
                template_data,
                tracking_id
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'access_token': oaAccessToken
                }
            }
        );

        res.status(200).json({
            message: 'Gửi tin nhắn template thành công 🚀',
            data: response.data
        });
    } catch (error) {
        console.error('Lỗi khi gửi tin nhắn template:', error.response?.data || error.message);
        res.status(500).json({
            message: 'Không gửi được tin nhắn 😢',
            error: error.response?.data || error.message
        });
    }
});

//gửi ZNS
app.post('/api/Zalo/send-template', async (req, res) => {
    // const oaAccessToken = process.env.ZALO_OA_ACCESS_TOKEN;
    const oaAccessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";

    const {
        phone,
        template_id,
        template_data,
        tracking_id = ''
    } = req.body;

    if (!phone || !template_id || !template_data) {
        return res.status(400).json({
            message: 'Thiếu trường bắt buộc: phone, template_id hoặc template_data'
        });
    }

    try {
        const response = await axios.post(
            'https://business.openapi.zalo.me/message/template',
            {
                phone,
                template_id,
                template_data,
                tracking_id
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'access_token': oaAccessToken
                }
            }
        );

        res.status(200).json({
            message: 'Gửi tin nhắn template thành công 🚀',
            data: response.data
        });
    } catch (error) {
        console.error('Lỗi khi gửi tin nhắn template:', error.response?.data || error.message);
        res.status(500).json({
            message: 'Không gửi được tin nhắn 😢',
            error: error.response?.data || error.message
        });
    }
});

//lấy dữ liệu mẫu của template
app.get('/api/Zalo/template-info', async (req, res) => {
    const oaAccessToken = "y8iaSNP_SsBqYoL-TtvtRF6C9t1sPG4EgC4H25Xq7awbnoSpLMWl89V-UJzuJMn1YC1dBdrrGaUTXqbLUW5O3vo_NmbT0LnOgOW4ENChILU4W5mg1X9uBDJdON0AL7astUfZGZ5RSItlgI5S70eU9uV_7sO0T4ehvE92PJ5nLNhznruIPdDQNgJVTJzvLNHkgD5y4ozpK6tOsaaM6MzU2-ldIMCsLaCUyDSJ0Xz9ALxx-2OW7ceFVUBF5InvM1XThTeS3tDIJ7MJyMaFNLviSPhVUY9TNszpdk5yDMPDNqU2qru8RaTqHksp80OVC0WKpA8xJ4ChBI-qgWfqQoyzEhNGQ6XK9q0mcez7M6DnHa2xy7OvPdjzIf7DBrL5RY4LjU0CM69X84UmvpfQGHPi4BQ3VcX3DxR7O2joOdLe";
    const { template_id } = req.query;

    if (!template_id) {
        return res.status(400).json({
            message: 'Thiếu template_id. Vui lòng cung cấp template_id'
        });
    }

    try {
        const response = await axios.get(
            `https://business.openapi.zalo.me/template/sample-data`,
            {
                params: {
                    template_id: template_id
                },
                headers: {
                    'Content-Type': 'application/json',
                    'access_token': oaAccessToken
                }
            }
        );

        res.status(200).json({
            message: 'Lấy thông tin template thành công 🚀',
            data: response.data
        });
    } catch (error) {
        console.error('Lỗi khi lấy thông tin template:', error.response?.data || error.message);
        res.status(500).json({
            message: 'Không thể lấy thông tin template 😢',
            error: error.response?.data || error.message
        });
    }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

