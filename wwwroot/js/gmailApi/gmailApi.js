const { google } = require('googleapis');

async function listOfLables(auth) {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.labels.list({
        userId: 'me',
    });
    const labels = res.data.labels;
    if (!labels || labels.length === 0) {
        console.log('No labels found.');
        return [];
    }

    console.log('Labels:');
    labels.forEach((label) => {
        console.log(`- ${label.name}`);
    });

    return labels;
}

async function sendEmail(auth, email) {
    const gmail = google.gmail({ version: 'v1', auth });
    const raw = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
            raw: raw,
        },
    });

    console.log('Email sent:', res.data);
    return res.data;
}

module.exports = {
    listOfLables : listOfLables,
    sendEmail: sendEmail
}