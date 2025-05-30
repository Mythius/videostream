var express = require('express');
var app = express();
var http = require('http').createServer(app);
var io = require('socket.io')(http);
var fs = require('fs');
var system = require('child_process');
const cookieParser = require('cookie-parser');
const path = require('path');
const cors = require('cors');
app.use(cors({
  origin: '*'
}));



var file = {
	save: function(name,text){
		fs.writeFile(name,text,e=>{
			if(e) console.log(e);
		});
	},
	read: function(name,callback){
		fs.readFile(name,(error,buffer)=>{
			if (error) console.log(error);
			else callback(buffer.toString());
		});
	}
}

class client{
	static all = [];
	constructor(socket){
		this.socket = socket;
		this.name = null;
		this.tiles = [];
		client.all.push(this);
		socket.on('disconnect',e=>{
			let index = client.all.indexOf(this);
			if(index != -1){
				client.all.splice(index,1);
			}
		});
	}
	emit(name,dat){
		this.socket.emit(name,dat);
	}
}

const port = 80;
const mainfolder = __dirname+'/';

app.use(cookieParser());

const PASSWORD = 'matthiasmovies'; // Change this to your desired password
const COOKIE_NAME = 'auth';

function authMiddleware(req, res, next) {
    // Allow access to static files (like CSS, JS, video files)
    if (
        // req.path.startsWith('/videos/') ||
        req.path.startsWith('/socket.io/') ||
        req.path.startsWith('/favicon.ico')
    ) {
        return next();
    }

    // Check for password in cookie
    if (req.cookies && req.cookies[COOKIE_NAME] === PASSWORD) {
        return next();
    }

    // If POST, check password
    if (req.method === 'POST' && req.path === '/login') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const params = new URLSearchParams(body);
            if (params.get('password') === PASSWORD) {
                res.cookie(COOKIE_NAME, PASSWORD, { httpOnly: true });
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

// app.use(authMiddleware);

app.use(express.static(mainfolder+'site/'));

app.get('/movies/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'site', 'videos', req.params.filename);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return res.sendStatus(404);
    }

    const range = req.headers.range;
    if (!range) {
      // Send entire file (not ideal for streaming clients)
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Parse Range
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stats.size - 1;

    const chunkSize = (end - start) + 1;

    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stats.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });

    file.pipe(res);
  });
});

app.get('/', (req, res) => {
    const videoDir = mainfolder + 'site/videos';
    fs.readdir(videoDir, (err, files) => {
        if (err) {
            res.status(500).send('Error reading video directory');
            return;
        }
        // Filter out non-files and hidden files if needed
        const links = files
            .filter(f => !f.startsWith('.'))
			.sort()
            .map(f => {
                const name = f.replace(/\.[^/.]+$/, ''); // Remove extension
                return `<a href="/${encodeURIComponent(name)}">${name}</a>`;
            })
            .join('<br>');
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


app.get('/json', (req, res) => {
    const videoDir = mainfolder + 'site/videos';
    console.log(videoDir);
    fs.readdir(videoDir, (err, files) => {
        if (err) {
	    console.log(err);
            res.status(500).send('Error reading video directory');
            return;
        }

        function getImage(name){
            const imgName = name.replace(/\.[^/.]+$/, '') + '.png';
            const imgPath = path.join(mainfolder, 'site', 'imgs', imgName);
            if (fs.existsSync(imgPath)) {
                return `https://media.msouthwick.com/imgs/${encodeURIComponent(imgName)}`;
            } else {
                return 'https://media.msouthwick.com/clapboard.jpg';
            }
        }

        // Filter out non-files and hidden files if needed
        const links = files
            .filter(f => !f.startsWith('.'))
            .sort()
	        .map(e=>{
        	return {
                    url: `http://192.168.0.153/movies/${encodeURI(e)}`,
                    thumbnail: getImage(e),
                    title: e.replace(/\.[^/.]+$/, '')
                };
            });

	res.send(links);
    });
});

app.get('/:video', (req, res) => {
    const videoName = req.params.video;
    const videoPath = `site/videos/${videoName}.mp4`;
    fs.access(videoPath, fs.constants.F_OK, (err) => {
        if (err) {
            res.status(404).send('Video not found');
            return;
        }
        res.send(`
            <html>
                <body>
                    <video width="640" height="480" controls>
                        <source src="/videos/${encodeURIComponent(videoName)}.mp4" type="video/mp4">
                        Your browser does not support the video tag.
                    </video>
                </body>
            </html>
        `);
    });
});


http.listen(port,()=>{console.log('Serving Port: '+port)});

io.on('connection',socket=>{
	var c = new client(socket);
});
