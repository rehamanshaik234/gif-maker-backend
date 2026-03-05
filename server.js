import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import { exec } from "child_process";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const BASE_FRAMES_DIR = "./frames";
const OUTPUT_DIR = "./output";

import multer from "multer";

if (!fs.existsSync(BASE_FRAMES_DIR)) fs.mkdirSync(BASE_FRAMES_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

/**
 * Solution: Use Stability AI's image-to-image for consistent frames
 */
// RECOMMENDED: Use Replicate API with Stable Diffusion img2img
// Install: npm install replicate
import Replicate from "replicate";
const upload = multer({ dest: 'uploads/' });

app.post("/generate-gif", upload.single('image'), async (req, res) => {
  try {
    // Generate timestamp-based frames directory
    const dateTime = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
    const FRAMES_DIR = path.join(BASE_FRAMES_DIR, dateTime);

    // Extract required and optional parameters
    const basePrompt = req.body.prompt;
    const environment = req.body.environment; // optional: Gym, Fire, City, Space, etc.
    const style = req.body.style; // optional: cartoon, anime, realistic, etc.
    const action = req.body.action; // optional: running, kicking, flying, etc.
    const uploadedImage = req.file;

    // Validate mandatory parameters
    if (!basePrompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    if (!uploadedImage) {
      return res.status(400).json({ error: "No image file uploaded" });
    }

    // Build enhanced prompt based on optional parameters
    let enhancedPrompt = basePrompt;
    
    if (action) {
      enhancedPrompt += `, the subject is ${action}`;
    }
    
    if (style) {
      enhancedPrompt += `, in ${style} style`;
    }
    
    if (environment) {
      enhancedPrompt += `, set in a ${environment} environment`;
    }

    // Add smooth motion guidance if not already in base prompt
    if (!enhancedPrompt.toLowerCase().includes("smooth")) {
      enhancedPrompt += ", with smooth and fluid motion";
    }

    console.log(`📝 Enhanced prompt: ${enhancedPrompt}`);
    const userPrompt = enhancedPrompt;

    // Clean old frames
    if (fs.existsSync(FRAMES_DIR)) {
      fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(FRAMES_DIR, { recursive: true });

    console.log("📤 Converting uploaded image to base64...");

    // Read uploaded image and convert to data URI
    const imageBuffer = fs.readFileSync(uploadedImage.path);
    const imageBase64 = imageBuffer.toString('base64');
    const mimeType = uploadedImage.mimetype || 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${imageBase64}`;

    console.log("🎬 Generating video from image...");

    // Generate video from image using RunwayML
    const videoGenResponse = await axios.post(
      "https://api.dev.runwayml.com/v1/image_to_video",
      {
        model: "gen4_turbo", // Options: gen4_turbo, veo3.1, gen3a_turbo, veo3.1_fast, veo3
        promptImage: dataUri, // Data URI of uploaded image
        promptText: userPrompt, // Optional: guide the motion
        ratio: "1280:720", // Options: 1280:720, 720:1280, 1104:832, 832:1104, 960:960, 1584:672
        duration: 5, // 2-10 seconds
        seed: Math.floor(Math.random() * 4294967295)
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.RUNWAY_API_KEY}`,
          "X-Runway-Version": "2024-11-06"
        }
      }
    );

    const videoTaskId = videoGenResponse.data.id;
    console.log(`📹 Video generation task: ${videoTaskId}`);

    // Clean up uploaded file
    fs.unlinkSync(uploadedImage.path);

    // Poll for video completion
    let videoUrl = null;
    let attempts = 0;
    const maxVideoAttempts = 60;

    while (!videoUrl && attempts < maxVideoAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000));

      const videoStatusResponse = await axios.get(
        `https://api.dev.runwayml.com/v1/tasks/${videoTaskId}`,
        {
          headers: {
            "Authorization": `Bearer ${process.env.RUNWAY_API_KEY}`,
            "X-Runway-Version": "2024-11-06"
          }
        }
      );

      const status = videoStatusResponse.data.status;
      console.log(`⏳ Video status: ${status}`);

      if (status === "SUCCEEDED") {
        const output = videoStatusResponse.data.output;
        videoUrl = output[0]?.url || output[0];
        console.log(`🎥 Video URL: ${videoUrl}`);
        break;
      } else if (status === "FAILED") {
        const failureReason = videoStatusResponse.data.failure || "Unknown reason";
        throw new Error(`Video generation failed: ${failureReason}`);
      }

      attempts++;
    }

    if (!videoUrl) {
      throw new Error("Video generation timed out");
    }

    console.log("✅ Video generated successfully!");
    console.log("📥 Downloading video...");

    // Download the video
    const videoResponse = await axios.get(videoUrl, {
      responseType: 'arraybuffer'
    });
    
    const videoPath = path.join(OUTPUT_DIR, 'temp_video.mp4');
    fs.writeFileSync(videoPath, Buffer.from(videoResponse.data));

    console.log("📸 Extracting frames...");

    // Extract frames using ffmpeg
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -i ${videoPath} -vf fps=10 ${FRAMES_DIR}/frame_%03d.png`,
        (error, stdout, stderr) => {
          if (error) {
            console.error("FFmpeg extraction error:", stderr);
            reject(error);
          } else {
            console.log("✅ Frames extracted");
            resolve();
          }
        }
      );
    });

    // Clean up temp video
    fs.unlinkSync(videoPath);

    console.log("🎬 Creating GIF...");

    const outputGif = path.join(OUTPUT_DIR, `animation_${Date.now()}.gif`);

    exec(
      `ffmpeg -y -framerate 10 -pattern_type glob -i '${FRAMES_DIR}/frame_*.png' \
      -vf "split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" \
      -loop 0 ${outputGif}`,
      (error, stdout, stderr) => {
        if (error) {
          console.error("FFmpeg error:", stderr);
          return res.status(500).json({ error: "GIF generation failed" });
        }

        console.log("✨ GIF created successfully!");

        // Delete frames folder after successful GIF generation
        if (fs.existsSync(FRAMES_DIR)) {
          fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
          console.log("🗑️ Frames folder deleted");
        }

        const gifBuffer = fs.readFileSync(outputGif);

        // convert to base64
        const base64Gif = gifBuffer.toString("base64");

        // optional: add data URI prefix
        const base64Data = `data:image/gif;base64,${base64Gif}`;

        // delete the gif file after reading
        fs.unlinkSync(outputGif);

        res.json({
          success: true,
          message: "Pipeline executed: Image Upload → Video → GIF",
          gif_base64: base64Data,
          generated_video: videoUrl
        });

      }
    );

  } catch (err) {
    console.error("Server error:", err);
    
    // Clean up uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: "Server error", 
      details: err.response?.data || err.message 
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 AI GIF server running on port ${PORT}`);
});