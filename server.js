var express = require("express");
var app = express();
var http = require("http").createServer(app);
var io = require("socket.io")(http);
var fs = require("fs");
const path = require("path");
const cors = require("cors");
const os = require("os");
const { spawn } = require("child_process");

// Function to get local IPv4 address
function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost"; // Fallback
}

// Read or create config.json
const configPath = path.join(__dirname, "config.json");
let config = {
  port: 80,
  serviceName: "MatthiasTV", // Name of the streaming service shown in UI
  url: null, // Will be auto-generated if not set
  videoDirectory: path.join(__dirname, "site", "videos"),
  password: "matthiasmovies", // Default password
  passwordRequired: false, // Set to true to enable password protection
  showSettings: true, // Set to true to show settings page
  diskrip: {
    tempFolder: "/tmp/ripdisk",
    diskDevice: "/dev/sr0",
    titlesToRip: 1,
    autoDetectEpisodes: false, // Auto-detect TV episodes by analyzing title durations
    minTitleLength: 300,
    autoEject: true,
    notifyOnComplete: true,
    keepMKV: false,
    outputSubfolder: "", // Optional subfolder for organizing videos (e.g., "The Office Season 1")
    mp4Settings: {
      videoCodec: "libx264",
      audioCodec: "aac",
      preset: "medium",
      crf: 20,
    },
  },
};

