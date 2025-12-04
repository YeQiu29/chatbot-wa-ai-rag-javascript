// sidang.js (LENGKAP dengan Performance Logging ke log.txt)
// Pastikan node version kompatibel dengan semua library yang kamu gunakan

// Polyfill (jika diperlukan untuk canvas DOMMatrix)
if (typeof global.DOMMatrix === 'undefined') {
  try {
    global.DOMMatrix = require('canvas').DOMMatrix;
  } catch (e) {
    console.warn('canvas DOMMatrix polyfill tidak tersedia:', e.message);
  }
}

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const moment = require('moment-timezone');
// [PENTING] Import library performance
const { performance } = require('perf_hooks');

moment.tz.setDefault('Asia/Jakarta');

// ========== Konfigurasi ==========
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'asdzxc123qwe', // isi sesuai environmentmu
  database: 'presensigps'
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_URL = GEMINI_API_KEY
  ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`
  : null;

// [BARU] Konfigurasi File Log
const LOG_FILE = path.join(__dirname, 'log.txt');

// ========== Global state ==========
let db; // koneksi pooled/connection
const repliedMessages = new Set(); // mencegah balasan ganda untuk message id
let pdfText = ''; // seluruh teks dari folder rag untuk RAG
// Cache untuk menghindari notifikasi berulang di runtime (reset setiap hari)
const sentNotificationsCache = new Set();

// ========== Helper: Logger ==========
// [BARU] Fungsi untuk mencatat log ke console DAN file log.txt
function logPerformance(message) {
  // 1. Tampilkan di console agar tetap bisa dipantau realtime
  console.log(message);

  // 2. Tulis ke file log.txt
  const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
  const logLine = `[${timestamp}] ${message}\n`;

  fs.appendFile(LOG_FILE, logLine, (err) => {
    if (err) console.error('Gagal menulis ke log.txt:', err.message);
  });
}

// ========== Helper: koneksi DB ==========
async function initDb() {
  try {
    db = await mysql.createPool({ ...dbConfig, waitForConnections: true, connectionLimit: 10, queueLimit: 0 });
    console.log('✅ Terhubung ke MySQL (pool).');
  } catch (err) {
    console.error('Gagal konek ke MySQL:', err.message);
    process.exit(1);
  }
}

// ========== Helper: load semua PDF di folder rag ==========
async function loadAllPdfs() {
  try {
    const folderPath = path.join(__dirname, 'rag');
    if (!fs.existsSync(folderPath)) {
      console.warn('Folder rag tidak ditemukan, melewati ekstraksi PDF.');
      pdfText = '';
      return;
    }
    const files = fs.readdirSync(folderPath).filter(f => f.toLowerCase().endsWith('.pdf'));
    let allText = '';
    for (const file of files) {
      try {
        const dataBuffer = fs.readFileSync(path.join(folderPath, file));
        const data = await pdfParse(dataBuffer);
        allText += data.text + '\n';
        console.log(`✅ PDF ${file} berhasil diekstrak`);
      } catch (err) {
        console.warn(`Gagal ekstrak PDF ${file}:`, err.message);
      }
    }
    pdfText = allText.trim();
    if (!pdfText) console.log('Info: Tidak ada teks PDF ditemukan di folder rag.');
  } catch (err) {
    console.error('loadAllPdfs error:', err.message);
  }
}

// ========== Helper: Gemini with RAG context (Measured) ==========
async function askGeminiWithContext(question) {
  // [TIMER START]
  const startAI = performance.now(); 

  if (!GEMINI_API_URL) return 'Fitur AI (Gemini) belum dikonfigurasi.';
  if (!pdfText || pdfText.trim() === '') return 'Maaf, data referensi dokumen tidak tersedia.';

  const prompt = `Anda adalah asisten AI untuk PT. Djemoendo. Jawab pertanyaan berikut secara akurat dan hanya berdasarkan dokumen yang disediakan. Jika jawaban tidak ada di dalam dokumen, katakan "Maaf, saya tidak dapat menemukan informasi tersebut dalam dokumen."

