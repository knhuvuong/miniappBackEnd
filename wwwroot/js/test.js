const authorize = require('./gmailAPI/googleAuth');
const { listOfLables, sendEmail } = require('./gmailAPI/gmailApi');

function encodeSubject(subject) {
    return `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
}

async function sendOTPToMail() {
    let auth = await authorize().then().catch(console.error);
    const subject = 'Mã OTP xác thực thông tin cựu sinh viên';
    const encodedSubject = encodeSubject(subject);
    let message = 'TO: nhukhanhtv052@gmail.com\n' +
        `Subject: ${encodedSubject}\n` +
        'Content-Type: text/plain; charset="UTF-8"\n' +
        'Content-Transfer-Encoding: 7bit\n\n' +
        'Your OTP is: 123456\n' +
        'This is a test email from Zalo Mini App.\n';

    await sendEmail(auth, message).then().catch(console.error);
}

sendOTPToMail().catch(console.error);