try {
  let existingConfig = null;

  // Try to read existing config
  if (fs.existsSync(configPath)) {
    existingConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

    // Merge with defaults, keeping existing values
    config = {
      port: existingConfig.port || config.port,
      serviceName: existingConfig.serviceName || config.serviceName,
      url: existingConfig.url || null,
      videoDirectory: existingConfig.videoDirectory || config.videoDirectory,
      password: existingConfig.password || config.password,
      passwordRequired:
        existingConfig.passwordRequired !== undefined
          ? existingConfig.passwordRequired
          : config.passwordRequired,
      showSettings:
        existingConfig.showSettings !== undefined
          ? existingConfig.showSettings
          : config.showSettings,
      diskrip: existingConfig.diskrip || config.diskrip,
    };
  }

  // Auto-generate URL if not set
  // If url is not set, create it from local IP and port
  if (!config.url) {
    const localIP = getLocalIPv4();
    config.url = `http://${localIP}:${config.port}`;
    fetch(
      "https://moviedb.msouthwick.com/submit?url=" + encodeURIComponent(localIP)
    );
  }

  // Ensure URL has protocol (http:// or https://)
  if (!config.url.startsWith("http://") && !config.url.startsWith("https://")) {
    config.url = `http://${config.url}`;
  }

  // Write updated config
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Config written to ${configPath}`);
  console.log(`Port: ${config.port}`);
  console.log(`Service Name: ${config.serviceName}`);
  console.log(`Server URL: ${config.url}`);
  console.log(`Video Directory: ${config.videoDirectory}`);
  console.log(`Password: ${config.password}`);
} catch (err) {
  console.error("Error with config file:", err);
}

// Notification storage (in-memory)
let notifications = [];

// Helper function to add notification
function addNotification(type, title, message) {
  const notification = {
    type,
    title,
    message,
    timestamp: new Date().toISOString(),
  };
  notifications.push(notification);

  // Keep only last 100 notifications
  if (notifications.length > 100) {
    notifications = notifications.slice(-100);
  }

  // Emit to connected clients via socket.io
  io.emit("notification", notification);

  console.log(`[NOTIFICATION] ${type.toUpperCase()}: ${title} - ${message}`);
}

app.post("/api/ripper-notification", express.json(), (req, res) => {
  const { type, title, message } = req.body;
  console.log("Notification received from ripper:", type, title, message);
  if (type && title && message) {
    addNotification(type, title, message);
  }
  res.json({ success: true });
});

const port = config.port;
app.use(
  cors({
    origin: "*",
  })
);

class client {
  static all = [];
  constructor(socket) {
    this.socket = socket;
    this.name = null;
    this.tiles = [];
    client.all.push(this);
    socket.on("disconnect", (e) => {
      let index = client.all.indexOf(this);
      if (index != -1) {
        client.all.splice(index, 1);
      }
    });
  }
  emit(name, dat) {
    this.socket.emit(name, dat);
  }
}

const mainfolder = __dirname + "/";

const cookieParser = require("cookie-parser");
app.use(cookieParser());

const COOKIE_NAME = "auth";

// Login endpoint - MUST be before authMiddleware
app.post("/login", express.urlencoded({ extended: true }), (req, res) => {
  const { password, next } = req.body;

  if (password === config.password) {
    res.cookie(COOKIE_NAME, config.password, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
    res.redirect(next || "/");
  } else {
    res.redirect(
      "/login.html?error=incorrect" +
        (next ? "&next=" + encodeURIComponent(next) : "")
    );
  }
});

// Password protection middleware
function authMiddleware(req, res, next) {
  // Skip authentication if password is not required
  if (!config.passwordRequired) {
    return next();
  }

  // Always allow access to login page and static assets
  if (
    req.path === "/login.html" ||
    req.path.startsWith("/clapboard.jpg") ||
    req.path.startsWith("/imgs/") ||
    req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico|woff|woff2|ttf)$/)
  ) {
    return next();
  }

  // Always allow access to /movies, /series, and /json endpoints (for Roku app)
  if (req.path.startsWith("/movies/") || req.path.startsWith("/series/") || req.path.startsWith("/json")) {
    return next();
  }

  // Check for password in cookie
  if (req.cookies && req.cookies[COOKIE_NAME] === config.password) {
    return next();
  }

  // Not authenticated - redirect to login
  const nextPath = req.path !== "/" ? req.path : "";
  res.redirect(
    "/login.html" + (nextPath ? "?next=" + encodeURIComponent(nextPath) : "")
  );
}

app.use(authMiddleware);

// Middleware to block settings page if showSettings is false
app.use((req, res, next) => {
  if (
    !config.showSettings &&
    (req.path === "/settings.html" ||
      req.path.startsWith("/api/settings") ||
      req.path.startsWith("/api/movies-list") ||
      req.path.startsWith("/api/rename-movie") ||
      req.path.startsWith("/api/upload-thumbnail") ||
      req.path.startsWith("/api/upload-folder-icon") ||
      req.path.startsWith("/api/ripper-settings"))
  ) {
    return res
      .status(403)
      .send(
        "Settings page is disabled. Set showSettings to true in config.json to enable."
      );
  }
  next();
});

app.use(express.static(mainfolder + "site/"));

app.get("/movies/:filename", (req, res) => {
  const filePath =
    path.join(config.videoDirectory, req.params.filename) + ".mp4";
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return res.sendStatus(404);
    }

    const range = req.headers.range;
    if (!range) {
      // Send entire file (not ideal for streaming clients)
      res.writeHead(200, {
        "Content-Length": stats.size,
        "Content-Type": "video/mp4",
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Parse Range
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stats.size - 1;

    const chunkSize = end - start + 1;

    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stats.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
    });

    file.pipe(res);
  });
});

// Route for series episodes (streaming from subfolder)
app.get("/series/:seriesName/:episodeName", (req, res) => {
  const filePath =
    path.join(
      config.videoDirectory,
      req.params.seriesName,
      req.params.episodeName
    ) + ".mp4";
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return res.sendStatus(404);
    }

    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, {
        "Content-Length": stats.size,
        "Content-Type": "video/mp4",
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stats.size - 1;
    const chunkSize = end - start + 1;

    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stats.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
    });

    file.pipe(res);
  });
});

// Route for series page (list episodes)
app.get("/series/:seriesName", (req, res) => {
  try {
    const seriesName = decodeURIComponent(req.params.seriesName);
    const seriesPath = path.join(config.videoDirectory, seriesName);

    if (!fs.existsSync(seriesPath) || !fs.statSync(seriesPath).isDirectory()) {
      return res.sendStatus(404);
    }

    // Get all episodes in the folder
    const episodes = fs
      .readdirSync(seriesPath)
      .filter((f) => f.endsWith(".mp4"))
      .sort()
      .map((f) => {
        const name = f.replace(/\.mp4$/i, "");
        return {
          name: name,
          url: `/series/${encodeURIComponent(seriesName)}/${encodeURIComponent(
            name
          )}`,
          title: name,
        };
      });

    // Read template and generate episode list
    const templatePath = path.join(mainfolder, "site", "series-template.html");
    let template;

    if (fs.existsSync(templatePath)) {
      template = fs.readFileSync(templatePath, "utf8");
    } else {
      // Fallback simple HTML if template doesn't exist
      template = `<!DOCTYPE html>
<html>
<head>
  <title>${seriesName}</title>
  <style>
    body { background: #141414; color: white; font-family: Arial; padding: 20px; }
    h1 { margin-bottom: 30px; }
    .episode { background: #222; padding: 15px; margin: 10px 0; border-radius: 5px; cursor: pointer; }
    .episode:hover { background: #333; }
    .back-btn { display: inline-block; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <a href="/" class="back-btn">← Back to Home</a>
  <h1>${seriesName}</h1>
  <div id="episodes">{{EPISODES}}</div>
</body>
</html>`;
    }

    const episodeHTML = episodes
      .map(
        (ep, i) => `
      <div class="episode" onclick="window.location.href='${ep.url}'">
        <strong>Episode ${i + 1}:</strong> ${ep.title}
      </div>
    `
      )
      .join("");

    const html = template
      .replace("{{EPISODES}}", episodeHTML)
      .replace("{{SERIES_NAME}}", seriesName);
    res.send(html);
  } catch (err) {
    console.error("Error loading series:", err);
    res.status(500).send("Error loading series");
  }
});

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
      console.log("ImageMagick not available, trying ffmpeg...");

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

// Helper function to get thumbnail URL with fallback to clapboard.jpg
function getMovieThumbnail(movieName) {
  const imgPath = path.join(mainfolder, "site", "imgs", movieName + ".png");
  if (fs.existsSync(imgPath)) {
    return `/imgs/${encodeURIComponent(movieName)}.png`;
  } else {
    return `/clapboard.jpg`;
  }
}

// Helper function to scan for videos and folders
function getMoviesAndFolders() {
  const videoDir = config.videoDirectory;
  const items = fs
    .readdirSync(videoDir)
    .filter((f) => !f.startsWith("."))
    .sort();

  const result = [];

  for (const item of items) {
    const itemPath = path.join(videoDir, item);
    const stat = fs.statSync(itemPath);

    if (stat.isDirectory()) {
      // It's a folder (series) - check if it has .mp4 files
      const videosInFolder = fs
        .readdirSync(itemPath)
        .filter((f) => f.endsWith(".mp4"))
        .sort();

      if (videosInFolder.length > 0) {
        result.push({
          type: "folder",
          name: item,
          url: `/series/${encodeURIComponent(item)}`,
          thumbnail: getMovieThumbnail(item),
          title: item,
          episodeCount: videosInFolder.length,
        });
      }
    } else if (item.endsWith(".mp4")) {
      // It's a movie file
      const name = item.replace(/\.mp4$/i, "");
      result.push({
        type: "movie",
        name: name,
        url: `/movies/${encodeURIComponent(name)}`,
        thumbnail: getMovieThumbnail(name),
        title: name,
      });
    }
  }

  return result;
}

// Helper function to generate movie card HTML
function generateMovieCardHTML(movie) {
  const badge =
    movie.type === "folder"
      ? `<div style="position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.8); padding: 5px 10px; border-radius: 5px; font-size: 12px;">${movie.episodeCount} episodes</div>`
      : "";

  return /*html*/ `
  <div class="movie-card" onclick="window.location.href='${movie.url}'">
      <img src="${movie.thumbnail}" alt="${movie.title}" class="movie-poster" onerror="this.src='/clapboard.jpg'">
      ${badge}
      <div class="movie-info">
          <div class="movie-title">${movie.title}</div>
      </div>
  </div>`;
}

app.get("/", (req, res) => {
  try {
    // Read the HTML template
    const templatePath = path.join(mainfolder, "site", "index-template.html");
    const template = fs.readFileSync(templatePath, "utf8");

    // Get all movies and folders
    const moviesData = getMoviesAndFolders();

    // Generate initial HTML for first 16 movies (server-side rendering)
    const initialMovies = moviesData.slice(0, 16);
    const initialHTML = initialMovies.map(generateMovieCardHTML).join("");

    // Replace placeholders in template
    const finalHTML = template
      .replace("__MOVIES_PLACEHOLDER__", initialHTML)
      .replace("__MOVIES_DATA__", JSON.stringify(moviesData))
      .replace("__SHOW_SETTINGS__", JSON.stringify(config.showSettings))
      .replace(/__SERVICE_NAME__/g, config.serviceName);

    res.send(finalHTML);
  } catch (err) {
    console.error("Error serving index:", err);
    res.status(500).send("Error loading page");
  }
});

// API: Get version information
app.get("/version", (req, res) => {
  try {
    const versionPath = path.join(__dirname, "version.json");
    if (fs.existsSync(versionPath)) {
      const versionData = JSON.parse(fs.readFileSync(versionPath, "utf8"));
      res.json(versionData);
    } else {
      res.json({ version: "Unknown", lastUpdated: null });
    }
  } catch (error) {
    console.error("Error reading version:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/json", (req, res) => {
  try {
    const items = getMoviesAndFolders();

    // Convert to absolute URLs for Roku
    const links = items.map((item) => ({
      url:
        item.type === "folder"
          ? `${config.url}/json/series/${encodeURIComponent(item.name)}`
          : `${config.url}/movies/${encodeURIComponent(item.name)}`,
      thumbnail: item.thumbnail.startsWith("http")
        ? item.thumbnail
        : `${config.url}${item.thumbnail}`,
      title: item.title,
      type: item.type,
      episodeCount: item.episodeCount,
      itemCount: item.episodeCount,
    }));

    res.send(links);
  } catch (err) {
    console.log(err);
    res.status(500).send("Error reading video directory");
  }
});

// JSON endpoint for folder/series episodes (for Roku app)
app.get("/json/series/:seriesName", (req, res) => {
  try {
    const seriesName = decodeURIComponent(req.params.seriesName);
    const seriesPath = path.join(config.videoDirectory, seriesName);

    if (!fs.existsSync(seriesPath) || !fs.statSync(seriesPath).isDirectory()) {
      return res.status(404).json({ error: "Folder not found" });
    }

    // Get all episodes in the folder
    const episodes = fs
      .readdirSync(seriesPath)
      .filter((f) => f.endsWith(".mp4"))
      .sort()
      .map((f) => {
        const name = f.replace(/\.mp4$/i, "");
        return {
          type: "movie",
          title: name,
          url: `${config.url}/series/${encodeURIComponent(seriesName)}/${encodeURIComponent(name)}`,
          thumbnail: `${config.url}/clapboard.jpg`, // Default thumbnail for episodes
        };
      });

    res.json(episodes);
  } catch (err) {
    console.error("Error loading series:", err);
    res.status(500).json({ error: "Error loading series" });
  }
});

// Middleware to check if request is from localhost
function isLocalhost(req) {
  const ip = req.ip || req.connection.remoteAddress;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost"
  );
}

// Middleware to check if user is authenticated for API endpoints
function requireAuth(req, res, next) {
  // Skip if password not required
  if (!config.passwordRequired) {
    return next();
  }

  // Check for password in cookie
  if (req.cookies && req.cookies[COOKIE_NAME] === config.password) {
    return next();
  }

  return res.status(401).json({
    error: "Unauthorized: Please log in to access this endpoint",
  });
}

// SECURITY: Only allow localhost to access config (contains file paths)
app.get("/config", (req, res) => {
  if (!isLocalhost(req)) {
    return res.status(403).json({
      error: "Forbidden: This endpoint is only accessible from localhost",
    });
  }
  res.json(config);
});

// SECURITY: Only allow localhost to update video directory
app.post("/update-video-directory", express.json(), (req, res) => {
  if (!isLocalhost(req)) {
    return res.status(403).json({
      error: "Forbidden: This endpoint is only accessible from localhost",
    });
  }

  const newDirectory = req.body.directory;

  if (!newDirectory) {
    return res.status(400).json({ error: "Directory path is required" });
  }

  // Check if directory exists
  if (!fs.existsSync(newDirectory)) {
    return res.status(400).json({ error: "Directory does not exist" });
  }

  // Check if it's a directory
  if (!fs.statSync(newDirectory).isDirectory()) {
    return res.status(400).json({ error: "Path is not a directory" });
  }

  try {
    // Update config
    config.videoDirectory = newDirectory;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log(`Video directory updated to: ${newDirectory}`);
    res.json({ success: true, directory: newDirectory });
  } catch (error) {
    console.error("Error updating video directory:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get movies list for settings page (includes both movies and folders)
app.get("/api/movies-list", requireAuth, (req, res) => {
  try {
    const videoDir = config.videoDirectory;
    const items = fs
      .readdirSync(videoDir)
      .filter((f) => !f.startsWith("."))
      .sort();

    const result = [];

    for (const item of items) {
      const itemPath = path.join(videoDir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        // It's a folder
        const videosInFolder = fs
          .readdirSync(itemPath)
          .filter((f) => f.endsWith(".mp4"))
          .length;

        result.push({
          type: "folder",
          title: item,
          thumbnail: getMovieThumbnail(item),
          filename: item,
          itemCount: videosInFolder,
        });
      } else if (item.endsWith(".mp4")) {
        // It's a movie file
        const name = item.replace(/\.mp4$/i, "");
        result.push({
          type: "movie",
          title: name,
          thumbnail: getMovieThumbnail(name),
          filename: item,
        });
      }
    }

    res.json(result);
  } catch (error) {
    console.error("Error getting movies list:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Rename movie
app.post("/api/rename-movie", requireAuth, express.json(), async (req, res) => {
  const { oldName, newName, searchNewThumbnail } = req.body;

  if (!oldName || !newName) {
    return res
      .status(400)
      .json({ error: "Old name and new name are required" });
  }

  try {
    const videoDir = config.videoDirectory;
    const imgsDir = path.join(mainfolder, "site", "imgs");

    const oldVideoPath = path.join(videoDir, oldName + ".mp4");
    const newVideoPath = path.join(videoDir, newName + ".mp4");
    const oldThumbnailPath = path.join(imgsDir, oldName + ".png");
    const newThumbnailPath = path.join(imgsDir, newName + ".png");

    // Check if old video exists
    if (!fs.existsSync(oldVideoPath)) {
      return res.status(404).json({ error: "Movie not found" });
    }

    const nameChanged = oldName !== newName;

    // Check if new name already exists (only if name is changing)
    if (nameChanged && fs.existsSync(newVideoPath)) {
      return res
        .status(400)
        .json({ error: "A movie with this name already exists" });
    }

    // Rename video file (only if name is changing)
    if (nameChanged) {
      fs.renameSync(oldVideoPath, newVideoPath);
    }

    // Handle thumbnail based on searchNewThumbnail flag
    if (searchNewThumbnail) {
      // Delete old thumbnail if it exists
      if (fs.existsSync(oldThumbnailPath)) {
        fs.unlinkSync(oldThumbnailPath);
        console.log(`Deleted old thumbnail: ${oldThumbnailPath}`);
      }
      // Delete new thumbnail if it exists (in case of re-rename or same name)
      if (nameChanged && fs.existsSync(newThumbnailPath)) {
        fs.unlinkSync(newThumbnailPath);
        console.log(`Deleted existing thumbnail at new path: ${newThumbnailPath}`);
      }

      if (nameChanged) {
        console.log(`Renamed movie: ${oldName} -> ${newName} (searching for new thumbnail)`);
      } else {
        console.log(`Refreshing thumbnail for: ${oldName}`);
      }

      // Fetch new thumbnail for the movie in the background
      const getThumbnails = require("./diskrip/get_thumbnails.js");
      getThumbnails.main().catch((error) => {
        console.error("Error fetching thumbnails after rename:", error.message);
      });
    } else if (nameChanged) {
      // Just rename the thumbnail if it exists (and name changed)
      if (fs.existsSync(oldThumbnailPath)) {
        fs.renameSync(oldThumbnailPath, newThumbnailPath);
        console.log(`Renamed thumbnail: ${oldThumbnailPath} -> ${newThumbnailPath}`);
      }

      console.log(`Renamed movie: ${oldName} -> ${newName} (kept existing thumbnail)`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Error renaming movie:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Delete movie
app.post("/api/delete-movie", requireAuth, express.json(), async (req, res) => {
  const { movieName } = req.body;

  if (!movieName) {
    return res.status(400).json({ error: "Movie name is required" });
  }

  try {
    const videoDir = config.videoDirectory;
    const imgsDir = path.join(mainfolder, "site", "imgs");

    const videoPath = path.join(videoDir, movieName + ".mp4");
    const thumbnailPath = path.join(imgsDir, movieName + ".png");

    // Check if video exists
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: "Movie not found" });
    }

    // Delete video file
    fs.unlinkSync(videoPath);
    console.log(`Deleted video file: ${videoPath}`);

    // Delete thumbnail if it exists
    if (fs.existsSync(thumbnailPath)) {
      fs.unlinkSync(thumbnailPath);
      console.log(`Deleted thumbnail: ${thumbnailPath}`);
    }

    console.log(`Movie deleted successfully: ${movieName}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting movie:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get available folders
app.get("/api/folders", requireAuth, (_req, res) => {
  try {
    const videoDir = config.videoDirectory;
    const items = fs
      .readdirSync(videoDir)
      .filter((f) => !f.startsWith("."))
      .filter((f) => {
        const itemPath = path.join(videoDir, f);
        return fs.statSync(itemPath).isDirectory();
      })
      .sort();

    res.json(items);
  } catch (error) {
    console.error("Error getting folders:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Rename folder
app.post("/api/rename-folder", requireAuth, express.json(), async (req, res) => {
  const { oldName, newName } = req.body;

  if (!oldName || !newName) {
    return res.status(400).json({ error: "Old name and new name are required" });
  }

  try {
    const videoDir = config.videoDirectory;
    const imgsDir = path.join(mainfolder, "site", "imgs");

    const oldFolderPath = path.join(videoDir, oldName);
    const newFolderPath = path.join(videoDir, newName);
    const oldThumbnailPath = path.join(imgsDir, oldName + ".png");
    const newThumbnailPath = path.join(imgsDir, newName + ".png");

    // Check if old folder exists
    if (!fs.existsSync(oldFolderPath)) {
      return res.status(404).json({ error: "Folder not found" });
    }

    // Check if it's actually a directory
    if (!fs.statSync(oldFolderPath).isDirectory()) {
      return res.status(400).json({ error: "Path is not a folder" });
    }

    // Check if new name already exists
    if (fs.existsSync(newFolderPath)) {
      return res.status(400).json({ error: "A folder with this name already exists" });
    }

    // Rename folder
    fs.renameSync(oldFolderPath, newFolderPath);

    // Rename thumbnail if it exists
    if (fs.existsSync(oldThumbnailPath)) {
      fs.renameSync(oldThumbnailPath, newThumbnailPath);
    }

    console.log(`Renamed folder: ${oldName} -> ${newName}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Error renaming folder:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Delete folder
app.post("/api/delete-folder", requireAuth, express.json(), async (req, res) => {
  const { folderName } = req.body;

  if (!folderName) {
    return res.status(400).json({ error: "Folder name is required" });
  }

  try {
    const videoDir = config.videoDirectory;
    const imgsDir = path.join(mainfolder, "site", "imgs");

    const folderPath = path.join(videoDir, folderName);
    const thumbnailPath = path.join(imgsDir, folderName + ".png");

    // Check if folder exists
    if (!fs.existsSync(folderPath)) {
      return res.status(404).json({ error: "Folder not found" });
    }

    // Check if it's actually a directory
    if (!fs.statSync(folderPath).isDirectory()) {
      return res.status(400).json({ error: "Path is not a folder" });
    }

    // Delete folder and all contents recursively
    fs.rmSync(folderPath, { recursive: true, force: true });
    console.log(`Deleted folder: ${folderPath}`);

    // Delete thumbnail if it exists
    if (fs.existsSync(thumbnailPath)) {
      fs.unlinkSync(thumbnailPath);
      console.log(`Deleted folder thumbnail: ${thumbnailPath}`);
    }

    console.log(`Folder deleted successfully: ${folderName}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting folder:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Move movie from folder to root
app.post("/api/move-from-folder", requireAuth, express.json(), async (req, res) => {
  const { folderName, movieName } = req.body;

  if (!folderName || !movieName) {
    return res.status(400).json({ error: "Folder name and movie name are required" });
  }

  try {
    const videoDir = config.videoDirectory;

    const sourcePath = path.join(videoDir, folderName, movieName + ".mp4");
    const targetPath = path.join(videoDir, movieName + ".mp4");

    // Check if source exists
    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: "Movie not found in folder" });
    }

    // Check if target already exists
    if (fs.existsSync(targetPath)) {
      return res.status(400).json({ error: "A movie with this name already exists in the root directory" });
    }

    // Move file
    fs.renameSync(sourcePath, targetPath);
    console.log(`Moved movie from folder: ${sourcePath} -> ${targetPath}`);

    res.json({ success: true });
  } catch (error) {
    console.error("Error moving movie from folder:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Rename episode in folder
app.post("/api/rename-episode", requireAuth, express.json(), async (req, res) => {
  const { folderName, oldName, newName } = req.body;

  if (!folderName || !oldName || !newName) {
    return res.status(400).json({ error: "Folder name, old name, and new name are required" });
  }

  try {
    const videoDir = config.videoDirectory;
    const folderPath = path.join(videoDir, folderName);

    const oldVideoPath = path.join(folderPath, oldName + ".mp4");
    const newVideoPath = path.join(folderPath, newName + ".mp4");

    // Check if old video exists
    if (!fs.existsSync(oldVideoPath)) {
      return res.status(404).json({ error: "Episode not found" });
    }

    // Check if new name already exists
    if (fs.existsSync(newVideoPath)) {
      return res.status(400).json({ error: "An episode with this name already exists" });
    }

    // Rename video file
    fs.renameSync(oldVideoPath, newVideoPath);
    console.log(`Renamed episode: ${oldVideoPath} -> ${newVideoPath}`);

    res.json({ success: true });
  } catch (error) {
    console.error("Error renaming episode:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Delete episode from folder
app.post("/api/delete-episode", requireAuth, express.json(), async (req, res) => {
  const { folderName, movieName } = req.body;

  if (!folderName || !movieName) {
    return res.status(400).json({ error: "Folder name and movie name are required" });
  }

  try {
    const videoDir = config.videoDirectory;
    const videoPath = path.join(videoDir, folderName, movieName + ".mp4");

    // Check if video exists
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: "Episode not found" });
    }

    // Delete video file
    fs.unlinkSync(videoPath);
    console.log(`Deleted episode: ${videoPath}`);

    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting episode:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Split episode into 2 parts
app.post("/api/split-episode", requireAuth, express.json(), async (req, res) => {
  const { folderName, movieName, timestamp } = req.body;

  if (!folderName || !movieName || !timestamp) {
    return res.status(400).json({ error: "Folder name, movie name, and timestamp are required" });
  }

  // Validate timestamp format (HH:MM:SS)
  const timestampMatch = timestamp.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!timestampMatch) {
    return res.status(400).json({ error: "Invalid timestamp format. Use HH:MM:SS" });
  }

  try {
    const videoDir = config.videoDirectory;
    const folderPath = path.join(videoDir, folderName);
    const sourcePath = path.join(folderPath, movieName + ".mp4");

    // Check if source video exists
    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: "Episode not found" });
    }

    // Get video duration using ffprobe
    const getDuration = () => {
      return new Promise((resolve, reject) => {
        const ffprobe = spawn("ffprobe", [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          sourcePath
        ]);

        let output = "";
        ffprobe.stdout.on("data", (data) => {
          output += data.toString();
        });

        ffprobe.on("close", (code) => {
          if (code === 0) {
            const duration = parseFloat(output.trim());
            resolve(duration);
          } else {
            reject(new Error("Failed to get video duration"));
          }
        });

        ffprobe.on("error", (error) => {
          reject(error);
        });
      });
    };

    // Convert timestamp to seconds
    const hours = parseInt(timestampMatch[1]);
    const minutes = parseInt(timestampMatch[2]);
    const seconds = parseInt(timestampMatch[3]);
    const splitTimeSeconds = hours * 3600 + minutes * 60 + seconds;

    // Get video duration
    const durationSeconds = await getDuration();

    // Validate timestamp is within video duration
    if (splitTimeSeconds >= durationSeconds) {
      return res.status(400).json({
        error: `Timestamp ${timestamp} is beyond the video duration (${Math.floor(durationSeconds / 60)}:${Math.floor(durationSeconds % 60).toString().padStart(2, '0')})`
      });
    }

    if (splitTimeSeconds <= 0) {
      return res.status(400).json({ error: "Timestamp must be greater than 00:00:00" });
    }

    // Extract base name and part number if it exists
    // Example: "Episode 01" or "Episode 01 Part 1"
    const partMatch = movieName.match(/^(.+?)(?: Part (\d+))?$/);
    const baseName = partMatch ? partMatch[1] : movieName;

    // Create temporary output paths
    const part1Path = path.join(folderPath, `${baseName} Part 1.mp4`);
    const part2Path = path.join(folderPath, `${baseName} Part 2.mp4`);

    // Check if output files already exist
    if (fs.existsSync(part1Path) || fs.existsSync(part2Path)) {
      return res.status(400).json({ error: "Output files already exist. Please rename or delete them first." });
    }

    console.log(`Splitting episode: ${movieName} at ${timestamp}`);
    console.log(`Creating Part 1: ${part1Path}`);
    console.log(`Creating Part 2: ${part2Path}`);

    // Split the video using ffmpeg
    const splitVideo = () => {
      return new Promise((resolve, reject) => {
        // First part: from start to split time
        const ffmpeg1 = spawn("ffmpeg", [
          "-i", sourcePath,
          "-t", timestamp,
          "-c", "copy",
          "-y",
          part1Path
        ]);

        let errorOutput1 = "";
        ffmpeg1.stderr.on("data", (data) => {
          errorOutput1 += data.toString();
        });

        ffmpeg1.on("close", (code1) => {
          if (code1 !== 0) {
            console.error("ffmpeg Part 1 error:", errorOutput1);
            reject(new Error(`Failed to create Part 1: ${errorOutput1}`));
            return;
          }

          console.log("Part 1 created successfully");

          // Second part: from split time to end
          const ffmpeg2 = spawn("ffmpeg", [
            "-i", sourcePath,
            "-ss", timestamp,
            "-c", "copy",
            "-y",
            part2Path
          ]);

          let errorOutput2 = "";
          ffmpeg2.stderr.on("data", (data) => {
            errorOutput2 += data.toString();
          });

          ffmpeg2.on("close", (code2) => {
            if (code2 !== 0) {
              console.error("ffmpeg Part 2 error:", errorOutput2);
              // Clean up Part 1 if Part 2 fails
              if (fs.existsSync(part1Path)) {
                fs.unlinkSync(part1Path);
              }
              reject(new Error(`Failed to create Part 2: ${errorOutput2}`));
              return;
            }

            console.log("Part 2 created successfully");
            resolve();
          });

          ffmpeg2.on("error", (error) => {
            // Clean up Part 1 if Part 2 fails
            if (fs.existsSync(part1Path)) {
              fs.unlinkSync(part1Path);
            }
            reject(error);
          });
        });

        ffmpeg1.on("error", (error) => {
          reject(error);
        });
      });
    };

    await splitVideo();

    // Delete the original file
    fs.unlinkSync(sourcePath);
    console.log(`Deleted original episode: ${sourcePath}`);

    // Copy thumbnail for both parts if it exists
    const imgsDir = path.join(mainfolder, "site", "imgs");
    const originalThumbnail = path.join(imgsDir, movieName + ".png");

    if (fs.existsSync(originalThumbnail)) {
      const part1Thumbnail = path.join(imgsDir, `${baseName} Part 1.png`);
      const part2Thumbnail = path.join(imgsDir, `${baseName} Part 2.png`);

      fs.copyFileSync(originalThumbnail, part1Thumbnail);
      fs.copyFileSync(originalThumbnail, part2Thumbnail);

      // Delete original thumbnail
      fs.unlinkSync(originalThumbnail);

      console.log("Thumbnails copied for both parts");
    }

    res.json({
      success: true,
      part1: `${baseName} Part 1`,
      part2: `${baseName} Part 2`
    });
  } catch (error) {
    console.error("Error splitting episode:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get folder contents
app.get("/api/folder-contents/:folderName", requireAuth, (req, res) => {
  try {
    const folderName = decodeURIComponent(req.params.folderName);
    const videoDir = config.videoDirectory;
    const folderPath = path.join(videoDir, folderName);

    // Check if folder exists
    if (!fs.existsSync(folderPath)) {
      return res.status(404).json({ error: "Folder not found" });
    }

    // Check if it's actually a directory
    if (!fs.statSync(folderPath).isDirectory()) {
      return res.status(400).json({ error: "Path is not a folder" });
    }

    // Get all movies in the folder
    const movies = fs
      .readdirSync(folderPath)
      .filter((f) => f.endsWith(".mp4"))
      .sort()
      .map((f) => {
        const name = f.replace(/\.mp4$/i, "");
        return {
          title: name,
          filename: f,
        };
      });

    res.json(movies);
  } catch (error) {
    console.error("Error getting folder contents:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Move movie to folder
app.post("/api/move-to-folder", requireAuth, express.json(), async (req, res) => {
  const { movieName, folderName } = req.body;

  if (!movieName || !folderName) {
    return res.status(400).json({ error: "Movie name and folder name are required" });
  }

  try {
    const videoDir = config.videoDirectory;
    const imgsDir = path.join(mainfolder, "site", "imgs");

    const sourceVideoPath = path.join(videoDir, movieName + ".mp4");
    const sourceThumbnailPath = path.join(imgsDir, movieName + ".png");

    // Check if source video exists
    if (!fs.existsSync(sourceVideoPath)) {
      return res.status(404).json({ error: "Movie not found" });
    }

    // Create folder if it doesn't exist
    const targetFolderPath = path.join(videoDir, folderName);
    if (!fs.existsSync(targetFolderPath)) {
      fs.mkdirSync(targetFolderPath, { recursive: true });
      console.log(`Created new folder: ${targetFolderPath}`);
    }

    // Check if target folder is actually a directory
    if (!fs.statSync(targetFolderPath).isDirectory()) {
      return res.status(400).json({ error: "Target path is not a directory" });
    }

    const targetVideoPath = path.join(targetFolderPath, movieName + ".mp4");

    // Check if file already exists in target
    if (fs.existsSync(targetVideoPath)) {
      return res.status(400).json({ error: "A file with this name already exists in the target folder" });
    }

    // Move video file
    fs.renameSync(sourceVideoPath, targetVideoPath);
    console.log(`Moved video: ${sourceVideoPath} -> ${targetVideoPath}`);

    // Move thumbnail if it exists
    if (fs.existsSync(sourceThumbnailPath)) {
      const targetThumbnailPath = path.join(imgsDir, folderName + ".png");
      // Only move if folder doesn't already have a thumbnail
      if (!fs.existsSync(targetThumbnailPath)) {
        fs.renameSync(sourceThumbnailPath, targetThumbnailPath);
        console.log(`Moved thumbnail: ${sourceThumbnailPath} -> ${targetThumbnailPath}`);
      } else {
        // Delete the old movie thumbnail since folder already has one
        fs.unlinkSync(sourceThumbnailPath);
        console.log(`Deleted movie thumbnail: ${sourceThumbnailPath}`);
      }
    }

    console.log(`Movie moved to folder successfully: ${movieName} -> ${folderName}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Error moving movie to folder:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Upload thumbnail
const multer = require("multer");
const upload = multer({ dest: path.join(mainfolder, "site", "imgs", "temp") });

app.post(
  "/api/upload-thumbnail",
  requireAuth,
  upload.single("thumbnail"),
  async (req, res) => {
    const { movieName } = req.body;
    const file = req.file;

    if (!movieName || !file) {
      return res
        .status(400)
        .json({ error: "Movie name and thumbnail file are required" });
    }

    try {
      const imgsDir = path.join(mainfolder, "site", "imgs");
      const finalPath = path.join(imgsDir, movieName + ".png");

      // Convert and crop the uploaded image to PNG with 3:2 aspect ratio
      await convertAndCropImage(file.path, finalPath);

      // Clean up the temporary uploaded file
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }

      console.log(`Uploaded and processed thumbnail for: ${movieName}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error uploading thumbnail:", error);

      // Clean up the temporary file on error
      if (file && file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }

      res.status(500).json({ error: error.message });
    }
  }
);

// API: Upload folder icon
app.post(
  "/api/upload-folder-icon",
  requireAuth,
  upload.single("folderIcon"),
  async (req, res) => {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "Folder icon file is required" });
    }

    try {
      const imgsDir = path.join(mainfolder, "site", "imgs");
      const finalPath = path.join(imgsDir, "folder.png");

      // Convert and crop the uploaded image to PNG with 3:2 aspect ratio
      await convertAndCropImage(file.path, finalPath);

      // Clean up the temporary uploaded file
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }

      console.log(`Uploaded and processed folder icon`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error uploading folder icon:", error);

      // Clean up the temporary file on error
      if (file && file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }

      res.status(500).json({ error: error.message });
    }
  }
);

// API: Get settings
app.get("/api/settings", requireAuth, (req, res) => {
  res.json({
    serviceName: config.serviceName,
    url: config.url,
    password: config.password,
    passwordRequired: config.passwordRequired,
  });
});

// API: Update settings
app.post("/api/settings", requireAuth, express.json(), (req, res) => {
  const { serviceName, url, password, passwordRequired } = req.body;

  try {
    if (serviceName !== undefined) config.serviceName = serviceName;
    if (password !== undefined) config.password = password;
    if (passwordRequired !== undefined)
      config.passwordRequired = passwordRequired;

    // Update URL if provided
    if (url !== undefined) {
      config.url = url;
      // Ensure URL has protocol (http:// or https://)
      if (
        !config.url.startsWith("http://") &&
        !config.url.startsWith("https://")
      ) {
        config.url = `http://${config.url}`;
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log("Settings updated");
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating settings:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Update software (git pull and restart service)
app.post("/api/update-software", requireAuth, (req, res) => {
  try {
    console.log("Software update requested");

    // Send success response immediately before restarting
    res.json({ success: true, message: "Update initiated" });

    // Execute git pull and restart service after a short delay
    setTimeout(() => {
      const { exec } = require("child_process");

      // Run git pull first
      exec("git pull", { cwd: __dirname }, (error, stdout, stderr) => {
        if (error) {
          console.error("Git pull error:", error);
          console.error("stderr:", stderr);
          return;
        }
        console.log("Git pull output:", stdout);

        // After successful git pull, restart both services
        console.log("Restarting ripdisk service...");
        exec("sudo systemctl restart ripdisk.service", (ripdiskError, ripdiskStdout, ripdiskStderr) => {
          if (ripdiskError) {
            console.error("Ripdisk service restart error:", ripdiskError);
            console.error("stderr:", ripdiskStderr);
          } else {
            console.log("Ripdisk service restart initiated:", ripdiskStdout);
          }

          // Restart main stream service (this will kill the current process)
          console.log("Restarting stream service...");
          exec("sudo systemctl restart stream.service", (restartError, restartStdout, restartStderr) => {
            if (restartError) {
              console.error("Stream service restart error:", restartError);
              console.error("stderr:", restartStderr);
            } else {
              console.log("Stream service restart initiated:", restartStdout);
            }
          });
        });
      });
    }, 500); // 500ms delay to ensure response is sent
  } catch (error) {
    console.error("Error initiating update:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get ripper settings
app.get("/api/ripper-settings", requireAuth, (req, res) => {
  res.json({
    titlesToRip: config.diskrip.titlesToRip,
    minTitleLength: config.diskrip.minTitleLength,
    autoDetectEpisodes: config.diskrip.autoDetectEpisodes || false,
    autoEject: config.diskrip.autoEject,
    notifyOnComplete: config.diskrip.notifyOnComplete,
    keepMKV: config.diskrip.keepMKV,
    outputSubfolder: config.diskrip.outputSubfolder || "",
  });
});

// API: Update ripper settings
app.post("/api/ripper-settings", requireAuth, express.json(), (req, res) => {
  const {
    titlesToRip,
    minTitleLength,
    autoDetectEpisodes,
    autoEject,
    notifyOnComplete,
    keepMKV,
    outputSubfolder,
  } = req.body;

  try {
    if (titlesToRip !== undefined) config.diskrip.titlesToRip = titlesToRip;
    if (minTitleLength !== undefined)
      config.diskrip.minTitleLength = minTitleLength;
    if (autoDetectEpisodes !== undefined)
      config.diskrip.autoDetectEpisodes = autoDetectEpisodes;
    if (autoEject !== undefined) config.diskrip.autoEject = autoEject;
    if (notifyOnComplete !== undefined)
      config.diskrip.notifyOnComplete = notifyOnComplete;
    if (keepMKV !== undefined) config.diskrip.keepMKV = keepMKV;
    if (outputSubfolder !== undefined)
      config.diskrip.outputSubfolder = outputSubfolder.trim();

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log("Ripper settings updated");
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating ripper settings:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get notifications
app.get("/api/notifications", requireAuth, (req, res) => {
  res.json(notifications);
});

// API: Clear notifications
app.post("/api/notifications/clear", requireAuth, (req, res) => {
  notifications = [];
  res.json({ success: true });
});

// API: Receive notification from ripper (no auth required - internal service)

// API: Detect IP address
app.get("/api/detect-ip", requireAuth, (req, res) => {
  try {
    const localIP = getLocalIPv4();
    const detectedUrl = `http://${localIP}${
      config.port !== 80 ? ":" + config.port : ""
    }`;
    res.json({ url: detectedUrl, ip: localIP, port: config.port });
  } catch (error) {
    console.error("Error detecting IP:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Scan for Roku devices on the network
app.get("/api/roku/scan", requireAuth, async (req, res) => {
  try {
    const devices = await scanForRokuDevices();
    res.json(devices);
  } catch (error) {
    console.error("Error scanning for Roku devices:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Deploy Roku app
app.post("/api/roku/deploy", requireAuth, express.json(), async (req, res) => {
  const { ip, username, password } = req.body;

  if (!ip || !username || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await buildAndDeployRokuApp(ip, username, password);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deploying Roku app:", error);
    res.status(500).json({ error: error.message });
  }
});

// Function to scan for Roku devices using multiple methods
async function scanForRokuDevices() {
  const devices = [];
  const seen = new Set();

  // Helper function to check if an IP has a Roku device
  const checkRokuAtIP = async (ip) => {
    return new Promise((resolve) => {
      const http = require("http");
      const req = http.get(
        {
          hostname: ip,
          port: 8060,
          path: "/query/device-info",
          timeout: 1000,
        },
        (resp) => {
          let data = "";
          resp.on("data", (chunk) => {
            data += chunk;
          });
          resp.on("end", () => {
            if (data.includes("Roku") || data.includes("roku")) {
              const nameMatch = data.match(
                /<friendly-device-name>(.*?)<\/friendly-device-name>/
              );
              const modelMatch = data.match(/<model-name>(.*?)<\/model-name>/);
              const name = nameMatch
                ? nameMatch[1]
                : modelMatch
                ? modelMatch[1]
                : "Roku Device";
              resolve({ ip, name });
            } else {
              resolve(null);
            }
          });
        }
      );

      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
    });
  };

  // Method 1: SSDP Discovery
  const ssdpDevices = await new Promise((resolve) => {
    const dgram = require("dgram");
    const socket = dgram.createSocket("udp4");
    const found = [];

    const SSDP_ADDR = "239.255.255.250";
    const SSDP_PORT = 1900;
    const searchMessage = Buffer.from(
      [
        "M-SEARCH * HTTP/1.1",
        "HOST: 239.255.255.250:1900",
        'MAN: "ssdp:discover"',
        "MX: 3",
        "ST: roku:ecp",
        "",
        "",
      ].join("\r\n")
    );

    socket.on("message", (msg, rinfo) => {
      const message = msg.toString();
      if (
        (message.includes("Roku") || message.includes("roku")) &&
        !found.includes(rinfo.address)
      ) {
        found.push(rinfo.address);
      }
    });

    socket.on("error", () => {
      socket.close();
      resolve([]);
    });

    try {
      socket.bind(() => {
        socket.send(
          searchMessage,
          0,
          searchMessage.length,
          SSDP_PORT,
          SSDP_ADDR
        );
      });
    } catch (err) {
      resolve([]);
    }

    setTimeout(() => {
      socket.close();
      resolve(found);
    }, 2000);
  });

  // Method 2: Local network scan
  const getLocalSubnet = () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          const parts = iface.address.split(".");
          return `${parts[0]}.${parts[1]}.${parts[2]}`;
        }
      }
    }
    return null;
  };

  const subnet = getLocalSubnet();
  const scanIPs = [];

  // Scan common IP ranges in the local subnet
  if (subnet) {
    // Scan a limited range for performance (typically home routers use .1-.254)
    // We'll scan in chunks to avoid overwhelming the network
    const ranges = [
      [1, 50], // Common router/device range
      [100, 150], // Common DHCP range
      [200, 254], // Upper DHCP range
    ];

    for (const [start, end] of ranges) {
      for (let i = start; i <= end; i++) {
        scanIPs.push(`${subnet}.${i}`);
      }
    }
  }

  // Check SSDP discovered IPs first
  console.log(`Found ${ssdpDevices.length} devices via SSDP`);
  for (const ip of ssdpDevices) {
    const device = await checkRokuAtIP(ip);
    if (device && !seen.has(device.ip)) {
      seen.add(device.ip);
      devices.push(device);
    }
  }

  // Then do network scan (in parallel batches for speed)
  console.log(`Scanning ${scanIPs.length} IPs on local network...`);
  const batchSize = 50;
  for (let i = 0; i < scanIPs.length; i += batchSize) {
    const batch = scanIPs.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(checkRokuAtIP));

    for (const device of results) {
      if (device && !seen.has(device.ip)) {
        seen.add(device.ip);
        devices.push(device);
        console.log(`Found Roku device: ${device.name} at ${device.ip}`);
      }
    }
  }

  console.log(`Total Roku devices found: ${devices.length}`);
  return devices;
}

// Function to build and deploy Roku app
async function buildAndDeployRokuApp(rokuIp, username, password) {
  return new Promise((resolve, reject) => {
    const archiver = require("archiver");

    // Create zip of rokuapp directory
    const zipPath = path.join(__dirname, "rokuapp.zip");
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      console.log(`Roku app package created: ${archive.pointer()} bytes`);

      // Update MainScene.brs with current URL before deploying
      const mainScenePath = path.join(
        __dirname,
        "rokuapp",
        "components",
        "MainScene.brs"
      );
      let mainSceneContent = fs.readFileSync(mainScenePath, "utf8");

      // Replace URL in the config section
      mainSceneContent = mainSceneContent.replace(
        /URL = ".*?"/,
        `URL = "${config.url}"`
      );

      // Write to temp location
      const tempMainScenePath = path.join(__dirname, "MainScene.brs.tmp");
      fs.writeFileSync(tempMainScenePath, mainSceneContent);

      // Recreate zip with updated file
      const output2 = fs.createWriteStream(zipPath);
      const archive2 = archiver("zip", { zlib: { level: 9 } });

      output2.on("close", async () => {
        // Deploy to Roku using curl (handles Digest auth automatically)
        const { spawn } = require("child_process");

        const curlArgs = [
          "--digest",
          "-u",
          `${username}:${password}`,
          "-F",
          "mysubmit=Replace",
          "-F",
          `archive=@${zipPath}`,
          "-w",
          "\n%{http_code}",  // Write HTTP status code at the end
          `http://${rokuIp}/plugin_install`,
        ];

        const curl = spawn("curl", curlArgs);
        let output = "";
        let errorOutput = "";

        curl.stdout.on("data", (data) => {
          output += data.toString();
        });

        curl.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        curl.on("close", (code) => {
          // Clean up
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
          if (fs.existsSync(tempMainScenePath))
            fs.unlinkSync(tempMainScenePath);

          // Extract HTTP status code from output
          const lines = output.trim().split('\n');
          const httpCode = lines[lines.length - 1];
          const responseBody = lines.slice(0, -1).join('\n');

          console.log(`Roku deployment HTTP status: ${httpCode}`);
          console.log("Response body:", responseBody);

          if (code === 0 && httpCode === "200") {
            console.log("Roku app deployed successfully");
            resolve();
          } else if (httpCode === "401") {
            reject(new Error("Authentication failed. Please check your developer password."));
          } else if (code !== 0) {
            console.error("curl stderr:", errorOutput);
            reject(
              new Error(
                `Deployment failed with exit code ${code}: ${errorOutput}`
              )
            );
          } else {
            reject(new Error(`Deployment failed with HTTP status ${httpCode}. Response: ${responseBody}`));
          }
        });

        curl.on("error", (error) => {
          // Clean up on error
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
          if (fs.existsSync(tempMainScenePath))
            fs.unlinkSync(tempMainScenePath);
          reject(new Error(`Failed to execute curl: ${error.message}`));
        });
      });

      archive2.on("error", (err) => {
        reject(err);
      });

      archive2.pipe(output2);

      // Add all roku app files with updated MainScene.brs
      archive2.directory(
        path.join(__dirname, "rokuapp", "components"),
        "components",
        {
          ignore: ["MainScene.brs"],
        }
      );
      archive2.file(tempMainScenePath, { name: "components/MainScene.brs" });
      archive2.directory(path.join(__dirname, "rokuapp", "source"), "source");

      // Add images directory (contains app icons)
      const imagesDir = path.join(__dirname, "rokuapp", "images");
      if (fs.existsSync(imagesDir)) {
        archive2.directory(imagesDir, "images");
      }

      // Add manifest
      const manifestPath = path.join(__dirname, "rokuapp", "manifest");
      if (fs.existsSync(manifestPath)) {
        archive2.file(manifestPath, { name: "manifest" });
      }

      archive2.finalize();
    });

    archive.on("error", (err) => {
      reject(err);
    });

    archive.pipe(output);
    archive.directory(path.join(__dirname, "rokuapp"), false);
    archive.finalize();
  });
}

http.listen(port, () => {
  console.log(`Serving http://localhost${port == 80 ? "" : `:${port}`}`);

  // Fetch missing thumbnails on startup
  console.log("Checking for missing thumbnails...");
  const getThumbnails = require("./diskrip/get_thumbnails.js");
  getThumbnails.main().catch((error) => {
    console.error("Error fetching thumbnails on startup:", error.message);
  });
});

io.on("connection", (socket) => {
  var c = new client(socket);
});
