
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
    minTitleLength: 300,
    autoEject: true,
    notifyOnComplete: true,
    keepMKV: false,
    mp4Settings: {
      videoCodec: "libx264",
      audioCodec: "aac",
      preset: "medium",
      crf: 20
    }
  }
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
      passwordRequired: existingConfig.passwordRequired !== undefined ? existingConfig.passwordRequired : config.passwordRequired,
      showSettings: existingConfig.showSettings !== undefined ? existingConfig.showSettings : config.showSettings,
      diskrip: existingConfig.diskrip || config.diskrip
    };
  }

  // Auto-generate URL if not set
  // If url is not set, create it from local IP and port
  if (!config.url) {
    const localIP = getLocalIPv4();
    config.url = `http://${localIP}:${config.port}`;
    fetch('https://moviedb.msouthwick.com/submit?url=' + encodeURIComponent(localIP));
  }

  // Ensure URL has protocol (http:// or https://)
  if (!config.url.startsWith('http://') && !config.url.startsWith('https://')) {
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

const COOKIE_NAME = 'auth';

// Login endpoint - MUST be before authMiddleware
app.post("/login", express.urlencoded({ extended: true }), (req, res) => {
  const { password, next } = req.body;

  if (password === config.password) {
    res.cookie(COOKIE_NAME, config.password, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });
    res.redirect(next || '/');
  } else {
    res.redirect('/login.html?error=incorrect' + (next ? '&next=' + encodeURIComponent(next) : ''));
  }
});

// Password protection middleware
function authMiddleware(req, res, next) {
    // Skip authentication if password is not required
    if (!config.passwordRequired) {
        return next();
    }

    // Always allow access to login page and static assets
    if (req.path === '/login.html' ||
        req.path.startsWith('/clapboard.jpg') ||
        req.path.startsWith('/imgs/') ||
        req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico|woff|woff2|ttf)$/)) {
        return next();
    }

    // Always allow access to /movies and /json endpoints (for Roku app)
    if (req.path.startsWith('/movies/') || req.path === '/json') {
        return next();
    }

    // Check for password in cookie
    if (req.cookies && req.cookies[COOKIE_NAME] === config.password) {
        return next();
    }

    // Not authenticated - redirect to login
    const nextPath = req.path !== '/' ? req.path : '';
    res.redirect('/login.html' + (nextPath ? '?next=' + encodeURIComponent(nextPath) : ''));
}

app.use(authMiddleware);

