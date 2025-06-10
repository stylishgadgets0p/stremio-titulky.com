// Create enhanced subtitle name with technical compatibility indicator
    createEnhancedSubtitleName(subtitle, isTopMatch = false, isTechnicalMatch = false) {
        let name = subtitle.title;
        
        // Add special edition info if detected
        if (subtitle.subtitleVideoInfo && subtitle.subtitleVideoInfo.specialEdition) {
            const edition = subtitle.subtitleVideoInfo.specialEdition.toUpperCase().replace('-', ' ');
            name += ` [${edition}]`;
        }
        
        // Add source info if available
        if (subtitle.videoVersion && !name/*
PACKAGE.JSON DEPENDENCIES:
{
  "name": "stremio-titulky-addon",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "express": "^4.18.2",
    "axios": "^1.4.0",
    "cheerio": "^1.0.0-rc.12",
    "cors": "^2.8.5",
    "adm-zip": "^0.5.10"
  }
}
*/

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const cors = require('cors');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
}));

// Middleware pro logování všech požadavků
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    console.log(`[REQUEST] Headers:`, JSON.stringify(req.headers, null, 2));
    if (req.body && Object.keys(req.body).length > 0) {
        console.log(`[REQUEST] Body:`, req.body);
    }
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store user sessions (in production, use Redis or database)
const userSessions = new Map();

// RealDebrid API client
class RealDebridClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.real-debrid.com/rest/1.0';
    }

    async getCurrentlyPlayingFile() {
        try {
            console.log('[REALDEBRID] Checking for currently playing file...');
            
            // Get user's downloads history (recent files)
            const response = await axios.get(`${this.baseUrl}/downloads`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'User-Agent': 'Titulky-Stremio-Addon/1.0'
                },
                params: {
                    page: 1,
                    limit: 10
                },
                timeout: 5000
            });

            if (response.data && response.data.length > 0) {
                // Get the most recent download (likely currently playing)
                const recentFile = response.data[0];
                console.log(`[REALDEBRID] Recent file: ${recentFile.filename}`);
                
                return {
                    filename: recentFile.filename,
                    generated: recentFile.generated,
                    size: recentFile.filesize,
                    // Extract only technical metadata, not movie title
                    technicalOnly: true
                };
            }

            console.log('[REALDEBRID] No recent downloads found');
            return null;

        } catch (error) {
            console.error('[REALDEBRID] Error getting current file:', error.message);
            if (error.response?.status === 401) {
                console.error('[REALDEBRID] Invalid API key');
            }
            return null;
        }
    }

    async getActiveStreams() {
        try {
            console.log('[REALDEBRID] Checking for active streams...');
            
            // Alternative: Check torrents that are currently downloading/seeding
            const response = await axios.get(`${this.baseUrl}/torrents`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'User-Agent': 'Titulky-Stremio-Addon/1.0'
                },
                params: {
                    filter: 'active',
                    limit: 5
                },
                timeout: 5000
            });

            if (response.data && response.data.length > 0) {
                const activeTorrent = response.data[0];
                console.log(`[REALDEBRID] Active torrent: ${activeTorrent.filename}`);
                
                return {
                    filename: activeTorrent.filename,
                    progress: activeTorrent.progress,
                    status: activeTorrent.status
                };
            }

            console.log('[REALDEBRID] No active torrents found');
            return null;

        } catch (error) {
            console.error('[REALDEBRID] Error getting active streams:', error.message);
            return null;
        }
    }

    async testApiKey() {
        try {
            console.log('[REALDEBRID] Testing API key...');
            
            const response = await axios.get(`${this.baseUrl}/user`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'User-Agent': 'Titulky-Stremio-Addon/1.0'
                },
                timeout: 5000
            });

            if (response.data && response.data.username) {
                console.log(`[REALDEBRID] API key valid for user: ${response.data.username}`);
                return { valid: true, username: response.data.username, premium: response.data.premium };
            }

            return { valid: false };

        } catch (error) {
            console.error('[REALDEBRID] API key test failed:', error.message);
            return { valid: false, error: error.message };
        }
    }
}

// Enhanced Subtitle matching system with RealDebrid integration
class SubtitleMatcher {
    constructor() {
        // Video source priority (higher = better match)
        this.sourcePriority = {
            'bluray': 100,
            'bdrip': 95,
            'remux': 90,
            'web-dl': 85,
            'webdl': 85,
            'webrip': 80,
            'hdtv': 75,
            'dvdrip': 70,
            'dvdscr': 65,
            'hdcam': 30,
            'cam': 25,
            'ts': 20
        };

        // Special edition patterns (for additional priority boost)
        this.specialEditions = [
            'extended', 'director', 'directors', 'special', 'edition', 'cut',
            'uncut', 'unrated', 'theatrical', 'ultimate', 'remastered',
            'anniversary', 'collectors', 'limited', 'deluxe', 'redux',
            'final', 'complete', 'definitive', 'alternate', 'international'
        ];
    }

    // Extract technical video info from RealDebrid filename (only technical metadata)
    extractTechnicalInfoFromRealDebrid(filename) {
        console.log(`[MATCHER-RD] Extracting technical info from: "${filename}"`);
        
        const info = {
            source: this.extractSource(filename),
            quality: this.extractQuality(filename),
            codec: this.extractCodec(filename),
            audio: this.extractAudio(filename),
            specialEdition: this.extractSpecialEdition(filename),
            releaseGroup: this.extractReleaseGroup(filename),
            originalFilename: filename,
            technicalOnly: true // Flag indicating we only extracted technical data
        };

        console.log(`[MATCHER-RD] Extracted technical info:`, {
            source: info.source,
            quality: info.quality,
            codec: info.codec,
            audio: info.audio,
            specialEdition: info.specialEdition,
            releaseGroup: info.releaseGroup
        });
        
        return info;
    }

    // Estimate release type from file size (when RealDebrid is not available)
    estimateReleaseTypeFromSize(fileSizeBytes, quality = '1080p', duration = 120) {
        console.log(`[MATCHER-SIZE] Estimating release type for ${fileSizeBytes} bytes, ${quality}, ~${duration}min`);
        
        if (!fileSizeBytes || fileSizeBytes <= 0) {
            console.log(`[MATCHER-SIZE] Invalid file size, returning unknown`);
            return { source: 'unknown', confidence: 0 };
        }

        const sizeGB = fileSizeBytes / (1024 * 1024 * 1024);
        const durationHours = duration / 60;
        
        console.log(`[MATCHER-SIZE] File size: ${sizeGB.toFixed(2)} GB, Duration: ${durationHours.toFixed(1)}h`);

        // Size ranges for different release types (per hour of content)
        const sizeRanges = {
            '2160p': {
                'remux': { min: 25, max: 80, confidence: 90 },
                'bdrip': { min: 8, max: 25, confidence: 85 },
                'web-dl': { min: 6, max: 15, confidence: 80 },
                'webrip': { min: 4, max: 10, confidence: 75 }
            },
            '1080p': {
                'remux': { min: 15, max: 50, confidence: 90 },
                'bdrip': { min: 4, max: 15, confidence: 85 },
                'web-dl': { min: 3, max: 8, confidence: 80 },
                'webrip': { min: 2, max: 6, confidence: 75 },
                'hdtv': { min: 1, max: 4, confidence: 70 }
            },
            '720p': {
                'bdrip': { min: 2, max: 8, confidence: 85 },
                'web-dl': { min: 1.5, max: 4, confidence: 80 },
                'webrip': { min: 1, max: 3, confidence: 75 },
                'hdtv': { min: 0.5, max: 2, confidence: 70 }
            },
            '480p': {
                'dvdrip': { min: 0.7, max: 2, confidence: 80 },
                'webrip': { min: 0.3, max: 1, confidence: 75 },
                'hdtv': { min: 0.2, max: 0.8, confidence: 70 }
            }
        };

        const normalizedQuality = quality.toLowerCase();
        const qualityRanges = sizeRanges[normalizedQuality] || sizeRanges['1080p'];
        
        const sizePerHour = sizeGB / Math.max(durationHours, 0.5); // Minimum 30 min
        console.log(`[MATCHER-SIZE] Size per hour: ${sizePerHour.toFixed(2)} GB/h`);

        let bestMatch = { source: 'unknown', confidence: 0 };

        for (const [source, range] of Object.entries(qualityRanges)) {
            if (sizePerHour >= range.min && sizePerHour <= range.max) {
                // Calculate confidence based on how well the size fits the range
                const rangeMid = (range.min + range.max) / 2;
                const deviation = Math.abs(sizePerHour - rangeMid) / (range.max - range.min);
                const adjustedConfidence = range.confidence * (1 - deviation);
                
                if (adjustedConfidence > bestMatch.confidence) {
                    bestMatch = { source, confidence: adjustedConfidence };
                }
                
                console.log(`[MATCHER-SIZE] ${source}: fits range ${range.min}-${range.max} GB/h, confidence: ${adjustedConfidence.toFixed(1)}%`);
            }
        }

        // Special cases for very small or very large files
        if (sizePerHour < 0.5) {
            bestMatch = { source: 'cam', confidence: 60 };
            console.log(`[MATCHER-SIZE] Very small file, likely CAM`);
        } else if (sizePerHour > 50) {
            bestMatch = { source: 'remux', confidence: 85 };
            console.log(`[MATCHER-SIZE] Very large file, likely REMUX`);
        }

        console.log(`[MATCHER-SIZE] Best estimate: ${bestMatch.source} (confidence: ${bestMatch.confidence.toFixed(1)}%)`);
        
        return bestMatch;
    }

    // Create video info from Stremio request data and optional RealDebrid info
    createVideoInfoFromStremio(stremioData, realDebridTechnical = null) {
        console.log(`[MATCHER-STREMIO] Creating video info from Stremio data`);
        
        let videoInfo = {
            source: 'unknown',
            quality: 'unknown',
            codec: 'unknown',
            audio: 'unknown',
            specialEdition: null,
            releaseGroup: 'unknown',
            confidence: 0,
            dataSource: 'estimated'
        };

        // If we have RealDebrid technical data, use that (most accurate)
        if (realDebridTechnical && realDebridTechnical.technicalOnly) {
            console.log(`[MATCHER-STREMIO] Using RealDebrid technical data`);
            videoInfo = {
                source: realDebridTechnical.source,
                quality: realDebridTechnical.quality,
                codec: realDebridTechnical.codec,
                audio: realDebridTechnical.audio,
                specialEdition: realDebridTechnical.specialEdition,
                releaseGroup: realDebridTechnical.releaseGroup,
                confidence: 95,
                dataSource: 'realdebrid'
            };
        } 
        // Otherwise estimate from file size and other Stremio data
        else if (stremioData.fileSize) {
            console.log(`[MATCHER-STREMIO] Estimating from file size: ${stremioData.fileSize} bytes`);
            
            const sizeEstimate = this.estimateReleaseTypeFromSize(
                stremioData.fileSize,
                stremioData.quality || '1080p',
                stremioData.duration || 120
            );
            
            videoInfo.source = sizeEstimate.source;
            videoInfo.confidence = sizeEstimate.confidence;
            videoInfo.dataSource = 'size_estimate';
            
            // Try to extract quality and other info from stream title if available
            if (stremioData.streamTitle) {
                const extractedInfo = this.extractVideoInfo(stremioData.streamTitle);
                videoInfo.quality = this.extractQuality(stremioData.streamTitle) || videoInfo.quality;
                videoInfo.codec = this.extractCodec(stremioData.streamTitle) || videoInfo.codec;
                videoInfo.specialEdition = extractedInfo.specialEdition || videoInfo.specialEdition;
            }
        }
        // Last resort: try to extract from stream title only
        else if (stremioData.streamTitle) {
            console.log(`[MATCHER-STREMIO] Extracting from stream title only`);
            const extractedInfo = this.extractVideoInfo(stremioData.streamTitle);
            videoInfo = {
                ...extractedInfo,
                quality: this.extractQuality(stremioData.streamTitle),
                codec: this.extractCodec(stremioData.streamTitle),
                audio: this.extractAudio(stremioData.streamTitle),
                releaseGroup: this.extractReleaseGroup(stremioData.streamTitle),
                confidence: 50,
                dataSource: 'stream_title'
            };
        }

        console.log(`[MATCHER-STREMIO] Final video info:`, videoInfo);
        return videoInfo;
    }

