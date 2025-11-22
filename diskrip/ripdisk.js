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
let lastRippedDisc = null;  // Track recently ripped disc to avoid immediate re-rip
let lastRipTime = 0;
const RIP_COOLDOWN_MS = 30000;  // Wait 30 seconds after ejection before detecting again

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
    const device = config.diskDevice;
    log(`Checking for disc presence on ${device}...`);
    // Try several methods to detect media presence; udisksctl output varies across systems
    try {
        // 1) udisksctl
        try {
            const out = await execPromise(`udisksctl info -b ${device}`);
            log(`udisksctl: ${out.split('\n')[0] || ''}`);
            if (out.includes('optical') || out.includes('MediaAvailable: true') || /Media:/.test(out)) {
                return true;
            }
        } catch (e) {
            log(`udisksctl failed: ${e && e.stderr ? e.stderr : (e && e.message) || e}`);
            // ignore and try next method
        }

        // 2) udevadm properties (ID_CDROM_MEDIA=1 when media present)
        try {
            const out = await execPromise(`udevadm info -q property -n ${device}`);
            log(`udevadm: ${out.split('\n')[0] || ''}`);
            if (/ID_CDROM_MEDIA=(1|true)/i.test(out) || /ID_FS_LABEL=/.test(out) || /ID_FS_TYPE=/.test(out)) {
                return true;
            }
        } catch (e) {
            log(`udevadm failed: ${e && e.stderr ? e.stderr : (e && e.message) || e}`);
            // ignore and try next method
        }

        // 3) blkid will print info when there is a filesystem on the disc
        try {
            const out = await execPromise(`blkid ${device}`);
            if (out && out.trim().length > 0) {
                log(`blkid: ${out.trim()}`);
                return true;
            }
        } catch (e) {
            log(`blkid failed: ${e && e.stderr ? e.stderr : (e && e.message) || e}`);
            // ignore
        }

        // 4) file -s can sometimes identify a filesystem on the raw device
        try {
            const out = await execPromise(`file -s ${device}`);
            log(`file -s: ${out.split('\n')[0] || ''}`);
            // If output contains common fs type or ISO9660, treat as present
            if (/ISO 9660|ISO9660|filesystem|FAT|NTFS|ext[234]/i.test(out)) {
                return true;
            }
        } catch (e) {
            log(`file -s failed: ${e && e.stderr ? e.stderr : (e && e.message) || e}`);
            // ignore
        }

        return false;
    } catch (error) {
        // If something unexpected happens, assume no disc
        log('isDiscPresent unexpected error: ' + (error && error.stderr ? error.stderr : (error && error.message) || error));
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
 * Convert a sanitized folder/name into a human-friendly title-cased name
 * e.g. HOW_TO_TRAIN_YOUR_DRAGON -> How To Train Your Dragon
 */
function humanizeName(name) {
    // Replace underscores and dashes with spaces, collapse spaces
    let s = name.replace(/[_-]+/g, ' ').trim();
    // Lowercase then Title Case each word
    s = s.toLowerCase().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return s;
}
/**
 * Rip disc to MKV using MakeMKV
 */
async function ripToMKV(discInfo) {
    return new Promise((resolve, reject) => {
        // Allow configuring whether to create a subfolder per-disc inside tempFolder.
        // If config.createTempSubfolder is === false, write files directly into tempFolder.
        const useSubfolder = !(config.createTempSubfolder === false);
        const outputPath = useSubfolder ? path.join(config.tempFolder, discInfo.name) : config.tempFolder;

        // Create temp folder or per-disc subfolder with proper permissions so it's writable even when run as sudo
        if (!fs.existsSync(outputPath)) {
            fs.mkdirSync(outputPath, { recursive: true });
        }

        // Ensure directory is writable: chown to current user and chmod to 0o777
        // This fixes the issue where sudo creates root-owned directory that non-root can't write to
        try {
            // Get the user that should own this (if running as sudo, use the sudo user)
            let targetUid = process.getuid();
            let targetGid = process.getgid();

            // If running as root (uid 0), try to get the sudo user from environment
            if (targetUid === 0 && process.env.SUDO_UID) {
                targetUid = parseInt(process.env.SUDO_UID);
                targetGid = parseInt(process.env.SUDO_GID) || targetGid;
                log(`Running as root with sudo; setting directory owner to sudo user (uid: ${targetUid}, gid: ${targetGid})`);
            }

            fs.chownSync(outputPath, targetUid, targetGid);
            fs.chmodSync(outputPath, 0o777);
            log(`Set ${outputPath} to uid:${targetUid}, gid:${targetGid}, mode 0o777`);
        } catch (err) {
            log(`Warning: Failed to set directory permissions: ${err.message}`);
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

        // If no titles selected, return early with empty result
        if (selectedTitles.length === 0) {
            log('No titles meet the minimum length requirement; skipping MKV rip.');
            resolve({ mkvFiles: [], outputPath, discInfo, createdSubfolder: useSubfolder });
            return;
        }

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

        log(`Executing: makemkvcon ${args.join(' ')}`);

        const makemkv = spawn('makemkvcon', args);

        makemkv.on('error', (err) => {
            log('Failed to start makemkvcon: ' + (err.message || err));
            reject(err);
        });

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
                try {
                    const mkvFiles = fs.readdirSync(outputPath)
                        .filter(f => f.endsWith('.mkv'))
                        .map(f => path.join(outputPath, f));

                    // Check if any files were actually created
                    if (mkvFiles.length === 0) {
                        log('Warning: MakeMKV reported success but no MKV files were created. This may indicate a read error.');
                        reject(new Error('MakeMKV completed but failed to create any output files'));
                        return;
                    }

                    resolve({ mkvFiles, outputPath, discInfo, createdSubfolder: useSubfolder });
                } catch (err) {
                    log(`Error reading output directory: ${err.message}`);
                    reject(err);
                }
            } else {
                reject(new Error(`MakeMKV exited with code ${code}`));
            }
        });
    });
}

