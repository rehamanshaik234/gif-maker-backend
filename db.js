import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || '62.72.20.27',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'admin@12345',
  database: process.env.DB_NAME || 'giffmaker_ai',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

export const pool = mysql.createPool(dbConfig);

export async function initDatabase() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Connected to MySQL Database at ' + dbConfig.host);

    // Create Users table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        credits INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Create Generated GIFs table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS generated_gifs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        prompt TEXT NOT NULL,
        style VARCHAR(100) NULL,
        environment VARCHAR(100) NULL,
        action VARCHAR(100) NULL,
        gif_url VARCHAR(1000) NOT NULL,
        gif_no_watermark_url VARCHAR(1000) NULL,
        video_url VARCHAR(1000) NULL,
        video_no_watermark_url VARCHAR(1000) NULL,
        sticker_url VARCHAR(1000) NULL,
        sticker_no_watermark_url VARCHAR(1000) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Add extra columns if they don't exist yet on older tables
    const extraColumns = [
      'ADD COLUMN IF NOT EXISTS gif_no_watermark_url VARCHAR(1000) NULL',
      'ADD COLUMN IF NOT EXISTS video_no_watermark_url VARCHAR(1000) NULL',
      'ADD COLUMN IF NOT EXISTS sticker_no_watermark_url VARCHAR(1000) NULL'
    ];

    for (const col of extraColumns) {
      try {
        await connection.query(`ALTER TABLE generated_gifs ${col};`);
      } catch (colErr) {
        // In case MySQL version does not support IF NOT EXISTS in ALTER TABLE
        try {
          const colName = col.split(' ')[0] === 'ADD' && col.split(' ')[2] === 'IF' ? col.split(' ')[5] : col.split(' ')[2];
          await connection.query(`ALTER TABLE generated_gifs ADD COLUMN ${col.replace('IF NOT EXISTS', '')};`);
        } catch (ignored) {}
      }
    }

    console.log('✅ MySQL tables initialized successfully');
    connection.release();
  } catch (error) {
    console.error('❌ Failed to initialize MySQL Database:', error);
  }
}