    // Extract quality from filename
    extractQuality(filename) {
        const qualityPatterns = [
            /2160p|4k/i,
            /1080p/i,
            /720p/i,
            /480p/i,
            /360p/i
        ];
        
        const filenameLower = filename.toLowerCase();
        
        for (const pattern of qualityPatterns) {
            if (pattern.test(filenameLower)) {
                const match = filenameLower.match(pattern);
                return match[0];
            }
        }
        
        return 'unknown';
    }

    // Extract codec from filename
    extractCodec(filename) {
        const codecPatterns = [
            /x264/i,
            /x265/i,
            /h\.?264/i,
            /h\.?265/i,
            /hevc/i,
            /avc/i,
            /xvid/i,
            /divx/i
        ];
        
        const filenameLower = filename.toLowerCase();
        
        for (const pattern of codecPatterns) {
            if (pattern.test(filenameLower)) {
                const match = filenameLower.match(pattern);
                return match[0].replace('.', '');
            }
        }
        
        return 'unknown';
    }

    // Extract audio info from filename
    extractAudio(filename) {
        const audioPatterns = [
            /dts-hd/i,
            /dts/i,
            /truehd/i,
            /atmos/i,
            /dd5\.?1/i,
            /ac3/i,
            /aac/i,
            /mp3/i,
            /flac/i
        ];
        
        const filenameLower = filename.toLowerCase();
        
        for (const pattern of audioPatterns) {
            if (pattern.test(filenameLower)) {
                const match = filenameLower.match(pattern);
                return match[0];
            }
        }
        
        return 'unknown';
    }

    // Extract release group from filename
    extractReleaseGroup(filename) {
        // Release groups are usually at the end, after a dash or in brackets
        const releasePatterns = [
            /-([A-Z0-9]+)(?:\.[a-z0-9]+)*$/i,  // -RELEASEGROUP.ext
            /\[([A-Z0-9]+)\]/i,                 // [RELEASEGROUP]
            /\{([A-Z0-9]+)\}/i                  // {RELEASEGROUP}
        ];
        
        for (const pattern of releasePatterns) {
            const match = filename.match(pattern);
            if (match && match[1] && match[1].length > 2) {
                return match[1].toUpperCase();
            }
        }
        
        return 'unknown';
    }

    // Calculate enhanced compatibility score with technical video info
    calculateTechnicalCompatibilityScore(videoInfo, subtitleInfo, movieTitle = '') {
        console.log(`[MATCHER-TECH] Calculating technical compatibility`);
        console.log(`[MATCHER-TECH] Video info:`, {
            source: videoInfo.source,
            quality: videoInfo.quality,
            codec: videoInfo.codec,
            confidence: videoInfo.confidence,
            dataSource: videoInfo.dataSource
        });
        console.log(`[MATCHER-TECH] Subtitle: "${subtitleInfo.originalTitle || subtitleInfo.title}"`);

        let score = 0;
        let bonuses = [];
        let confidence = videoInfo.confidence || 50;

        // Weight the scoring based on confidence of video info
        const confidenceMultiplier = confidence / 100;

        // 1. Source compatibility (40% of score)
        const sourceScore = this.calculateCompatibilityScore(videoInfo, subtitleInfo, movieTitle);
        const weightedSourceScore = sourceScore * 0.4 * confidenceMultiplier;
        score += weightedSourceScore;
        bonuses.push(`Source: ${sourceScore.toFixed(1)}% * 0.4 * ${confidenceMultiplier.toFixed(2)} = ${weightedSourceScore.toFixed(1)}`);

        // 2. Quality match (25% of score)
        if (videoInfo.quality !== 'unknown' && subtitleInfo.originalTitle) {
            const subtitleLower = subtitleInfo.originalTitle.toLowerCase();
            if (subtitleLower.includes(videoInfo.quality)) {
                const qualityBonus = 100 * 0.25 * confidenceMultiplier;
                score += qualityBonus;
                bonuses.push(`Quality match (${videoInfo.quality}): 100% * 0.25 * ${confidenceMultiplier.toFixed(2)} = ${qualityBonus.toFixed(1)}`);
            } else {
                // Check for compatible qualities
                const qualityMap = {
                    '2160p': ['4k', '2160p', 'uhd'],
                    '1080p': ['1080p', 'fhd', 'fullhd'],
                    '720p': ['720p', 'hd'],
                    '480p': ['480p', 'sd']
                };
                
                const compatibleQualities = qualityMap[videoInfo.quality] || [];
                const hasCompatibleQuality = compatibleQualities.some(q => subtitleLower.includes(q));
                
                if (hasCompatibleQuality) {
                    const compatibleBonus = 80 * 0.25 * confidenceMultiplier;
                    score += compatibleBonus;
                    bonuses.push(`Compatible quality: 80% * 0.25 * ${confidenceMultiplier.toFixed(2)} = ${compatibleBonus.toFixed(1)}`);
                } else {
                    bonuses.push(`No quality match: 0%`);
                }
            }
        } else {
            const defaultBonus = 50 * 0.25;
            score += defaultBonus;
            bonuses.push(`No quality info: 50% * 0.25 = ${defaultBonus.toFixed(1)}`);
        }

        // 3. Codec match (15% of score) - only if we have high confidence
        if (videoInfo.codec !== 'unknown' && subtitleInfo.originalTitle && confidence > 70) {
            const subtitleLower = subtitleInfo.originalTitle.toLowerCase();
            if (subtitleLower.includes(videoInfo.codec.toLowerCase())) {
                const codecBonus = 100 * 0.15 * confidenceMultiplier;
                score += codecBonus;
                bonuses.push(`Codec match (${videoInfo.codec}): 100% * 0.15 * ${confidenceMultiplier.toFixed(2)} = ${codecBonus.toFixed(1)}`);
            } else {
                bonuses.push(`No codec match: 0%`);
            }
        } else {
            const defaultBonus = 50 * 0.15;
            score += defaultBonus;
            bonuses.push(`No codec info: 50% * 0.15 = ${defaultBonus.toFixed(1)}`);
        }

        // 4. Release group match (10% of score) - only for RealDebrid data
        if (videoInfo.releaseGroup !== 'unknown' && subtitleInfo.originalTitle && videoInfo.dataSource === 'realdebrid') {
            const subtitleLower = subtitleInfo.originalTitle.toLowerCase();
            const releaseGroupLower = videoInfo.releaseGroup.toLowerCase();
            
            if (subtitleLower.includes(releaseGroupLower)) {
                const releaseBonus = 100 * 0.1;
                score += releaseBonus;
                bonuses.push(`Release group match (${videoInfo.releaseGroup}): 100% * 0.1 = ${releaseBonus.toFixed(1)}`);
            } else {
                bonuses.push(`No release group match: 0%`);
            }
        } else {
            const defaultBonus = 50 * 0.1;
            score += defaultBonus;
            bonuses.push(`No release group info: 50% * 0.1 = ${defaultBonus.toFixed(1)}`);
        }

        // 5. Title similarity (10% of score)
        const titleScore = this.calculateTitleSimilarity(movieTitle, subtitleInfo.title || subtitleInfo.originalTitle);
        const titleBonus = titleScore * 0.1;
        score += titleBonus;
        bonuses.push(`Title similarity: ${titleScore.toFixed(1)}% * 0.1 = ${titleBonus.toFixed(1)}`);

        // Data source bonus - prefer RealDebrid data
        if (videoInfo.dataSource === 'realdebrid') {
            const dataSourceBonus = 5;
            score += dataSourceBonus;
            bonuses.push(`RealDebrid data bonus: +${dataSourceBonus}`);
        } else if (videoInfo.dataSource === 'size_estimate' && confidence > 60) {
            const dataSourceBonus = 2;
            score += dataSourceBonus;
            bonuses.push(`Size estimate bonus: +${dataSourceBonus}`);
        }

        console.log(`[MATCHER-TECH] Score breakdown: ${bonuses.join(', ')}`);
        console.log(`[MATCHER-TECH] Final technical compatibility score: ${score.toFixed(1)}% (confidence: ${confidence}%)`);

        return Math.min(100, Math.max(0, score));
    }

    // Extract video source from title
    extractVideoInfo(streamTitle) {
        console.log(`[MATCHER] Analyzing stream: "${streamTitle}"`);
        
        const info = {
            source: this.extractSource(streamTitle),
            specialEdition: this.extractSpecialEdition(streamTitle),
            originalTitle: streamTitle
        };

        console.log(`[MATCHER] Extracted video source: ${info.source}`);
        if (info.specialEdition) {
            console.log(`[MATCHER] Detected special edition: ${info.specialEdition}`);
        }
        return info;
    }

    extractSource(title) {
        const sources = ['bluray', 'bdrip', 'remux', 'web-dl', 'webdl', 'webrip', 'hdtv', 'dvdrip', 'dvdscr', 'hdcam', 'cam', 'ts'];
        const titleLower = title.toLowerCase();
        
        for (const source of sources) {
            if (titleLower.includes(source) || titleLower.includes(source.replace('-', ''))) {
                return source;
            }
        }
        return 'unknown';
    }

    // Extract special edition info from title
    extractSpecialEdition(title) {
        const titleLower = title.toLowerCase();
        
        for (const edition of this.specialEditions) {
            if (titleLower.includes(edition)) {
                // Look for common combinations
                if (titleLower.includes('extended') && titleLower.includes('cut')) {
                    return 'extended-cut';
                }
                if (titleLower.includes('director') && (titleLower.includes('cut') || titleLower.includes('edition'))) {
                    return 'directors-cut';
                }
                if (titleLower.includes('special') && titleLower.includes('edition')) {
                    return 'special-edition';
                }
                if (titleLower.includes('ultimate') && titleLower.includes('edition')) {
                    return 'ultimate-edition';
                }
                
                return edition;
            }
        }
        return null;
    }

    // Calculate compatibility score between video and subtitle sources
    calculateCompatibilityScore(videoInfo, subtitleInfo, movieTitle = '') {
        console.log(`[MATCHER] Comparing video source "${videoInfo.source}" with subtitle source "${subtitleInfo.source}"`);

        let score = 0;

        // Perfect match
        if (videoInfo.source === subtitleInfo.source) {
            console.log(`[MATCHER] Perfect source match: 100%`);
            score = 100;
        }
        // Compatible sources
        else if (this.areSourcesCompatible(videoInfo.source, subtitleInfo.source)) {
            console.log(`[MATCHER] Compatible sources: 80%`);
            score = 80;
        }
        // Different but known sources
        else if (videoInfo.source !== 'unknown' && subtitleInfo.source !== 'unknown') {
            console.log(`[MATCHER] Different known sources: 40%`);
            score = 40;
        }
        // Unknown source
        else {
            console.log(`[MATCHER] Unknown source: 20%`);
            score = 20;
        }

        return score;
    }

    // Calculate special edition bonus score
    calculateSpecialEditionBonus(videoInfo, subtitleInfo) {
        let bonus = 0;
        
        // If video has special edition info
        if (videoInfo.specialEdition) {
            const videoEdition = videoInfo.specialEdition;
            const subtitleTitle = (subtitleInfo.originalTitle || '').toLowerCase();
            
            // Perfect special edition match
            if (subtitleTitle.includes(videoEdition)) {
                bonus = 20;
                console.log(`[MATCHER] Perfect special edition match "${videoEdition}": +${bonus}%`);
            }
            // Partial match for common editions
            else if (videoEdition === 'extended-cut' && subtitleTitle.includes('extended')) {
                bonus = 15;
                console.log(`[MATCHER] Extended edition match: +${bonus}%`);
            }
            else if (videoEdition === 'directors-cut' && (subtitleTitle.includes('director') || subtitleTitle.includes('directors'))) {
                bonus = 15;
                console.log(`[MATCHER] Directors cut match: +${bonus}%`);
            }
            else if (videoEdition === 'special-edition' && subtitleTitle.includes('special')) {
                bonus = 10;
                console.log(`[MATCHER] Special edition match: +${bonus}%`);
            }
            // General special edition indicators
            else if (this.specialEditions.some(edition => subtitleTitle.includes(edition))) {
                bonus = 5;
                console.log(`[MATCHER] General special edition detected: +${bonus}%`);
            }
        }
        // If subtitle has special edition but video doesn't - small penalty
        else if (subtitleInfo.originalTitle && this.specialEditions.some(edition => 
            subtitleInfo.originalTitle.toLowerCase().includes(edition))) {
            bonus = -5;
            console.log(`[MATCHER] Subtitle has special edition but video doesn't: ${bonus}%`);
        }

        return bonus;
    }

