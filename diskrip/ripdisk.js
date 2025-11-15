#!/usr/bin/env node

const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const notifier = require('node-notifier');

// Load configuration
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config;

try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (error) {
    console.error('Error loading config.json:', error.message);
    process.exit(1);
}

// Global state
let isRipping = false;
let checkInterval = null;

/**
 * Log message with timestamp
 */
function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

/**
 * Send notification
 */
function notify(title, message) {
    if (config.notifyOnComplete) {
        notifier.notify({
            title: title,
            message: message,
            sound: true
        });
    }
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
 * Check if a disc is present in the drive
 */
async function isDiscPresent() {
    try {
        const output = await execPromise(`udisksctl info -b ${config.diskDevice}`);
        return output.includes('optical') || output.includes('MediaAvailable: true');
    } catch (error) {
        // If device is not found or not ready, no disc is present
        return false;
    }
}

/**
 * Get disc information using makemkvcon
 */
async function getDiscInfo() {
    try {
        log('Scanning disc with MakeMKV...');
        const output = await execPromise(`makemkvcon -r info disc:0`);

        // Extract disc name from output
        const nameMatch = output.match(/CINFO:2,0,"([^"]+)"/);
        const discName = nameMatch ? nameMatch[1] : `Disc_${Date.now()}`;

        // Parse all titles with their durations
        const titles = [];
        const titleRegex = /TINFO:(\d+),9,0,"(\d+):(\d+):(\d+)"/g;
        let match;

        while ((match = titleRegex.exec(output)) !== null) {
            const titleIndex = parseInt(match[1]);
            const hours = parseInt(match[2]);
            const minutes = parseInt(match[3]);
            const seconds = parseInt(match[4]);
            const durationInSeconds = hours * 3600 + minutes * 60 + seconds;

            titles.push({
                index: titleIndex,
                duration: durationInSeconds,
                durationFormatted: `${match[2]}:${match[3]}:${match[4]}`
            });
        }

        // Sort by duration (longest first)
        titles.sort((a, b) => b.duration - a.duration);

        // Filter by minimum length
        const minLength = config.minTitleLength || 300;
        const validTitles = titles.filter(t => t.duration >= minLength);

        return {
            name: sanitizeFilename(discName),
            titles: validTitles,
            titleCount: validTitles.length
        };
    } catch (error) {
        log('Error getting disc info: ' + (error.stderr || error.message));
        throw error;
    }
}

/**
 * Sanitize filename
 */
function sanitizeFilename(name) {
    return name.replace(/[^\w\s-]/g, '_').replace(/\s+/g, '_');
}

/**
 * Rip disc to MKV using MakeMKV
 */
async function ripToMKV(discInfo) {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(config.tempFolder, discInfo.name);

        // Create temp folder
        if (!fs.existsSync(outputPath)) {
            fs.mkdirSync(outputPath, { recursive: true });
        }

        // Determine which titles to rip
        const titlesToRip = config.titlesToRip || 1;
        const selectedTitles = discInfo.titles.slice(0, titlesToRip);

        log(`Ripping disc "${discInfo.name}" to MKV...`);
        log(`Found ${discInfo.titleCount} valid titles, ripping ${selectedTitles.length} largest:`);
        selectedTitles.forEach((title, idx) => {
            log(`  ${idx + 1}. Title ${title.index} - Duration: ${title.durationFormatted}`);
        });
        log(`Output path: ${outputPath}`);

        // Build title list argument (comma-separated title indices)
        const titleList = selectedTitles.map(t => t.index).join(',');

        // Use makemkvcon to rip specific titles
        const args = [
            '-r',
            'mkv',
            'disc:0',
            titleList,
            outputPath
        ];

        const makemkv = spawn('makemkvcon', args);

        let output = '';

        makemkv.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;

            // Log progress
            const progressMatch = text.match(/PRGV:(\d+),(\d+),(\d+)/);
            if (progressMatch) {
                const current = parseInt(progressMatch[1]);
                const total = parseInt(progressMatch[2]);
                const percent = Math.round((current / total) * 100);
                log(`Progress: ${percent}%`);
            }

            // Log current operation
            const msgMatch = text.match(/MSG:(\d+),(\d+),\d+,"([^"]+)"/);
            if (msgMatch) {
                log(`MakeMKV: ${msgMatch[3]}`);
            }
        });

        makemkv.stderr.on('data', (data) => {
            log(`MakeMKV Error: ${data}`);
        });

        makemkv.on('close', (code) => {
            if (code === 0) {
                log('MKV ripping completed successfully');

                // Find all MKV files created
                const mkvFiles = fs.readdirSync(outputPath)
                    .filter(f => f.endsWith('.mkv'))
                    .map(f => path.join(outputPath, f));

                resolve({ mkvFiles, outputPath });
            } else {
                reject(new Error(`MakeMKV exited with code ${code}`));
            }
        });
    });
}

/**
 * Convert MKV to MP4 using FFmpeg
 */
