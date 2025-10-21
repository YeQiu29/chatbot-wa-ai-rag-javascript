const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const cron = require('node-cron');

// Konfigurasi database (sesuaikan dengan milik Anda)
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'asdzxc123qwe',
  database: 'presensigps'
};

// Inisialisasi WhatsApp Client
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
    takeoverOnconflict: true,
    takeoverTimeoutMs: 30000
});

// QR Code untuk login WhatsApp
client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
});

// Ketika WhatsApp sudah siap
client.on('ready', () => {
  console.log('Client is ready!');
  startCronJob();
});

// Jadwalkan pengecekan setiap hari kerja jam 10:41 WIB
function startCronJob() {
  // Jalankan Senin-Jumat jam 10:41 WIB (GMT+7)
  cron.schedule('05 16 * * 1-5', async () => {
    console.log('Memeriksa karyawan yang belum absen...');
    await checkAndSendReminders();
  }, {
    scheduled: true,
    timezone: "Asia/Jakarta" // WIB timezone
  });
}

async function checkAndSendReminders() {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    
    const today = new Date().toLocaleDateString('en-CA'); // Format YYYY-MM-DD
    
    // Query untuk mendapatkan karyawan yang belum absen sama sekali hari ini
    const [rows] = await connection.execute(`
      SELECT k.nik, k.nama_lengkap, k.no_hp
      FROM karyawan k
      LEFT JOIN presensi p ON k.nik = p.nik AND p.tgl_presensi = ?
      WHERE p.jam_in IS NULL
      AND k.no_hp IS NOT NULL
      AND k.no_hp != ''
    `, [today]);
    
    console.log(`Menemukan ${rows.length} karyawan yang belum absen`);
    
    for (const row of rows) {
      const nama = row.nama_lengkap;
      const noHp = formatPhoneNumber(row.no_hp);
      
      const message = `Hai ${nama},\n\nAnda belum melakukan absensi masuk hari ini (${today}). ` +
        `Silakan segera lakukan absensi jika Anda sedang bekerja. ` +
        `Jika Anda sedang tidak bekerja, harap hubungi HRD.\n\n` +
        `Terima kasih.`;
      
      await sendWhatsAppMessage(noHp, message);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    if (connection) await connection.end();
  }
}

// Format nomor HP ke format WhatsApp
function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\D/g, '');
  
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.substring(1);
  }
  
  if (!cleaned.startsWith('62')) {
    cleaned = '62' + cleaned;
  }
  
  return cleaned + '@c.us';
}

// Fungsi pengiriman pesan WhatsApp
async function sendWhatsAppMessage(phone, message) {
  try {
    await client.sendMessage(phone, message);
    console.log(`Pesan terkirim ke ${phone}`);
  } catch (error) {
    console.error(`Gagal mengirim ke ${phone}:`, error.message);
  }
}

// Handle error
client.on('auth_failure', msg => {
  console.error('Autentikasi gagal:', msg);
});

client.on('disconnected', reason => {
  console.log('Client logged out:', reason);
  client.initialize(); // Coba login ulang
});

// Tambahkan delay sebelum initialize
async function startClient() {
  try {
    console.log('Menghubungkan ke WhatsApp...');
    await client.initialize();
  } catch (error) {
    console.error('Gagal initialize:', error);
    // Coba lagi setelah 5 detik
    setTimeout(startClient, 5000);
  }
}


// Mulai klien WhatsApp
// client.initialize()
startClient();
