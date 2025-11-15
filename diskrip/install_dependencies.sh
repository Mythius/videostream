#!/bin/bash

# CD/DVD Ripper Installation Script for Ubuntu
# This script installs all necessary dependencies for automatic disc ripping

set -e

echo "=== CD/DVD Ripper Dependency Installation ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (use sudo)"
    exit 1
fi

echo "Updating package lists..."
apt-get update

echo ""
echo "Installing MakeMKV dependencies..."
# MakeMKV CLI
apt-get install -y build-essential pkg-config libc6-dev libssl-dev libexpat1-dev libavcodec-dev libgl1-mesa-dev qtbase5-dev zlib1g-dev wget

echo ""
echo "Installing FFmpeg..."
apt-get install -y ffmpeg

echo ""
echo "Installing disk monitoring tools..."
apt-get install -y udev inotify-tools udisks2

echo ""
echo "Installing Node.js (if not already installed)..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y nodejs
else
    echo "Node.js already installed: $(node --version)"
fi

echo ""
echo "Installing MakeMKV..."
# Download and install MakeMKV
MAKEMKV_VERSION="1.17.5"
MAKEMKV_OSS="makemkv-oss-${MAKEMKV_VERSION}"
MAKEMKV_BIN="makemkv-bin-${MAKEMKV_VERSION}"

cd /tmp

# Install MakeMKV OSS (open source component)
if [ ! -d "$MAKEMKV_OSS" ]; then
    wget "https://www.makemkv.com/download/${MAKEMKV_OSS}.tar.gz"
    tar -xzf "${MAKEMKV_OSS}.tar.gz"
fi
cd "$MAKEMKV_OSS"
./configure
make
make install
cd /tmp

# Install MakeMKV BIN (binary component)
if [ ! -d "$MAKEMKV_BIN" ]; then
    wget "https://www.makemkv.com/download/${MAKEMKV_BIN}.tar.gz"
    tar -xzf "${MAKEMKV_BIN}.tar.gz"
fi
cd "$MAKEMKV_BIN"
mkdir -p tmp
echo "accepted" > tmp/eula_accepted
make
make install
cd /tmp

# Clean up
rm -rf "${MAKEMKV_OSS}" "${MAKEMKV_OSS}.tar.gz"
rm -rf "${MAKEMKV_BIN}" "${MAKEMKV_BIN}.tar.gz"

echo ""
echo "Creating output directories..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.json"

if [ -f "$CONFIG_FILE" ]; then
    OUTPUT_FOLDER=$(grep -oP '"outputFolder":\s*"\K[^"]+' "$CONFIG_FILE" || echo "/media/ripped-discs")
    TEMP_FOLDER=$(grep -oP '"tempFolder":\s*"\K[^"]+' "$CONFIG_FILE" || echo "/tmp/ripdisk")
else
    OUTPUT_FOLDER="/media/ripped-discs"
    TEMP_FOLDER="/tmp/ripdisk"
fi

mkdir -p "$OUTPUT_FOLDER"
mkdir -p "$TEMP_FOLDER"
chmod 777 "$OUTPUT_FOLDER"
chmod 777 "$TEMP_FOLDER"

echo ""
echo "Setting up systemd service..."
# Create systemd service file
cat > /etc/systemd/system/ripdisk.service << EOF
[Unit]
Description=Automatic CD/DVD Ripper
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${SCRIPT_DIR}
ExecStart=/usr/bin/node ${SCRIPT_DIR}/ripdisk.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo ""
echo "Creating udev rule for automatic disk detection..."
# Create udev rule
cat > /etc/udev/rules.d/99-cdrom.rules << 'EOF'
# Trigger on CD/DVD insertion
KERNEL=="sr[0-9]*", ACTION=="change", ENV{DISK_MEDIA_CHANGE}=="1", RUN+="/bin/systemctl restart ripdisk.service"
EOF

# Reload udev rules
udevadm control --reload-rules

echo ""
echo "Installing npm dependencies..."
cd "$SCRIPT_DIR"
npm install node-notifier

echo ""
echo "=== Installation Complete ==="
echo ""
echo "To start the service:"
echo "  sudo systemctl enable ripdisk.service"
echo "  sudo systemctl start ripdisk.service"
echo ""
echo "To check status:"
echo "  sudo systemctl status ripdisk.service"
echo ""
echo "To view logs:"
echo "  sudo journalctl -u ripdisk.service -f"
echo ""
echo "Configuration file: ${CONFIG_FILE}"
echo "Output folder: ${OUTPUT_FOLDER}"
echo ""
