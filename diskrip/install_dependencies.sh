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

# Get the actual user who invoked sudo (not root)
ACTUAL_USER="${SUDO_USER:-$USER}"
ACTUAL_HOME=$(eval echo ~$ACTUAL_USER)

echo "Running as sudo, detecting node for user: $ACTUAL_USER"

# Try to find node binary in this order:
# 1. User's which node (running as the actual user)
# 2. NVM default installation
# 3. Standard system paths
NODE_PATH=""

# Run 'which node' as the actual user
NODE_PATH=$(sudo -u "$ACTUAL_USER" bash -c 'which node 2>/dev/null' || echo "")

if [ -n "$NODE_PATH" ]; then
    echo "✓ Found Node.js at: $NODE_PATH"
elif [ -f "$ACTUAL_HOME/.nvm/nvm.sh" ]; then
    # Source nvm as the actual user and get the node path
    NODE_PATH=$(sudo -u "$ACTUAL_USER" bash -c "
        export NVM_DIR=\"$ACTUAL_HOME/.nvm\"
        [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"
        which node 2>/dev/null
    " || echo "")

    if [ -n "$NODE_PATH" ]; then
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
echo "Removing old udev rule (no longer needed - service now runs continuously)..."
UDEV_RULE="/etc/udev/rules.d/99-cdrom.rules"

if [ -f "$UDEV_RULE" ]; then
    echo "Removing old udev rule..."
    rm -f "$UDEV_RULE"
    udevadm control --reload-rules
    echo "✓ Old udev rule removed"
else
    echo "✓ No old udev rule found"
fi

echo ""
echo "Installing npm dependencies..."
cd "$SCRIPT_DIR"

sudo systemctl enable ripdisk.service
sudo systemctl start ripdisk.service

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
