const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const fs = require('fs');

// === Konfigurasi Database ===
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'asdzxc123qwe',
  database: 'presensigps'
};

// === Status Notifikasi ===
const STATUS_FILE = './messageStatus.json';
const messageStatus = {
  checkIn: new Set(),
  checkOut: new Set(),
  morningReminder: new Set(),
  afternoonReminder: new Set()
};

// === Fungsi Simpan & Load Status ===
function loadStatus() {
  if (fs.existsSync(STATUS_FILE)) {
    const data = fs.readFileSync(STATUS_FILE);
    const parsed = JSON.parse(data);
    messageStatus.checkIn = new Set(parsed.checkIn || []);
    messageStatus.checkOut = new Set(parsed.checkOut || []);
    messageStatus.morningReminder = new Set(parsed.morningReminder || []);
    messageStatus.afternoonReminder = new Set(parsed.afternoonReminder || []);
  }
}

function saveStatus() {
  const data = {
    checkIn: Array.from(messageStatus.checkIn),
    checkOut: Array.from(messageStatus.checkOut),
    morningReminder: Array.from(messageStatus.morningReminder),
    afternoonReminder: Array.from(messageStatus.afternoonReminder)
  };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
}

// === Inisialisasi WhatsApp Client ===
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process'
    ]
  },
  restartOnAuthFail: true,
  takeoverOnConflict: true,
  takeoverTimeoutMs: 30000
});

// === Event WhatsApp ===
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('authenticated', () => console.log('AUTHENTICATED'));
client.on('auth_failure', msg => console.error('AUTHENTICATION FAILURE:', msg));
client.on('disconnected', reason => {
  console.log('Client logged out:', reason);
  setTimeout(() => client.initialize(), 5000);
});
client.on('ready', () => {
  console.log('Client is ready!');
  startCronJobs();
});

// === Cron Jobs ===
function startCronJobs() {
  cron.schedule('*/2 6-20 * * *', async () => {
    console.log('Memeriksa absensi baru...');
    await checkNewCheckIns();
    await checkNewCheckOuts();
  }, { timezone: "Asia/Jakarta" });

  // Reminder pagi - jam 09:10
  cron.schedule('40 9 * * 1-5', async () => {
    console.log('Memeriksa yang belum absen pagi...');
    await checkAndSendMorningReminders();
  }, { timezone: "Asia/Jakarta" });

  // Reminder sore - jam 09:30 (hanya untuk pengujian, normalnya 17:00)
  cron.schedule('00 17 * * 1-5', async () => {
    console.log('Mengingatkan absen pulang...');
    await sendAfternoonReminders();
  }, { timezone: "Asia/Jakarta" });


  cron.schedule('0 0 * * *', () => {
    messageStatus.checkIn.clear();
    messageStatus.checkOut.clear();
    messageStatus.morningReminder.clear();
    messageStatus.afternoonReminder.clear();
    saveStatus();
    console.log('Reset status notifikasi harian');
  }, { timezone: "Asia/Jakarta" });
}

// === Check Absensi Masuk ===
async function checkNewCheckIns() {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    const today = new Date().toLocaleDateString('en-CA');
    const [rows] = await connection.execute(`
      SELECT k.nik, k.nama_lengkap, k.no_hp, p.jam_in
      FROM presensi p
      JOIN karyawan k ON p.nik = k.nik
      WHERE p.tgl_presensi = ?
        AND p.jam_in IS NOT NULL
        AND p.jam_out IS NULL
        AND k.no_hp IS NOT NULL AND k.no_hp != ''
        AND p.jam_in >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
    `, [today]);

    for (const row of rows) {
      const nik = row.nik;
      const key = `${today}_${nik}`;
      if (!messageStatus.checkIn.has(key)) {
        const nama = row.nama_lengkap;
        const noHp = formatPhoneNumber(row.no_hp);
        const message = `Hai ${nama},\n\nWajah Teridentifikasi, Absensi Berhasil. Selamat Bekerja!`;

        await sendWhatsAppMessage(noHp, message);
        messageStatus.checkIn.add(key);
        saveStatus();
        console.log(`Notifikasi masuk terkirim ke ${nik}`);
      }
    }
  } catch (error) {
    console.error('Error checkNewCheckIns:', error);
  } finally {
    if (connection) await connection.end();
  }
}