    // Calculate title similarity score
    calculateTitleSimilarity(movieTitle, subtitleTitle) {
        if (!movieTitle || !subtitleTitle) return 50;

        const normalizeTitle = (title) => {
            return title.toLowerCase()
                .replace(/[^\w\s]/g, ' ')     // Replace special chars with spaces
                .replace(/\b(the|a|an)\b/g, '') // Remove articles
                .replace(/\s+/g, ' ')         // Normalize spaces
                .trim();
        };

        const normalizedMovie = normalizeTitle(movieTitle);
        const normalizedSubtitle = normalizeTitle(subtitleTitle);

        console.log(`[MATCHER] Comparing titles: "${normalizedMovie}" vs "${normalizedSubtitle}"`);

        // Exact match
        if (normalizedMovie === normalizedSubtitle) {
            console.log(`[MATCHER] Exact title match: 100%`);
            return 100;
        }

        // Check if subtitle contains sequel/prequel indicators
        const sequelWords = ['reloaded', 'revolutions', 'resurrection', 'begins', 'returns', 'rises', 'awakens', 'forever', 'reborn', 'origins', 'legacy', 'part', 'ii', 'iii', 'iv', 'v'];
        const numberPattern = /\b(2|3|4|5|6|7|8|9|10)\b/;
        
        const subtitleHasSequel = sequelWords.some(word => normalizedSubtitle.includes(word)) || 
                                 numberPattern.test(normalizedSubtitle);

        // If searching for original movie but subtitle is sequel
        if (subtitleHasSequel && !normalizedMovie.includes('2') && !normalizedMovie.includes('3') && 
            !sequelWords.some(word => normalizedMovie.includes(word))) {
            
            // Still check if base title matches
            const movieWords = normalizedMovie.split(' ').filter(w => w.length > 2);
            const subtitleWords = normalizedSubtitle.split(' ').filter(w => w.length > 2);
            const baseWords = subtitleWords.filter(word => !sequelWords.includes(word) && !numberPattern.test(word));
            
            const commonWords = movieWords.filter(word => baseWords.includes(word));
            
            if (commonWords.length === movieWords.length && movieWords.length > 0) {
                console.log(`[MATCHER] Base title matches but subtitle is sequel: 60%`);
                return 60;
            }
        }

        // Check if movie title is at the beginning of subtitle title (most important for exact matches)
        if (normalizedSubtitle.startsWith(normalizedMovie + ' ') && !subtitleHasSequel) {
            console.log(`[MATCHER] Movie title at start of subtitle (no sequel): 100%`);
            return 100;
        }

        // Movie title is contained in subtitle title (but check for sequels)
        if (normalizedSubtitle.includes(normalizedMovie)) {
            if (subtitleHasSequel) {
                console.log(`[MATCHER] Movie title contained but subtitle is sequel: 60%`);
                return 60;
            }
            console.log(`[MATCHER] Movie title contained in subtitle: 90%`);
            return 90;
        }

        // Subtitle title is contained in movie title
        if (normalizedMovie.includes(normalizedSubtitle)) {
            console.log(`[MATCHER] Subtitle title contained in movie: 85%`);
            return 85;
        }

        // Check for common words (basic similarity)
        const movieWords = normalizedMovie.split(' ').filter(w => w.length > 2);
        const subtitleWords = normalizedSubtitle.split(' ').filter(w => w.length > 2);
        const commonWords = movieWords.filter(word => subtitleWords.includes(word));
        
        if (commonWords.length > 0) {
            const similarity = (commonWords.length * 2) / (movieWords.length + subtitleWords.length) * 100;
            console.log(`[MATCHER] Common words similarity: ${similarity.toFixed(1)}%`);
            return Math.min(80, Math.max(30, similarity));
        }

        console.log(`[MATCHER] No title similarity: 10%`);
        return 10;
    }

    areSourcesCompatible(source1, source2) {
        const compatibleGroups = [
            ['bluray', 'bdrip', 'remux'],
            ['web-dl', 'webdl', 'webrip'],
            ['dvdrip', 'dvdscr'],
            ['hdcam', 'cam', 'ts']
        ];

        for (const group of compatibleGroups) {
            if (group.includes(source1) && group.includes(source2)) {
                return true;
            }
        }
        return false;
    }

    // Enhanced sorting with technical video info
    sortSubtitlesByTechnicalRelevance(subtitles, videoInfo, movieTitle = '') {
        console.log(`[MATCHER-TECH] Sorting ${subtitles.length} subtitles by technical relevance`);
        console.log(`[MATCHER-TECH] Video source: ${videoInfo.source} (${videoInfo.dataSource}, confidence: ${videoInfo.confidence}%)`);
        console.log(`[MATCHER-TECH] Movie title: "${movieTitle}"`);
        
        const scoredSubtitles = subtitles.map(subtitle => {
            const subtitleInfo = this.extractVideoInfo(subtitle.videoVersion || subtitle.title);
            const technicalScore = this.calculateTechnicalCompatibilityScore(videoInfo, subtitleInfo, movieTitle);
            const editionBonus = this.calculateSpecialEditionBonus(videoInfo, subtitleInfo);
            
            const finalScore = Math.min(100, technicalScore + editionBonus);
            
            return {
                ...subtitle,
                technicalScore: technicalScore,
                editionBonus: editionBonus,
                finalScore: finalScore,
                subtitleVideoInfo: subtitleInfo
            };
        });

        // Sort by final score (descending), then by downloads (descending)
        scoredSubtitles.sort((a, b) => {
            // Primary sort: final score (higher is better)
            const scoreDiff = b.finalScore - a.finalScore;
            if (Math.abs(scoreDiff) >= 2) {
                return scoreDiff;
            }
            
            // Secondary sort: downloads (higher is better)
            const downloadDiff = (b.downloads || 0) - (a.downloads || 0);
            if (downloadDiff !== 0) {
                return downloadDiff;
            }
            
            // Tertiary sort: ID (for consistent ordering)
            return (a.id || '').localeCompare(b.id || '');
        });

        console.log(`[MATCHER-TECH] Top 6 technical matches:`);
        scoredSubtitles.slice(0, 6).forEach((sub, i) => {
            const editionInfo = sub.editionBonus !== 0 ? ` Edition: ${sub.editionBonus > 0 ? '+' : ''}${sub.editionBonus}%` : '';
            console.log(`[MATCHER-TECH] ${i+1}. "${sub.title}" - TechScore: ${sub.technicalScore.toFixed(1)}%${editionInfo} - Final: ${sub.finalScore.toFixed(1)}% - Downloads: ${sub.downloads || 0}`);
        });

        return scoredSubtitles;
    }

    // Sort subtitles by source relevance to video
    sortSubtitlesByRelevance(subtitles, videoInfo, movieTitle = '') {
        console.log(`[MATCHER] Sorting ${subtitles.length} subtitles by source relevance and title similarity`);
        console.log(`[MATCHER] Target movie title: "${movieTitle}"`);
        if (videoInfo.specialEdition) {
            console.log(`[MATCHER] Target special edition: "${videoInfo.specialEdition}"`);
        }
        
        const scoredSubtitles = subtitles.map(subtitle => {
            const subtitleInfo = this.extractVideoInfo(subtitle.videoVersion || subtitle.title);
            const sourceScore = this.calculateCompatibilityScore(videoInfo, subtitleInfo);
            const titleScore = this.calculateTitleSimilarity(movieTitle, subtitle.title);
            const editionBonus = this.calculateSpecialEditionBonus(videoInfo, subtitleInfo);
            
            // Combined score: 60% source + 25% title + 15% edition bonus
            const baseScore = (sourceScore * 0.6) + (titleScore * 0.25);
            const finalScore = Math.min(100, baseScore + editionBonus);
            
            return {
                ...subtitle,
                compatibilityScore: sourceScore,
                titleSimilarity: titleScore,
                editionBonus: editionBonus,
                finalScore: finalScore,
                subtitleVideoInfo: subtitleInfo
            };
        });

        // Sort by final score (descending), then by downloads (descending)
        scoredSubtitles.sort((a, b) => {
            // Primary sort: final score (higher is better)
            const scoreDiff = b.finalScore - a.finalScore;
            if (Math.abs(scoreDiff) >= 3) { // Reduced threshold for more sensitive sorting
                return scoreDiff;
            }
            
            // Secondary sort: downloads (higher is better)
            const downloadDiff = (b.downloads || 0) - (a.downloads || 0);
            if (downloadDiff !== 0) {
                return downloadDiff;
            }
            
            // Tertiary sort: ID (for consistent ordering)
            return (a.id || '').localeCompare(b.id || '');
        });

        console.log(`[MATCHER] Top 6 matches after sorting:`);
        scoredSubtitles.slice(0, 6).forEach((sub, i) => {
            const editionInfo = sub.editionBonus !== 0 ? ` EditionBonus: ${sub.editionBonus > 0 ? '+' : ''}${sub.editionBonus}%` : '';
            console.log(`[MATCHER] ${i+1}. "${sub.title}" - Source: ${sub.subtitleVideoInfo.source} - SourceScore: ${sub.compatibilityScore}% - TitleScore: ${sub.titleSimilarity.toFixed(1)}%${editionInfo} - FinalScore: ${sub.finalScore.toFixed(1)}% - Downloads: ${sub.downloads || 0}`);
        });

        return scoredSubtitles;
    }

    // Create enhanced subtitle name with technical compatibility indicator
    createEnhancedSubtitleName(subtitle, isTopMatch = false, isTechnicalMatch = false) {
        let name = subtitle.title;
        
        // Add special edition info if detected
        if (subtitle.subtitleVideoInfo && subtitle.subtitleVideoInfo.specialEdition) {
            const edition = subtitle.subtitleVideoInfo.specialEdition.toUpperCase().replace('-', ' ');
            name += ` [${edition}]`;
        }
        
        // Add source info if available
        if (subtitle.videoVersion && !name.includes(subtitle.videoVersion)) {
            const source = this.extractSource(subtitle.videoVersion);
            if (source !== 'unknown') {
                name += ` [${source.toUpperCase()}]`;
            }
        }

        // Add compatibility indicator based on final score
        const finalScore = subtitle.finalScore || subtitle.compatibilityScore || subtitle.technicalScore;
        
        if (isTechnicalMatch && finalScore >= 95) {
            name = `🎯🔥 ${name}`; // Perfect technical match
        } else if (isTechnicalMatch && finalScore >= 90) {
            name = `🎯⭐ ${name}`; // Excellent technical match
        } else if (isTechnicalMatch && finalScore >= 80) {
            name = `🎯✅ ${name}`; // Good technical match
        } else if (isTopMatch && finalScore >= 95) {
            name = `🏆 ${name}`; // Perfect match with edition bonus
        } else if (finalScore >= 90) {
            name = `🎯 ${name}`; // Excellent match
        } else if (finalScore >= 80) {
            name = `✅ ${name}`; // Good match
        } else if (finalScore >= 60) {
            name = `📝 ${name}`; // Decent match
        } else {
            name = `⚠️ ${name}`; // Poor match
        }

        // Add edition bonus indicator for special editions
        if (subtitle.editionBonus && subtitle.editionBonus > 0) {
            name = name.replace(/^(🎯🔥|🎯⭐|🎯✅|🏆|🎯|✅|📝|⚠️) /, '$1⭐ '); // Add star for edition bonus
        }

        // Add author if available
        if (subtitle.author && !name.includes(subtitle.author)) {
            name += ` - ${subtitle.author}`;
        }

        return name;
    }
}