Dokumen:
${pdfText}

Pertanyaan: ${question}`;

  try {
    const response = await axios.post(GEMINI_API_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    }, { timeout: 20000 });

    // [TIMER END]
    const endAI = performance.now();
    const duration = ((endAI - startAI) / 1000).toFixed(4);
    
    // Log ke file
    logPerformance(`⏱️ [PERF] Gemini Inference Time: ${duration} seconds`);

    return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Maaf, saya tidak bisa menjawab pertanyaan Anda.';
  } catch (error) {
    console.error('Error Gemini:', error.message || error);
    return 'Maaf, terjadi kesalahan pada sistem AI.';
  }
}

// ========== Helper: normalisasi & pencarian karyawan (Measured) ==========
async function getEmployeeByPhoneNumber(rawPhone) {
  const startDB = performance.now(); // [TIMER START]

  let connection;
  try {
    connection = await db.getConnection();
    console.log('getEmployeeByPhoneNumber: Incoming phoneNumber:', rawPhone);
    let cleaned = String(rawPhone).replace('@c.us', '').replace(/\D/g, ''); 
    console.log('getEmployeeByPhoneNumber: Cleaned digits:', cleaned);

    let plain = cleaned;
    if (plain.startsWith('0')) {
      plain = '62' + plain.slice(1);
    }
    if (!plain.startsWith('62')) {
      if (plain.length >= 9 && plain.length <= 13) {
        plain = '62' + plain;
      }
    }
    const localFormat = plain.replace(/^62/, '0');
    const plusFormat = '+' + plain;
    console.log('Search variations:', { plain, localFormat, plusFormat });

    const query = `SELECT nik, nama_lengkap, no_hp
