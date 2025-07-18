require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const sql = require('mssql');
const cors = require('cors');
const nodemailer = require("nodemailer");
const axios = require("axios");
const cron = require('node-cron');
const zaloCallback = require('../js/OAZalo/zaloCallback');
const { saveToken } = require('../js/OAZalo/verifierTokenStore')
const refreshAccessToken = require('../js/OAZalo/refreshToken');
const { getToken, isTokenExpired } = require('../js/OAZalo/verifierTokenStore');
const { getConnection } = require('./db');
const cheerio = require('cheerio');

const app = express();

async function checkAndRefreshTokenOnStartup() {
    const tokenData = await getToken();
    console.log("-----Thông tin token từ DB:-----", JSON.stringify(tokenData, null, 2));

    if (!tokenData) {
        console.warn('Không tìm thấy token, bạn cần đăng nhập lại để lấy access_token mới!');
        return;
    }

    if (await isTokenExpired(tokenData)) {
        console.log('Token đã hết hạn hoặc gần hết hạn, tiến hành làm mới token...');
        const refreshToken = tokenData.refresh_token;
        try {
            const response = await refreshAccessToken(refreshToken);
            const updatedTokenData = {
                ...tokenData,
                access_token: response.access_token,
                refresh_token: response.refresh_token,
                updated_at: new Date().toISOString(),
            };

            saveToken(updatedTokenData);

        } catch (error) {
            console.error('Lỗi khi làm mới token:', error.message);
        }
    } else {
        console.log('Access token vẫn còn hạn sử dụng');
    }
}

// kiểm tra token
checkAndRefreshTokenOnStartup();

//24h
cron.schedule('0 0 * * *', async () => {
    console.log(`----------Thực hiện refresh lúc ${new Date().toLocaleString()}----------`);
    const tokenData = await getToken();
    if (!tokenData?.refresh_token) return console.log('Chưa có refresh_token để làm mới');

    try {
        await refreshAccessToken(tokenData.refresh_token);
    } catch (err) {
        console.error('Refresh thất bại', err.message);
    }
});

cron.schedule('0 0 * * *', async () => {
    console.log("🔄 Đang xoá OTP hết hạn...");

    try {
        const pool = await getConnection();
        await pool.request().query(`
            DELETE FROM Zalo_OTP WHERE NgayHetHan < GETDATE()
        `);
        console.log("✅ Đã xoá xong OTP hết hạn.");
    } catch (err) {
        console.error("❌ Lỗi khi xoá OTP:", err);
    }
});

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_SENDER,
    port: parseInt(process.env.EMAIL_PORT, 10),
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

const generateOTP = () => {
    return Math.floor(10000 + Math.random() * 90000).toString();
};

app.use(bodyParser.json());

app.use(cors());

app.use('/', zaloCallback);

//gửi otp 
app.post("/api/sendOTP", async (req, res) => {

    const { mail } = req.body;
    console.log(mail)
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
        const pool = await getConnection();

        const existingOTP = await pool.request()
            .input('Mail', sql.NVarChar, mail)
            .query(`SELECT 1 FROM Zalo_OTP WHERE Mail = @Mail AND NgayHetHan > GETDATE()`);

        if (existingOTP.recordset.length > 0) {
            return res.status(429).send({ message: "Vui lòng chờ trước khi yêu cầu OTP mới." });
        }

        await pool.request()
            .input('Mail', sql.NVarChar, mail)
            .input('OTP', sql.NVarChar, otp)
            .input('NgayTao', sql.DateTime, createAtUTC)
            .input('NgayHetHan', sql.DateTime, expiresAtUTC)
            .input('TrangThai', sql.Bit, verify)
            .query(`INSERT INTO Zalo_OTP (Mail, OTP, NgayTao, NgayHetHan, TrangThai) VALUES (@Mail, @OTP, @NgayTao, @NgayHetHan, @TrangThai)`);

        const mailOptions = {
            from: process.env.EMAIL_SENDER,
            to: mail,
            subject: "Mã OTP xác thực thông tin cựu sinh viên",
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
        return res.status(500).send({ message: "Internal Server Error", error });
    }
});

//xác nhận otp
app.post("/api/verifyOTP", async (req, res) => {
    const { mail, otp } = req.body;

    try {
        const pool = await getConnection();

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
        return res.status(500).send({ message: "Internal Server Error", error });
    }
});