// Initialize matcher
const subtitleMatcher = new SubtitleMatcher();

// Keep-alive ping endpoint
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        activeSessions: userSessions.size
    });
});

// Keep-alive function to prevent Render.com sleep
function startKeepAlive() {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    console.log(`[KEEP-ALIVE] Starting self-ping every 13 minutes to: ${baseUrl}/ping`);
    
    setInterval(async () => {
        try {
            const startTime = Date.now();
            const response = await axios.get(`${baseUrl}/ping`, {
                timeout: 30000,
                headers: {
                    'User-Agent': 'Titulky-Addon-KeepAlive/1.0'
                }
            });
            const responseTime = Date.now() - startTime;
            
            console.log(`[KEEP-ALIVE] ✓ Ping successful in ${responseTime}ms - Status: ${response.data.status} - Uptime: ${response.data.uptime}s`);
        } catch (error) {
            console.log(`[KEEP-ALIVE] ✗ Ping failed: ${error.message}`);
            
            // If ping fails, try alternative endpoints
            try {
                await axios.get(`${baseUrl}/health`, { timeout: 15000 });
                console.log(`[KEEP-ALIVE] ✓ Fallback health ping successful`);
            } catch (fallbackError) {
                console.log(`[KEEP-ALIVE] ✗ Fallback ping also failed: ${fallbackError.message}`);
            }
        }
    }, 13 * 60 * 1000); // Ping every 13 minutes (780 seconds)
}

// Helper function to get movie/series title from IMDB ID
async function getMovieTitle(imdbId) {
    try {
        // Use OMDB API to get movie title (free API)
        const omdbUrl = `http://www.omdbapi.com/?i=tt${imdbId}&apikey=trilogy`;
        console.log(`[OMDB] Fetching title for IMDB ${imdbId}`);
        
        const response = await axios.get(omdbUrl, { timeout: 5000 });
        
        if (response.data && response.data.Title && response.data.Response === 'True') {
            console.log(`[OMDB] Found title: "${response.data.Title}" (${response.data.Year})`);
            return {
                title: response.data.Title,
                year: response.data.Year,
                type: response.data.Type
            };
        } else {
            console.log(`[OMDB] No title found for IMDB ${imdbId}`);
            return null;
        }
    } catch (error) {
        console.error(`[OMDB] Error fetching title for IMDB ${imdbId}:`, error.message);
        return null;
    }
}

// Helper function to create fallback SRT content when captcha is detected
function createFallbackSRT(title, language = 'cs') {
    return `1
00:00:01,000 --> 00:05:00,000
Dosáhli jste maximální počet stažení 25 za den. Reset limitu proběhne zítra.
`;
}

// Addon manifest
const manifest = {
    id: 'com.titulky.subtitles',
    version: '1.0.0',
    name: 'Titulky.com Subtitles',
    description: 'Czech and Slovak subtitles from Titulky.com with RealDebrid integration',
    logo: 'https://www.titulky.com/favicon.ico',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
        adult: false,
        p2p: false,
        configurable: false,
        configurationRequired: false
    }
};

class TitulkyClient {
    constructor() {
        this.baseUrl = 'https://www.titulky.com';
        this.cookies = {};
        this.lastUsed = Date.now();
        this.captchaDetected = false; // Track captcha state
    }

    // New method to fetch detailed subtitle information including video version
    async getSubtitleDetails(linkFile, subtitleId) {
        console.log(`[DETAILS] Fetching details for: ${linkFile}-${subtitleId}.htm`);
        
        try {
            const detailUrl = `${this.baseUrl}/${linkFile}-${subtitleId}.htm`;
            
            const response = await axios.get(detailUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': this.baseUrl,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate'
                },
                timeout: 10000,
                responseType: 'arraybuffer'
            });

            // Handle compressed response
            let content;
            const contentEncoding = response.headers['content-encoding'];
            
            if (contentEncoding === 'gzip') {
                content = zlib.gunzipSync(response.data).toString('utf-8');
            } else if (contentEncoding === 'deflate') {
                content = zlib.inflateSync(response.data).toString('utf-8');
            } else {
                content = response.data.toString('utf-8');
            }

