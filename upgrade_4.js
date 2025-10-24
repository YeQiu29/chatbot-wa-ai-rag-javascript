// Tambahkan ini di baris paling atas index.js
if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = require('canvas').DOMMatrix;
}

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');

require('dotenv').config();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;


//const pdfParse = require('pdf-parse').default;
const pdfParse = require('pdf-parse'); // ✅ versi lama aman
const path = require('path');
const repliedMessages = new Set();

// === Load dan ekstrak semua PDF di folder "rag" saat startup ===
let pdfText = '';
async function loadAllPdfs() {
  try {
    const folderPath = path.join(__dirname, 'rag');
    const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.pdf'));
    let allText = '';
    for (const file of files) {
      const dataBuffer = fs.readFileSync(path.join(folderPath, file));
      const data = await pdfParse(dataBuffer);
      allText += data.text + '\n';
      console.log(`PDF ${file} berhasil diekstrak`);
    }
    pdfText = allText;
  } catch (err) {
    console.error('Gagal ekstrak PDF:', err.message);
  }
}
loadAllPdfs();

// Fungsi untuk bertanya ke Gemini
async function askGeminiWithContext(question) {
  // Gunakan seluruh teks PDF sebagai konteks
  if (!pdfText || pdfText.trim() === '') {
    console.error('Teks PDF kosong, tidak bisa bertanya ke Gemini.');
    return 'Maaf, data referensi tidak tersedia saat ini.';
  }

  const prompt = `Anda adalah asisten AI untuk PT. Djemoendo. Jawab pertanyaan berikut secara akurat dan hanya berdasarkan dokumen yang disediakan. Jika jawaban tidak ada di dalam dokumen, katakan "Maaf, saya tidak dapat menemukan informasi tersebut dalam dokumen."

Dokumen:
${pdfText}

Pertanyaan: ${question}`;

  try {
    const response = await axios.post(GEMINI_API_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    });
    return response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'Maaf, saya tidak bisa menjawab pertanyaan Anda.';
  } catch (error) {
    console.error('Error Gemini:', error.message);
    return 'Maaf, terjadi kesalahan pada sistem AI.';
  }
}

// === Konfigurasi Database ===
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: '',
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

const DAILY_GREETING_FILE = './dailyGreetingStatus.json';
const dailyGreetingStatus = new Set();

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

function loadDailyGreetingStatus() {
  if (fs.existsSync(DAILY_GREETING_FILE)) {
    const data = fs.readFileSync(DAILY_GREETING_FILE);
    const parsed = JSON.parse(data);
    dailyGreetingStatus.clear();
    parsed.forEach(item => dailyGreetingStatus.add(item));
  }
}