// Tìm kiếm thông tin cựu sinh viên đăng nhập zalo theo ngành
app.get('/api/SinhViens/Zalo/major/search', async (req, res) => {
    const { keyword, page = 1, pageSize = 20, nganhId } = req.query;

    if (!nganhId || isNaN(nganhId)) {
        return res.status(400).send('Thiếu hoặc sai định dạng nganhId');
    }

    try {
        const pool = await getConnection();
        const request = pool.request();

        request.input('nganhId', sql.Int, nganhId);

        let query = `
      SELECT ID, MaSV, HoTen, AnhDaiDien, Khoa 
      FROM ZaloAccount 
      WHERE Nganh_ID = @nganhId
    `;

        if (keyword) {
            if (!isNaN(keyword)) {
                query += ' AND (MaSV LIKE @keyword OR Khoa LIKE @keyword)';
            } else {
                query += ' AND (HoTen LIKE @keyword)';
            }
            request.input('keyword', sql.NVarChar, `%${keyword}%`);
        }

        const offset = (page - 1) * pageSize;
        query += ' ORDER BY MaSV OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY';
        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, pageSize);

        // Đếm tổng số kết quả phù hợp
        let totalCountQuery = `
      SELECT COUNT(*) AS totalCount 
      FROM ZaloAccount 
      WHERE Nganh_ID = @nganhId
    `;
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
            page: Number(page),
            pageSize: Number(pageSize),
            totalPages
        });

    } catch (err) {
        console.error('Lỗi tìm kiếm:', err);
        res.status(500).send('Internal Server Error');
    }
});

