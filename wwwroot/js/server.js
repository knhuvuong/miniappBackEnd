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

        return res.status(200).send({ message: "Xác minh OTP thành công!" });

    } catch (error) {
        console.error("Lỗi khi xác minh OTP:", error);
        return res.status(500).send({ message: "Internal Server Error", error });
    }
});

// Tìm kiếm thông tin cựu sinh viên đã đăng ký thông tin theo ngành (Tìm bạn cùng lớp)
app.get('/api/SinhViens/Zalo/major/search', async (req, res) => {
    const { keyword, page = 1, pageSize = 20, maLop } = req.query;

    if (!maLop) {
        return res.status(400).send('Thiếu mã lớp');
    }

    try {
        const pool = await getConnection();
        const request = pool.request();

        request.input('maLop', sql.NVarChar, maLop);

        let query = `
            SELECT za.ID, zan.MaSV, za.HoTen, za.AnhDaiDien, zan.Nganh, zan.Khoa 
            FROM ZaloAccount za 
            JOIN ZaloAccount_Nganh zan ON za.ID = zan.ZaloAccount_ID
            WHERE zan.MaLopNhapHoc = @maLop
        `;

        if (keyword) {
            if (!isNaN(keyword)) {
                query += ' AND (zan.MaSV LIKE @keyword OR zan.Khoa LIKE @keyword)';
            } else {
                query += ' AND (za.HoTen LIKE @keyword)';
            }
            request.input('keyword', sql.NVarChar, `%${keyword}%`);
        }

        const offset = (page - 1) * pageSize;
        query += ' ORDER BY zan.MaSV OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY';
        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, pageSize);

        // Đếm tổng số kết quả phù hợp
        let totalCountQuery = `
            SELECT COUNT(*) AS totalCount 
            FROM ZaloAccount za
            JOIN ZaloAccount_Nganh zan ON za.ID = zan.ZaloAccount_ID
            WHERE zan.MaLopNhapHoc = @maLop
        `;
        if (keyword) {
            if (!isNaN(keyword)) {
                totalCountQuery += ' AND (zan.MaSV LIKE @keyword OR zan.Khoa LIKE @keyword)';
            } else {
                totalCountQuery += ' AND (za.HoTen LIKE @keyword)';
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
                sv.NgaySinh,
                sv.HienDienSV,
				lnh.NienKhoa,
                n1.TenNhomNganh,
                n2.ID AS Nganh_ID,
				ndt.TenNganh,
				lnh.ID AS LopNhapHoc_ID,
				lnh.MaLopNhapHoc
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
        console.error('Lỗi khi tìm sinh viên:', err.stack || err.message || err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

//danh sách csv theo lớp
app.get('/api/SinhViens/list', async (req, res) => {
    const { page = 1, pageSize = 5, maLop } = req.query;

    const pageNum = Number(page);
    const pageSizeNum = Number(pageSize);

    if (
        isNaN(pageNum) || isNaN(pageSizeNum) || pageNum <= 0 || pageSizeNum <= 0 ||
        !maLop || typeof maLop !== 'string'
    ) {
        return res.status(400).send('page, pageSize phải là số và maLop là chuỗi hợp lệ.');
    }

    try {
        const pool = await getConnection();
        const request = pool.request();

        request.input('maLop', sql.NVarChar, maLop);

        const totalCountQuery = `
            SELECT COUNT(*) AS totalCount
            FROM ZaloAccount za
            JOIN ZaloAccount_Nganh zan ON za.ID = zan.ZaloAccount_ID
            WHERE zan.MaLopNhapHoc = @maLop
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
            SELECT 
                za.ID, za.HoTen, za.AnhDaiDien, za.ZaloID,
                zan.MaSV, zan.Nganh, zan.Khoa, zan.MaLopNhapHoc
            FROM ZaloAccount za
            JOIN ZaloAccount_Nganh zan ON za.ID = zan.ZaloAccount_ID
            WHERE zan.MaLopNhapHoc = @maLop
            ORDER BY za.ID
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
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
        pool = await getConnection();

        const userQuery = `
            SELECT * FROM ZaloAccount WHERE ZaloID = @ZaloID
        `;
        const userResult = await pool.request()
            .input('ZaloID', sql.VarChar, ZaloID)
            .query(userQuery);

        if (userResult.recordset.length === 0) {
            return res.status(404).json({ error: 'Chưa có thông tin tài khoản!' });
        }

        const user = userResult.recordset[0];

        // Lấy danh sách ngành học
        const majorQuery = `
            SELECT MaSV, Khoa, Nganh_ID, Nganh, MaLopNhapHoc, LopNhapHoc_ID
            FROM ZaloAccount_Nganh
            WHERE ZaloAccount_ID = @UserID
        `;
        const majorResult = await pool.request()
            .input('UserID', sql.Int, user.ID)
            .query(majorQuery);

        res.json({
            profile: user,
            majors: majorResult.recordset
        });

    } catch (err) {
        console.error('SQL Server Error:', err.message);
        res.status(500).json({ error: 'Internal Server Error', details: err.message });
    } finally {
        if (pool) pool.close();
    }
});

//kiểm tra user tồn tại trong ZaloAccount
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

//tạo hoặc cập nhật thông tin user vào ZaloAccount và ZaloAccount_Nganh
async function addMajorToZaloAccount(pool, zaloAccId, MaSV, Nganh_ID, Nganh, LopNhapHoc_ID, MaLopNhapHoc, Khoa) {
    // Validate required fields
    if (!zaloAccId || !MaSV || !Nganh_ID || !Nganh || !MaLopNhapHoc || !Khoa) {
        throw new Error('Thiếu thông tin bắt buộc để thêm ngành');
    }

    // Check if the major already exists for this user
    const checkEnrollment = await pool.request()
        .input('ZaloAccount_ID', sql.Int, zaloAccId)
        .input('Nganh_ID', sql.Int, Nganh_ID)
        .query(`
            SELECT ID FROM ZaloAccount_Nganh
            WHERE ZaloAccount_ID = @ZaloAccount_ID AND Nganh_ID = @Nganh_ID
        `);

    if (checkEnrollment.recordset.length === 0) {
        // Add new major
        await pool.request()
            .input('ZaloAccount_ID', sql.Int, zaloAccId)
            .input('MaSV', sql.VarChar, MaSV)
            .input('Nganh_ID', sql.Int, Nganh_ID)
            .input('Nganh', sql.NVarChar, Nganh)
            .input('LopNhapHoc_ID', sql.Int, LopNhapHoc_ID || null)
            .input('MaLopNhapHoc', sql.NVarChar, MaLopNhapHoc)
            .input('Khoa', sql.VarChar, Khoa)
            .query(`
                INSERT INTO ZaloAccount_Nganh (
                    ZaloAccount_ID, MaSV, Nganh_ID, Nganh, LopNhapHoc_ID, MaLopNhapHoc, Khoa
                )
                VALUES (
                    @ZaloAccount_ID, @MaSV, @Nganh_ID, @Nganh, @LopNhapHoc_ID, @MaLopNhapHoc, @Khoa
                )
            `);
        return true;
    }
    return false;
}
app.post('/api/SinhViens/TaoThongTinMoi', async (req, res) => {
    const {
        SVTN_ID, MaSV, HoTen, NgaySinh, Sdt, Email, Khoa,
        Nganh_ID, Nganh, LopNhapHoc_ID, MaLopNhapHoc,
        ChucVu, DonViCongTac, ThamNien, DiaChiLienHe,
        ZaloID, AnhDaiDien
    } = req.body;

    if (!SVTN_ID || !MaSV || !HoTen || !NgaySinh || !Sdt || !Email || !Khoa || !Nganh_ID || !Nganh || !ZaloID || !AnhDaiDien || !MaLopNhapHoc) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    const NgayTao = new Date();
    const NgayCapNhat = new Date();

    let pool;

    try {
        pool = await getConnection();

        // 1. Check if ZaloID exists
        const checkZalo = await pool.request()
            .input('ZaloID', sql.VarChar, ZaloID)
            .query('SELECT ID FROM ZaloAccount WHERE ZaloID = @ZaloID');

        let zaloAccId;

        if (checkZalo.recordset.length > 0) {
            // Update existing ZaloAccount
            zaloAccId = checkZalo.recordset[0].ID;

            await pool.request()
                .input('ZaloID', sql.VarChar, ZaloID)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('NgaySinh', sql.DateTime, NgaySinh)
                .input('Sdt', sql.VarChar, Sdt)
                .input('Email', sql.VarChar, Email)
                .input('ChucVu', sql.NVarChar, ChucVu || null)
                .input('DonViCongTac', sql.NVarChar, DonViCongTac || null)
                .input('ThamNien', sql.VarChar, ThamNien || null)
                .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe || null)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .input('NgayCapNhat', sql.DateTime, NgayCapNhat)
                .query(`
                    UPDATE ZaloAccount SET 
                        HoTen = @HoTen, NgaySinh = @NgaySinh, Sdt = @Sdt, Email = @Email,
                        ChucVu = @ChucVu, DonViCongTac = @DonViCongTac, 
                        ThamNien = @ThamNien, DiaChiLienHe = @DiaChiLienHe, 
                        AnhDaiDien = @AnhDaiDien, NgayCapNhat = @NgayCapNhat
                    WHERE ZaloID = @ZaloID
                `);
        } else {
            // Insert new ZaloAccount
            const insertResult = await pool.request()
                .input('SVTN_ID', sql.Int, SVTN_ID)
                .input('HoTen', sql.NVarChar, HoTen)
                .input('NgaySinh', sql.DateTime, NgaySinh)
                .input('Sdt', sql.VarChar, Sdt)
                .input('Email', sql.VarChar, Email)
                .input('ChucVu', sql.NVarChar, ChucVu || null)
                .input('DonViCongTac', sql.NVarChar, DonViCongTac || null)
                .input('ThamNien', sql.VarChar, ThamNien || null)
                .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe || null)
                .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
                .input('ZaloID', sql.VarChar, ZaloID)
                .input('NgayTao', sql.DateTime, NgayTao)
                .input('NgayCapNhat', sql.DateTime, NgayCapNhat)
                .query(`
                    INSERT INTO ZaloAccount (
                        SVTN_ID, HoTen, NgaySinh, Sdt, Email, ChucVu, DonViCongTac,
                        ThamNien, DiaChiLienHe, AnhDaiDien, ZaloID,
                        NgayTao, NgayCapNhat
                    )
                    OUTPUT INSERTED.ID
                    VALUES (
                        @SVTN_ID, @HoTen, @NgaySinh, @Sdt, @Email, @ChucVu, @DonViCongTac,
                        @ThamNien, @DiaChiLienHe, @AnhDaiDien, @ZaloID,
                        @NgayTao, @NgayCapNhat
                    )
                `);

            zaloAccId = insertResult.recordset[0]?.ID;
        }

        await addMajorToZaloAccount(pool, zaloAccId, MaSV, Nganh_ID, Nganh, LopNhapHoc_ID, MaLopNhapHoc, Khoa);

        // gửi ZNS
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

        //     const tokenData = await getToken();
        //     const accessToken = tokenData.access_token

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

        res.status(200).json({
            message: 'Thành công tạo hoặc cập nhật user',
            zaloAccId
        });

    } catch (err) {
        console.error("Lỗi xử lý:", err);
        res.status(500).send('Internal Server Error');
    } finally {
        pool && pool.close();
    }
});

//lấy danh sách ngành học còn lại của 1 sinh viên thông qua ZaloAccount_ID
app.get('/api/SinhViens/NganhConLai', async (req, res) => {
    const { zaloAccId } = req.query;
    if (!zaloAccId) return res.status(400).send('Thiếu zaloAccId');

    let pool;
    try {
        pool = await getConnection();

        const userResult = await pool.request()
            .input('ZaloAccId', sql.Int, zaloAccId)
            .query(`
                SELECT HoTen, NgaySinh
                FROM ZaloAccount
                WHERE ID = @ZaloAccId
            `);

        const user = userResult.recordset[0];
        if (!user) {
            return res.status(404).send('Không tìm thấy ZaloAccount');
        }

        const { HoTen, NgaySinh } = user;

        const result = await pool.request()
            .input('HoTen', sql.NVarChar, HoTen)
            .input('NgaySinh', sql.DateTime, NgaySinh)
            .input('ZaloAccId', sql.Int, zaloAccId)
            .query(`
                SELECT DISTINCT
                    sv.ID,
                    sv.MSSV,
                    sv.FullName,
                    sv.NgaySinh,
                    sv.HienDienSV,
                    lnh.NienKhoa AS Khoa,
                    n1.TenNhomNganh,
                    n2.ID AS Nganh_ID,
                    ndt.TenNganh AS Nganh,
                    lnh.ID AS LopNhapHoc_ID,
                    lnh.MaLopNhapHoc
                FROM SinhVien sv
                JOIN DT_LopNhapHoc_SinhVien lhsv ON sv.ID = lhsv.SinhVien_ID
                JOIN DT_LopNhapHoc lnh ON lhsv.LopNhapHoc_ID = lnh.ID
                JOIN DT_NganhDaoTao ndt ON lnh.Nganh_ID = ndt.ID
                JOIN Nganh n2 ON ndt.MaNganh = n2.MaNganh
                JOIN NhomNganh n1 ON n2.NhomNganh_ID = n1.ID
                WHERE sv.HienDienSV = 3
                    AND sv.FullName = @HoTen
                    AND sv.NgaySinh = @NgaySinh
                    AND n2.ID NOT IN (
                        SELECT Nganh_ID FROM ZaloAccount_Nganh WHERE ZaloAccount_ID = @ZaloAccId
                    )
            `);

        res.status(200).json({
            success: true,
            data: result.recordset,
        });

    } catch (err) {
        console.error("Lỗi khi lấy danh sách ngành còn lại:", err);
        res.status(500).send('Lỗi server');
    } finally {
        pool && pool.close();
    }
});

//thêm ngành cho 1 sinh viên đã có zaloAccount
app.post('/api/SinhViens/ThemNganh', async (req, res) => {
    const {
        ZaloAccount_ID, MaSV, Nganh_ID, Nganh, LopNhapHoc_ID, MaLopNhapHoc, Khoa
    } = req.body;

    // Validate required fields
    if (!ZaloAccount_ID || !MaSV || !Nganh_ID || !Nganh || !MaLopNhapHoc || !Khoa) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    let pool;

    try {
        pool = await getConnection();

        const checkZaloAccount = await pool.request()
            .input('ZaloAccount_ID', sql.Int, ZaloAccount_ID)
            .query('SELECT ID FROM ZaloAccount WHERE ID = @ZaloAccount_ID');

        if (checkZaloAccount.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy ZaloAccount với ID cung cấp');
        }

        const added = await addMajorToZaloAccount(pool, ZaloAccount_ID, MaSV, Nganh_ID, Nganh, LopNhapHoc_ID, MaLopNhapHoc, Khoa);

        if (added) {
            res.status(200).json({
                message: 'Thêm ngành thành công'
            });
        } else {
            res.status(400).json({
                message: 'Ngành này đã tồn tại cho ZaloAccount'
            });
        }

    } catch (err) {
        console.error("Lỗi xử lý:", err);
        res.status(500).send('Internal Server Error');
    } finally {
        pool && pool.close();
    }
});

//lấy danh sách ngành đã thêm theo ZaloAccount_ID
app.get('/api/SinhViens/NganhDaThem', async (req, res) => {
    const { zaloAccId } = req.query;

    if (isNaN(zaloAccId)) {
        return res.status(400).send('ZaloAccount_ID không hợp lệ');
    }

    let pool;

    try {
        pool = await getConnection();

        const result = await pool.request()
            .input('ZaloAccount_ID', sql.Int, zaloAccId)
            .query(`
                SELECT 
                    zan.Nganh_ID,
                    zan.Nganh,
                    zan.MaSV,
                    zan.LopNhapHoc_ID,
                    zan.MaLopNhapHoc,
                    zan.Khoa
                FROM ZaloAccount_Nganh zan
                WHERE zan.ZaloAccount_ID = @ZaloAccount_ID
            `);

        res.status(200).json(result.recordset);

    } catch (err) {
        console.error("Lỗi khi lấy ngành đã thêm:", err);
        res.status(500).send("Lỗi máy chủ");
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

//Cập nhật cá nhân - việc làm
app.post('/api/SinhViens/CapNhatThongTinCaNhanVaViecLam', async (req, res) => {
    const {
        ZaloID, SVTN_ID, HoTen, Sdt, Email,
        ChucVu, DonViCongTac, ThamNien, DiaChiLienHe, AnhDaiDien
    } = req.body;

    if (!ZaloID || !SVTN_ID || !HoTen || !Sdt || !Email || !AnhDaiDien) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    const NgayCapNhat = new Date();
    let pool;

    try {
        pool = await getConnection();

        const check = await pool.request()
            .input('ZaloID', sql.VarChar, ZaloID)
            .query('SELECT ID FROM ZaloAccount WHERE ZaloID = @ZaloID');

        if (check.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy tài khoản Zalo');
        }

        await pool.request()
            .input('ZaloID', sql.VarChar, ZaloID)
            .input('SVTN_ID', sql.Int, SVTN_ID)
            .input('HoTen', sql.NVarChar, HoTen)
            .input('Sdt', sql.VarChar, Sdt)
            .input('Email', sql.VarChar, Email)
            .input('ChucVu', sql.NVarChar, ChucVu || null)
            .input('DonViCongTac', sql.NVarChar, DonViCongTac || null)
            .input('ThamNien', sql.NVarChar, ThamNien || null)
            .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe || null)
            .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
            .input('NgayCapNhat', sql.DateTime, NgayCapNhat)
            .query(`
                UPDATE ZaloAccount
                SET SVTN_ID = @SVTN_ID, HoTen = @HoTen,
                    Sdt = @Sdt, Email = @Email,
                    ChucVu = @ChucVu, DonViCongTac = @DonViCongTac, ThamNien = @ThamNien,
                    DiaChiLienHe = @DiaChiLienHe, AnhDaiDien = @AnhDaiDien,
                    NgayCapNhat = @NgayCapNhat
                WHERE ZaloID = @ZaloID
            `);

        res.status(200).send('Cập nhật thông tin cá nhân + việc làm thành công');
    } catch (err) {
        console.error('Lỗi:', err);
        res.status(500).send('Lỗi máy chủ');
    } finally {
        if (pool) await pool.close();
    }
});

//cập nhật toàn bộ thông tin (với ngành khai báo được chọn lại)
app.post('/api/SinhViens/CapNhatToanBoThongTin', async (req, res) => {
    const {
        ZaloID, SVTN_ID, MaSV, HoTen, NgaySinh, Sdt, Email,
        ChucVu, DonViCongTac, ThamNien, DiaChiLienHe, AnhDaiDien,
        Nganh_ID, Nganh, LopNhapHoc_ID, MaLopNhapHoc, Khoa
    } = req.body;

    if (!ZaloID || !SVTN_ID || !MaSV || !HoTen || !NgaySinh || !Sdt || !Email || !AnhDaiDien || !Nganh_ID || !Nganh || !MaLopNhapHoc || !Khoa) {
        return res.status(400).send('Thiếu thông tin bắt buộc');
    }

    const NgayCapNhat = new Date();
    let pool;

    try {
        pool = await getConnection();

        // 1. Kiểm tra tài khoản
        const result = await pool.request()
            .input('ZaloID', sql.VarChar, ZaloID)
            .query('SELECT ID FROM ZaloAccount WHERE ZaloID = @ZaloID');

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy tài khoản Zalo');
        }

        const zaloAccId = result.recordset[0].ID;

        // 2. Cập nhật ZaloAccount
        await pool.request()
            .input('ZaloID', sql.VarChar, ZaloID)
            .input('SVTN_ID', sql.Int, SVTN_ID)
            .input('HoTen', sql.NVarChar, HoTen)
            .input('NgaySinh', sql.DateTime, NgaySinh)
            .input('Sdt', sql.VarChar, Sdt)
            .input('Email', sql.VarChar, Email)
            .input('ChucVu', sql.NVarChar, ChucVu || null)
            .input('DonViCongTac', sql.NVarChar, DonViCongTac || null)
            .input('ThamNien', sql.VarChar, ThamNien || null)
            .input('DiaChiLienHe', sql.NVarChar, DiaChiLienHe || null)
            .input('AnhDaiDien', sql.NVarChar, AnhDaiDien)
            .input('NgayCapNhat', sql.DateTime, NgayCapNhat)
            .query(`
                UPDATE ZaloAccount
                SET SVTN_ID = @SVTN_ID, HoTen = @HoTen, NgaySinh = @NgaySinh,
                    Sdt = @Sdt, Email = @Email,
                    ChucVu = @ChucVu, DonViCongTac = @DonViCongTac, ThamNien = @ThamNien,
                    DiaChiLienHe = @DiaChiLienHe, AnhDaiDien = @AnhDaiDien,
                    NgayCapNhat = @NgayCapNhat
                WHERE ZaloID = @ZaloID
            `);

        // 3. Xóa toàn bộ ngành cũ
        await pool.request()
            .input('ZaloAccount_ID', sql.Int, zaloAccId)
            .query(`DELETE FROM ZaloAccount_Nganh WHERE ZaloAccount_ID = @ZaloAccount_ID`);

        // 4. Thêm lại ngành mới (gọi lại hàm bạn đã viết sẵn)
        await addMajorToZaloAccount(pool, zaloAccId, MaSV, Nganh_ID, Nganh, LopNhapHoc_ID, MaLopNhapHoc, Khoa);

        res.status(200).json({
            message: 'Cập nhật toàn bộ thông tin thành công',
            zaloAccId: zaloAccId
        });

    } catch (err) {
        console.error('Lỗi:', err);
        res.status(500).send('Lỗi máy chủ');
    } finally {
        if (pool) await pool.close();
    }
});

// //bản tin csv tms
// app.get('/api/BanTinMoiNhatCSV', async (req, res) => {
//     try {
//         const pool = await getConnection();
//         const result = await pool.request().query('SELECT TOP 5 * FROM Zalo_BanTinCuuSV ORDER BY NgayTao DESC');
//         res.json(result.recordset);
//     } catch (err) {
//         console.error(err);
//         res.status(500).send('Internal Server Error');
//     }
// });

//5 bản tin csv wordpress
app.get("/api/BanTinMoiNhatCSV", async (req, res) => {
    const url = "https://alumni.tvu.edu.vn/wp-json/wp/v2/posts?per_page=5&orderby=date&order=desc";

    try {
        const response = await axios.get(url);
        res.json(response.data);
    } catch (error) {
        console.error("Lỗi lấy bản tin:", error.message);
        res.status(500).send("Internal Server Error: " + error.message);
    }
});

//tất cả bản tin csv wordpress
app.get("/api/TatCaBanTinWP", async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const per_page = parseInt(req.query.limit) || 5;

    const url = `https://alumni.tvu.edu.vn/wp-json/wp/v2/posts?orderby=date&order=desc&page=${page}&per_page=${per_page}`;

    try {
        const response = await axios.get(url);
        const total = response.headers["x-wp-total"];
        const totalPages = response.headers["x-wp-totalpages"];

        res.json({
            articles: response.data,
            page,
            per_page,
            total: Number(total),
            totalPages: Number(totalPages),
        });
    } catch (error) {
        console.error("Lỗi lấy bản tin:", error.message);
        const statusCode = error.response?.status || 500;
        res.status(statusCode).send("Lỗi khi lấy bản tin: " + error.message);
    }
});

//lấy chi tiết bài viết từ WordPress
app.get("/api/ChiTietBanTinWP", async (req, res) => {
    const { id } = req.query;

    if (!id) {
        return res.status(400).send("Thiếu tham số 'id' bài viết");
    }

    const url = `https://alumni.tvu.edu.vn/wp-json/wp/v2/posts/${id}`;

    try {
        const response = await axios.get(url);
        res.send(response.data);
    } catch (error) {
        console.error("Lỗi khi lấy chi tiết bản tin:", error.message);
        res.status(500).send("Internal Server Error: " + error.message);
    }
});

//danh sách bản tin db
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

//chi tiết bản tin db
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

// Góp ý từ sinh viên
app.post('/api/GopY', async (req, res) => {
    const { ZaloID, TieuDe, NoiDung } = req.body;

    // Kiểm tra đầu vào
    if (!ZaloID || !TieuDe || !NoiDung) {
        return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    }

    let pool;

    try {
        pool = await getConnection();

        // Kiểm tra ZaloID có tồn tại trong ZaloAccount
        const checkZaloID = await pool.request()
            .input('ZaloID', sql.VarChar, ZaloID)
            .query('SELECT ID FROM ZaloAccount WHERE ZaloID = @ZaloID');

        if (checkZaloID.recordset.length === 0) {
            return res.status(404).json({ error: 'ZaloID không tồn tại trong hệ thống' });
        }

        const ZaloAcc_ID = checkZaloID.recordset[0].ID;

        // Ghi góp ý
        await pool.request()
            .input('ZaloAccount_ID', sql.Int, ZaloAcc_ID)
            .input('TieuDe', sql.NVarChar, TieuDe)
            .input('NoiDung', sql.NVarChar, NoiDung)
            .query(`
                INSERT INTO Zalo_ThongTinTuCuuSV (
                    ZaloAccount_ID, TieuDe, NoiDung, NgayTao
                ) VALUES (
                    @ZaloAccount_ID, @TieuDe, @NoiDung, GETDATE()
                )
            `);

        res.status(200).json({ message: 'Góp ý đã được ghi nhận' });

    } catch (err) {
        console.error('Lỗi khi xử lý góp ý:', err);
        res.status(500).json({ error: 'Lỗi máy chủ', details: err.message });
    } finally {
        if (pool) await pool.close();
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

        const result = await pool.request().query(`
        SELECT 
            nn.ID, 
            nn.TenNhomNganh,
            COUNT(n.ID) AS SoLuongNganh
        FROM NhomNganh nn
        LEFT JOIN Nganh n ON n.NhomNganh_ID = nn.ID
        GROUP BY nn.ID, nn.TenNhomNganh
        ORDER BY nn.ID 
        `);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy nhóm ngành nào!');
        }

        res.json({
            data: result.recordset,
            totalCount: result.recordset.length,
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

        const result = await request.query(`
      SELECT 
          n.ID,
          n.TenNganh,
          n.NhomNganh_ID,
          COUNT(DISTINCT lnh.NienKhoa) AS SoLuongKhoa
      FROM Nganh n
      LEFT JOIN DT_NganhDaoTao ndt ON ndt.MaNganh = n.MaNganh
      LEFT JOIN DT_LopNhapHoc lnh ON lnh.Nganh_ID = ndt.ID
      WHERE n.NhomNganh_ID = @nhomNganhId
      GROUP BY n.ID, n.TenNganh, n.NhomNganh_ID
    `);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy ngành nào trong nhóm ngành này!');
        }

        res.json(result.recordset);
    } catch (err) {
        console.error('Lỗi khi lấy ngành theo nhóm ngành:', err);
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

        const result = await request.query(`
      SELECT 
          lnh.NienKhoa,
          COUNT(lnh.ID) AS SoLuongLop
      FROM DT_LopNhapHoc lnh
      JOIN DT_NganhDaoTao ndt ON lnh.Nganh_ID = ndt.ID
      WHERE ndt.MaNganh = (
        SELECT MaNganh FROM Nganh WHERE ID = @nganhId
      )
      GROUP BY lnh.NienKhoa
      ORDER BY lnh.NienKhoa DESC
    `);

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

        const result = await request.query(`
            SELECT 
                lnh.ID,
                lnh.MaLopNhapHoc,
                lnh.TenLopNhapHoc,
                lnh.NienKhoa,
                lnh.Nganh_ID,
                (
                    SELECT COUNT(*) 
                    FROM ZaloAccount_Nganh zan
                    WHERE zan.MaLopNhapHoc = lnh.MaLopNhapHoc
                ) AS SoLuongSinhVien
            FROM DT_LopNhapHoc lnh
            JOIN DT_NganhDaoTao ndt ON lnh.Nganh_ID = ndt.ID
            WHERE ndt.MaNganh = (
                SELECT MaNganh FROM Nganh WHERE ID = @nganhId
            )
            AND lnh.NienKhoa = @khoa
            ORDER BY lnh.MaLopNhapHoc
                `);

        if (result.recordset.length === 0) {
            return res.status(404).send('Không tìm thấy lớp nào cho khóa này!');
        }

        res.json(result.recordset);
    } catch (err) {
        console.error('Lỗi khi lấy lớp nhập học:', err);
        res.status(500).send('Internal Server Error');
    }
});

//tìm kiếm sinh viên theo mã lớp nhập học (dữ liệu ở bảng ZaloAccount_Nganh)
app.get('/api/TimKiemSinhVien', async (req, res) => {
    const { maLop, page = 1, pageSize = 10 } = req.query;

    if (!maLop) {
        return res.status(400).json({ error: 'Thiếu tham số maLop' });
    }

    const pageNum = parseInt(page);
    const sizeNum = parseInt(pageSize);

    if (isNaN(pageNum) || isNaN(sizeNum) || pageNum <= 0 || sizeNum <= 0) {
        return res.status(400).json({ error: 'Page và pageSize phải là số nguyên dương.' });
    }

    let pool;

    try {
        pool = await getConnection();
        const request = pool.request();
        request.input('maLop', sql.NVarChar, maLop);

        // Đếm tổng số sinh viên thuộc lớp này
        const countQuery = `
            SELECT COUNT(*) AS totalCount
            FROM ZaloAccount_Nganh zan
            WHERE zan.MaLopNhapHoc = @maLop
        `;
        const countResult = await request.query(countQuery);
        const totalCount = countResult.recordset[0].totalCount;

        if (totalCount === 0) {
            return res.status(404).json({ error: 'Không tìm thấy sinh viên nào trong lớp này!' });
        }

        const offset = (pageNum - 1) * sizeNum;
        request.input('offset', sql.Int, offset);
        request.input('pageSize', sql.Int, sizeNum);

        // Lấy thông tin sinh viên (kết hợp với bảng ZaloAccount)
        const dataQuery = `
            SELECT za.ID, zan.MaSV, za.HoTen, za.AnhDaiDien, zan.Nganh, zan.Khoa, zan.MaLopNhapHoc
            FROM ZaloAccount za
            JOIN ZaloAccount_Nganh zan ON za.ID = zan.ZaloAccount_ID
            WHERE zan.MaLopNhapHoc = @maLop
            ORDER BY zan.MaSV
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `;
        const result = await request.query(dataQuery);

        res.json({
            profiles: result.recordset,
            totalCount,
            page: pageNum,
            pageSize: sizeNum,
            totalPages: Math.ceil(totalCount / sizeNum)
        });

    } catch (err) {
        console.error('Lỗi truy vấn:', err);
        res.status(500).json({ error: 'Lỗi máy chủ', details: err.message });
    } finally {
        if (pool) await pool.close();
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
