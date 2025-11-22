# Automatic CD/DVD Ripper

Automatically rips CD/DVD discs to MKV and converts to MP4 when inserted.

## Features

- Automatic disc detection and ripping
- Converts MKV to MP4 with configurable quality settings
- Runs as a systemd service
- Configurable output directories and quality settings
- Title filtering (rip only the longest title or multiple titles)
- Automatic disc ejection after completion
- Desktop notifications

## Installation

### Quick Start

Run the installation script:

```bash
cd diskrip
sudo ./install_dependencies.sh
```

The script is **idempotent** and can be safely run multiple times.

### What It Does

The installation script:

1. Installs FFmpeg for video conversion
2. Installs disk monitoring tools (udev, udisks2)
3. Installs native MakeMKV (removes snap version if present)
4. Creates output and temp directories from config.json
5. Sets up systemd service for automatic background operation
6. Configures udev rules for automatic disc detection
7. Installs Node.js dependencies

### Starting the Service

After installation:

```bash
# Enable service to start on boot
sudo systemctl enable ripdisk.service

# Start the service now
sudo systemctl start ripdisk.service

# Check status
sudo systemctl status ripdisk.service

# View real-time logs
sudo journalctl -u ripdisk.service -f
```

## Configuration

Edit [config.json](config.json):

```json
{
  "outputFolder": "/media/ripped-discs",
  "tempFolder": "/tmp/ripdisk",
  "diskDevice": "/dev/sr0",
  "titlesToRip": 1,
  "minTitleLength": 300,
  "autoEject": true,
  "notifyOnComplete": true,
  "keepMKV": false,
  "mp4Settings": {
    "videoCodec": "libx264",
    "audioCodec": "aac",
    "preset": "medium",
    "crf": 20
  }
}
```

### Configuration Options

- **outputFolder**: Final destination for MP4 files
- **tempFolder**: Temporary location for MKV files during ripping
- **diskDevice**: Optical drive device (usually `/dev/sr0`)
- **titlesToRip**: Number of titles to rip (1 = longest only, 2+ = multiple)
- **minTitleLength**: Minimum title length in seconds (default: 300 = 5 minutes)
- **autoEject**: Automatically eject disc when done
- **notifyOnComplete**: Show desktop notifications
- **keepMKV**: Keep original MKV files (false = delete after conversion)
- **createTempSubfolder**: Create subfolder per disc in tempFolder (default: true)

### MP4 Settings

- **videoCodec**: Video codec (`libx264`, `libx265`, `copy`)
- **audioCodec**: Audio codec (`aac`, `mp3`, `copy`)
- **preset**: Encoding speed (`ultrafast`, `fast`, `medium`, `slow`, `veryslow`)
- **crf**: Quality (0-51, lower = better quality, 18-23 recommended)

## Troubleshooting

### Check Service Status

```bash
sudo systemctl status ripdisk.service
```

### View Logs

```bash
# Real-time logs
sudo journalctl -u ripdisk.service -f

# Recent logs
sudo journalctl -u ripdisk.service -n 100

# Logs since last boot
sudo journalctl -u ripdisk.service -b
```

### Common Issues

#### Permission Errors

The service runs as root to access optical drives and write to system directories. If you see permission errors:

1. Check directory permissions:
   ```bash
   ls -la /media/ripped-discs
   ls -la /tmp/ripdisk
   ```

2. Ensure directories are writable:
   ```bash
   sudo chmod 777 /media/ripped-discs
   sudo chmod 777 /tmp/ripdisk
   ```

#### MakeMKV Not Found

If you see "makemkvcon command not found":

1. Verify MakeMKV is installed:
   ```bash
   which makemkvcon
   makemkvcon --version
   ```

2. Reinstall if needed:
   ```bash
   cd diskrip
   sudo ./install_dependencies.sh
   ```

#### Disc Not Detected

1. Check if disc is recognized by system:
   ```bash
   lsblk
   udisksctl info -b /dev/sr0
   ```

2. Manually trigger disc detection:
   ```bash
   sudo systemctl restart ripdisk.service
   ```

#### Service Won't Start

1. Check for syntax errors in ripdisk.js:
   ```bash
   node ripdisk.js
   ```

2. Check config.json is valid:
   ```bash
   cat config.json | jq .
   ```

### Manual Testing

Test without the service:

```bash
cd diskrip
node ripdisk.js
```

This runs the ripper in the foreground with full output.

## How It Works

1. Service monitors `/dev/sr0` for disc insertion
2. When detected, waits 5 seconds for disc to spin up
3. Scans disc with MakeMKV to find titles
4. Rips longest title(s) to MKV in temp folder
5. Converts MKV to MP4 with FFmpeg
6. Moves MP4 to output folder
7. Cleans up temporary MKV files (unless keepMKV is true)
8. Ejects disc (if autoEject is true)
9. Shows notification (if notifyOnComplete is true)

## Requirements

- Ubuntu/Debian Linux
- Node.js 14+ (for ripdisk.js)
- Optical drive
- Sufficient disk space for ripping (DVDs: ~8GB, Blu-ray: ~50GB)

## License

MIT