function saveDailyGreetingStatus() {
  fs.writeFileSync(DAILY_GREETING_FILE, JSON.stringify(Array.from(dailyGreetingStatus), null, 2));
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

// Event pesan masuk WhatsApp
client.on('message', async msg => {
  console.log('Pesan masuk:', msg.body);
  console.log('Sender:', msg.from);

  if (repliedMessages.has(msg.id._serialized)) {
    console.log('Pesan sudah pernah dibalas, dilewati.');
    return;
  }
  repliedMessages.add(msg.id._serialized);

  if (msg.from.endsWith('@g.us')) {
    console.log('Pesan dari grup, dilewati.');
    return;
  }
  if (msg.fromMe) {
    console.log('Pesan dari bot sendiri, dilewati.');
    return;
  }

  const senderPhoneNumber = msg.from;
  console.log('Formatted senderPhoneNumber for lookup:', senderPhoneNumber); // Debug log
  const employee = await getEmployeeByPhoneNumber(senderPhoneNumber);
  console.log('Employee lookup result:', employee); // Debug log

  if (employee) {
    console.log('Sender is a registered employee:', employee.nama_lengkap); // Debug log
    const todayKey = new Date().toLocaleDateString('en-CA');
    const employeeDailyKey = `${employee.nik}_${todayKey}`;

    if (!dailyGreetingStatus.has(employeeDailyKey)) {
      const greetingMessage = `Halo ${employee.nama_lengkap}! Ada yang bisa saya bantu hari ini?\n\nAnda bisa menanyakan:\n- Absensi bulan ini: /infoabsensi_bulanini\n- Cuti/Sakit bulan ini: /infosakit_cutibulanini`;
      await msg.reply(greetingMessage);
      dailyGreetingStatus.add(employeeDailyKey);
      saveDailyGreetingStatus();
      console.log('Daily greeting sent to employee.'); // Debug log
    }

    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    console.log('Message body for command check:', msg.body); // Debug log

    if (msg.body === '/infoabsensi_bulanini') {
      console.log('Command /infoabsensi_bulanini detected.'); // Debug log
      const attendanceData = await getMonthlyAttendance(employee.nik, currentMonth, currentYear);
      let responseMessage = `*Absensi ${employee.nama_lengkap} Bulan Ini (${currentMonth}/${currentYear}):*\n\n`;
      if (attendanceData.length > 0) {
        attendanceData.forEach(record => {
          const date = new Date(record.tgl_presensi).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit' });
          const jamIn = record.jam_in ? new Date(record.jam_in).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
          const jamOut = record.jam_out ? new Date(record.jam_out).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
          responseMessage += `Tanggal: ${date}, Masuk: ${jamIn}, Pulang: ${jamOut}\n`;
        });
      } else {
        responseMessage += 'Tidak ada data absensi untuk bulan ini.';
      }
      await msg.reply(responseMessage);
      return;
    } else if (msg.body === '/infosakit_cutibulanini') {
      console.log('Command /infosakit_cutibulanini detected.'); // Debug log
      const leaveData = await getMonthlyLeave(employee.nik, currentMonth, currentYear);
      let responseMessage = `*Informasi Cuti/Sakit ${employee.nama_lengkap} Bulan Ini (${currentMonth}/${currentYear}):*\n\n`;
      if (leaveData.length > 0) {
        leaveData.forEach(record => {
          const date = new Date(record.tgl_izin).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit' });
          let statusApprovedText = '';
          if (record.status_approved === 0) statusApprovedText = 'Pending';
          else if (record.status_approved === 1) statusApprovedText = 'Disetujui';
          else if (record.status_approved === 2) statusApprovedText = 'Ditolak';
          else statusApprovedText = 'Tidak Diketahui';

          responseMessage += `Tanggal: ${date}, Jenis: ${record.status}, Keterangan: ${record.keterangan || '-'}, Status: ${statusApprovedText}\n`;
        });
      } else {
        responseMessage += 'Tidak ada pengajuan cuti/sakit untuk bulan ini.';
      }
      await msg.reply(responseMessage);
      return;
    }

    // Fallback to Gemini for employees if no command matched
    if (msg.body && msg.body.length > 1) {
      const jawaban = await askGeminiWithContext(msg.body);
      console.log('Jawaban (dari karyawan, bukan perintah):', jawaban);
      await msg.reply(jawaban);
    } else {
      console.log('Pesan tidak memenuhi syarat untuk dijawab oleh Gemini (dari karyawan, bukan perintah).');
    }
    return;
  } else {
    console.log('Sender is NOT a registered employee.'); // Debug log
    // If not an employee, always go to Gemini
    if (msg.body && msg.body.length > 1) {
      const jawaban = await askGeminiWithContext(msg.body);
      console.log('Jawaban (dari non-karyawan):', jawaban);
      await msg.reply(jawaban);
    } else {
      console.log('Pesan tidak memenuhi syarat untuk dijawab oleh Gemini (dari non-karyawan).');
    }
    return;
  }
});

// === Cron Jobs ===
function startCronJobs() {
  cron.schedule('*/2 6-20 * * *', async () => {
    console.log('Memeriksa absensi baru...');
    await checkNewCheckIns();
    await checkNewCheckOuts();
  }, { timezone: "Asia/Jakarta" });

  // Reminder tengah hari/siang - jam 07:00
  cron.schedule('00 7 * * 1-5', async () => { // menit 0, jam 7, setiap hari, setiap bulan, Senin-Jumat
    console.log('Memeriksa yang belum absen pag (07:00)...');
    await checkAndSendMorningReminders(); // Memanggil fungsi pengingat pagi
  }, { timezone: "Asia/Jakarta" });

  // Reminder sore - TEST SETIAP MENIT
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
    dailyGreetingStatus.clear(); // Clear daily greeting status
    saveDailyGreetingStatus(); // Save cleared status
    console.log('Reset status notifikasi harian dan sapaan harian');
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
          `Silahkan segera lakukan absensi jika Anda sedang bekerja. ` +
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

// === Fungsi Database Baru ===
async function getEmployeeByPhoneNumber(phoneNumber) {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log('getEmployeeByPhoneNumber: Incoming phoneNumber:', phoneNumber);

    // Bersihkan format nomor dari WhatsApp
    const cleanedPhone = phoneNumber.replace('@c.us', '').replace(/\D/g, '');
    console.log('getEmployeeByPhoneNumber: Cleaned phone number:', cleanedPhone);

    // Buat beberapa variasi format umum
    const localFormat = cleanedPhone.replace(/^62/, '0');  // 62881... → 0881...
    const plusFormat = '+' + cleanedPhone;                 // +62881...
    const plainFormat = cleanedPhone;                      // 62881...

    console.log('Search variations:', { plainFormat, localFormat, plusFormat });

    // Query fleksibel
    const query = `
      SELECT nik, nama_lengkap 
      FROM karyawan 
      WHERE REPLACE(REPLACE(REPLACE(no_hp, '+', ''), ' ', ''), '-', '') IN (?, ?, ?)
      LIMIT 1
    `;
    const [rows] = await connection.execute(query, [plainFormat, localFormat, plusFormat]);

    console.log('getEmployeeByPhoneNumber: Query result rows:', rows);
    return rows.length > 0 ? rows[0] : null;

  } catch (error) {
    console.error('Error getEmployeeByPhoneNumber:', error);
    return null;
  } finally {
    if (connection) await connection.end();
  }
}

async function getMonthlyAttendance(nik, month, year) {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-31`; // Simplified, consider actual days in month
    const [rows] = await connection.execute(
      `SELECT tgl_presensi, jam_in, jam_out FROM presensi WHERE nik = ? AND tgl_presensi BETWEEN ? AND ? ORDER BY tgl_presensi ASC`,
      [nik, startDate, endDate]
    );
    return rows;
  } catch (error) {
    console.error('Error getMonthlyAttendance:', error);
    return [];
  } finally {
    if (connection) await connection.end();
  }
}

async function getMonthlyLeave(nik, month, year) {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-31`; // Simplified, consider actual days in month
    const [rows] = await connection.execute(
      `SELECT tgl_izin, status, keterangan, status_approved FROM pengajuan_izin WHERE nik = ? AND tgl_izin BETWEEN ? AND ? ORDER BY tgl_izin ASC`,
      [nik, startDate, endDate]
    );
    return rows;
  } catch (error) {
    console.error('Error getMonthlyLeave:', error);
    return [];
  } finally {
    if (connection) await connection.end();
  }
}

// === Mulai WhatsApp Client ===
async function startClient() {
  try {
    console.log('Menghubungkan ke WhatsApp...');
    loadStatus();  // <--- Restore data saat program dijalankan
    loadDailyGreetingStatus(); // Load daily greeting status
    await client.initialize();
  } catch (error) {
    console.error('Gagal initialize:', error);
    setTimeout(startClient, 10000);
  }
}

startClient();