//tìm kiếm thông tin cựu sinh viên trong db
app.get('/api/SinhViens/search', async (req, res) => {
    const { keyword, page = 1, pageSize = 20 } = req.query;

    try {
        const pool = await getConnection();

        const request = pool.request();
        const countRequest = pool.request();

        let query = `
            SELECT 
                sv.ID,
                sv.MSSV,
                sv.FullName,
                ndt.TenNganh,
                lnh.NienKhoa,
                sv.NgaySinh,
                sv.HienDienSV,
                n1.TenNhomNganh,
                n2.ID AS Nganh_ID
            FROM SinhVien sv
            JOIN DT_LopNhapHoc_SinhVien lhsv ON sv.ID = lhsv.SinhVien_ID
            JOIN DT_LopNhapHoc lnh ON lhsv.LopNhapHoc_ID = lnh.ID
            JOIN DT_NganhDaoTao ndt ON lnh.Nganh_ID = ndt.ID
            JOIN Nganh n2 ON ndt.MaNganh = n2.MaNganh  
            JOIN NhomNganh n1 ON n2.NhomNganh_ID = n1.ID
            WHERE sv.HienDienSV = 3
        `;

        let countQuery = `
            SELECT COUNT(*) AS totalCount
            FROM SinhVien sv
            JOIN DT_LopNhapHoc_SinhVien lhsv ON sv.ID = lhsv.SinhVien_ID
            JOIN DT_LopNhapHoc lnh ON lhsv.LopNhapHoc_ID = lnh.ID
            JOIN DT_NganhDaoTao ndt ON lnh.Nganh_ID = ndt.ID
            JOIN Nganh n2 ON ndt.MaNganh = n2.MaNganh  
            JOIN NhomNganh n1 ON n2.NhomNganh_ID = n1.ID
            WHERE sv.HienDienSV = 3
        `;

        function convertToISODate(dateStr) {
            const parts = dateStr.split('-');
            if (parts.length === 3) {
                const [day, month, year] = parts;
                if (/^\d{2}$/.test(day) && /^\d{2}$/.test(month) && /^\d{4}$/.test(year)) {
                    return `${year}-${month}-${day}`;
                }
            }
            return null;
        }

        if (keyword) {
            const parts = keyword.trim().split(/\s+/);
            let nameParts = [];
            let dob = null;

            for (const part of parts) {
                if (/^\d{2}-\d{2}-\d{4}$/.test(part)) {
                    dob = convertToISODate(part);
                } else {
                    nameParts.push(part);
                }
            }

            if (nameParts.length > 0) {
                const nameSearch = nameParts.join(' ');
                query += ' AND sv.FullName LIKE @fullName';
                countQuery += ' AND sv.FullName LIKE @fullName';
                request.input('fullName', sql.NVarChar, `%${nameSearch}%`);
                countRequest.input('fullName', sql.NVarChar, `%${nameSearch}%`);
            }

            if (dob) {
                query += ' AND sv.NgaySinh = @ngaySinh';
                countQuery += ' AND sv.NgaySinh = @ngaySinh';
                request.input('ngaySinh', sql.Date, dob);
                countRequest.input('ngaySinh', sql.Date, dob);
            }
        }

        // Phân trang
        const offset = (page - 1) * pageSize;
        query += ' ORDER BY lnh.NienKhoa DESC OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY';

        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, pageSize);

        const result = await request.query(query);
        const totalCountResult = await countRequest.query(countQuery);

        const totalCount = totalCountResult.recordset[0].totalCount;
        const totalPages = Math.ceil(totalCount / pageSize);

        // Format ngày sinh
        function formatDateVN(date) {
            const d = new Date(date);
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            return `${day}-${month}-${year}`;
        }

        const students = result.recordset.map(student => ({
            ...student,
            NgaySinh: student.NgaySinh ? formatDateVN(student.NgaySinh) : null
        }));

        if (students.length === 0) {
            return res.status(404).send('Không tìm thấy sinh viên phù hợp');
        }

        res.json({
            students,
            totalCount,
            page: Number(page),
            pageSize: Number(pageSize),
            totalPages
        });

    } catch (err) {
        console.error('Lỗi khi tìm sinh viên:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

//danh sách csv 
app.get('/api/SinhViens/list', async (req, res) => {
    const { page = 1, pageSize = 5, nganhId } = req.query;

    const pageNum = Number(page);
    const pageSizeNum = Number(pageSize);
    const nganhIdNum = Number(nganhId);

    if (
        isNaN(pageNum) || isNaN(pageSizeNum) || pageNum <= 0 || pageSizeNum <= 0 ||
        isNaN(nganhIdNum)
    ) {
        return res.status(400).send('page, pageSize và nganhId phải là số nguyên dương.');
    }

    try {
        const pool = await getConnection();
        const request = pool.request();

        request.input('nganhId', sql.Int, nganhIdNum);

        const totalCountQuery = `
      SELECT COUNT(*) AS totalCount 
      FROM ZaloAccount 
      WHERE Nganh_ID = @nganhId
    `;
        const totalCountResult = await request.query(totalCountQuery);
        const totalCount = totalCountResult.recordset[0].totalCount;
        const totalPages = Math.ceil(totalCount / pageSizeNum);

        if (totalCount === 0) {
            return res.json({
                profiles: [],
                totalCount: 0,
                page: pageNum,
                pageSize: pageSizeNum,
                totalPages: 0
            });
        }

        const offset = (pageNum - 1) * pageSizeNum;
        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, pageSizeNum);

        const dataQuery = `
      SELECT * 
      FROM ZaloAccount 
      WHERE Nganh_ID = @nganhId
      ORDER BY ID OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    `;

        const result = await request.query(dataQuery);

        return res.json({
            profiles: result.recordset,
            totalCount,
            page: pageNum,
            pageSize: pageSizeNum,
            totalPages
        });

    } catch (err) {
        console.error('Lỗi truy vấn:', err);
        res.status(500).send('Internal Server Error');
    }
});

//thông tin của 1 user (truyền zaloId vào)
app.get('/api/SinhViens/info', async (req, res) => {
    const { ZaloID } = req.query;

    if (!ZaloID) {
        return res.status(400).json({ error: 'ZaloID không được để trống!' });
    }

    let pool;

    try {
        const pool = await getConnection();

        const query = 'SELECT * FROM ZaloAccount WHERE ZaloID = @ZaloID';
        const result = await pool.request()
            .input('ZaloID', sql.VarChar, ZaloID)
            .query(query);

        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Chưa có thông tin tài khoản!' });
        }

        res.json({ profile: result.recordset[0] });
    } catch (err) {
        console.error('SQL Server Error:', err.message);
        res.status(500).json({ error: 'Internal Server Error', details: err.message });
    } finally {
        if (pool) pool.close();
    }
});

//kiểm tra user tồn tại
app.get('/api/SinhViens/checkUserExist', async (req, res) => {
    const { ZaloID } = req.query;

    if (!ZaloID) {
        return res.status(400).json({ error: 'ZaloID không được để trống!' });
    }

    let pool;

    try {
        const pool = await getConnection();

        const query = 'SELECT ID FROM ZaloAccount WHERE ZaloID = @ZaloID';
        const result = await pool.request()
            .input('ZaloID', sql.VarChar, ZaloID)
            .query(query);

        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Chưa có thông tin tài khoản!' });
        }

        res.json({ profile: result.recordset[0] });
    } catch (err) {
        console.error('SQL Server Error:', err.message);
        res.status(500).json({ error: 'Internal Server Error', details: err.message });
    } finally {
        if (pool) pool.close();
    }
});