// Middleware to block settings page if showSettings is false
app.use((req, res, next) => {
  if (!config.showSettings && (req.path === '/settings.html' || req.path.startsWith('/api/settings') || req.path.startsWith('/api/movies-list') || req.path.startsWith('/api/rename-movie') || req.path.startsWith('/api/upload-thumbnail'))) {
    return res.status(403).send('Settings page is disabled. Set showSettings to true in config.json to enable.');
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

// Helper function to generate movie card HTML
function generateMovieCardHTML(movie) {
  return `
                <div class="movie-card" onclick="window.location.href='${movie.url}'">
                    <img src="${movie.thumbnail}" alt="${movie.title}" class="movie-poster" onerror="this.src='/clapboard.jpg'">
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

    // Scan video directory
    const videoDir = config.videoDirectory;
    const files = fs.readdirSync(videoDir)
      .filter((f) => !f.startsWith("."))
      .filter((f) => f.match(".mp4"))
      .sort();

    // Generate movie data array
    const moviesData = files.map((f) => {
      const name = f.replace(/\.[^/.]+$/, ""); // Remove extension
      return {
        url: `/movies/${encodeURIComponent(name)}`,
        thumbnail: getMovieThumbnail(name),
        title: name,
      };
    });

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

app.get("/json", (req, res) => {
  const videoDir = config.videoDirectory;
  fs.readdir(videoDir, (err, files) => {
    if (err) {
      console.log(err);
      res.status(500).send("Error reading video directory");
      return;
    }

    function getImage(name) {
      const movieName = name.replace(/\.[^/.]+$/, "");
      const imgPath = path.join(mainfolder, "site", "imgs", movieName + ".png");
      if (fs.existsSync(imgPath)) {
        return `${config.url}/imgs/${encodeURIComponent(movieName)}.png`;
      } else {
        return `${config.url}/clapboard.jpg`;
      }
    }

    // Filter out non-files and hidden files if needed
    const links = files
      .filter((f) => !f.startsWith("."))
      .filter((f) => f.match(".mp4"))
      .sort()
      .map((e) => {
        const movieName = e.replace(/\.[^/.]+$/, ""); // Remove .mp4 extension
        return {
          url: `${config.url}/movies/${encodeURIComponent(movieName)}`,
          thumbnail: getImage(e),
          title: movieName,
        };
      });

    res.send(links);
  });
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
    error: "Unauthorized: Please log in to access this endpoint"
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

// API: Get movies list for settings page
app.get("/api/movies-list", requireAuth, (req, res) => {
  try {
    const videoDir = config.videoDirectory;
    const files = fs.readdirSync(videoDir)
      .filter((f) => !f.startsWith("."))
      .filter((f) => f.endsWith(".mp4"))
      .sort();

    const movies = files.map((f) => {
      const name = f.replace(/\.mp4$/i, "");
      return {
        title: name,
        thumbnail: getMovieThumbnail(name),
        filename: f
      };
    });

    res.json(movies);
  } catch (error) {
    console.error("Error getting movies list:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Rename movie
app.post("/api/rename-movie", requireAuth, express.json(), async (req, res) => {
  const { oldName, newName } = req.body;

  if (!oldName || !newName) {
    return res.status(400).json({ error: "Old name and new name are required" });
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

    // Check if new name already exists
    if (fs.existsSync(newVideoPath)) {
      return res.status(400).json({ error: "A movie with this name already exists" });
    }

    // Rename video file
    fs.renameSync(oldVideoPath, newVideoPath);

    // Rename thumbnail if it exists
    if (fs.existsSync(oldThumbnailPath)) {
      fs.renameSync(oldThumbnailPath, newThumbnailPath);
    }

    console.log(`Renamed movie: ${oldName} -> ${newName}`);

    // Fetch new thumbnail for the renamed movie in the background
    const getThumbnails = require('./diskrip/get_thumbnails.js');
    getThumbnails.main().catch(error => {
      console.error('Error fetching thumbnails after rename:', error.message);
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error renaming movie:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Upload thumbnail
const multer = require('multer');
const upload = multer({ dest: path.join(mainfolder, "site", "imgs", "temp") });

app.post("/api/upload-thumbnail", requireAuth, upload.single('thumbnail'), async (req, res) => {
  const { movieName } = req.body;
  const file = req.file;

  if (!movieName || !file) {
    return res.status(400).json({ error: "Movie name and thumbnail file are required" });
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
});

// API: Get settings
app.get("/api/settings", requireAuth, (req, res) => {
  res.json({
    serviceName: config.serviceName,
    url: config.url,
    password: config.password,
    passwordRequired: config.passwordRequired
  });
});

// API: Update settings
app.post("/api/settings", requireAuth, express.json(), (req, res) => {
  const { serviceName, url, password, passwordRequired } = req.body;

  try {
    if (serviceName !== undefined) config.serviceName = serviceName;
    if (password !== undefined) config.password = password;
    if (passwordRequired !== undefined) config.passwordRequired = passwordRequired;

    // Update URL if provided
    if (url !== undefined) {
      config.url = url;
      // Ensure URL has protocol (http:// or https://)
      if (!config.url.startsWith('http://') && !config.url.startsWith('https://')) {
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
      const http = require('http');
      const req = http.get({
        hostname: ip,
        port: 8060,
        path: '/query/device-info',
        timeout: 1000
      }, (resp) => {
        let data = '';
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => {
          if (data.includes('Roku') || data.includes('roku')) {
            const nameMatch = data.match(/<friendly-device-name>(.*?)<\/friendly-device-name>/);
            const modelMatch = data.match(/<model-name>(.*?)<\/model-name>/);
            const name = nameMatch ? nameMatch[1] : (modelMatch ? modelMatch[1] : 'Roku Device');
            resolve({ ip, name });
          } else {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  };

  // Method 1: SSDP Discovery
  const ssdpDevices = await new Promise((resolve) => {
    const dgram = require('dgram');
    const socket = dgram.createSocket('udp4');
    const found = [];

    const SSDP_ADDR = '239.255.255.250';
    const SSDP_PORT = 1900;
    const searchMessage = Buffer.from([
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 3',
      'ST: roku:ecp',
      '',
      ''
    ].join('\r\n'));

    socket.on('message', (msg, rinfo) => {
      const message = msg.toString();
      if ((message.includes('Roku') || message.includes('roku')) && !found.includes(rinfo.address)) {
        found.push(rinfo.address);
      }
    });

    socket.on('error', () => {
      socket.close();
      resolve([]);
    });

    try {
      socket.bind(() => {
        socket.send(searchMessage, 0, searchMessage.length, SSDP_PORT, SSDP_ADDR);
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
        if (iface.family === 'IPv4' && !iface.internal) {
          const parts = iface.address.split('.');
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
      [1, 50],    // Common router/device range
      [100, 150], // Common DHCP range
      [200, 254]  // Upper DHCP range
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

    // If we've found devices, we can stop scanning
    if (devices.length > 0 && i > batchSize * 2) {
      console.log(`Found ${devices.length} device(s), stopping scan early`);
      break;
    }
  }

  console.log(`Total Roku devices found: ${devices.length}`);
  return devices;
}

// Function to build and deploy Roku app
async function buildAndDeployRokuApp(rokuIp, username, password) {
  return new Promise((resolve, reject) => {
    const archiver = require('archiver');

    // Create zip of rokuapp directory
    const zipPath = path.join(__dirname, 'rokuapp.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`Roku app package created: ${archive.pointer()} bytes`);

      // Update MainScene.brs with current URL before deploying
      const mainScenePath = path.join(__dirname, 'rokuapp', 'components', 'MainScene.brs');
      let mainSceneContent = fs.readFileSync(mainScenePath, 'utf8');

      // Replace URL in the config section
      mainSceneContent = mainSceneContent.replace(
        /URL = ".*?"/,
        `URL = "${config.url}"`
      );

      // Write to temp location
      const tempMainScenePath = path.join(__dirname, 'MainScene.brs.tmp');
      fs.writeFileSync(tempMainScenePath, mainSceneContent);

      // Recreate zip with updated file
      const output2 = fs.createWriteStream(zipPath);
      const archive2 = archiver('zip', { zlib: { level: 9 } });

      output2.on('close', async () => {
        // Deploy to Roku using curl (handles Digest auth automatically)
        const { spawn } = require('child_process');

        const curlArgs = [
          '--digest',
          '-u', `${username}:${password}`,
          '-F', 'mysubmit=Replace',
          '-F', `archive=@${zipPath}`,
          `http://${rokuIp}/plugin_install`
        ];

        const curl = spawn('curl', curlArgs);
        let output = '';
        let errorOutput = '';

        curl.stdout.on('data', (data) => {
          output += data.toString();
        });

        curl.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        curl.on('close', (code) => {
          // Clean up
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
          if (fs.existsSync(tempMainScenePath)) fs.unlinkSync(tempMainScenePath);

          if (code === 0) {
            console.log('Roku app deployed successfully');
            console.log('Response:', output);
            resolve();
          } else {
            console.error('curl stderr:', errorOutput);
            reject(new Error(`Deployment failed with exit code ${code}: ${errorOutput}`));
          }
        });

        curl.on('error', (error) => {
          // Clean up on error
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
          if (fs.existsSync(tempMainScenePath)) fs.unlinkSync(tempMainScenePath);
          reject(new Error(`Failed to execute curl: ${error.message}`));
        });
      });

      archive2.on('error', (err) => {
        reject(err);
      });

      archive2.pipe(output2);

      // Add all roku app files with updated MainScene.brs
      archive2.directory(path.join(__dirname, 'rokuapp', 'components'), 'components', {
        ignore: ['MainScene.brs']
      });
      archive2.file(tempMainScenePath, { name: 'components/MainScene.brs' });
      archive2.directory(path.join(__dirname, 'rokuapp', 'source'), 'source');

      // Add images directory (contains app icons)
      const imagesDir = path.join(__dirname, 'rokuapp', 'images');
      if (fs.existsSync(imagesDir)) {
        archive2.directory(imagesDir, 'images');
      }

      // Add manifest
      const manifestPath = path.join(__dirname, 'rokuapp', 'manifest');
      if (fs.existsSync(manifestPath)) {
        archive2.file(manifestPath, { name: 'manifest' });
      }

      archive2.finalize();
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);
    archive.directory(path.join(__dirname, 'rokuapp'), false);
    archive.finalize();
  });
}

http.listen(port, () => {
  console.log(`Serving http://localhost${port == 80 ? "" : `:${port}`}`);

  // Fetch missing thumbnails on startup
  console.log('Checking for missing thumbnails...');
  const getThumbnails = require('./diskrip/get_thumbnails.js');
  getThumbnails.main().catch(error => {
    console.error('Error fetching thumbnails on startup:', error.message);
  });
});

io.on("connection", (socket) => {
  var c = new client(socket);
});