/**
 * Convert MKV to MP4 using FFmpeg
 */
async function convertToMP4(mkvFile, outputFolder, outputFilename = null) {
    return new Promise((resolve, reject) => {
        const basename = path.basename(mkvFile, '.mkv');
        const mp4Name = outputFilename || `${basename}.mp4`;
        const mp4File = path.join(outputFolder, mp4Name);

        log(`Converting ${basename}.mkv to MP4 as ${mp4Name}...`);

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
                log(`Conversion completed: ${mp4Name}`);
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

        notify('Disc Detected', `Retrieving: ${discInfo.name}`);

    // Rip to MKV
    const { mkvFiles, outputPath, createdSubfolder } = await ripToMKV(discInfo);
        log(`Created ${mkvFiles.length} MKV files`);

        // Create output folder
        const finalOutputFolder = config.outputFolder;
        if (!fs.existsSync(finalOutputFolder)) {
            fs.mkdirSync(finalOutputFolder, { recursive: true });
        }

        // Convert each MKV to MP4
        for (let i = 0; i < mkvFiles.length; i++) {
            const mkvFile = mkvFiles[i];
            const movieBase = humanizeName(discInfo.name);
            let outputFilename;
            if (mkvFiles.length === 1) {
                outputFilename = `${movieBase}.mp4`;
            } else {
                // If multiple titles, append the original mkv basename to keep uniqueness
                const titleBasename = path.basename(mkvFile, '.mkv');
                outputFilename = `${movieBase} - ${titleBasename}.mp4`;
            }

            await convertToMP4(mkvFile, finalOutputFolder, outputFilename);
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

        // Clean up temp folder (only remove per-disc subfolder, not the shared tempFolder)
        if (createdSubfolder && fs.existsSync(outputPath)) {
            fs.rmdirSync(outputPath, { recursive: true });
        }

        log(`=== Ripping complete! Files saved to: ${finalOutputFolder} ===`);
        notify('Ripping Complete', `${discInfo.name} has been ripped successfully!`);

        // Track this rip to avoid immediate re-rip
        lastRippedDisc = discInfo.name;
        lastRipTime = Date.now();
        log(`Cooldown started (${RIP_COOLDOWN_MS / 1000}s) to prevent re-ripping the same disc`);

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

    // Skip detection during cooldown period after a successful rip
    if (lastRippedDisc && Date.now() - lastRipTime < RIP_COOLDOWN_MS) {
        const timeLeft = Math.ceil((RIP_COOLDOWN_MS - (Date.now() - lastRipTime)) / 1000);
        log(`Still in cooldown for "${lastRippedDisc}" (${timeLeft}s remaining)`);
        return;
    }

    // Clear cooldown state if cooldown has expired
    if (lastRippedDisc && Date.now() - lastRipTime >= RIP_COOLDOWN_MS) {
        log(`Cooldown expired for "${lastRippedDisc}"; resuming detection`);
        lastRippedDisc = null;
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