//tạo thông tin mới
app.post('/api/SinhViens/TaoThongTinMoi', async (req, res) => {
    const {
        SVTN_ID, MaSV, HoTen, Sdt, Email, Khoa, Nganh_ID, Nganh, ChucVu,
        DonViCongTac, ThamNien, DiaChiLienHe, ZaloID, AnhDaiDien
    } = req.body;

    const tokenData = await getToken();
    const accessToken = tokenData.access_token

    if (!SVTN_ID || !MaSV || !HoTen || !Sdt || !Email || !Khoa || !Nganh_ID || !Nganh || !ZaloID || !AnhDaiDien) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    const NgayTao = new Date();
    const NgayCapNhat = new Date();

    let pool;
    try {
        const pool = await getConnection();

        const checkRequest = pool.request();
        checkRequest.input('ZaloID', sql.NVarChar, ZaloID);
        const checkZaloID = await checkRequest.query(`
            SELECT ID FROM ZaloAccount WHERE ZaloID = @ZaloID
        `);

        let zaloAccId;

        if (checkZaloID.recordset.length > 0) {
            // Đã tồn tại - UPDATE
            const updateRequest = pool.request();
            updateRequest.input('ZaloID', sql.NVarChar, ZaloID)
                .input('MaSV', sql.VarChar, MaSV)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('Sdt', sql.NVarChar, Sdt)
                .input('Email', sql.NVarChar, Email)
                .input('Khoa', sql.NVarChar, Khoa)
                .input('Nganh_ID', sql.Int, Nganh_ID)
                .input('Nganh', sql.NVarChar, Nganh)
                .input('ChucVu', sql.NVarChar, ChucVu)
                .input('DonViCongTac', sql.NVarChar, DonViCongTac)
                .input('ThamNien', sql.NVarChar, ThamNien)
                .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .input('NgayTao', sql.DateTime, NgayTao)
                .input('NgayCapNhat', sql.DateTime, NgayCapNhat);

            await updateRequest.query(`
                UPDATE ZaloAccount
                SET MaSV = @MaSV, HoTen = @HoTen, Sdt = @Sdt, Email = @Email, 
                    Khoa = @Khoa, Nganh_ID = @Nganh_ID, Nganh = @Nganh, ChucVu = @ChucVu, DonViCongTac = @DonViCongTac, ThamNien = @ThamNien, 
                    DiaChiLienHe = @DiaChiLienHe, AnhDaiDien = @AnhDaiDien, NgayTao = @NgayTao, 
                    NgayCapNhat = @NgayCapNhat, DaXacThuc = 1
                WHERE ZaloID = @ZaloID
            `);

            zaloAccId = checkZaloID.recordset[0].ID;

        } else {
            // Chưa tồn tại - INSERT mới
            const insertRequest = pool.request();
            insertRequest
                .input('SVTN_ID', sql.Int, SVTN_ID)
                .input('MaSV', sql.VarChar, MaSV)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('Sdt', sql.NVarChar, Sdt)
                .input('Email', sql.NVarChar, Email)
                .input('Khoa', sql.NVarChar, Khoa)
                .input('Nganh_ID', sql.Int, Nganh_ID)
                .input('Nganh', sql.NVarChar, Nganh)
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
                    SVTN_ID, MaSV, HoTen, Sdt, Email, Khoa, Nganh_ID, Nganh, ChucVu, DonViCongTac, 
                    ThamNien, DiaChiLienHe, ZaloID, AnhDaiDien, NgayTao, NgayCapNhat, DaXacThuc
                )
                OUTPUT INSERTED.ID
                VALUES (
                    @SVTN_ID, @MaSV, @HoTen, @Sdt, @Email, @Khoa, @Nganh_ID, @Nganh, @ChucVu, @DonViCongTac, 
                    @ThamNien, @DiaChiLienHe, @ZaloID, @AnhDaiDien, @NgayTao, @NgayCapNhat, 1
                )
            `);

            zaloAccId = insertResult.recordset[0]?.ID;
        }

        //gửi ZNS
        // if (zaloAccId && Sdt) {
        //     const znsPayload = {
        //         phone: Sdt.startsWith('0') ? `84${Sdt.slice(1)}` : Sdt,
        //         template_id: "426499",
        //         template_data: {
        //             ten_sinh_vien: HoTen,
        //             ma_sinh_vien: MaSV,
        //             sdt_sinh_vien: Sdt,
        //             email_sinh_vien: Email
        //         },
        //     };

        //     try {
        //         const znsRes = await fetch("https://business.openapi.zalo.me/message/template", {
        //             method: "POST",
        //             headers: {
        //                 "Content-Type": "application/json",
        //                 "access_token": accessToken
        //             },
        //             body: JSON.stringify(znsPayload)
        //         });

        //         const znsData = await znsRes.json();

        //         console.log("Kết quả gửi ZNS:", znsData);
        //     } catch (znsErr) {
        //         console.error("Gửi ZNS thất bại:", znsErr);
        //     }
        // }

        res.status(200).send({
            message: 'Thành công tạo mới user',
            zaloAccId: zaloAccId || null
        });

    } catch (err) {
        console.error("Lỗi xử lý:", err);
        res.status(500).send('Internal Server Error');
    } finally {
        pool && pool.close();
    }
});

// Cập nhật thông tin sinh viên
app.post('/api/SinhViens/CapNhatThongTin', async (req, res) => {
    const { SVTN_ID, MaSV, HoTen, Sdt, Email, Khoa, Nganh_ID, Nganh, ChucVu, DonViCongTac, ThamNien, DiaChiLienHe, ZaloID, AnhDaiDien } = req.body;

    if (!SVTN_ID || !MaSV || !HoTen || !Sdt || !Email || !Khoa || !Nganh_ID || !Nganh || !ZaloID || !AnhDaiDien) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    const NgayCapNhat = new Date();

    let pool;
    try {
        const pool = await getConnection();

        const request = pool.request();
        request.input('ZaloID', sql.NVarChar, ZaloID);

        const checkZaloID = await request.query(`SELECT 1 FROM ZaloAccount WHERE ZaloID = @ZaloID`);

        if (checkZaloID.recordset.length > 0) {
            // Nếu ZaloID đã tồn tại, cập nhật thông tin
            await request
                .input('SVTN_ID', sql.Int, SVTN_ID)
                .input('MaSV', sql.Int, MaSV)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('Sdt', sql.NVarChar, Sdt)
                .input('Email', sql.NVarChar, Email)
                .input('Khoa', sql.NVarChar, Khoa)
                .input('Nganh_ID', sql.Int, Nganh_ID)
                .input('Nganh', sql.NVarChar, Nganh)
                .input('ChucVu', sql.NVarChar, ChucVu)
                .input('DonViCongTac', sql.NVarChar, DonViCongTac)
                .input('ThamNien', sql.NVarChar, ThamNien)
                .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .input('NgayCapNhat', sql.DateTime, NgayCapNhat)
                .query(`
                    UPDATE ZaloAccount
                    SET SVTN_ID = @SVTN_ID, MaSV = @MaSV, HoTen = @HoTen, Sdt = @Sdt, Email = @Email, 
                    Khoa = @Khoa, Nganh_ID = @Nganh_ID, Nganh = @Nganh, ChucVu = @ChucVu, DonViCongTac = @DonViCongTac, ThamNien = @ThamNien, 
                    DiaChiLienHe = @DiaChiLienHe, AnhDaiDien = @AnhDaiDien, NgayCapNhat = @NgayCapNhat
                    WHERE ZaloID = @ZaloID
                `);

            res.status(200).send('Cập nhật thông tin thành công');
        } else {
            // Nếu ZaloID chưa tồn tại, thêm mới
            await request
                .input('SVTN_ID', sql.Int, SVTN_ID)
                .input('MaSV', sql.Int, MaSV)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('Sdt', sql.NVarChar, Sdt)
                .input('Email', sql.NVarChar, Email)
                .input('Khoa', sql.NVarChar, Khoa)
                .input('Nganh_ID', sql.Int, Nganh_ID)
                .input('Nganh', sql.NVarChar, Nganh)
                .input('ChucVu', sql.NVarChar, ChucVu)
                .input('DonViCongTac', sql.NVarChar, DonViCongTac)
                .input('ThamNien', sql.NVarChar, ThamNien)
                .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .input('NgayCapNhat', sql.DateTime, NgayCapNhat)
                .query(`
                    INSERT INTO ZaloAccount (SVTN_ID, MaSV, HoTen, Sdt, Email, Khoa, Nganh_ID, Nganh, ChucVu, DonViCongTac, ThamNien, DiaChiLienHe, ZaloID, AnhDaiDien)
                    VALUES (@SVTN_ID, @MaSV, @HoTen, @Sdt, @Email, @Khoa, @Nganh_ID, @Nganh, @ChucVu, @DonViCongTac, @ThamNien, @DiaChiLienHe, @ZaloID, @AnhDaiDien, @NgayCapNhat)
                `);

            res.status(201).send('Thêm mới thông tin thành công');
        }
    } catch (err) {
        console.error('Lỗi chi tiết:', err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (pool) {
            await pool.close();
        }
    }
});

app.get('/api/BanTinMoiNhatCSV', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query('SELECT TOP 5 * FROM Zalo_BanTinCuuSV ORDER BY NgayTao DESC');
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

//danh sách bản tin
app.get('/api/TatCaBanTin', async (req, res) => {
    const { page = 1, pageSize = 10 } = req.query;

    if (isNaN(page) || isNaN(pageSize) || page <= 0 || pageSize <= 0) {
        return res.status(400).send('Page và pageSize phải là số nguyên dương.');
    }

    try {
        const pool = await getConnection();
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
        res.status(500).send('Internal Server Error');
    }
});

//chi tiết bản tin
app.get('/api/ChiTietBanTin', async (req, res) => {
    const { id } = req.query;

    if (!id) {
        return res.status(400).send('Thiếu ID bản tin');
    }

    try {
        const pool = await getConnection();
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
        res.status(500).send('Internal Server Error');
    }
});

//góp ý 
app.post('/api/GopY', async (req, res) => {
    const { ZaloId, TieuDe, NoiDung } = req.body;

    if (!ZaloId || !TieuDe || !NoiDung) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    try {
        const pool = await getConnection();

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
        res.status(500).send('Internal Server Error');
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
        res.status(500).send("Internal Server Error: " + error.message);
    }
});

//chi tiết bản tin tvu
app.get("/api/ChiTietBanTin", async (req, res) => {
    const url = "https://mobilegateway.tvu.edu.vn/portal/tvunews?content=true";
    try {
        const response = await axios.get(url);
        res.send(response.data);
    } catch (error) {
        res.status(500).send("Internal Server Error: " + error.message);
    }
});

//danh sách việc làm
app.get('/api/jobs', async (req, res) => {
    try {
        const url = 'https://dichvuvieclam.tvu.edu.vn/';
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);

        const jobs = [];

        $('tr').each((i, el) => {
            const tds = $(el).find('td');
            if (tds.length >= 4) {
                const anchor = $(tds[0]).find('a');
                const jobTitle = anchor.find('strong').text().trim();
                const href = anchor.attr('href')?.trim();

                const td0Text = $(tds[0]).text().trim().replace(jobTitle, '').replace(/[\n\r"]/g, '').trim();
                const company = td0Text || 'Không rõ';

                const location = $(tds[1]).text().trim();
                const salary = $(tds[2]).text().trim();
                const datePosted = $(tds[3]).text().trim();

                if (jobTitle) {
                    jobs.push({
                        jobTitle,
                        company,
                        location,
                        salary,
                        datePosted,
                        link: href || null
                    });
                }
            }
        });

        res.json({
            success: true,
            data: jobs
        });
    } catch (error) {
        console.error('Lỗi crawl:', error.message);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi crawl dữ liệu'
        });
    }
});

//chi tiết việc làm
app.get('/api/job-detail', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu tham số url'
            });
        }

        const decodedUrl = decodeURIComponent(url);
        const { data } = await axios.get(decodedUrl);
        const $ = cheerio.load(data);

        const iframeSrc = $('.ead-preview iframe').attr('src');
        if (!iframeSrc) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy nội dung chi tiết'
            });
        }

        const pdfMatch = iframeSrc.match(/url=([^&]+)/);
        const pdfUrl = pdfMatch ? decodeURIComponent(pdfMatch[1]) : null;

        res.json({
            success: true,
            data: {
                viewerUrl: iframeSrc.startsWith('http') ? iframeSrc : 'https:' + iframeSrc,
                pdfUrl
            }
        });
    } catch (error) {
        console.error('Lỗi crawl chi tiết:', error.message);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy chi tiết bài đăng'
        });
    }
});

//danh sach nhom nganh
app.get('/api/NhomNganh', async (req, res) => {
    try {
        const pool = await getConnection();
        const request = pool.request();

        const query = 'SELECT ID, TenNhomNganh FROM NhomNganh';
        const result = await request.query(query);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy nhóm ngành nào!');
        }

        const countQuery = 'SELECT COUNT(*) AS totalCount FROM NhomNganh';
        const countResult = await request.query(countQuery);
        const totalCount = countResult.recordset[0].totalCount;

        res.json({
            data: result.recordset,
            totalCount
        });

    } catch (err) {
        console.error('Lỗi khi lấy nhóm ngành:', err);
        res.status(500).send('Internal Server Error');
    }
});

//nganh theo nhom nganh
app.get('/api/NganhNhomNganh', async (req, res) => {
    try {
        const { nhomNganhId } = req.query;

        if (!nhomNganhId) {
            return res.status(400).send('Thiếu tham số nhomNganhId');
        }

        const pool = await getConnection();
        const request = pool.request();

        request.input('nhomNganhId', sql.Int, nhomNganhId);

        const query = `
            SELECT 
                Nganh.ID,
                Nganh.TenNganh,
                Nganh.NhomNganh_ID,
                nn.TenNhomNganh
            FROM Nganh
            JOIN NhomNganh nn ON Nganh.NhomNganh_ID = nn.ID
            WHERE nn.ID = @nhomNganhId
        `;

        const result = await request.query(query);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy ngành nào trong nhóm ngành này!');
        }

        res.json(result.recordset);

    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

//khóa theo ngành
app.get('/api/KhoaNganh', async (req, res) => {
    try {
        const { nganhId } = req.query;
        if (!nganhId) {
            return res.status(400).send('Thiếu tham số nganhId');
        }
        const pool = await getConnection();
        const request = pool.request();
        request.input('nganhId', sql.Int, nganhId);
        const query = `
            SELECT 
                MaLopNhapHoc,
                TenLopNhapHoc,
                NienKhoa,
                Nganh_ID
            FROM DT_LopNhapHoc lnh
            JOIN DT_NganhDaoTao ndt ON lnh.Nganh_ID = ndt.ID
            WHERE Nganh_ID = @nganhId
        `;
        const result = await request.query(query);
        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy khóa nào cho ngành này!');
        }
        res.json(result.recordset);
    } catch (err) {
        console.error('Lỗi khi lấy khóa ngành:', err);
        res.status(500).send('Internal Server Error');
    }
});

//lớp theo khóa ngành
app.get('/api/LopNhapHoc', async (req, res) => {
    try {

        const { khoa, nganhId } = req.query;

        if (!khoa || !nganhId) {
            return res.status(400).send('Thiếu tham số khoa và nganhId');
        }
        
        const pool = await getConnection();
        const request = pool.request();
        request.input('khoa', sql.NVarChar, khoa);
        request.input('nganhId', sql.Int, nganhId);

        const query = `
            SELECT 
                lnh.ID,
                MaLopNhapHoc,
                TenLopNhapHoc,
                NienKhoa,
                Nganh_ID
            FROM DT_LopNhapHoc lnh
            JOIN DT_NganhDaoTao ndt ON lnh.Nganh_ID = ndt.ID
            WHERE Nganh_ID = @nganhId
            AND NienKhoa = @khoa`;

        const result = await request.query(query);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy lớp nào cho khóa này!');
        }

        res.json(result.recordset);

    } catch (err) {
        console.error('Lỗi khi lấy lớp nhập học:', err);
        res.status(500).send('Internal Server Error');
    }
});

//--------------------------------------Thống kê-----------------------------------//

//số lượng csv có thông tin tài khoản mini app


//số lượng theo khóa ngành địa chỉ


//----------------------------------------Zalo------------------------------------//

//lấy danh sách followers của OA
app.get('/api/Zalo/followers', async (req, res) => {
    try {
        const offset = parseInt(req.query.offset) || 0;
        const count = parseInt(req.query.count) || 20;

        const tokenData = await getToken();
        const accessToken = tokenData.access_token


        if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

        const response = await axios.get('https://openapi.zalo.me/v2.0/oa/getfollowers', {
            headers: {
                access_token: accessToken
            },
            params: {
                data: JSON.stringify({ offset, count })
            }
        });

        res.json(response.data);
    } catch (err) {
        console.error('Lỗi lấy followers:', err.response?.data || err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

//lấy thông tin chi tiết của follower
app.get('/api/Zalo/detailfollower', async (req, res) => {
    const { user_id } = req.query;

    try {

        if (!user_id) {
            return res.status(400).json({ error: 'Thiếu user_id trong yêu cầu' });
        }

        const tokenData = await getToken();
        const accessToken = tokenData.access_token


        if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

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
            error: 'Internal Server Error',
            message: err.response?.data || err.message
        });
    }
});

//gửi broadcast
app.post('/api/Zalo/sendbroadcast', async (req, res) => {
    const tokenData = await getToken();
    const accessToken = tokenData.access_token


    if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

    const {
        gender,
        cities,
        attachment_id
    } = req.body;

    if (!attachment_id) {
        return res.status(400).json({ message: 'Thiếu attachment_id' });
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
                'access_token': accessToken,
                'Content-Type': 'application/json'
            }
        });

        res.status(200).json({
            message: 'Broadcast thành công',
            zalo_response: response.data
        });
    } catch (error) {
        console.error('Zalo broadcast error:', error.response?.data || error.message);
        res.status(500).json({
            message: 'Gửi broadcast thất bại',
            error: error.response?.data || error.message
        });
    }
});

//tạo bài viết
app.post('/api/Zalo/create-article', async (req, res) => {
    const tokenData = await getToken();
    const accessToken = tokenData.access_token


    if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

    const { title, author, cover, description, body } = req.body;

    if (!title || !author || !description || !body || !cover) {
        return res.status(400).json({
            message: 'Thiếu các trường bắt buộc: title, author, description, body, cover'
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
                    'access_token': accessToken
                }
            }
        );

        res.status(200).json({
            message: 'Tạo bài viết thành công!',
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
    const tokenData = await getToken();
    const accessToken = tokenData.access_token


    if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

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
                    access_token: accessToken
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
    const { id } = req.query;

    if (!id) {
        return res.status(400).json({ error: 'Thiếu id trong yêu cầu' });
    }

    try {
        const tokenData = await getToken();
        const accessToken = tokenData.access_token


        if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

        const response = await axios.post('https://openapi.zalo.me/v2.0/article/remove', {
            id: id
        }, {
            headers: {
                "Content-Type": "application/json",
                "access_token": accessToken
            }
        });

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

        const tokenData = await getToken();
        const accessToken = tokenData.access_token


        if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

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
    const tokenData = await getToken();
    const accessToken = tokenData.access_token


    if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

    const { offset = 0, limit = 5, type = 'normal' } = req.query;

    try {
        const response = await axios.get('https://openapi.zalo.me/v2.0/article/getslice', {
            headers: {
                'access_token': accessToken
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

    const tokenData = await getToken();
    const accessToken = tokenData.access_token


    if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

    const {
        offset = 0,
        limit = 100,
        status = 1
    } = req.query;

    try {
        const response = await axios.get('https://business.openapi.zalo.me/template/all', {
            headers: {
                'access_token': accessToken
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

    const tokenData = await getToken();
    const accessToken = tokenData.access_token


    if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

    const templateId = req.query.template_id;

    if (!templateId) {
        return res.status(400).json({ message: 'Thiếu template_id' });
    }

    try {
        const response = await axios.get('https://business.openapi.zalo.me/template/info/v2', {
            headers: {
                'Content-Type': 'application/json',
                'access_token': accessToken
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
    const tokenData = await getToken();
    const accessToken = tokenData.access_token


    if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

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
                    'access_token': accessToken
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
    const tokenData = await getToken();
    const accessToken = tokenData.access_token


    if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

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
                    'access_token': accessToken
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
    const tokenData = await getToken();
    const accessToken = tokenData.access_token


    if (!tokenData.access_token) return res.status(401).json({ error: 'Thiếu access_token' });

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
                    'access_token': accessToken
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
