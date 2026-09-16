import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import { exec } from "child_process";
import dotenv from "dotenv";
import multer from "multer";
import cors from "cors";

import { initDatabase, pool } from "./db.js";
import authRoutes, { optionalAuth } from "./routes/auth.js";
import gifRoutes from "./routes/gifs.js";

dotenv.config();

const app = express();

const BASE_FRAMES_DIR = path.resolve("./frames");
const OUTPUT_DIR = path.resolve("./output");
const UPLOADS_DIR = path.resolve("./uploads");

if (!fs.existsSync(BASE_FRAMES_DIR)) fs.mkdirSync(BASE_FRAMES_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({ dest: 'uploads/', limits: { fileSize: 200 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ limit: "200mb", extended: true }));

// Serve output files publicly
app.use("/output", express.static(OUTPUT_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));

// Initialize MySQL Database
initDatabase().catch(err => console.error("Database initialization warning:", err.message));

// Mount Routes
app.use("/api/auth", authRoutes);
app.use("/api/gifs", gifRoutes);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Helper function to execute shell commands
function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("FFmpeg error:", stderr || error.message);
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

// Generate GIF Endpoint
app.post("/generate-gif", upload.single("image"), optionalAuth, async (req, res) => {
  const startTime = Date.now();
  console.log("🚀 /generate-gif called");

  let uploadedImagePath = null;

  try {
    const { prompt, style, environment, action } = req.body;
    const uploadedImage = req.file;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt required" });
    }

    if (!uploadedImage) {
      return res.status(400).json({ error: "Image required" });
    }

    uploadedImagePath = uploadedImage.path;

    /* ------------------ PROMPT ENHANCEMENT ------------------ */
    let enhancedPrompt = prompt;

    if (action) {
      enhancedPrompt += `, the subject is actively ${action} with dynamic body movement`;
    }

    if (style) {
      enhancedPrompt += `, rendered in ${style} style`;
    }

    if (environment) {
      enhancedPrompt += `, scene takes place inside a ${environment}, background fully transformed into ${environment}`;
    }

    enhancedPrompt += ", cinematic lighting, smooth motion, dynamic camera movement, high detail";

    console.log("📝 Enhanced Prompt:", enhancedPrompt);

    /* ------------------ IMAGE → BASE64 ------------------ */
    const imageBuffer = fs.readFileSync(uploadedImage.path);
    const base64 = imageBuffer.toString("base64");
    const mime = uploadedImage.mimetype || "image/jpeg";
    const dataUri = `data:${mime};base64,${base64}`;

    console.log("🎬 Sending request to Runway");

    /* ------------------ RUNWAY VIDEO GENERATION ------------------ */
    const runwayResponse = await axios.post(
      "https://api.dev.runwayml.com/v1/image_to_video",
      {
        model: "gen4_turbo",
        promptImage: dataUri,
        promptText: enhancedPrompt.slice(0, 512),
        ratio: "1280:720",
        duration: 5
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`,
          "X-Runway-Version": "2024-11-06",
          "Content-Type": "application/json"
        }
      }
    );

    const taskId = runwayResponse.data.id;
    console.log("📌 Runway task:", taskId);

    /* ------------------ POLLING ------------------ */
    let videoUrl = null;

    while (!videoUrl) {
      await new Promise((r) => setTimeout(r, 5000));

      const status = await axios.get(
        `https://api.dev.runwayml.com/v1/tasks/${taskId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`,
            "X-Runway-Version": "2024-11-06"
          }
        }
      );

      console.log("📊 Status:", status.data.status);

      if (status.data.status === "SUCCEEDED") {
        const output = status.data.output;
        if (typeof output[0] === "string") {
          videoUrl = output[0];
        } else if (output[0]?.url) {
          videoUrl = output[0].url;
        }
      }

      if (status.data.status === "FAILED") {
        throw new Error("Runway video generation failed");
      }
    }

    console.log("🎥 Video URL:", videoUrl);

    /* ------------------ DOWNLOAD RAW VIDEO ------------------ */
    const videoResponse = await axios.get(videoUrl, {
      responseType: "arraybuffer"
    });

    const videoBuffer = Buffer.from(videoResponse.data);

    const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    // File names for both Clean and Watermarked versions
    const cleanVideoName = `video_${uniqueId}.mp4`;
    const watermarkedVideoName = `video_wm_${uniqueId}.mp4`;

    const cleanGifName = `gif_${uniqueId}.gif`;
    const watermarkedGifName = `gif_wm_${uniqueId}.gif`;

    const cleanWebpName = `sticker_${uniqueId}.webp`;
    const watermarkedWebpName = `sticker_wm_${uniqueId}.webp`;

    const cleanVideoPath = path.join(OUTPUT_DIR, cleanVideoName);
    const watermarkedVideoPath = path.join(OUTPUT_DIR, watermarkedVideoName);

    const cleanGifPath = path.join(OUTPUT_DIR, cleanGifName);
    const watermarkedGifPath = path.join(OUTPUT_DIR, watermarkedGifName);

    const cleanWebpPath = path.join(OUTPUT_DIR, cleanWebpName);
    const watermarkedWebpPath = path.join(OUTPUT_DIR, watermarkedWebpName);

    // Save initial clean raw video
    fs.writeFileSync(cleanVideoPath, videoBuffer);

    /* ------------------ FFMPEG: GENERATE WATERMARKED VIDEO ------------------ */
    // Watermark text: "GifMaker AI"
    const wmDrawtextVideo = "drawtext=text='GifMaker AI':fontsize=18:fontcolor=white@0.9:box=1:boxcolor=black@0.4:boxborderw=6:x=w-tw-15:y=h-th-15";
    const wmDrawtextGif = "drawtext=text='GifMaker AI':fontsize=16:fontcolor=white@0.9:box=1:boxcolor=black@0.4:boxborderw=6:x=w-tw-12:y=h-th-12";

    await runFfmpeg(`ffmpeg -y -i "${cleanVideoPath}" -vf "${wmDrawtextVideo}" -c:a copy "${watermarkedVideoPath}"`);

    /* ------------------ FFMPEG: GENERATE GIFS (CLEAN & WATERMARKED) ------------------ */
    // 1. Clean GIF
    await runFfmpeg(
      `ffmpeg -y -i "${cleanVideoPath}" -vf "fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" "${cleanGifPath}"`
    );

    // 2. Watermarked GIF
    await runFfmpeg(
      `ffmpeg -y -i "${cleanVideoPath}" -vf "${wmDrawtextGif},fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" "${watermarkedGifPath}"`
    );

    /* ------------------ FFMPEG: GENERATE WEBP STICKERS (CLEAN & WATERMARKED) ------------------ */
    // 1. Clean WebP
    await runFfmpeg(
      `ffmpeg -y -i "${cleanVideoPath}" -vf "fps=12,scale=512:512:flags=lanczos" -c:v libwebp -loop 0 "${cleanWebpPath}"`
    );

    // 2. Watermarked WebP
    await runFfmpeg(
      `ffmpeg -y -i "${cleanVideoPath}" -vf "${wmDrawtextGif},fps=12,scale=512:512:flags=lanczos" -c:v libwebp -loop 0 "${watermarkedWebpPath}"`
    );

    /* ------------------ READ BASE64 & BUILD URLS ------------------ */
    const cleanVideoBase64 = fs.readFileSync(cleanVideoPath).toString("base64");
    const wmVideoBase64 = fs.readFileSync(watermarkedVideoPath).toString("base64");

    const cleanGifBase64 = fs.readFileSync(cleanGifPath).toString("base64");
    const wmGifBase64 = fs.readFileSync(watermarkedGifPath).toString("base64");

    const cleanWebpBase64 = fs.readFileSync(cleanWebpPath).toString("base64");
    const wmWebpBase64 = fs.readFileSync(watermarkedWebpPath).toString("base64");

    const host = req.get("host") || `localhost:${PORT}`;
    const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const serverBaseUrl = `${protocol}://${host}`;

    const publicWatermarkedGifUrl = `${serverBaseUrl}/output/${watermarkedGifName}`;
    const publicCleanGifUrl = `${serverBaseUrl}/output/${cleanGifName}`;

    const publicWatermarkedVideoUrl = `${serverBaseUrl}/output/${watermarkedVideoName}`;
    const publicCleanVideoUrl = `${serverBaseUrl}/output/${cleanVideoName}`;

    const publicWatermarkedWebpUrl = `${serverBaseUrl}/output/${watermarkedWebpName}`;
    const publicCleanWebpUrl = `${serverBaseUrl}/output/${cleanWebpName}`;

    // Clean up uploaded image
    if (uploadedImagePath && fs.existsSync(uploadedImagePath)) {
      try { fs.unlinkSync(uploadedImagePath); } catch (e) {}
    }

    const userId = req.user?.id || req.body.user_id || null;

    // If user is authenticated / specified, save record into database
    if (userId) {
      try {
        await pool.query(
          `INSERT INTO generated_gifs 
            (user_id, prompt, style, environment, action, gif_url, gif_no_watermark_url, video_url, video_no_watermark_url, sticker_url, sticker_no_watermark_url) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            prompt,
            style || null,
            environment || null,
            action || null,
            publicWatermarkedGifUrl,
            publicCleanGifUrl,
            publicWatermarkedVideoUrl,
            publicCleanVideoUrl,
            publicWatermarkedWebpUrl,
            publicCleanWebpUrl
          ]
        );
        console.log(`💾 Saved GIF record to database for user ${userId}`);
      } catch (dbErr) {
        console.error("Database save record warning:", dbErr.message);
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`🏁 Completed in ${totalTime}s. Watermarked: ${publicWatermarkedGifUrl}, Clean: ${publicCleanGifUrl}`);

    /* ------------------ RESPONSE (DEFAULT WATERMARKED + CLEAN) ------------------ */
    res.json({
      success: true,
      generation_time_seconds: totalTime,
      // Default URLs
      gif_url: publicWatermarkedGifUrl,
      video_url: publicWatermarkedVideoUrl,
      sticker_url: publicWatermarkedWebpUrl,
      // Explicit Watermarked URLs
      gif_watermarked_url: publicWatermarkedGifUrl,
      video_watermarked_url: publicWatermarkedVideoUrl,
      sticker_watermarked_url: publicWatermarkedWebpUrl,
      // Clean / No-Watermark URLs
      gif_no_watermark_url: publicCleanGifUrl,
      video_no_watermark_url: publicCleanVideoUrl,
      sticker_no_watermark_url: publicCleanWebpUrl,
      // Base64 Outputs
      gif_base64: `data:image/gif;base64,${wmGifBase64}`, // default watermarked
      gif_watermarked_base64: `data:image/gif;base64,${wmGifBase64}`,
      gif_no_watermark_base64: `data:image/gif;base64,${cleanGifBase64}`,
      video_mp4_base64: `data:video/mp4;base64,${wmVideoBase64}`,
      video_no_watermark_base64: `data:video/mp4;base64,${cleanVideoBase64}`,
      sticker_webp_base64: `data:image/webp;base64,${wmWebpBase64}`,
      sticker_no_watermark_base64: `data:image/webp;base64,${cleanWebpBase64}`
    });

  } catch (err) {
    console.error("🔥 Error:", err.response?.data || err.message);

    if (uploadedImagePath && fs.existsSync(uploadedImagePath)) {
      try { fs.unlinkSync(uploadedImagePath); } catch (e) {}
    }

    res.status(500).json({
      error: "Generation failed",
      details: err.response?.data || err.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 AI GIF server running on port ${PORT}`);
});
