#!/usr/bin/env node

/**
 * Test Eject Script
 *
 * Simple script to test disc ejection functionality.
 * Uses the same configuration as the ripdisk service.
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load configuration from root directory
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
let config;

try {
    const rootConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = rootConfig.diskrip;
    if (!config) {
        console.error('Error: "diskrip" section not found in config.json');
        process.exit(1);
    }
} catch (error) {
    console.error('Error loading config.json:', error.message);
    process.exit(1);
}

/**
 * Execute command and return promise
 */
function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stderr });
            } else {
                resolve(stdout);
            }
        });
    });
}

/**
 * Test disc ejection
 */
async function testEject() {
    console.log('=== Disc Eject Test ===\n');
    console.log(`Device: ${config.diskDevice}`);
    console.log(`Attempting to eject...\n`);

    try {
        await execPromise(`eject ${config.diskDevice}`);
        console.log('✓ Disc ejected successfully!');
        console.log('\nThe disc drive should have opened.');
        console.log('If the drive did not eject, check:');
        console.log('  1. Is the device path correct in config.json?');
        console.log(`     Current device: ${config.diskDevice}`);
        console.log('  2. Is a disc present in the drive?');
        console.log('  3. Do you have permission to eject the drive?');
        console.log('     (May need to run with sudo)');
    } catch (error) {
        console.error('✗ Failed to eject disc');
        console.error('\nError:', error.stderr || error.error?.message || error);
        console.error('\nTroubleshooting:');
        console.error('  1. Check if the device exists:');
        console.error(`     ls -la ${config.diskDevice}`);
        console.error('  2. Try manual eject:');
        console.error(`     eject ${config.diskDevice}`);
        console.error('  3. Check device name on your system:');
        console.error('     lsblk (Linux) or diskutil list (macOS)');
        process.exit(1);
    }
}

// Run the test
testEject().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