            return this.parseSubtitleDetails(content);
            
        } catch (error) {
            console.error(`[DETAILS] Error fetching details for ${linkFile}-${subtitleId}:`, error.message);
            return null;
        }
    }

    parseSubtitleDetails(html) {
        console.log('[DETAILS] Parsing subtitle detail page');
        const $ = cheerio.load(html);
        
        const details = {
            videoVersion: '',
            releaseInfo: '',
            author: ''
        };

        try {
            // Look for the main content table with subtitle details
            const infoTable = $('table').filter((i, table) => {
                return $(table).text().includes('VERZE PRO') || $(table).text().includes('DALŠÍ INFO');
            });

            if (infoTable.length > 0) {
                // Parse version info from "VERZE PRO" section
                const versionCell = infoTable.find('td').filter((i, cell) => {
                    return $(cell).text().trim().startsWith('VERZE PRO');
                });

                if (versionCell.length > 0) {
                    const versionText = versionCell.next('td').text().trim();
                    details.videoVersion = this.cleanVersionText(versionText);
                    console.log(`[DETAILS] Found video version: ${details.videoVersion}`);
                }

                // Look for additional release info in table cells
                infoTable.find('tr').each((i, row) => {
                    const cells = $(row).find('td');
                    if (cells.length >= 2) {
                        const label = $(cells[0]).text().trim();
                        const value = $(cells[1]).text().trim();
                        
                        switch (label) {
                            case 'DALŠÍ INFO':
                                details.releaseInfo = value;
                                break;
                            case 'ULOŽIL':
                                details.author = value;
                                break;
                        }
                    }
                });
            }

            // Try alternative parsing - look for version info in different structures
            if (!details.videoVersion) {
                // Look for video file names or version strings in the page
                const versionPatterns = [
                    /([A-Za-z0-9]+\.[A-Za-z0-9]+\.[0-9]+p\.[A-Za-z0-9]+\.[A-Za-z0-9-]+)/g,
                    /([0-9]+p[.-][A-Za-z0-9.-]+)/g,
                    /(BluRay|BDRip|DVDRip|WEBRip|HDTV|WEB-DL)[.-]?[A-Za-z0-9.-]*/gi,
                    /(x264|x265|H\.264|H\.265|HEVC)[.-]?[A-Za-z0-9.-]*/gi
                ];

                const pageText = $.text();
                for (const pattern of versionPatterns) {
                    const matches = pageText.match(pattern);
                    if (matches && matches.length > 0) {
                        details.videoVersion = matches[0];
                        console.log(`[DETAILS] Extracted version from pattern: ${details.videoVersion}`);
                        break;
                    }
                }
            }

        } catch (error) {
            console.error('[DETAILS] Error parsing subtitle details:', error.message);
        }

        return details;
    }

    cleanVersionText(text) {
        // Clean and normalize version text
        return text
            .replace(/\s+/g, ' ')
            .replace(/[^\w\d\.\-\[\]]/g, ' ')
            .trim()
            .substring(0, 100); // Limit length
    }

    // Enhanced search with detailed info
    async searchSubtitlesWithDetails(query, fetchDetails = false) {
        console.log(`[SEARCH+] Starting enhanced search for: "${query}"`);
        
        const basicResults = await this.searchSubtitles(query);
        
        if (!fetchDetails || basicResults.length === 0) {
            return basicResults;
        }

        // Fetch details for top results (limit to avoid too many requests)
        const detailedResults = [];
        const maxDetails = Math.min(5, basicResults.length); // Limit to top 5
        
        for (let i = 0; i < maxDetails; i++) {
            const subtitle = basicResults[i];
            console.log(`[SEARCH+] Fetching details for result ${i+1}/${maxDetails}: ${subtitle.title}`);
            
            try {
                const details = await this.getSubtitleDetails(subtitle.linkFile, subtitle.id);
                
                if (details && details.videoVersion) {
                    subtitle.videoVersion = details.videoVersion;
                    subtitle.releaseInfo = details.releaseInfo;
                    subtitle.detailedAuthor = details.author;
                    
                    console.log(`[SEARCH+] Enhanced subtitle: ${subtitle.title} - Version: ${subtitle.videoVersion}`);
                } else {
                    console.log(`[SEARCH+] No additional details found for: ${subtitle.title}`);
                }
                
                detailedResults.push(subtitle);
                
                // Small delay to avoid overwhelming the server
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.error(`[SEARCH+] Failed to fetch details for ${subtitle.title}:`, error.message);
                // Add subtitle without details
                detailedResults.push(subtitle);
            }
        }
        
        // Add remaining results without details
        for (let i = maxDetails; i < basicResults.length; i++) {
            detailedResults.push(basicResults[i]);
        }
        
        return detailedResults;
    }

    async login(username, password) {
        console.log(`[LOGIN] Attempting login for user: ${username}`);
        try {
            const loginData = new URLSearchParams({
                'Login': username,
                'Password': password,
                'foreverlog': '0',
                'Detail2': ''
            });

            console.log(`[LOGIN] Sending POST request to ${this.baseUrl}/index.php`);
            const response = await axios.post(`${this.baseUrl}/index.php`, loginData, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': this.baseUrl,
                    'Referer': this.baseUrl,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate'
                },
                timeout: 10000,
                responseType: 'arraybuffer'
            });

            console.log(`[LOGIN] Response status: ${response.status}`);
            
            // Handle compressed response
            let content;
            const contentEncoding = response.headers['content-encoding'];
            
            if (contentEncoding === 'gzip') {
                console.log('[LOGIN] Decompressing gzip content');
                content = zlib.gunzipSync(response.data).toString('utf-8');
            } else if (contentEncoding === 'deflate') {
                console.log('[LOGIN] Decompressing deflate content');
                content = zlib.inflateSync(response.data).toString('utf-8');
            } else {
                console.log('[LOGIN] No compression detected');
                content = response.data.toString('utf-8');
            }
            
            if (content.includes('BadLogin')) {
                console.log('[LOGIN] Bad credentials detected');
                return false;
            }

            // Extract cookies from response
            const setCookie = response.headers['set-cookie'];
            if (setCookie) {
                console.log(`[LOGIN] Extracting cookies from ${setCookie.length} set-cookie headers`);
                setCookie.forEach(cookie => {
                    const [name, value] = cookie.split('=');
                    if (name && value) {
                        this.cookies[name] = value.split(';')[0];
                        console.log(`[LOGIN] Cookie set: ${name}=${this.cookies[name].substring(0, 10)}...`);
                    }
                });
            }

            this.lastUsed = Date.now();
            this.captchaDetected = false; // Reset captcha state on successful login
            console.log('[LOGIN] Login successful');
            return true;
        } catch (error) {
            console.error('[LOGIN] Login error:', error.message);
            if (error.response) {
                console.error('[LOGIN] Response status:', error.response.status);
                console.error('[LOGIN] Response data type:', typeof error.response.data);
            }
            return false;
        }
    }

    async searchSubtitles(query) {
        console.log(`[SEARCH] Starting search for: "${query}"`);
        
        // If captcha was detected in previous requests, return empty results
        if (this.captchaDetected) {
            console.log('[SEARCH] Captcha detected in previous request, skipping search');
            return [];
        }
        
        try {
            const searchUrl = `${this.baseUrl}/index.php?${new URLSearchParams({
                'Fulltext': query,
                'FindUser': ''
            })}`;

            console.log(`[SEARCH] Search URL: ${searchUrl}`);
            console.log(`[SEARCH] Using cookies: ${Object.keys(this.cookies).join(', ')}`);

            const response = await axios.get(searchUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': this.baseUrl,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate'
                },
                timeout: 15000,
                responseType: 'arraybuffer'
            });

            console.log(`[SEARCH] Response status: ${response.status}`);
            console.log(`[SEARCH] Response headers:`, response.headers);
            
            // Handle compressed response
            let content;
            const contentEncoding = response.headers['content-encoding'];
            
            if (contentEncoding === 'gzip') {
                console.log('[SEARCH] Decompressing gzip content');
                content = zlib.gunzipSync(response.data).toString('utf-8');
            } else if (contentEncoding === 'deflate') {
                console.log('[SEARCH] Decompressing deflate content');
                content = zlib.inflateSync(response.data).toString('utf-8');
            } else {
                console.log('[SEARCH] No compression detected');
                content = response.data.toString('utf-8');
            }

            console.log(`[SEARCH] Content length: ${content.length} characters`);
            console.log(`[SEARCH] Content start: ${content.substring(0, 200)}`);

            // Check for captcha in search results
            if (content.includes('captcha') || content.includes('CAPTCHA')) {
                console.log('[SEARCH] CAPTCHA detected in search results');
                this.captchaDetected = true;
                return [];
            }

            const subtitles = this.parseSearchResults(content);
            console.log(`[SEARCH] Found ${subtitles.length} subtitles`);
            
            this.lastUsed = Date.now();
            return subtitles;
        } catch (error) {
            console.error('[SEARCH] Search error:', error.message);
            if (error.response) {
                console.error('[SEARCH] Response status:', error.response.status);
                console.error('[SEARCH] Response headers:', error.response.headers);
                console.error('[SEARCH] Response data type:', typeof error.response.data);
            }
            return [];
        }
    }

    parseSearchResults(html) {
        console.log('[PARSE] Starting to parse search results');
        const $ = cheerio.load(html);
        const subtitles = [];

        // Debug: Check if we're logged in
        if (html.includes('Přihlásit')) {
            console.log('[PARSE] WARNING: Appears to be logged out (found login text)');
        }

        const rows = $('tr[class^="r"]');
        console.log(`[PARSE] Found ${rows.length} result rows`);

        rows.each((index, element) => {
            try {
                const $row = $(element);
                const cells = $row.find('td');
                
                console.log(`[PARSE] Row ${index}: ${cells.length} cells`);
                
                // Debug: print all links in the row for first few rows
                if (index < 3) {
                    cells.each((cellIndex, cell) => {
                        const cellText = $(cell).text().trim();
                        const links = $(cell).find('a');
                        if (links.length > 0) {
                            links.each((linkIndex, link) => {
                                const href = $(link).attr('href');
                                const linkText = $(link).text().trim();
                                console.log(`[PARSE] Row ${index}, Cell ${cellIndex}, Link ${linkIndex}: href="${href}", text="${linkText}"`);
                            });
                        }
                        console.log(`[PARSE] Row ${index}, Cell ${cellIndex}: "${cellText}"`);
                    });
                }
                
                // Adjust for different table structure (8 cells instead of 9)
                if (cells.length < 8) {
                    console.log(`[PARSE] Row ${index}: Insufficient cells (${cells.length}), skipping`);
                    return;
                }

                // Find the link in any cell - search all cells for the main link
                let linkElement = null;
                let href = null;
                
                for (let i = 0; i < cells.length; i++) {
                    const cellLinks = cells.eq(i).find('a');
                    cellLinks.each((j, link) => {
                        const linkHref = $(link).attr('href');
                        if (linkHref && linkHref.includes('-') && linkHref.includes('.htm')) {
                            linkElement = $(link);
                            href = linkHref;
                            console.log(`[PARSE] Row ${index}: Found main link in cell ${i}: ${href}`);
                            return false; // Break out of each loop
                        }
                    });
                    if (href) break; // Break out of for loop
                }
                
                console.log(`[PARSE] Row ${index}: href = ${href}`);
                
                if (!href) {
                    console.log(`[PARSE] Row ${index}: No href found, skipping`);
                    return;
                }

                const linkMatch = href.match(/(.+)-(\d+)\.htm/);
                if (!linkMatch) {
                    console.log(`[PARSE] Row ${index}: href doesn't match pattern, skipping`);
                    return;
                }

                const title = linkElement.text().trim();
                
                // Try to find other data in the cells
                let version = '';
                let year = '';
                let downloads = 0;
                let lang = '';
                let size = 0;
                let author = '';
                
                // Look for year (4 digits)
                cells.each((i, cell) => {
                    const cellText = $(cell).text().trim();
                    if (/^\d{4}$/.test(cellText)) {
                        year = cellText;
                    }
                    // Look for downloads (numbers)
                    if (/^\d{1,6}$/.test(cellText) && parseInt(cellText) > 0) {
                        downloads = Math.max(downloads, parseInt(cellText));
                    }
                    // Look for language flags
                    const langImg = $(cell).find('img');
                    if (langImg.length > 0) {
                        lang = langImg.attr('alt') || '';
                    }
                });

                console.log(`[PARSE] Row ${index}: title="${title}", lang="${lang}", downloads=${downloads}, year="${year}"`);

                // Convert language codes
                let language = lang;
                if (lang === 'CZ') language = 'Czech';
                if (lang === 'SK') language = 'Slovak';

                subtitles.push({
                    id: linkMatch[2],
                    linkFile: linkMatch[1],
                    title: title,
                    version: version,
                    year: year,
                    downloads: downloads,
                    language: language,
                    size: size,
                    author: author,
                    rating: Math.min(5, Math.floor(downloads / 100)) // Simple rating based on downloads
                });
            } catch (error) {
                console.error(`[PARSE] Parse row ${index} error:`, error.message);
            }
        });

        console.log(`[PARSE] Successfully parsed ${subtitles.length} subtitles`);
        return subtitles;
    }

    async downloadSubtitle(subtitleId, linkFile) {
        console.log(`[DOWNLOAD] Starting download: id=${subtitleId}, linkFile=${linkFile}`);
        try {
            const downloadUrl = `${this.baseUrl}/idown.php?${new URLSearchParams({
                'R': Date.now().toString(),
                'titulky': subtitleId,
                'histstamp': '',
                'zip': 'z'
            })}`;

            console.log(`[DOWNLOAD] Download page URL: ${downloadUrl}`);

            const response = await axios.get(downloadUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'Referer': `${this.baseUrl}/${linkFile}.htm`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate'
                },
                responseType: 'arraybuffer'
            });

            // Handle compressed response
            let content;
            const contentEncoding = response.headers['content-encoding'];
            
            if (contentEncoding === 'gzip') {
                console.log('[DOWNLOAD] Decompressing gzip content');
                content = zlib.gunzipSync(response.data).toString('utf-8');
            } else if (contentEncoding === 'deflate') {
                console.log('[DOWNLOAD] Decompressing deflate content');
                content = zlib.inflateSync(response.data).toString('utf-8');
            } else {
                console.log('[DOWNLOAD] No compression detected');
                content = response.data.toString('utf-8');
            }

            console.log(`[DOWNLOAD] Content length: ${content.length}`);

            // Check if captcha is required
            if (content.includes('captcha') || content.includes('CAPTCHA')) {
                console.log('[DOWNLOAD] Captcha detected - setting captcha flag');
                this.captchaDetected = true;
                throw new Error('CAPTCHA_DETECTED');
            }

            // Extract download link and wait time
            const downloadLinkMatch = content.match(/id="downlink" href="([^"]+)"/);
            const waitTimeMatch = content.match(/CountDown\((\d+)\)/);

            if (!downloadLinkMatch) {
                console.log('[DOWNLOAD] Download link not found in content');
                console.log('[DOWNLOAD] Content preview:', content.substring(0, 500));
                throw new Error('Download link not found');
            }

            const finalUrl = `${this.baseUrl}${downloadLinkMatch[1]}`;
            const waitTime = waitTimeMatch ? parseInt(waitTimeMatch[1]) : 0;

            console.log(`[DOWNLOAD] Final URL: ${finalUrl}`);
            console.log(`[DOWNLOAD] Wait time: ${waitTime} seconds`);

            // Wait before downloading
            if (waitTime > 0) {
                console.log(`[DOWNLOAD] Waiting ${waitTime} seconds...`);
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
            }

            const fileResponse = await axios.get(finalUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'Referer': `${this.baseUrl}/idown.php`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                responseType: 'arraybuffer'
            });

            console.log(`[DOWNLOAD] Downloaded ${fileResponse.data.length} bytes`);
            
            // Extract SRT from ZIP archive
            try {
                console.log('[DOWNLOAD] Extracting SRT from ZIP archive');
                const zip = new AdmZip(fileResponse.data);
                const zipEntries = zip.getEntries();
                
                console.log(`[DOWNLOAD] ZIP contains ${zipEntries.length} files`);
                
                // Look for SRT file in the archive
                let srtContent = null;
                for (const entry of zipEntries) {
                    console.log(`[DOWNLOAD] Found file in ZIP: ${entry.entryName}`);
                    
                    if (entry.entryName.toLowerCase().endsWith('.srt')) {
                        console.log(`[DOWNLOAD] Extracting SRT file: ${entry.entryName}`);
                        
                        // Get raw buffer data first (preserve original encoding)
                        const srtBuffer = entry.getData();
                        
                        // Process encoding conversion
                        try {
                            // Try UTF-8 first
                            let content = srtBuffer.toString('utf-8');
                            
                            // Check if UTF-8 decoding is valid (no replacement characters)
                            if (content.includes('�') || this.hasWin1250EncodingPattern(content)) {
                                console.log(`[DOWNLOAD] Converting Windows-1250 to UTF-8`);
                                content = iconv.decode(srtBuffer, 'windows-1250');
                            } else {
                                console.log(`[DOWNLOAD] Using UTF-8 encoding`);
                            }
                            
                            srtContent = content;
                            console.log(`[DOWNLOAD] Content sample (first 200 chars): ${content.substring(0, 200).replace(/\n/g, '\\n')}`);
                            
                        } catch (encodingError) {
                            console.log(`[DOWNLOAD] Encoding conversion failed, using Windows-1250: ${encodingError.message}`);
                            srtContent = iconv.decode(srtBuffer, 'windows-1250');
                        }
                        
                        break;
                    }
                }
                
                if (!srtContent) {
                    // If no SRT found, try to extract any text file
                    for (const entry of zipEntries) {
                        if (!entry.isDirectory && entry.entryName.includes('.')) {
                            console.log(`[DOWNLOAD] Extracting text file: ${entry.entryName}`);
                            
                            // Get raw buffer and process encoding
                            const fileBuffer = entry.getData();
                            try {
                                let content = fileBuffer.toString('utf-8');
                                
                                if (content.includes('�') || this.hasWin1250EncodingPattern(content)) {
                                    console.log(`[DOWNLOAD] Converting text file Windows-1250 to UTF-8`);
                                    content = iconv.decode(fileBuffer, 'windows-1250');
                                }
                                
                                srtContent = content;
                                
                            } catch (encodingError) {
                                console.log(`[DOWNLOAD] Text file encoding conversion failed: ${encodingError.message}`);
                                srtContent = iconv.decode(fileBuffer, 'windows-1250');
                            }
                            
                            break;
                        }
                    }
                }
                
                if (srtContent) {
                    console.log(`[DOWNLOAD] Successfully extracted SRT content (${srtContent.length} characters)`);
                    return srtContent;
                } else {
                    console.log('[DOWNLOAD] No SRT file found in ZIP archive');
                    throw new Error('No SRT file found in archive');
                }
                
            } catch (zipError) {
                console.error('[DOWNLOAD] ZIP extraction error:', zipError.message);
                console.log('[DOWNLOAD] Falling back to raw ZIP data');
                return fileResponse.data;
            }
            
        } catch (error) {
            console.error('[DOWNLOAD] Download error:', error.message);
            throw error;
        }
    }

    getCookieString() {
        return Object.entries(this.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
    }

    // Helper method for encoding detection
    hasWin1250EncodingPattern(text) {
        // Look for byte sequences that indicate Windows-1250 content decoded as UTF-8
        const win1250Patterns = [
            /\u00C4\u008D/, // č as UTF-8 bytes
            /\u00C4\u008F/, // ď as UTF-8 bytes  
            /\u00C4\u009B/, // ě as UTF-8 bytes
            /\u00C5\u0088/, // ň as UTF-8 bytes
            /\u00C5\u0099/, // ř as UTF-8 bytes
            /\u00C5\u00A1/, // š as UTF-8 bytes
            /\u00C5\u00A5/, // ť as UTF-8 bytes
            /\u00C5\u00AF/, // ů as UTF-8 bytes
            /\u00C5\u00BE/, // ž as UTF-8 bytes
            /\u00C3\u00A1/, // á as UTF-8 bytes
            /\u00C3\u00A9/, // é as UTF-8 bytes
            /\u00C3\u00AD/, // í as UTF-8 bytes
            /\u00C3\u00B3/, // ó as UTF-8 bytes
            /\u00C3\u00BA/, // ú as UTF-8 bytes
            /\u00C3\u00BD/  // ý as UTF-8 bytes
        ];
        
        return win1250Patterns.some(pattern => pattern.test(text));
    }
}

