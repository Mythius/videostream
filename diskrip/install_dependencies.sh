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
echo "Installing FFmpeg..."
apt-get install -y ffmpeg

echo ""
echo "Installing disk monitoring tools..."
apt-get install -y udev inotify-tools udisks2

echo ""
echo "Installing MakeMKV..."
# Check if MakeMKV snap is installed and remove it
if snap list makemkv &>/dev/null; then
    echo "Removing MakeMKV snap..."
    snap remove makemkv
fi

# Install MakeMKV from PPA (native, no AppArmor restrictions)
if ! grep -q "heyarje/makemkv-beta" /etc/apt/sources.list.d/*.list 2>/dev/null; then
    echo "Adding MakeMKV PPA..."
    add-apt-repository -y ppa:heyarje/makemkv-beta
    apt-get update
fi

echo "Installing MakeMKV native packages..."
apt-get install -y makemkv-bin makemkv-oss

# Verify installation
if ! command -v makemkvcon &>/dev/null; then
    echo "ERROR: MakeMKV installation failed"
    echo "makemkvcon command not found"
    exit 1
fi

echo "✓ MakeMKV installed successfully: $(makemkvcon --version 2>&1 | head -1)"

echo ""
echo "Configuring directories..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.json"

if [ -f "$CONFIG_FILE" ]; then
    OUTPUT_FOLDER=$(grep -oP '"outputFolder":\s*"\K[^"]+' "$CONFIG_FILE" 2>/dev/null || echo "/media/ripped-discs")
    TEMP_FOLDER=$(grep -oP '"tempFolder":\s*"\K[^"]+' "$CONFIG_FILE" 2>/dev/null || echo "/tmp/ripdisk")

    # Expand ~ to actual home directory if present
    OUTPUT_FOLDER="${OUTPUT_FOLDER/#\~/$HOME}"
    TEMP_FOLDER="${TEMP_FOLDER/#\~/$HOME}"
else
    OUTPUT_FOLDER="/media/ripped-discs"
    TEMP_FOLDER="/tmp/ripdisk"
fi

echo "Creating directories:"
echo "  Output: $OUTPUT_FOLDER"
echo "  Temp:   $TEMP_FOLDER"

mkdir -p "$OUTPUT_FOLDER"
mkdir -p "$TEMP_FOLDER"
chmod 777 "$OUTPUT_FOLDER"
chmod 777 "$TEMP_FOLDER"

echo "✓ Directories created with proper permissions"

echo ""
echo "Detecting Node.js installation..."

# Try to find node binary in this order:
# 1. User's current node (which node)
# 2. NVM default installation
# 3. Standard system paths
NODE_PATH=""

if command -v node &>/dev/null; then
    NODE_PATH=$(which node)
    echo "✓ Found Node.js at: $NODE_PATH"
elif [ -f "$HOME/.nvm/nvm.sh" ]; then
    # Source nvm and get the default node path
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    if command -v node &>/dev/null; then
        NODE_PATH=$(which node)
        echo "✓ Found Node.js via NVM at: $NODE_PATH"
    fi
fi

# Fallback to common paths
if [ -z "$NODE_PATH" ]; then
    if [ -f "/usr/bin/node" ]; then
        NODE_PATH="/usr/bin/node"
        echo "✓ Using system Node.js at: $NODE_PATH"
    elif [ -f "/usr/local/bin/node" ]; then
        NODE_PATH="/usr/local/bin/node"
        echo "✓ Using Node.js at: $NODE_PATH"
    else
        echo "ERROR: Node.js not found. Please install Node.js first."
        exit 1
    fi
fi

echo ""
echo "Setting up systemd service..."
SERVICE_FILE="/etc/systemd/system/ripdisk.service"
SERVICE_CONTENT="[Unit]
Description=Automatic CD/DVD Ripper
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${NODE_PATH} ${SCRIPT_DIR}/ripdisk.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target"

# Only update if changed or doesn't exist
if [ ! -f "$SERVICE_FILE" ] || ! diff -q <(echo "$SERVICE_CONTENT") "$SERVICE_FILE" &>/dev/null; then
    echo "Updating systemd service file..."
    echo "$SERVICE_CONTENT" > "$SERVICE_FILE"
    systemctl daemon-reload
    echo "✓ Service file updated"
else
    echo "✓ Service file already up to date"
fi

echo ""
echo "Setting up udev rule for automatic disk detection..."
UDEV_RULE="/etc/udev/rules.d/99-cdrom.rules"
UDEV_CONTENT='# Trigger on CD/DVD insertion
KERNEL=="sr[0-9]*", ACTION=="change", ENV{DISK_MEDIA_CHANGE}=="1", RUN+="/bin/systemctl restart ripdisk.service"'

# Only update if changed or doesn't exist
if [ ! -f "$UDEV_RULE" ] || ! diff -q <(echo "$UDEV_CONTENT") "$UDEV_RULE" &>/dev/null; then
    echo "Updating udev rule..."
    echo "$UDEV_CONTENT" > "$UDEV_RULE"
    udevadm control --reload-rules
    echo "✓ Udev rule updated"
else
    echo "✓ Udev rule already up to date"
fi

echo ""
echo "Installing npm dependencies..."
cd "$SCRIPT_DIR"

# Install npm packages (idempotent - won't reinstall if already present)
if [ -f "package.json" ]; then
    npm install
else
    npm install node-notifier
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Summary:"
echo "  Node.js:     ${NODE_PATH} ($(${NODE_PATH} --version))"
echo "  MakeMKV:     $(makemkvcon --version 2>&1 | head -1)"
echo "  FFmpeg:      $(ffmpeg -version 2>&1 | head -1)"
echo "  Config:      ${CONFIG_FILE}"
echo "  Temp folder: ${TEMP_FOLDER}"
echo "  Output:      ${OUTPUT_FOLDER}"
echo ""
echo "Next steps:"
echo ""
echo "1. Enable and start the service:"
echo "   sudo systemctl enable ripdisk.service"
echo "   sudo systemctl start ripdisk.service"
echo ""
echo "2. Check service status:"
echo "   sudo systemctl status ripdisk.service"
echo ""
echo "3. Monitor logs in real-time:"
echo "   sudo journalctl -u ripdisk.service -f"
echo ""
echo "Note: This script is idempotent and can be run multiple times safely."
echo ""