async function convertToMP4(mkvFile, outputFolder) {
    return new Promise((resolve, reject) => {
        const basename = path.basename(mkvFile, '.mkv');
        const mp4File = path.join(outputFolder, `${basename}.mp4`);

        log(`Converting ${basename}.mkv to MP4...`);

        const args = [
            '-i', mkvFile,
            '-c:v', config.mp4Settings.videoCodec,
            '-preset', config.mp4Settings.preset,
            '-crf', config.mp4Settings.crf.toString(),
            '-c:a', config.mp4Settings.audioCodec,
            '-b:a', '192k',
            '-movflags', '+faststart',
            mp4File
        ];

        const ffmpeg = spawn('ffmpeg', args);

        ffmpeg.stderr.on('data', (data) => {
            const text = data.toString();

            // Log progress
            const timeMatch = text.match(/time=(\d+):(\d+):(\d+)/);
            if (timeMatch) {
                log(`Encoding time: ${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`);
            }
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                log(`Conversion completed: ${basename}.mp4`);
                resolve(mp4File);
            } else {
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });
    });
}

/**
 * Eject disc
 */
async function ejectDisc() {
    try {
        log('Ejecting disc...');
        await execPromise(`eject ${config.diskDevice}`);
        log('Disc ejected successfully');
    } catch (error) {
        log('Error ejecting disc: ' + error.message);
    }
}

/**
 * Main ripping process
 */
async function ripDisc() {
    if (isRipping) {
        log('Already ripping a disc, skipping...');
        return;
    }

    try {
        isRipping = true;

        log('=== Starting disc ripping process ===');

        // Wait a bit for disc to be fully loaded
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Get disc information
        const discInfo = await getDiscInfo();

        if (discInfo.titleCount === 0) {
            log('No valid titles found on disc (all titles are shorter than minimum length)');
            notify('No Valid Titles', 'Disc has no titles meeting minimum length requirement');
            if (config.autoEject) {
                await ejectDisc();
            }
            return;
        }

        const titlesToRip = Math.min(config.titlesToRip || 1, discInfo.titleCount);
        log(`Disc detected: ${discInfo.name} (${discInfo.titleCount} valid titles, ripping ${titlesToRip})`);

        notify('Disc Detected', `Ripping: ${discInfo.name}`);

        // Rip to MKV
        const { mkvFiles, outputPath } = await ripToMKV(discInfo);
        log(`Created ${mkvFiles.length} MKV files`);

        // Create output folder
        const finalOutputFolder = path.join(config.outputFolder, discInfo.name);
        if (!fs.existsSync(finalOutputFolder)) {
            fs.mkdirSync(finalOutputFolder, { recursive: true });
        }

        // Convert each MKV to MP4
        for (const mkvFile of mkvFiles) {
            await convertToMP4(mkvFile, finalOutputFolder);
        }

        // Handle MKV files based on config
        if (config.keepMKV) {
            log('Moving MKV files to output folder...');
            for (const mkvFile of mkvFiles) {
                const dest = path.join(finalOutputFolder, path.basename(mkvFile));
                fs.renameSync(mkvFile, dest);
            }
        } else {
            log('Deleting temporary MKV files...');
            for (const mkvFile of mkvFiles) {
                fs.unlinkSync(mkvFile);
            }
        }

        // Clean up temp folder
        if (fs.existsSync(outputPath)) {
            fs.rmdirSync(outputPath, { recursive: true });
        }

        log(`=== Ripping complete! Files saved to: ${finalOutputFolder} ===`);
        notify('Ripping Complete', `${discInfo.name} has been ripped successfully!`);

        // Eject disc if configured
        if (config.autoEject) {
            await ejectDisc();
        }

    } catch (error) {
        log('Error during ripping process: ' + (error.message || error));
        notify('Ripping Failed', 'An error occurred during disc ripping');
    } finally {
        isRipping = false;
    }
}

/**
 * Check for disc and start ripping if found
 */
async function checkForDisc() {
    if (isRipping) {
        return;
    }

    try {
        const discPresent = await isDiscPresent();

        if (discPresent) {
            log('Disc detected in drive!');
            await ripDisc();
        }
    } catch (error) {
        // Silently handle errors during checking
    }
}

/**
 * Main entry point
 */
async function main() {
    log('=== CD/DVD Auto-Ripper Started ===');
    log(`Monitoring device: ${config.diskDevice}`);
    log(`Output folder: ${config.outputFolder}`);
    log(`Temp folder: ${config.tempFolder}`);
    log('Waiting for disc insertion...');

    // Check immediately on startup
    await checkForDisc();

    // Then check periodically
    checkInterval = setInterval(checkForDisc, 5000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        log('Shutting down...');
        if (checkInterval) {
            clearInterval(checkInterval);
        }
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        log('Shutting down...');
        if (checkInterval) {
            clearInterval(checkInterval);
        }
        process.exit(0);
    });
}

// Start the application
main().catch(error => {
    log('Fatal error: ' + error.message);
    process.exit(1);
});
