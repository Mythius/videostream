#!/bin/bash

# AppArmor Configuration Script for MakeMKV Snap
# This script configures AppArmor to allow MakeMKV snap to write to custom directories

set -e

echo "=== MakeMKV AppArmor Configuration ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (use sudo)"
    exit 1
fi

# Get script directory and config file
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.json"

# Check if makemkv is installed as a snap
if ! snap list makemkv &>/dev/null; then
    echo "ERROR: MakeMKV snap is not installed."
    echo "Install it with: sudo snap install makemkv"
    exit 1
fi

echo "✓ MakeMKV snap is installed"

# Parse directories from config.json
if [ -f "$CONFIG_FILE" ]; then
    TEMP_FOLDER=$(grep -oP '"tempFolder":\s*"\K[^"]+' "$CONFIG_FILE" 2>/dev/null || echo "")
    OUTPUT_FOLDER=$(grep -oP '"outputFolder":\s*"\K[^"]+' "$CONFIG_FILE" 2>/dev/null || echo "")

    # Expand ~ to home directory if present
    TEMP_FOLDER="${TEMP_FOLDER/#\~/$HOME}"
    OUTPUT_FOLDER="${OUTPUT_FOLDER/#\~/$HOME}"
else
    echo "WARNING: config.json not found, using default directories"
    TEMP_FOLDER="/home/$SUDO_USER/temp"
    OUTPUT_FOLDER="/media/ripped-discs"
fi

# Default to safe values if parsing failed
if [ -z "$TEMP_FOLDER" ]; then
    TEMP_FOLDER="/home/$SUDO_USER/temp"
fi
if [ -z "$OUTPUT_FOLDER" ]; then
    OUTPUT_FOLDER="/media/ripped-discs"
fi

echo "Configuring AppArmor for directories:"
echo "  Temp folder:   $TEMP_FOLDER"
echo "  Output folder: $OUTPUT_FOLDER"
echo ""

# Create directories if they don't exist
mkdir -p "$TEMP_FOLDER"
mkdir -p "$OUTPUT_FOLDER"
chmod 777 "$TEMP_FOLDER"
chmod 777 "$OUTPUT_FOLDER"

# Create AppArmor override directory
mkdir -p /etc/apparmor.d/local

# Create AppArmor override for makemkvcon
echo "Creating AppArmor override..."
cat > /etc/apparmor.d/local/snap.makemkv.makemkvcon <<EOF
# AppArmor override for MakeMKV snap
# Allows makemkvcon to write to custom directories configured in ripdisk

# Allow access to temp folder
${TEMP_FOLDER}/ rw,
${TEMP_FOLDER}/** rwk,

# Allow access to output folder
${OUTPUT_FOLDER}/ rw,
${OUTPUT_FOLDER}/** rwk,

# Also allow common locations (belt and suspenders)
/media/** rwk,
/mnt/** rwk,
/tmp/** rwk,

# Allow reading from optical drives
/dev/sr[0-9]* r,
/dev/sg[0-9]* r,
EOF

echo "✓ AppArmor override created at /etc/apparmor.d/local/snap.makemkv.makemkvcon"

# Check if AppArmor profile exists
PROFILE_PATH="/var/lib/snapd/apparmor/profiles/snap.makemkv.makemkvcon"
if [ ! -f "$PROFILE_PATH" ]; then
    echo "WARNING: AppArmor profile not found at $PROFILE_PATH"
    echo "The profile may not be loaded yet. Try running makemkvcon once first."
    exit 0
fi

# Reload the AppArmor profile
echo "Reloading AppArmor profile..."
if apparmor_parser -r "$PROFILE_PATH"; then
    echo "✓ AppArmor profile reloaded successfully"
else
    echo "ERROR: Failed to reload AppArmor profile"
    echo "You may need to restart the system or reload AppArmor manually:"
    echo "  sudo systemctl reload apparmor"
    exit 1
fi

# Test if the directories are now accessible
echo ""
echo "Testing MakeMKV access to directories..."

# Create a test file as the snap would
if sudo -u root snap run makemkv.makemkvcon --version &>/dev/null; then
    echo "✓ MakeMKV snap is executable"
else
    echo "WARNING: Could not execute MakeMKV snap"
fi

# Verify AppArmor status
echo ""
echo "Verifying AppArmor configuration..."
if aa-status 2>/dev/null | grep -q "snap.makemkv.makemkvcon"; then
    echo "✓ MakeMKV AppArmor profile is loaded"
else
    echo "WARNING: MakeMKV AppArmor profile may not be active"
fi

echo ""
echo "=== Configuration Complete ==="
echo ""
echo "MakeMKV snap should now be able to write to:"
echo "  - $TEMP_FOLDER"
echo "  - $OUTPUT_FOLDER"
echo ""
echo "If you still experience permission issues:"
echo "  1. Restart the ripdisk service: sudo systemctl restart ripdisk.service"
echo "  2. Check AppArmor logs: sudo journalctl -xe | grep -i apparmor"
echo "  3. Check service logs: sudo journalctl -u ripdisk.service -f"
echo ""
