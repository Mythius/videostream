#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");

// Load configuration from root directory
const CONFIG_FILE = path.join(__dirname, "..", "config.json");
let config;

try {
  const rootConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  config = rootConfig;
  if (!config.videoDirectory) {
    console.error('Error: "videoDirectory" not found in config.json');
    process.exit(1);
  }
} catch (error) {
  console.error("Error loading config.json:", error.message);
  process.exit(1);
}

const videoDirectory = config.videoDirectory;
const imgsDirectory = path.join(__dirname, "..", "site", "imgs");

/**
 * Log message with timestamp
 */
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

/**
 * Get all MP4 files from video directory
 */
function getMP4Files() {
  if (!fs.existsSync(videoDirectory)) {
    log(`Video directory does not exist: ${videoDirectory}`);
    return [];
  }

  return fs
    .readdirSync(videoDirectory)
    .filter((f) => !f.startsWith("."))
    .filter((f) => f.toLowerCase().endsWith(".mp4"))
    .map((f) => f.replace(/\.mp4$/i, ""));
}

/**
 * Get existing thumbnails
 */
function getExistingThumbnails() {
  if (!fs.existsSync(imgsDirectory)) {
    log(`Creating imgs directory: ${imgsDirectory}`);
    fs.mkdirSync(imgsDirectory, { recursive: true });
    return [];
  }

  return fs
    .readdirSync(imgsDirectory)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .map((f) => f.replace(/\.png$/i, ""));
}

/**
 * Search for movie poster using custom API
 * API endpoint: moviedb.msouthwick.com
 * Returns the image URL directly (API serves the image itself)
 */
async function searchMoviePoster(movieTitle) {
  const apiUrl = `https://moviedb.msouthwick.com/poster?movie=${encodeURIComponent(
    movieTitle
  )}`;

  log(`Found poster for "${movieTitle}"`);
  return apiUrl;
}

/**
 * Download image from URL
 */
function downloadImage(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const tempFile = outputPath + ".tmp";

    protocol
      .get(url, (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          downloadImage(res.headers.location, outputPath)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const fileStream = fs.createWriteStream(tempFile);

        res.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close();
          fs.renameSync(tempFile, outputPath);
          resolve();
        });

        fileStream.on("error", (error) => {
          fs.unlinkSync(tempFile);
          reject(error);
        });
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

/**
 * Convert image to PNG with 2:3 aspect ratio (portrait) using ImageMagick/ffmpeg
 * Preserves the original aspect ratio without cropping
 */
async function convertAndCropImage(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Try using ImageMagick's convert command first
    // The poster images are typically portrait (2:3), we want to preserve that
    const convertArgs = [
      inputPath,
      "-resize",
      "600x900", // Resize to fit 2:3 ratio (600x900) while preserving aspect ratio
      outputPath,
    ];

    const convert = spawn("convert", convertArgs);

    convert.on("error", (error) => {
      // If ImageMagick is not available, try ffmpeg
      log("ImageMagick not available, trying ffmpeg...");

      const ffmpegArgs = [
        "-i",
        inputPath,
        "-vf",
        "scale=600:900:force_original_aspect_ratio=decrease",
        "-y",
        outputPath,
      ];

      const ffmpeg = spawn("ffmpeg", ffmpegArgs);

      ffmpeg.on("error", (ffmpegError) => {
        reject(
          new Error(
            "Neither ImageMagick nor ffmpeg available for image processing"
          )
        );
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });
    });

    convert.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        // ImageMagick failed, don't reject yet, let the error handler try ffmpeg
      }
    });
  });
}

/**
 * Process a single movie thumbnail
 */
async function processThumbnail(movieName) {
  log(`Processing thumbnail for: ${movieName}`);

  // Search for poster
  const posterUrl = await searchMoviePoster(movieName);

  if (!posterUrl) {
    log(`Skipping "${movieName}" - no poster found`);
    return false;
  }

  try {
    // Download to temporary file
    const tempFile = path.join(imgsDirectory, `${movieName}.tmp`);
    const finalFile = path.join(imgsDirectory, `${movieName}.png`);

    log(`Downloading poster for "${movieName}"...`);
    await downloadImage(posterUrl, tempFile);

    log(`Converting "${movieName}"...`);
    await convertAndCropImage(tempFile, finalFile);

    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }

    log(` Thumbnail created for "${movieName}"`);
    return true;
  } catch (error) {
    log(`Error processing "${movieName}": ${error.message}`);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  log("=== Thumbnail Fetcher Started ===");
  log(`Video directory: ${videoDirectory}`);
  log(`Images directory: ${imgsDirectory}`);

  // Get list of movies and existing thumbnails
  const movies = getMP4Files();
  const thumbnails = getExistingThumbnails();

  log(`Found ${movies.length} movies`);
  log(`Found ${thumbnails.length} existing thumbnails`);

  // Find missing thumbnails
  const missing = movies.filter((movie) => !thumbnails.includes(movie));

  if (missing.length === 0) {
    log("All thumbnails are up to date!");
    return;
  }

  log(`Missing ${missing.length} thumbnails`);

  // Process each missing thumbnail
  let successCount = 0;
  for (const movie of missing) {
    const success = await processThumbnail(movie);
    if (success) {
      successCount++;
    }

    // Add a small delay between requests to be nice to the API
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  log("=== Thumbnail Fetcher Complete ===");
  log(`Successfully created ${successCount}/${missing.length} thumbnails`);
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    log("Fatal error: " + error.message);
    process.exit(1);
  });
}

// Export for use as a module
module.exports = { main };