// OPTIONS handler pro CORS
app.options('*', (req, res) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400'
    });
    res.status(200).end();
});

// Routes
app.get('/', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Titulky.com Stremio Addon s RealDebrid</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #333;
        }

        .container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            max-width: 600px;
            width: 90%;
            text-align: center;
        }

        .logo {
            width: 80px;
            height: 80px;
            background: linear-gradient(45deg, #ff6b6b, #ee5a24);
            border-radius: 50%;
            margin: 0 auto 30px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2rem;
            color: white;
            font-weight: bold;
        }

        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 2.5rem;
            font-weight: 700;
        }

        .subtitle {
            color: #666;
            margin-bottom: 40px;
            font-size: 1.1rem;
        }

        .form-group {
            margin-bottom: 25px;
            text-align: left;
        }

        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #555;
        }

        input {
            width: 100%;
            padding: 15px;
            border: 2px solid #e0e0e0;
            border-radius: 12px;
            font-size: 1rem;
            transition: all 0.3s ease;
            background: rgba(255, 255, 255, 0.9);
        }

        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        .optional {
            font-size: 0.9rem;
            color: #888;
            margin-left: 5px;
        }

        .btn {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 12px;
            font-size: 1.1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            width: 100%;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
        }

        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        .result {
            margin-top: 30px;
            padding: 20px;
            border-radius: 12px;
            display: none;
        }

        .result.success {
            background: rgba(76, 175, 80, 0.1);
            border: 2px solid #4caf50;
            color: #2e7d32;
        }

        .result.error {
            background: rgba(244, 67, 54, 0.1);
            border: 2px solid #f44336;
            color: #c62828;
        }

        .install-btn {
            background: linear-gradient(45deg, #4caf50, #8bc34a);
            margin-top: 15px;
            text-decoration: none;
            display: inline-block;
            padding: 12px 25px;
            border-radius: 8px;
            color: white;
            font-weight: 600;
            transition: all 0.3s ease;
        }

        .install-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(76, 175, 80, 0.3);
        }

        .info {
            background: rgba(33, 150, 243, 0.1);
            border: 2px solid #2196f3;
            border-radius: 12px;
            padding: 20px;
            margin-top: 30px;
            text-align: left;
        }

        .info h3 {
            color: #1976d2;
            margin-bottom: 10px;
        }

        .info ul {
            color: #333;
            line-height: 1.6;
            padding-left: 20px;
        }

        .loading {
            display: none;
            align-items: center;
            justify-content: center;
            color: #667eea;
            font-weight: 600;
        }

        .warning {
            background: rgba(255, 193, 7, 0.1);
            border: 2px solid #ffc107;
            border-radius: 12px;
            padding: 15px;
            margin-top: 20px;
            color: #856404;
        }

        .keep-alive-status {
            background: rgba(76, 175, 80, 0.1);
            border: 2px solid #4caf50;
            border-radius: 12px;
            padding: 15px;
            margin-top: 20px;
            color: #2e7d32;
        }

        .realdebrid-section {
            background: rgba(255, 152, 0, 0.1);
            border: 2px solid #ff9800;
            border-radius: 12px;
            padding: 20px;
            margin-top: 20px;
            text-align: left;
        }

        .realdebrid-section h3 {
            color: #f57c00;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .realdebrid-section .icon {
            font-size: 1.5rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">T</div>
        <h1>Titulky.com</h1>
        <p class="subtitle">Stremio Addon pro české a slovenské titulky s RealDebrid integrací</p>
        
        <form id="configForm">
            <div class="form-group">
                <label for="username">Uživatelské jméno na Titulky.com:</label>
                <input type="text" id="username" name="username" required placeholder="Vaše uživatelské jméno na Titulky.com">
            </div>
            
            <div class="form-group">
                <label for="password">Heslo na Titulky.com:</label>
                <input type="password" id="password" name="password" required placeholder="Vaše heslo">
            </div>
            
            <div class="form-group">
                <label for="realDebridKey">
                    RealDebrid API klíč: 
                    <span class="optional">(volitelné - pro lepší matching)</span>
                </label>
                <input type="text" id="realDebridKey" name="realDebridKey" placeholder="Váš RealDebrid API klíč">
            </div>
            
            <button type="submit" class="btn" id="submitBtn">
                Vytvořit konfiguraci
            </button>
            
            <div class="loading" id="loading">
                Ověřuji přihlašovací údaje...
            </div>
        </form>
        
        <div id="result" class="result">
            <div id="resultMessage"></div>
            <a id="installLink" class="install-btn" style="display: none;">
                Nainstalovat do Stremio
            </a>
        </div>
        
        <div class="realdebrid-section">
            <h3><span class="icon">🚀</span>RealDebrid Integrace (NOVÉ!)</h3>
            <ul>
                <li><strong>Chytré matching:</strong> Addon automaticky detekuje váš právě přehrávaný soubor z RealDebrid</li>
                <li><strong>Přesné titulky:</strong> Seřadí titulky podle kvality, kodeku a release skupiny vašeho souboru</li>
                <li><strong>Perfektní shoda:</strong> 🎯🔥 = perfektní shoda s RealDebrid souborem</li>
                <li><strong>API klíč najdete:</strong> RealDebrid → Account → API Token</li>
                <li><strong>Volitelné:</strong> Addon funguje i bez RealDebrid API klíče</li>
            </ul>
        </div>
        
        <div class="keep-alive-status">
            <strong>🟢 Keep-Alive aktivní:</strong><br>
            Addon se automaticky udržuje při životě ping každých 13 minut pro Render.com hosting.
        </div>
        
        <div class="warning">
            <strong>⚠️ Limit stažení:</strong><br>
            Titulky.com má limit 25 stažení za den. Po překročení limitu se zobrazí speciální SRT soubor s upozorněním.
        </div>
        
        <div class="info">
            <h3>📋 Instrukce:</h3>
            <ul>
                <li>Zadejte své přihlašovací údaje k účtu na Titulky.com</li>
                <li><strong>Volitelně:</strong> Přidejte RealDebrid API klíč pro chytré matching titulků</li>
                <li>Klikněte na "Vytvořit konfiguraci"</li>
                <li>Po úspěšném ověření klikněte na "Nainstalovat do Stremio"</li>
                <li>Addon bude dostupný v sekci Addons ve Stremio</li>
                <li>Titulky se automaticky zobrazí při přehrávání filmů a seriálů</li>
                <li><strong>S RealDebrid:</strong> Titulky budou seřazeny podle vašeho aktuálního souboru</li>
            </ul>
        </div>
    </div>

    <script>
        document.getElementById('configForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const submitBtn = document.getElementById('submitBtn');
            const loading = document.getElementById('loading');
            const result = document.getElementById('result');
            const resultMessage = document.getElementById('resultMessage');
            const installLink = document.getElementById('installLink');
            
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const realDebridKey = document.getElementById('realDebridKey').value;
            
            // Show loading state
            submitBtn.style.display = 'none';
            loading.style.display = 'flex';
            result.style.display = 'none';
            
            try {
                const response = await fetch('/configure', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ username, password, realDebridKey })
                });
                
                const data = await response.json();
                
                if (response.ok && data.success) {
                    result.className = 'result success';
                    
                    let rdStatus = '';
                    if (data.realDebridStatus) {
                        if (data.realDebridStatus.valid) {
                            rdStatus = \`<br><strong>🚀 RealDebrid:</strong> Aktivní pro uživatele \${data.realDebridStatus.username} (Premium: \${data.realDebridStatus.premium ? 'Ano' : 'Ne'})\`;
                        } else {
                            rdStatus = \`<br><strong>⚠️ RealDebrid:</strong> Neplatný API klíč\`;
                        }
                    }
                    
                    resultMessage.innerHTML = \`
                        <strong>✅ Konfigurace úspěšně vytvořena!</strong><br>
                        \${rdStatus}
                        <br><br>
                        <strong>📋 Kroky pro instalaci:</strong><br>
                        1. Zkopírujte URL níže<br>
                        2. Otevřete Stremio → Settings → Addons<br>
                        3. Klikněte "Community addons"<br>
                        4. Klikněte "Add addon URL"<br>
                        5. Vložte URL (bez stremio:// prefixu)<br>
                        <br>
                        <input type="text" value="\${data.testUrl}" readonly style="width: 100%; margin: 10px 0; padding: 5px; font-size: 12px; border: 1px solid #ddd; border-radius: 4px;" onclick="this.select()">
                    \`;
                    installLink.href = data.installUrl;
                    installLink.style.display = 'inline-block';
                    installLink.textContent = 'Automatická instalace';
                } else {
                    result.className = 'result error';
                    resultMessage.innerHTML = \`
                        <strong>❌ Chyba:</strong><br>
                        \${data.error || 'Neočekávaná chyba při vytváření konfigurace'}
                    \`;
                    installLink.style.display = 'none';
                }
            } catch (error) {
                result.className = 'result error';
                resultMessage.innerHTML = \`
                    <strong>❌ Chyba spojení:</strong><br>
                    Nepodařilo se spojit se serverem. Zkuste to později.
                \`;
                installLink.style.display = 'none';
            }
            
            // Hide loading state
            submitBtn.style.display = 'block';
            loading.style.display = 'none';
            result.style.display = 'block';
        });

        document.getElementById('installLink').addEventListener('click', (e) => {
            setTimeout(() => {
                alert('Addon byl úspěšně nainstalován! S RealDebrid API budou titulky automaticky seřazeny podle vašeho přehrávaného souboru.');
            }, 1000);
        });
    </script>
</body>
</html>`;
    res.send(html);
});

app.get('/manifest.json', (req, res) => {
    console.log('[MANIFEST] Basic manifest requested');
    res.set({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.json(manifest);
});

app.get('/:config/manifest.json', (req, res) => {
    const config = req.params.config;
    console.log(`[MANIFEST] Configured manifest requested, config length: ${config.length}`);
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        console.log(`[MANIFEST] Config decoded for user: ${decodedConfig.username}`);
        
        const configuredManifest = {
            ...manifest,
            id: `com.titulky.subtitles.${decodedConfig.username}`,
            name: `Titulky.com CZ/SK${decodedConfig.realDebridKey ? ' + RealDebrid' : ''}`,
            description: `${manifest.description}${decodedConfig.realDebridKey ? ' + Smart matching with RealDebrid' : ''}`
        };
        
        res.set({
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        
        res.json(configuredManifest);
    } catch (error) {
        console.error('[MANIFEST] Invalid configuration:', error.message);
        res.status(400).json({ error: 'Invalid configuration' });
    }
});

app.get('/:config/subtitles/:type/:id*', async (req, res) => {
    const { config, type } = req.params;
    let fullPath = req.params.id + (req.params[0] || ''); // Capture everything after :id
    
    console.log(`[SUBTITLES] Raw path: "${fullPath}"`);
    
    // Decode URL-encoded path
    fullPath = decodeURIComponent(fullPath);
    console.log(`[SUBTITLES] Decoded path: "${fullPath}"`);
    
    // Extract just the ID part (before any /)
    let id = fullPath.split('/')[0];
    
    // Remove query parameters from ID (after &)
    id = id.split('&')[0];
    
    // Remove .json extension if present
    id = id.replace('.json', '');
    
    console.log(`[SUBTITLES] Request: type=${type}, id=${id}, config=${config.substring(0, 20)}...`);
    console.log(`[SUBTITLES] Cleaned ID: "${id}"`);
    console.log(`[SUBTITLES] ID parts: [${id.split(':')}]`);
    
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        const { username, password, realDebridKey } = decodedConfig;

        console.log(`[SUBTITLES] Decoded config for user: ${username}`);
        if (realDebridKey) {
            console.log(`[SUBTITLES] RealDebrid integration enabled`);
        }

        if (!username || !password) {
            console.log('[SUBTITLES] Missing credentials in config');
            return res.status(400).json({ error: 'Missing credentials' });
        }

        // Get or create client session
        let client = userSessions.get(username);
        if (!client) {
            console.log(`[SUBTITLES] No session found for ${username}, creating new session`);
            client = new TitulkyClient();
            const loginSuccess = await client.login(username, password);
            if (!loginSuccess) {
                console.log(`[SUBTITLES] Login failed for ${username}`);
                return res.status(401).json({ error: 'Login failed' });
            }
            userSessions.set(username, client);
            console.log(`[SUBTITLES] Session created for ${username}`);
        } else {
            console.log(`[SUBTITLES] Using existing session for ${username}`);
            client.lastUsed = Date.now();
        }

        // Initialize RealDebrid client if API key is provided
        let realDebridClient = null;
        let realDebridTechnical = null;
        
        if (realDebridKey) {
            try {
                realDebridClient = new RealDebridClient(realDebridKey);
                
                // Try to get currently playing file
                const realDebridFile = await realDebridClient.getCurrentlyPlayingFile();
                
                if (!realDebridFile) {
                    // Fallback: try to get active streams
                    const activeStream = await realDebridClient.getActiveStreams();
                    if (activeStream) {
                        realDebridFile = {
                            filename: activeStream.filename,
                            size: 0, // Size not available from active streams
                            technicalOnly: true
                        };
                    }
                }
                
                if (realDebridFile && realDebridFile.filename) {
                    console.log(`[REALDEBRID] Found file: ${realDebridFile.filename}`);
                    // Extract only technical metadata from RealDebrid filename
                    realDebridTechnical = subtitleMatcher.extractTechnicalInfoFromRealDebrid(realDebridFile.filename);
                } else {
                    console.log(`[REALDEBRID] No current file found, using standard matching`);
                }
            } catch (rdError) {
                console.error(`[REALDEBRID] Error: ${rdError.message}`);
                // Continue without RealDebrid - don't fail the whole request
            }
        }

        // Extract IMDB ID and get movie/series title from OMDB API
        let baseImdbId, season, episode;
        
        // Parse different ID formats from Stremio
        if (id.includes(':')) {
            // Format: tt1234567:1:1 (series:season:episode)
            const parts = id.split(':');
            baseImdbId = parts[0].replace('tt', '');
            season = parts[1];
            episode = parts[2];
            console.log(`[SUBTITLES] Series format: IMDB=${baseImdbId}, S${season}E${episode}`);
        } else {
            // Simple movie format: tt1234567
            baseImdbId = id.replace('tt', '');
            console.log(`[SUBTITLES] Movie format: IMDB=${baseImdbId}`);
        }

        console.log(`[SUBTITLES] IMDB ID: ${baseImdbId}`);
        
        // Get movie/series title from OMDB API (this is where we get the real movie name)
        const movieInfo = await getMovieTitle(baseImdbId);
        if (!movieInfo) {
            console.log(`[SUBTITLES] Could not get title for IMDB ${baseImdbId}`);
            return res.json({ subtitles: [] });
        }

        // Extract potential file size and other info from Stremio request headers
        const stremioData = {
            movieTitle: movieInfo.title,
            year: movieInfo.year,
            type: type,
            season: season,
            episode: episode,
            fileSize: null, // Will try to extract from headers
            streamTitle: null, // Not available in subtitle requests
            quality: null, // Will try to estimate
            duration: null // Will try to estimate based on type
        };

        // Try to extract file size from request headers if available
        const contentLength = req.get('content-length');
        const userAgent = req.get('user-agent') || '';
        const referer = req.get('referer') || '';
        
        // Look for size hints in headers (some Stremio clients include this)
        if (contentLength) {
            stremioData.fileSize = parseInt(contentLength);
            console.log(`[SUBTITLES] Found file size in headers: ${stremioData.fileSize} bytes`);
        }

        // Estimate duration based on content type
        if (type === 'movie') {
            stremioData.duration = 120; // Average movie duration in minutes
        } else if (type === 'series') {
            stremioData.duration = 45; // Average episode duration in minutes
        }

        console.log(`[SUBTITLES] Stremio data:`, stremioData);
        
        // Check if captcha was detected in previous requests
        if (client.captchaDetected) {
            console.log('[SUBTITLES] CAPTCHA detected - providing fallback subtitle');
            
            const fallbackTitle = season && episode ? 
                `${movieInfo.title} S${season}E${episode}` : 
                movieInfo.title;
            
            const fallbackSubtitle = {
                id: 'captcha_fallback',
                url: `${req.protocol}://${req.get('host')}/${config}/fallback-subtitle/limit-reached.srt`,
                lang: 'cs',
                name: '⚠️ Dosáhli jste max. 25 stažení za den',
                rating: 1
            };
            
            return res.json({ subtitles: [fallbackSubtitle] });
        }
        
        // Create search queries based on the real movie title from IMDB
        let searchQueries = [];
        
        if (type === 'movie') {
            // For movies, search by title and title+year
            searchQueries = [
                movieInfo.title,
                `${movieInfo.title} ${movieInfo.year}`,
                movieInfo.title.replace(/[^\w\s]/g, ''), // Remove special characters
            ];
        } else if (type === 'series') {
            // For series, we need episode info from the ID
            if (season && episode) {
                console.log(`[SUBTITLES] Series: ${movieInfo.title} S${season}E${episode}`);
                
                searchQueries = [
                    `${movieInfo.title} S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`,
                    `${movieInfo.title} ${season}x${episode.padStart(2, '0')}`,
                    `${movieInfo.title} ${season}x${episode}`,
                    `${movieInfo.title} S${season}E${episode}`,
                    movieInfo.title // Fallback to just series name
                ];
            } else {
                // No episode info, just series name
                searchQueries = [movieInfo.title];
            }
        }

        console.log(`[SUBTITLES] Search queries: ${searchQueries.join(', ')}`);

        let allSubtitles = [];
        
        // Try each search query until we find results
        for (let i = 0; i < searchQueries.length; i++) {
            const query = searchQueries[i];
            console.log(`[SUBTITLES] Trying search query ${i+1}/${searchQueries.length}: "${query}"`);
            
            try {
                // Use enhanced search for first query to get version info
                const fetchDetails = (i === 0); // Only fetch details for first/best query
                const subtitles = await client.searchSubtitlesWithDetails(query, fetchDetails);
                
                // Check if captcha was detected during search
                if (client.captchaDetected) {
                    console.log('[SUBTITLES] CAPTCHA detected during search - providing fallback subtitle');
                    
                    const fallbackTitle = season && episode ? 
                        `${movieInfo.title} S${season}E${episode}` : 
                        movieInfo.title;
                    
                    const fallbackSubtitle = {
                        id: 'captcha_fallback',
                        url: `${req.protocol}://${req.get('host')}/${config}/fallback-subtitle/limit-reached.srt`,
                        lang: 'cs',
                        name: '⚠️ Dosáhli jste max. 25 stažení za den',
                        rating: 1
                    };
                    
                    return res.json({ subtitles: [fallbackSubtitle] });
                }
                
                if (subtitles.length > 0) {
                    console.log(`[SUBTITLES] SUCCESS: Found ${subtitles.length} results for query: "${query}"`);
                    allSubtitles = subtitles;
                    break;
                } else {
                    console.log(`[SUBTITLES] No results for query: "${query}"`);
                }
            } catch (searchError) {
                console.error(`[SUBTITLES] Search failed for query "${query}":`, searchError.message);
                // Continue with next query
            }
        }

        console.log(`[SUBTITLES] Total subtitles found: ${allSubtitles.length}`);
        
        // Create comprehensive video info from all available sources
        const videoInfo = subtitleMatcher.createVideoInfoFromStremio(stremioData, realDebridTechnical);
        
        let sortedSubtitles;
        
        // Use enhanced technical matching
        console.log(`[SUBTITLES] Using technical matching (${videoInfo.dataSource})`);
        sortedSubtitles = subtitleMatcher.sortSubtitlesByTechnicalRelevance(allSubtitles, videoInfo, movieInfo.title);
        
        // Limit to top 6 results
        const topSubtitles = sortedSubtitles.slice(0, 6);
        
        const stremioSubtitles = topSubtitles.map((sub, index) => {
            const isTopMatch = index === 0;
            const isTechnicalMatch = videoInfo.dataSource === 'realdebrid' || videoInfo.confidence > 70;
            const enhancedName = subtitleMatcher.createEnhancedSubtitleName(sub, isTopMatch, isTechnicalMatch);

            const subtitle = {
                id: `${sub.id}:${sub.linkFile}`,
                url: `${req.protocol}://${req.get('host')}/${config}/subtitle/${sub.id}/${encodeURIComponent(sub.linkFile)}.srt`,
                lang: sub.language.toLowerCase() === 'czech' ? 'cs' : 
                      sub.language.toLowerCase() === 'slovak' ? 'sk' : 'cs',
                name: enhancedName,
                rating: Math.min(5, Math.max(1, Math.round((sub.finalScore || sub.compatibilityScore || sub.technicalScore) / 20)))
            };
            
            const scoreInfo = videoInfo.dataSource === 'realdebrid' ? 
                `Tech: ${sub.technicalScore?.toFixed(1) || 'N/A'}%` :
                `Est: ${sub.technicalScore?.toFixed(1) || 'N/A'}%`;
                
            console.log(`[SUBTITLES] ${index + 1}. "${sub.title}" → ${subtitle.name} (${scoreInfo}, Final: ${sub.finalScore?.toFixed(1) || 'N/A'}%, Rating: ${subtitle.rating})`);
            return subtitle;
        });

        const matchingType = videoInfo.dataSource === 'realdebrid' ? 'RealDebrid-technical' : 
                           videoInfo.dataSource === 'size_estimate' ? 'size-estimated' : 'standard';
        console.log(`[SUBTITLES] Returning ${stremioSubtitles.length} ${matchingType} matched subtitles to Stremio`);
        res.json({ subtitles: stremioSubtitles });
        
    } catch (error) {
        console.error('[SUBTITLES] Error:', error.message);
        console.error('[SUBTITLES] Stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to fetch subtitles',
            details: error.message 
        });
    }
});

// New route for fallback subtitles when captcha is detected
app.get('/:config/fallback-subtitle/:filename', (req, res) => {
    const { filename } = req.params;
    
    console.log(`[FALLBACK] Generating fallback subtitle: ${filename}`);
    
    try {
        // Use same fallback content for all cases
        const fallbackContent = createFallbackSRT('', 'cs');
        
        res.set({
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="limit_reached.srt"`,
            'Content-Length': Buffer.byteLength(fallbackContent, 'utf-8')
        });
        
        res.send(fallbackContent);
        
    } catch (error) {
        console.error('[FALLBACK] Error generating fallback subtitle:', error.message);
        res.status(500).json({ error: 'Failed to generate fallback subtitle' });
    }
});

app.get('/:config/subtitle/:id/:linkFile', async (req, res) => {
    const { config, id, linkFile } = req.params;
    
    console.log(`[DOWNLOAD] Request: id=${id}, linkFile=${linkFile}`);
    
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        const { username } = decodedConfig;

        console.log(`[DOWNLOAD] Download request for user: ${username}`);

        const client = userSessions.get(username);
        if (!client) {
            console.log(`[DOWNLOAD] No session found for ${username}`);
            return res.status(401).json({ error: 'Session expired' });
        }

        const decodedLinkFile = decodeURIComponent(linkFile.replace('.srt', ''));
        console.log(`[DOWNLOAD] Decoded link file: ${decodedLinkFile}`);
        
        try {
            const subtitleData = await client.downloadSubtitle(id, decodedLinkFile);
            
            // Check if we got SRT content (string) or ZIP data (buffer)
            if (typeof subtitleData === 'string') {
                console.log(`[DOWNLOAD] Returning SRT content (${subtitleData.length} characters)`);
                
                res.set({
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Disposition': `attachment; filename="subtitle_${id}.srt"`,
                    'Content-Length': Buffer.byteLength(subtitleData, 'utf-8')
                });
                res.send(subtitleData);
            } else {
                console.log(`[DOWNLOAD] Returning ZIP data (${subtitleData.length} bytes)`);
                
                res.set({
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="subtitle_${id}.zip"`,
                    'Content-Length': subtitleData.length
                });
                res.send(subtitleData);
            }
        } catch (downloadError) {
            // Check if error is due to captcha
            if (downloadError.message === 'CAPTCHA_DETECTED') {
                console.log(`[DOWNLOAD] CAPTCHA detected - generating fallback SRT for subtitle ${id}`);
                
                // Use same fallback content for all cases
                const fallbackContent = createFallbackSRT('', 'cs');
                
                res.set({
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Disposition': `attachment; filename="limit_reached_${id}.srt"`,
                    'Content-Length': Buffer.byteLength(fallbackContent, 'utf-8')
                });
                
                res.send(fallbackContent);
                return;
            }
            
            // For other errors, rethrow
            throw downloadError;
        }
        
    } catch (error) {
        console.error('[DOWNLOAD] Error:', error.message);
        console.error('[DOWNLOAD] Stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to download subtitle',
            details: error.message 
        });
    }
});