FROM karyawan
WHERE REPLACE(REPLACE(REPLACE(no_hp, '+', ''), ' ', ''), '-', '') IN (?, ?, ?)
LIMIT 1`;
    const [rows] = await connection.execute(query, [plain, localFormat, plusFormat]);
    console.log('getEmployeeByPhoneNumber: Query result rows:', rows);
    
    // [TIMER END] Opsional: Log waktu pencarian karyawan (jika ingin di log ke file, uncomment bawah ini)
    // const endDB = performance.now();
    // logPerformance(`⏱️ [PERF] Employee Lookup DB Time: ${((endDB - startDB)/1000).toFixed(4)}s`);

    return rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.error('Error getEmployeeByPhoneNumber:', err.message || err);
    return null;
  } finally {
    if (connection) connection.release();
  }
}

// ========== Helper: hasBeenGreetedToday (DB last_greeting) ==========
async function hasBeenGreetedToday(rawPhone) {
  let connection;
  try {
    connection = await db.getConnection();
    const phoneKey = String(rawPhone).replace('@c.us', '').replace(/\D/g, '');
    const today = moment().format('YYYY-MM-DD');

    const [rows] = await connection.execute('SELECT last_date FROM last_greeting WHERE phone = ?', [phoneKey]);
    if (rows.length > 0 && rows[0].last_date && moment(rows[0].last_date).format('YYYY-MM-DD') === today) {
      return true;
    }

    await connection.execute('REPLACE INTO last_greeting (phone, last_date) VALUES (?, ?)', [phoneKey, today]);
    return false;
  } catch (err) {
    console.error('hasBeenGreetedToday error:', err.message || err);
    return false;
  } finally {
    if (connection) connection.release();
  }
}

// ========== Helper: Format nomor untuk pengiriman WA ==========
function formatPhoneNumberForWhatsApp(phone) {
  if (!phone) return phone;
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
  if (!cleaned.startsWith('62')) cleaned = '62' + cleaned;
  return cleaned + '@c.us';
}

// ========== Helper: Kirim pesan WA (Measured) ==========
async function sendWhatsAppMessage(client, phone, message, typeLabel = 'General') {
  const startSend = performance.now(); // [TIMER START]
  try {
    await client.sendMessage(phone, message);
    
    // [TIMER END]
    const endSend = performance.now();
    const duration = ((endSend - startSend) / 1000).toFixed(4);
    
    // Log ke file
    logPerformance(`⏱️ [PERF] WA Send Time (${typeLabel}) to ${phone}: ${duration} seconds`);

    return true;
  } catch (err) {
    console.error(`Gagal mengirim ke ${phone}:`, err.message || err);
    return false;
  }
}

// ========== Fungsi Attendance queries (Measured) ==========
async function getMonthlyAttendance(nik, month, year) {
  const start = performance.now(); // [TIMER START]
  let connection;
  try {
    connection = await db.getConnection();
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
    const [rows] = await connection.execute(
      `SELECT tgl_presensi, jam_in, jam_out FROM presensi WHERE nik = ? AND tgl_presensi BETWEEN ? AND ? ORDER BY tgl_presensi ASC`,
      [nik, startDate, endDate]
    );

    const end = performance.now(); // [TIMER END]
    // Log ke file
    logPerformance(`⏱️ [PERF] DB Query Absensi: ${((end - start)/1000).toFixed(4)}s`);

    return rows;
  } catch (err) {
    console.error('getMonthlyAttendance error:', err.message || err);
    return [];
  } finally {
    if (connection) connection.release();
  }
}

async function getMonthlyLeave(nik, month, year) {
  const start = performance.now(); // [TIMER START]
  let connection;
  try {
    connection = await db.getConnection();
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
    const [rows] = await connection.execute(
      `SELECT tgl_izin, status, keterangan, status_approved FROM pengajuan_izin WHERE nik = ? AND tgl_izin BETWEEN ? AND ? ORDER BY tgl_izin ASC`,
      [nik, startDate, endDate]
    );
    
    const end = performance.now(); // [TIMER END]
    // Log ke file
    logPerformance(`⏱️ [PERF] DB Query Cuti: ${((end - start)/1000).toFixed(4)}s`);

    return rows;
  } catch (err) {
    console.error('getMonthlyLeave error:', err.message || err);
    return [];
  } finally {
    if (connection) connection.release();
  }
}

// === Fungsi Ambil Data Izin/Sakit Bulan Ini (Measured) ===
async function getMonthlyIzin(nik, month, year) {
  const start = performance.now(); // [TIMER START]
  let connection;
  try {
    connection = await db.getConnection();
    const [rows] = await connection.execute(`
      SELECT tgl_izin, status, keterangan, status_approved
      FROM pengajuan_izin
      WHERE nik = ?
        AND MONTH(tgl_izin) = ?
        AND YEAR(tgl_izin) = ?
      ORDER BY tgl_izin ASC
    `, [nik, month, year]);

    const end = performance.now(); // [TIMER END]
    // Log ke file
    logPerformance(`⏱️ [PERF] DB Query Izin/Sakit: ${((end - start)/1000).toFixed(4)}s`);

    return rows;
  } catch (error) {
    console.error('Error saat mengambil data izin/sakit:', error.message || error);
    return [];
  } finally {
    if (connection) connection.release();
  }
}

// ========== Cron Job: Check In (Measured) ==========
async function checkNewCheckIns(client) {
  const jobStart = performance.now(); // 1. Start Job Timer
  let connection;
  try {
    connection = await db.getConnection();
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    const [rows] = await connection.execute(
      `SELECT k.nik, k.nama_lengkap, k.no_hp, p.jam_in
