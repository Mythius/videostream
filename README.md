# Video Stream Server & Roku App

A self-hosted video streaming solution with support for web browsers, Roku devices, and a desktop application. Stream your personal video collection across all your devices.

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Server Setup](#server-setup)
- [Desktop App](#desktop-app)
- [Roku App Setup](#roku-app-setup)
- [Configuration](#configuration)
- [Recommended Tools](#recommended-tools)

## Features

- 🎬 Stream videos from your local collection
- 📱 Web-based interface accessible from any browser
- 📺 Native Roku app support
- 💻 Cross-platform desktop application (Windows, macOS, Linux)
- 🔐 Password protection
- 🎯 Automatic network IP detection
- 📂 Customizable video directory

## Requirements

### Server & Desktop App

- **Node.js**: Version 18.x or higher recommended
  - Check your version: `node --version`
  - Download from: https://nodejs.org/
- **npm**: Comes bundled with Node.js
  - Check your version: `npm --version`
- **Operating System**:
  - Linux (Ubuntu, Debian, etc.)
  - macOS
  - Windows 10/11

### Desktop App Build Requirements

- **macOS** (for building macOS apps):
  - Xcode Command Line Tools
- **Windows** (for building Windows apps):
  - Windows 10/11
- **Linux** (for building Linux apps):
  - Standard build tools (`build-essential` on Debian/Ubuntu)

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/mythius/videostream
   cd videostream
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure the server** (optional)

   The server will auto-generate a `config.json` file on first run, but you can create it manually:

   ```json
   {
     "serverName": "192.168.1.100:3000",
     "videoDirectory": "/path/to/your/videos",
     "password": "your-secure-password",
     "url": "http://192.168.1.100:3000"
   }
   ```

## Server Setup

### Quick Start (Development)

```bash
npm start
```

The server will start on port `3000` by default. Access it at:
- Local: `http://localhost:3000`
- Network: `http://YOUR_LOCAL_IP:3000`

### Production Deployment

#### Option 1: Using PM2 (Recommended)

1. **Install PM2 globally**
   ```bash
   npm install -g pm2
   ```

2. **Start the server**
   ```bash
   pm2 start server.js --name "videostream"
   ```

3. **Enable auto-start on system boot**
   ```bash
   pm2 startup
   pm2 save
   ```

4. **Useful PM2 commands**
   ```bash
   pm2 status              # Check server status
   pm2 logs videostream    # View logs
   pm2 restart videostream # Restart server
   pm2 stop videostream    # Stop server
   ```

#### Option 2: Systemd Service (Linux)

1. **Create a service file**
   ```bash
   sudo nano /etc/systemd/system/videostream.service
   ```

2. **Add the following configuration** (adjust paths as needed):
   ```ini
   [Unit]
   Description=Video Stream Server
   After=network.target

   [Service]
   Type=simple
   User=YOUR_USERNAME
   WorkingDirectory=/path/to/videostream
   ExecStart=/usr/bin/node /path/to/videostream/server.js
   Restart=on-failure
   RestartSec=10
   StandardOutput=syslog
   StandardError=syslog
   SyslogIdentifier=videostream

   [Install]
   WantedBy=multi-user.target
   ```

3. **Enable and start the service**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable videostream
   sudo systemctl start videostream
   ```

4. **Useful systemd commands**
   ```bash
   sudo systemctl status videostream  # Check status
   sudo systemctl restart videostream # Restart
   sudo systemctl stop videostream    # Stop
   sudo journalctl -u videostream -f  # View logs
   ```

#### Option 3: Docker (Alternative)

If you prefer Docker, you can create a `Dockerfile`:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

Then build and run:
```bash
docker build -t videostream .
docker run -d -p 3000:3000 -v /path/to/videos:/app/site/videos --name videostream videostream
```

### Firewall Configuration

Make sure port `3000` is open on your server:

**Linux (ufw)**:
```bash
sudo ufw allow 3000/tcp
```

**Linux (firewalld)**:
```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

**Windows Firewall**:
```powershell
New-NetFirewallRule -DisplayName "Video Stream" -Direction Inbound -Port 3000 -Protocol TCP -Action Allow
```

## Desktop App

The desktop application bundles the server with an Electron-based GUI.

### Running the Desktop App (Development)

```bash
npm run desktop
```

### Building the Desktop App

#### Build for Your Current Platform

```bash
npm run build
```

The built application will be in the `dist/` directory.

#### Build for Specific Platforms

**macOS**:
```bash
npm run build:mac
```
Outputs:
- `.dmg` installer
- `.zip` archive

**Windows**:
```bash
npm run build:win
```
Outputs:
- NSIS installer (`.exe`)
- Portable executable

**Linux**:
```bash
npm run build:linux
```
Outputs:
- AppImage (universal)
- `.deb` package (Debian/Ubuntu)

#### Cross-Platform Building

Note: You typically need to build on the target platform:
- macOS apps: Build on macOS
- Windows apps: Build on Windows (or use wine on Linux)
- Linux apps: Build on Linux

#### Build Configuration

The build configuration is in [package.json](package.json) under the `build` section. The built app is named **MatthiasTV** and includes:
- The Express server
- Web interface files
- Roku app source
- All dependencies

## Roku App Setup

### Prerequisites

1. **Enable Developer Mode on your Roku**
   - Press Home 3x, Up 2x, Right, Left, Right, Left, Right
   - Set a developer password
   - Note your Roku's IP address

2. **Configure the Server URL**

   Update the server URL in two places:

   **a. Server configuration** - [config.json](config.json):
   ```json
   {
     "serverName": "YOUR_SERVER_IP:3000",
     "url": "http://YOUR_SERVER_IP:3000"
   }
   ```

   **b. Roku app** - `rokuapp/components/MainScene.brs`:
   ```brightscript
   ' Update the server URL
   m.baseURL = "http://YOUR_SERVER_IP:3000"
   ```

### Creating the Roku Channel

1. **Zip the Roku app**
   ```bash
   cd rokuapp
   zip -r ../roku-channel.zip .
   cd ..
   ```

2. **Install on Roku**
   - Open browser to `http://ROKU_IP` (where ROKU_IP is your Roku's IP address)
   - Login with your developer password
   - Click "Upload" and select `roku-channel.zip`
   - Click "Install"

3. **Launch the channel** on your Roku device

For detailed Roku development instructions, see the [Roku Developer Setup Guide](https://developer.roku.com/docs/developer-program/getting-started/developer-setup.md).

## Configuration

### config.json Options

| Option | Description | Default |
|--------|-------------|---------|
| `serverName` | Server address (IP:port or domain:port) | Auto-detected local IP with port 3000 |
| `videoDirectory` | Absolute path to your video folder | `./site/videos` |
| `password` | Password for accessing the stream | `matthiasmovies` |
| `url` | Full server URL including protocol | `http://[local-ip]:3000` |

### Changing the Port

Edit [server.js](server.js):
```javascript
const port = 3000; // Change this to your desired port
```

### Video Directory Structure

Place your video files in the configured `videoDirectory`. Supported formats:
- MP4 (recommended)
- MKV
- AVI
- MOV
- WebM

## Recommended Tools

If you're building your own video collection from DVDs/Blu-rays:

### Ripping DVDs/Blu-rays

**MakeMKV** - Free and open-source disc ripper
- Download: https://www.makemkv.com/
- Supports DVDs and Blu-rays
- Creates lossless MKV files

### Converting Videos

**FFmpeg** - Powerful video conversion tool

**Installation**:
- **Windows**: `winget install ffmpeg`
- **Linux**: `sudo apt install ffmpeg` (Ubuntu/Debian) or `sudo yum install ffmpeg` (RHEL/CentOS)
- **macOS**: `brew install ffmpeg`

**Example conversion** (MKV to MP4):
```bash
ffmpeg -i input.mkv -c:v libx264 -c:a aac -strict experimental output.mp4
```

**Batch conversion** (Linux/macOS):
```bash
for file in *.mkv; do
  ffmpeg -i "$file" -c:v libx264 -c:a aac "${file%.mkv}.mp4"
done
```

## Troubleshooting

### Server won't start
- Check if port 3000 is already in use: `lsof -i :3000` (macOS/Linux) or `netstat -ano | findstr :3000` (Windows)
- Verify Node.js is installed: `node --version`
- Check file permissions on the video directory

### Can't access from other devices
- Verify firewall allows port 3000
- Ensure devices are on the same network
- Check server is binding to `0.0.0.0` not `localhost`

### Videos won't play
- Verify video format is supported
- Check file permissions
- Ensure video files are in the configured directory
- Check browser console for errors

### Desktop app build fails
- Clear node_modules: `rm -rf node_modules && npm install`
- Clear electron cache: `rm -rf ~/.electron`
- Ensure electron-builder is installed: `npm install --save-dev electron-builder`

## License

ISC

## Contributing

Issues and pull requests are welcome! Please see the [issues page](https://github.com/mythius/mylib/issues).

## Support

For questions or support, please open an issue on GitHub.
