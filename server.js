/* CONFIG */
const url_name = "http://192.168.0.153";
const port = 80;

/* END CONFIG */

var express = require("express");
var app = express();
var http = require("http").createServer(app);
var io = require("socket.io")(http);
var fs = require("fs");
const path = require("path");
const cors = require("cors");
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

app.use(express.static(mainfolder + "site/"));

app.get("/movies/:filename", (req, res) => {
  const filePath = path.join(__dirname, "site", "videos", req.params.filename);

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

app.get("/", (req, res) => {
  const videoDir = mainfolder + "site/videos";
  fs.readdir(videoDir, (err, files) => {
    if (err) {
      res.status(500).send("Error reading video directory");
      return;
    }
    // Filter out non-files and hidden files if needed
    const links = files
      .filter((f) => !f.startsWith("."))
      .filter((f) => f.match(".mp4"))
      .sort()
      .map((f) => {
        const name = f.replace(/\.[^/.]+$/, ""); // Remove extension
        return `<a href="/${encodeURIComponent(name)}">${name}</a>`;
      })
      .join("<br>");
    res.send(`
        <html>
            <head><style>
                body{background-color:#234;}
                a{color: white;}
                h1{color: white; font-family:monospace;}
            </style></head>
            <body>
            <h1>Movie Server</h1>
            ${links}</body>
        </html>`);
  });
});

app.get("/json", (req, res) => {
  const videoDir = mainfolder + "site/videos";
  console.log(videoDir);
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
        return `${url_name}/imgs/${encodeURIComponent(imgName)}`;
      } else {
        return `${url_name}/clapboard.jpg`;
      }
    }

    // Filter out non-files and hidden files if needed
    const links = files
      .filter((f) => !f.startsWith("."))
      .sort()
      .map((e) => {
        return {
          url: `${url_name}/movies/${encodeURI(e)}`,
          thumbnail: getImage(e),
          title: e.replace(/\.[^/.]+$/, ""),
        };
      });

    res.send(links);
  });
});

app.get("/:video", (req, res) => {
  const videoName = req.params.video;
  const videoPath = `site/videos/${videoName}.mp4`;
  fs.access(videoPath, fs.constants.F_OK, (err) => {
    if (err) {
      res.status(404).send("Video not found");
      return;
    }
    res.send(`
            <html>
                <body>
                    <video width="640" height="480" controls>
                        <source src="/videos/${encodeURIComponent(
                          videoName
                        )}.mp4" type="video/mp4">
                        Your browser does not support the video tag.
                    </video>
                </body>
            </html>
        `);
  });
});

http.listen(port, () => {
  console.log(`Serving http://localhost${port == 80 ? "" : `:${port}`}`);
});

io.on("connection", (socket) => {
  var c = new client(socket);
});