// === Check Absensi Pulang ===
async function checkNewCheckOuts() {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    const today = new Date().toLocaleDateString('en-CA');
    const [rows] = await connection.execute(`
      SELECT k.nik, k.nama_lengkap, k.no_hp, p.jam_out
      FROM presensi p
      JOIN karyawan k ON p.nik = k.nik
      WHERE p.tgl_presensi = ?
        AND p.jam_out IS NOT NULL
        AND p.jam_out >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        AND k.no_hp IS NOT NULL AND k.no_hp != ''
    `, [today]);

    for (const row of rows) {
      const nik = row.nik;
      const key = `${today}_${nik}`;
      if (!messageStatus.checkOut.has(key)) {
        const nama = row.nama_lengkap;
        const noHp = formatPhoneNumber(row.no_hp);
        const message = `Hai ${nama},\n\nWajah Teridentifikasi, Absensi Pulang Berhasil. Hati-hati dijalan!`;

        await sendWhatsAppMessage(noHp, message);
        messageStatus.checkOut.add(key);
        saveStatus();
        console.log(`Notifikasi pulang terkirim ke ${nik}`);
      }
    }
  } catch (error) {
    console.error('Error checkNewCheckOuts:', error);
  } finally {
    if (connection) await connection.end();
  }
}

// === Reminder Pagi ===
async function checkAndSendMorningReminders() {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    const today = new Date().toLocaleDateString('en-CA');
    const [rows] = await connection.execute(`
      SELECT k.nik, k.nama_lengkap, k.no_hp
      FROM karyawan k
      LEFT JOIN presensi p ON k.nik = p.nik AND p.tgl_presensi = ?
      WHERE p.jam_in IS NULL
        AND k.no_hp IS NOT NULL AND k.no_hp != ''
    `, [today]);

    for (const row of rows) {
      const nik = row.nik;
      if (!messageStatus.morningReminder.has(nik)) {
        const nama = row.nama_lengkap;
        const noHp = formatPhoneNumber(row.no_hp);
        const message = `Hai ${nama},\n\nAnda belum melakukan absensi masuk hari ini (${today}). ` +
          `Silakan segera lakukan absensi jika Anda sedang bekerja. ` +
          `Jika Anda sedang tidak bekerja, harap hubungi HRD.\n\nTerima kasih.`;

        await sendWhatsAppMessage(noHp, message);
        messageStatus.morningReminder.add(nik);
        saveStatus();
        console.log(`Pengingat pagi terkirim ke ${nik}`);
      }
    }
  } catch (error) {
    console.error('Error checkAndSendMorningReminders:', error);
  } finally {
    if (connection) await connection.end();
  }
}

// === Reminder Sore ===
async function sendAfternoonReminders() {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    const today = new Date().toLocaleDateString('en-CA');
    const [rows] = await connection.execute(`
      SELECT k.nik, k.nama_lengkap, k.no_hp
      FROM presensi p
      JOIN karyawan k ON p.nik = k.nik
      WHERE p.tgl_presensi = ?
        AND p.jam_in IS NOT NULL
        AND p.jam_out IS NULL
        AND k.no_hp IS NOT NULL AND k.no_hp != ''
    `, [today]);

    for (const row of rows) {
      const nik = row.nik;
      if (!messageStatus.afternoonReminder.has(nik)) {
        const nama = row.nama_lengkap;
        const noHp = formatPhoneNumber(row.no_hp);
        const message = `Selamat sore ${nama},\n\nJangan Lupa Absen Pulang, Ya. Dan hati-hati dijalan, semoga harimu selalu menyenangkan!`;

        await sendWhatsAppMessage(noHp, message);
        messageStatus.afternoonReminder.add(nik);
        saveStatus();
        console.log(`Pengingat sore terkirim ke ${nik}`);
      }
    }
  } catch (error) {
    console.error('Error sendAfternoonReminders:', error);
  } finally {
    if (connection) await connection.end();
  }
}

// === Format Nomor WhatsApp ===
function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
  if (!cleaned.startsWith('62')) cleaned = '62' + cleaned;
  return cleaned + '@c.us';
}

// === Kirim Pesan WhatsApp ===
async function sendWhatsAppMessage(phone, message) {
  try {
    await client.sendMessage(phone, message);
    console.log(`Pesan terkirim ke ${phone}`);
    return true;
  } catch (error) {
    console.error(`Gagal mengirim ke ${phone}:`, error.message);
    return false;
  }
}

// === Mulai WhatsApp Client ===
async function startClient() {
  try {
    console.log('Menghubungkan ke WhatsApp...');
    loadStatus();  // <--- Restore data saat program dijalankan
    await client.initialize();
  } catch (error) {
    console.error('Gagal initialize:', error);
    setTimeout(startClient, 10000);
  }
}

startClient();

setTimeout(() => {
  checkAndSendMorningReminders();
  sendAfternoonReminders();
}, 5000);