FROM presensi p
JOIN karyawan k ON p.nik = k.nik
WHERE p.tgl_presensi = ?
AND p.jam_in IS NOT NULL
AND p.jam_out IS NULL
AND k.no_hp IS NOT NULL AND k.no_hp != ''
AND p.jam_in >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)`,
      [today]
    );

    // 2. Log Waktu Query DB
    const dbTime = ((performance.now() - jobStart) / 1000).toFixed(4);
    if(rows.length > 0) logPerformance(`⏱️ [PERF] Cron CheckIn DB Query: ${dbTime}s found ${rows.length} rows`);

    for (const row of rows) {
      const key = `${today}_${row.nik}_checkin`;
      if (!sentNotificationsCache.has(key)) {
        const noHp = formatPhoneNumberForWhatsApp(row.no_hp);
        const message = `Hai ${row.nama_lengkap},\n\nWajah Teridentifikasi, Absensi Berhasil. Selamat Bekerja!`;
        
        // 3. Kirim WA dengan label 'Cron CheckIn' untuk timer
        await sendWhatsAppMessage(client, noHp, message, 'Cron CheckIn');
        
        sentNotificationsCache.add(key);
      }
    }
  } catch (err) {
    console.error('checkNewCheckIns error:', err.message || err);
  } finally {
    if (connection) connection.release();
  }
}

// ========== Cron Job: Check Out (Measured) ==========
async function checkNewCheckOuts(client) {
  const jobStart = performance.now(); // 1. Start Job Timer
  let connection;
  try {
    connection = await db.getConnection();
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    const [rows] = await connection.execute(
      `SELECT k.nik, k.nama_lengkap, k.no_hp, p.jam_out
FROM presensi p
JOIN karyawan k ON p.nik = k.nik
WHERE p.tgl_presensi = ?
AND p.jam_out IS NOT NULL
AND p.jam_out >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
AND k.no_hp IS NOT NULL AND k.no_hp != ''`,
      [today]
    );

    // 2. Log Waktu Query DB
    const dbTime = ((performance.now() - jobStart) / 1000).toFixed(4);
    if(rows.length > 0) logPerformance(`⏱️ [PERF] Cron CheckOut DB Query took ${dbTime}s`);

    for (const row of rows) {
      const key = `${today}_${row.nik}_checkout`;
      if (!sentNotificationsCache.has(key)) {
        const noHp = formatPhoneNumberForWhatsApp(row.no_hp);
        const message = `Hai ${row.nama_lengkap},\n\nWajah Teridentifikasi, Absensi Pulang Berhasil. Hati-hati di jalan!`;
        
        // 3. Kirim WA dengan label 'Cron CheckOut'
        await sendWhatsAppMessage(client, noHp, message, 'Cron CheckOut');
        
        sentNotificationsCache.add(key);
      }
    }
  } catch (err) {
    console.error('checkNewCheckOuts error:', err.message || err);
  } finally {
    if (connection) connection.release();
  }
}

// ========== Cron Job: Reminder Pagi (Measured) ==========
async function checkAndSendMorningReminders(client) {
  const jobStart = performance.now(); // 1. Start Job Timer
  let connection;
  try {
    connection = await db.getConnection();
    const today = new Date().toLocaleDateString('en-CA');
    const [rows] = await connection.execute(
      `SELECT k.nik, k.nama_lengkap, k.no_hp
FROM karyawan k
LEFT JOIN presensi p ON k.nik = p.nik AND p.tgl_presensi = ?
WHERE p.jam_in IS NULL
AND k.no_hp IS NOT NULL AND k.no_hp != ''`,
      [today]
    );

    // 2. Log Waktu Query DB
    const dbTime = ((performance.now() - jobStart) / 1000).toFixed(4);
    if(rows.length > 0) logPerformance(`⏱️ [PERF] Cron Morning Reminder DB Query took ${dbTime}s`);

    for (const row of rows) {
      const key = `${today}_${row.nik}_morning`;
      if (!sentNotificationsCache.has(key)) {
        const noHp = formatPhoneNumberForWhatsApp(row.no_hp);
        const message = `Hai ${row.nama_lengkap},\n\nAnda belum melakukan absensi masuk hari ini (${today}). Silahkan segera lakukan absensi jika Anda sedang bekerja. Jika Anda sedang tidak bekerja, harap hubungi HRD.\n\nTerima kasih.`;
        
        // 3. Kirim WA dengan label 'Morning Reminder'
        await sendWhatsAppMessage(client, noHp, message, 'Morning Reminder');
        
        sentNotificationsCache.add(key);
      }
    }
  } catch (err) {
    console.error('checkAndSendMorningReminders error:', err.message || err);
} finally {
    if (connection) connection.release();
  }
}

// ========== Cron Job: Reminder Sore (Measured) ==========
async function sendAfternoonReminders(client) {
  const jobStart = performance.now(); // 1. Start Job Timer
  let connection;
  try {
    connection = await db.getConnection();
    const today = new Date().toLocaleDateString('en-CA');
    const [rows] = await connection.execute(
      `SELECT k.nik, k.nama_lengkap, k.no_hp