app.post('/configure', async (req, res) => {
    const { username, password, realDebridKey } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    // Test login before creating config
    try {
        const testClient = new TitulkyClient();
        const loginSuccess = await testClient.login(username, password);
        
        if (!loginSuccess) {
            return res.status(401).json({ error: 'Neplatné přihlašovací údaje pro Titulky.com' });
        }
        
        // Store successful session
        userSessions.set(username, testClient);
        console.log(`[CONFIGURE] Stored session for ${username}`);
        
    } catch (error) {
        console.error('Login test error:', error.message);
        return res.status(500).json({ error: 'Chyba při ověřování přihlašovacích údajů na Titulky.com' });
    }

    // Test RealDebrid API key if provided
    let realDebridStatus = null;
    if (realDebridKey && realDebridKey.trim()) {
        try {
            const realDebridClient = new RealDebridClient(realDebridKey.trim());
            realDebridStatus = await realDebridClient.testApiKey();
            console.log(`[CONFIGURE] RealDebrid API test result:`, realDebridStatus);
        } catch (rdError) {
            console.error('RealDebrid API test error:', rdError.message);
            realDebridStatus = { valid: false, error: rdError.message };
        }
    }

    const configData = { username, password };
    if (realDebridKey && realDebridKey.trim()) {
        configData.realDebridKey = realDebridKey.trim();
    }

    const config = Buffer.from(JSON.stringify(configData)).toString('base64');
    
    // Create both stremio:// and https:// URLs for testing
    const baseUrl = req.get('host');
    const installUrl = `stremio://${baseUrl}/${config}/manifest.json`;
    const testUrl = `${req.protocol}://${baseUrl}/${config}/manifest.json`;
    
    console.log(`[CONFIGURE] Created config for ${username}${realDebridKey ? ' with RealDebrid' : ''}, config: ${config.substring(0, 20)}...`);
    
    res.json({ 
        success: true, 
        installUrl,
        testUrl,
        config: config,
        realDebridStatus: realDebridStatus,
        message: 'Configuration created successfully'
    });
});

