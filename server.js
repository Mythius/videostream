
var express = require("express");
var app = express();
var http = require("http").createServer(app);
var io = require("socket.io")(http);
var fs = require("fs");
const path = require("path");
const cors = require("cors");
const os = require("os");

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
  port: 3000,
  serverName: null, // Will be set below based on port
  videoDirectory: path.join(__dirname, "site", "videos"),
  password: "matthiasmovies", // Default password
  passwordRequired: false, // Set to true to enable password protection
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
  // Try to read existing config
  if (fs.existsSync(configPath)) {
    const existingConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

    // Merge with defaults, keeping existing values
    config = {
      port: existingConfig.port || config.port,
      serverName: existingConfig.serverName || null,
      videoDirectory: existingConfig.videoDirectory || config.videoDirectory,
      password: existingConfig.password || config.password,
      passwordRequired: existingConfig.passwordRequired !== undefined ? existingConfig.passwordRequired : config.passwordRequired,
      diskrip: existingConfig.diskrip || config.diskrip
    };
  }

  // Get the local IP and create the default server name with port
  const localIP = getLocalIPv4();
  const defaultServerName = `${localIP}:${config.port}`;

  // Set serverName if not already set
  if (!config.serverName) {
    config.serverName = defaultServerName;
  }

  // Build the full URL from serverName
  const url_name = config.serverName.startsWith('http')
    ? config.serverName
    : `http://${config.serverName}`;

  config.url = url_name; // For backwards compatibility

  // Write updated config
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Config written to ${configPath}`);
  console.log(`Port: ${config.port}`);
  console.log(`Server Name: ${config.serverName}`);
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

// Password protection middleware - only for GET /
function authMiddleware(req, res, next) {
    // Skip authentication if password is not required
    if (!config.passwordRequired) {
        return next();
    }

    // Only protect GET / route
    if (req.path !== '/' && req.path !== '/login') {
        return next();
    }

    // Check for password in cookie
    if (req.cookies && req.cookies[COOKIE_NAME] === config.password) {
        return next();
    }

    // If POST to /login, check password
    if (req.method === 'POST' && req.path === '/login') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const params = new URLSearchParams(body);
            if (params.get('password') === config.password) {
                res.cookie(COOKIE_NAME, config.password, { httpOnly: true });
                res.redirect(req.query.next || '/');
            } else {
                res.send(`<html><body>
                    <form method="POST" action="/login">
                        <input type="password" name="password" placeholder="Password" autofocus>
                        <button type="submit">Login</button>
                        <div style="color:red;">Incorrect password</div>
                    </form>
                </body></html>`);
            }
        });
        return;
    }

    // Show login form
    res.send(`<html><body>
        <form method="POST" action="/login${req.path !== '/' ? '?next=' + encodeURIComponent(req.path) : ''}">
            <input type="password" name="password" placeholder="Password" autofocus>
            <button type="submit">Login</button>
        </form>
    </body></html>`);
}

app.use(authMiddleware);

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

// Helper function to get thumbnail URL with fallback to clapboard.jpg
function getMovieThumbnail(movieName) {
  const imgName = movieName + ".png";
  const imgPath = path.join(mainfolder, "site", "imgs", imgName);
  if (fs.existsSync(imgPath)) {
    return `${config.url}/imgs/${encodeURIComponent(imgName)}`;
  } else {
    return `${config.url}/clapboard.jpg`;
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
      .replace("__MOVIES_DATA__", JSON.stringify(moviesData));

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
      const imgName = name.replace(/\.[^/.]+$/, "") + ".png";
      const imgPath = path.join(mainfolder, "site", "imgs", imgName);
      if (fs.existsSync(imgPath)) {
        return `${config.url}/imgs/${encodeURIComponent(imgName)}`;
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
        return {
          url: `${config.url}/movies/${encodeURI(e)}`,
          thumbnail: getImage(e),
          title: e.replace(/\.[^/.]+$/, ""),
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