FROM presensi p
JOIN karyawan k ON p.nik = k.nik
WHERE p.tgl_presensi = ?
AND p.jam_in IS NOT NULL
AND p.jam_out IS NULL
AND k.no_hp IS NOT NULL AND k.no_hp != ''`,
      [today]
    );

    // 2. Log Waktu Query DB
    const dbTime = ((performance.now() - jobStart) / 1000).toFixed(4);
    if(rows.length > 0) logPerformance(`⏱️ [PERF] Cron Afternoon Reminder DB Query took ${dbTime}s`);

    for (const row of rows) {
      const key = `${today}_${row.nik}_afternoon`;
      if (!sentNotificationsCache.has(key)) {
        const noHp = formatPhoneNumberForWhatsApp(row.no_hp);
        const message = `Selamat sore ${row.nama_lengkap},\n\nJangan lupa absen pulang ya. Dan hati-hati di jalan!`;
        
        // 3. Kirim WA dengan label 'Afternoon Reminder'
        await sendWhatsAppMessage(client, noHp, message, 'Afternoon Reminder');
        
        sentNotificationsCache.add(key);
      }
    }
  } catch (err) {
    console.error('sendAfternoonReminders error:', err.message || err);
  } finally {
    if (connection) connection.release();
  }
}

// ========== Inisialisasi Client WhatsApp ==========
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
  },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 30000,
});

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('📱 Scan QR code untuk login WhatsApp Web');
});
client.on('authenticated', () => console.log('✅ AUTHENTICATED'));
client.on('auth_failure', msg => console.error('AUTHENTICATION FAILURE:', msg));
client.on('disconnected', reason => {
  console.log('Client disconnected:', reason);
  // coba inisialisasi ulang
  setTimeout(() => client.initialize(), 5000);
});
client.on('ready', () => {
  console.log('✅ WhatsApp client ready!');
  // start cron jobs setelah client siap
  startCronJobs();
});

// ========== Handler Pesan Masuk (Measured End-to-End) ==========
client.on('message', async (msg) => {
  // [TIMER START] Start Timer tepat saat pesan masuk
  const msgStart = performance.now(); 

  try {
    console.log('Pesan masuk:', msg.body);
    console.log('Sender:', msg.from);

    // Cegah balasan ganda untuk message id yang sama
    if (msg.id && repliedMessages.has(msg.id._serialized)) {
      console.log('Pesan sudah pernah dibalas, dilewati.');
      return;
    }

    // Skip pesan grup
    if (msg.from && msg.from.endsWith('@g.us')) {
      console.log('Pesan dari grup, dilewati.');
      return;
    }

    // Skip pesan dari bot sendiri
    if (msg.fromMe) {
      console.log('Pesan dari bot sendiri, dilewati.');
      return;
    }

    const senderPhone = msg.from; // biasanya '628xx...@c.us'
    const employee = await getEmployeeByPhoneNumber(senderPhone);
    console.log('Employee lookup result:', employee);

    if (!employee) {
      // fallback: jika bukan karyawan, tanya ke Gemini (jika ada) atau beri pesan
      if (msg.body && msg.body.length > 1) {
        const jawaban = await askGeminiWithContext(msg.body);
        await msg.reply(jawaban);
      } else {
        await msg.reply('Nomor kamu belum terdaftar di sistem.');
      }
      
      // Update cache
      if (msg.id) repliedMessages.add(msg.id._serialized);

      // [TIMER END] Log Total Waktu (User Tidak Terdaftar)
      const msgEnd = performance.now();
      const totalDuration = ((msgEnd - msgStart) / 1000).toFixed(4);
      
      // Log ke file
      logPerformance(`⏱️ [PERF] Total End-to-End Response Time (Non-Employee): ${totalDuration} seconds`);
      console.log(`-------------------------------------------`);
      return;
    }

    // jika karyawan terdaftar -> sapa sekali per hari (first interaction any text)
    const greeted = await hasBeenGreetedToday(senderPhone);
    if (!greeted) {
      const greetingMessage = `Halo ${employee.nama_lengkap}! 👋\n\nAda yang bisa saya bantu hari ini?\n\nAnda bisa menanyakan:\n- Absensi bulan ini: /infoabsensi_bulanini\n- Cuti/Sakit bulan ini: /infosakit_cutibulanini`;
      await msg.reply(greetingMessage);
      if (msg.id) repliedMessages.add(msg.id._serialized);
      
      // [TIMER END] Log Total Waktu (Greeting)
      const msgEnd = performance.now();
      const totalDuration = ((msgEnd - msgStart) / 1000).toFixed(4);
      
      // Log ke file
      logPerformance(`⏱️ [PERF] Total End-to-End Response Time (Greeting): ${totalDuration} seconds`);
      console.log(`-------------------------------------------`);
      return; 
    }

    // Handle commands
    const text = (msg.body || '').toString().trim();

    if (text === '/infoabsensi_bulanini') {
        const currentMonth = new Date().getMonth() + 1;
        const currentYear = new Date().getFullYear();
        const attendanceData = await getMonthlyAttendance(employee.nik, currentMonth, currentYear);

        let responseMessage = `*📅 Absensi ${employee.nama_lengkap} Bulan Ini (${currentMonth}/${currentYear}):*\n\n`;

        if (attendanceData.length > 0) {
            let totalKehadiran = 0;
            let totalTerlambat = 0;

            attendanceData.forEach(record => {
            const date = new Date(record.tgl_presensi).toLocaleDateString('id-ID', {
                day: '2-digit',
                month: '2-digit'
            });

            const jamIn = record.jam_in ? record.jam_in.toString().trim().substring(0, 5) : '-';
            const jamOut = record.jam_out ? record.jam_out.toString().trim().substring(0, 5) : '-';

            // Hitung kehadiran
            if (record.jam_in) totalKehadiran++;

            // Hitung keterlambatan (jika jam_in lewat dari 07:00)
            if (record.jam_in && record.jam_in > '07:00') totalTerlambat++;

            responseMessage += `🗓️ *Tanggal:* ${date}\n⏰ *Masuk:* ${jamIn}\n🏁 *Pulang:* ${jamOut}\n\n`;
            });

            responseMessage += `📊 *Total Kehadiran:* ${totalKehadiran} hari\n`;
            responseMessage += `⚠️ *Total Terlambat:* ${totalTerlambat} kali`;
        } else {
            responseMessage += 'Tidak ada data absensi untuk bulan ini.';
        }

        await msg.reply(responseMessage);
        if (msg.id) repliedMessages.add(msg.id._serialized);
        
        // [TIMER END] Log Total Waktu (Command Absensi)
        const msgEnd = performance.now();
        
        // Log ke file
        logPerformance(`⏱️ [PERF] Total End-to-End Response Time (Command Absensi): ${((msgEnd - msgStart) / 1000).toFixed(4)} seconds`);
        console.log(`-------------------------------------------`);
        return;
    }

    if (text === '/infosakit_cutibulanini') {
        const currentMonth = new Date().getMonth() + 1;
        const currentYear = new Date().getFullYear();
        const izinData = await getMonthlyIzin(employee.nik, currentMonth, currentYear);

        let responseMessage = `*Informasi Cuti/Sakit ${employee.nama_lengkap}*\n*Bulan Ini (${new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })})*\n\n`;

        if (izinData.length > 0) {
            izinData.forEach(record => {
            const tanggal = new Date(record.tgl_izin).toLocaleDateString('id-ID', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            });

            // 🟢 Konversi kode ke teks
            const jenis = record.status === 'i' ? 'Izin' : record.status === 's' ? 'Sakit' : '-';
            const statusMap = { 0: 'Pending', 1: 'Approved', 2: 'Rejected' };
            const statusText = statusMap[record.status_approved] || 'Tidak Diketahui';

            responseMessage += `📅 *Tanggal:* ${tanggal}\n🩺 *Jenis:* ${jenis}\n📝 *Keterangan:* ${record.keterangan}\n✅ *Status:* ${statusText}\n\n`;
            });
        } else {
            responseMessage += '_Tidak ada data cuti/sakit untuk bulan ini._';
        }

        await msg.reply(responseMessage.trim());
        if (msg.id) repliedMessages.add(msg.id._serialized);

        // [TIMER END] Log Total Waktu (Command Sakit)
        const msgEnd = performance.now();
        
        // Log ke file
        logPerformance(`⏱️ [PERF] Total End-to-End Response Time (Command Izin/Sakit): ${((msgEnd - msgStart) / 1000).toFixed(4)} seconds`);
        console.log(`-------------------------------------------`);
        return;
    }

    // Jika bukan command di atas -> fallback ke Gemini (jika tersedia) atau pesan default
    if (text && text.length > 1) {
      const jawaban = await askGeminiWithContext(text);
      await msg.reply(jawaban);
      if (msg.id) repliedMessages.add(msg.id._serialized);

      // [TIMER END] Log Total Waktu (Gemini Response)
      const msgEnd = performance.now();
      
      // Log ke file
      logPerformance(`⏱️ [PERF] Total End-to-End Response Time (AI Chat): ${((msgEnd - msgStart) / 1000).toFixed(4)} seconds`);
      console.log(`-------------------------------------------`);
      return;
    } else {
      await msg.reply('Maaf, saya tidak dapat menemukan informasi tersebut dalam dokumen.');
      if (msg.id) repliedMessages.add(msg.id._serialized);

      // [TIMER END] Log Total Waktu (Default Fallback)
      const msgEnd = performance.now();
      
      // Log ke file
      logPerformance(`⏱️ [PERF] Total End-to-End Response Time (Default): ${((msgEnd - msgStart) / 1000).toFixed(4)} seconds`);
      console.log(`-------------------------------------------`);
      return;
    }

  } catch (err) {
    console.error('Error di handler message:', err.message || err);
}
});

// ========== Cron jobs ==========
function startCronJobs() {
  // reset daily cache and repliedMessages set at midnight
  cron.schedule('0 0 * * *', () => {
    sentNotificationsCache.clear();
    repliedMessages.clear();
    console.log('Reset daily caches: sentNotificationsCache & repliedMessages.');
 }, { timezone: 'Asia/Jakarta' });

  // Cek absensi setiap 2 menit antara jam 06-20
  cron.schedule('*/2 6-20 * * *', async () => {
    console.log('Cron: Memeriksa absensi baru...');
    await checkNewCheckIns(client);
    await checkNewCheckOuts(client);
  }, { timezone: 'Asia/Jakarta' });

  // Reminder pagi (07:00) Senin-Jumat
  cron.schedule('0 7 * * 1-5', async () => {
    console.log('Cron: Pengingat pagi (07:00)');
    await checkAndSendMorningReminders(client);
  }, { timezone: 'Asia/Jakarta' });

  // Reminder sore (17:00) Senin-Jumat
  cron.schedule('0 17 * * 1-5', async () => {
    console.log('Cron: Pengingat sore (17:00)');
    await sendAfternoonReminders(client);
  }, { timezone: 'Asia/Jakarta' });
}

// ========== Start everything ==========
(async () => {
  await initDb();
  await loadAllPdfs();
  // start client
  client.initialize();
})();