// Test RealDebrid API endpoint
app.post('/test-realdebrid', async (req, res) => {
    const { apiKey } = req.body;
    
    if (!apiKey) {
        return res.status(400).json({ error: 'API key required' });
    }

    try {
        const realDebridClient = new RealDebridClient(apiKey);
        const result = await realDebridClient.testApiKey();
        
        if (result.valid) {
            // Also try to get current file info
            const currentFile = await realDebridClient.getCurrentlyPlayingFile();
            const activeStreams = await realDebridClient.getActiveStreams();
            
            res.json({
                success: true,
                ...result,
                currentFile: currentFile,
                activeStreams: activeStreams
            });
        } else {
            res.status(401).json({
                success: false,
                error: result.error || 'Invalid API key'
            });
        }
    } catch (error) {
        console.error('RealDebrid test error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Optional: Add endpoint to test technical matching
app.get('/test-technical-matching/:config', async (req, res) => {
    const { config } = req.params;
    const { fileSize, quality, movieTitle, realDebridFile } = req.query;
    
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        const { username, realDebridKey } = decodedConfig;

        const client = userSessions.get(username);
        if (!client) {
            return res.status(401).json({ error: 'Session expired' });
        }

        // Create test video info
        const stremioData = {
            movieTitle: movieTitle || 'Test Movie',
            fileSize: fileSize ? parseInt(fileSize) : null,
            quality: quality || '1080p',
            duration: 120,
            streamTitle: null
        };

        let realDebridTechnical = null;
        if (realDebridKey && realDebridFile) {
            realDebridTechnical = subtitleMatcher.extractTechnicalInfoFromRealDebrid(realDebridFile);
        }

        const videoInfo = subtitleMatcher.createVideoInfoFromStremio(stremioData, realDebridTechnical);
        
        // Get some sample subtitles for testing
        const subtitles = await client.searchSubtitles(movieTitle || 'test');
        const sortedSubtitles = subtitleMatcher.sortSubtitlesByTechnicalRelevance(subtitles.slice(0, 10), videoInfo, movieTitle);

        res.json({
            success: true,
            testData: stremioData,
            videoInfo: videoInfo,
            realDebridTechnical: realDebridTechnical,
            sampleResults: sortedSubtitles.slice(0, 5).map(sub => ({
                title: sub.title,
                videoVersion: sub.videoVersion,
                detectedSource: sub.subtitleVideoInfo?.source || 'unknown',
                technicalScore: sub.technicalScore,
                finalScore: sub.finalScore,
                enhancedName: subtitleMatcher.createEnhancedSubtitleName(sub, false, videoInfo.confidence > 70)
            }))
        });
    } catch (error) {
        console.error('[TEST-TECH-MATCHING] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Optional: Add endpoint to test source matching
app.get('/test-matching/:config/:videoTitle', async (req, res) => {
    const { config, videoTitle } = req.params;
    
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        const { username } = decodedConfig;

        const client = userSessions.get(username);
        if (!client) {
            return res.status(401).json({ error: 'Session expired' });
        }

        const videoInfo = subtitleMatcher.extractVideoInfo(decodeURIComponent(videoTitle));
        const subtitles = await client.searchSubtitlesWithDetails(decodeURIComponent(videoTitle), true);
        const sortedSubtitles = subtitleMatcher.sortSubtitlesByRelevance(subtitles, videoInfo, decodeURIComponent(videoTitle));
        
        res.json({
            success: true,
            videoSource: videoInfo.source,
            totalFound: subtitles.length,
            top6Results: sortedSubtitles.slice(0, 6).map(sub => ({
                title: sub.title,
                videoVersion: sub.videoVersion,
                detectedSource: sub.subtitleVideoInfo?.source || 'unknown',
                compatibilityScore: sub.compatibilityScore,
                titleSimilarity: sub.titleSimilarity,
                finalScore: sub.finalScore,
                enhancedName: subtitleMatcher.createEnhancedSubtitleName(sub)
            }))
        });
    } catch (error) {
        console.error('[TEST-MATCHING] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/test/:config/:query', async (req, res) => {
    const { config, query } = req.params;
    
    console.log(`[TEST] Manual test request: query="${query}"`);
    
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        const { username, password } = decodedConfig;

        let client = userSessions.get(username);
        if (!client) {
            console.log(`[TEST] Creating new session for ${username}`);
            client = new TitulkyClient();
            const loginSuccess = await client.login(username, password);
            if (!loginSuccess) {
                return res.status(401).json({ error: 'Login failed' });
            }
            userSessions.set(username, client);
        }

        const subtitles = await client.searchSubtitles(decodeURIComponent(query));
        
        res.json({
            success: true,
            query: decodeURIComponent(query),
            found: subtitles.length,
            subtitles: subtitles.slice(0, 5), // First 5 results
            captchaDetected: client.captchaDetected
        });
    } catch (error) {
        console.error('[TEST] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Health check with detailed info including keep-alive status
app.get('/health', (req, res) => {
    const sessionCount = userSessions.size;
    const uptime = process.uptime();
    
    // Count sessions with captcha detected
    const captchaSessions = Array.from(userSessions.values()).filter(session => session.captchaDetected).length;
    
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: Math.floor(uptime),
        activeSessions: sessionCount,
        captchaSessions: captchaSessions,
        keepAlive: {
            enabled: true,
            interval: '13 minutes',
            purpose: 'Prevent Render.com sleep'
        },
        realDebridIntegration: {
            enabled: true,
            features: ['smart_matching', 'file_detection', 'quality_matching']
        },
        version: '1.1.0'
    });
});

// Catch-all error handler
app.use((error, req, res, next) => {
    console.error('[ERROR] Unhandled error:', error.message);
    console.error('[ERROR] Stack:', error.stack);
    console.error('[ERROR] Request URL:', req.url);
    console.error('[ERROR] Request headers:', req.headers);
    
    res.status(500).json({
        error: 'Internal server error',
        message: error.message,
        url: req.url
    });
});

// 404 handler with logging
app.use((req, res) => {
    console.log(`[404] Not found: ${req.method} ${req.url}`);
    console.log(`[404] Headers:`, req.headers);
    res.status(404).json({ 
        error: 'Not found',
        path: req.url,
        method: req.method
    });
});

// Clean up expired sessions every hour and reset captcha flags
setInterval(() => {
    const oneHour = 60 * 60 * 1000;
    const now = Date.now();
    
    console.log(`[CLEANUP] Checking ${userSessions.size} sessions for cleanup`);
    
    for (const [username, session] of userSessions.entries()) {
        if (now - session.lastUsed > oneHour) {
            console.log(`[CLEANUP] Removing expired session for ${username}`);
            userSessions.delete(username);
        } else if (session.captchaDetected && now - session.lastUsed > 10 * 60 * 1000) {
            // Reset captcha flag after 10 minutes of inactivity
            console.log(`[CLEANUP] Resetting captcha flag for ${username}`);
            session.captchaDetected = false;
        }
    }
    
    console.log(`[CLEANUP] ${userSessions.size} sessions remaining after cleanup`);
}, 60 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Titulky.com Stremio Addon with RealDebrid integration running on port ${PORT}`);
    console.log(`Manifest URL: http://localhost:${PORT}/manifest.json`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Ping endpoint: http://localhost:${PORT}/ping`);
    console.log('🚀 RealDebrid integration enabled');
    console.log('🎯 Smart subtitle matching active');
    console.log('Debug logging enabled');
    console.log('CAPTCHA fallback functionality active');
    
    // Start keep-alive mechanism for production (Render.com)
    if (process.env.NODE_ENV === 'production' || process.env.RENDER_EXTERNAL_URL) {
        console.log('🟢 Starting keep-alive mechanism for Render.com...');
        console.log('⏰ Self-ping will occur every 13 minutes to prevent sleep');
        
        // Start keep-alive after 30 seconds to ensure server is fully ready
        setTimeout(() => {
            startKeepAlive();
            console.log('✅ Keep-alive mechanism started successfully');
        }, 30000);
    } else {
        console.log('🟡 Keep-alive mechanism disabled (local development)');
    }
});