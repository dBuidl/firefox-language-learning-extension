class LanguageLearningBackground {
    constructor() {
        this.serverAPI = new ServerAPI();
        this.vocabularyTracker = new VocabularyTracker();
        this.translationCache = new TranslationCache();
        this.translationQueue = new Map(); // tabId -> processing queue
        this.activeProcessing = new Set(); // Track which tabs are actively processing
        this.batchSize = 50; // Maximum words per batch request to server
        
        this.init();
    }

    async init() {
        await this.loadSettings();
        this.setupMessageListener();
        this.setupInstallHandler();
        
        // Clean up expired cache entries on startup
        await this.translationCache.cleanupExpiredEntries();
        
        // Set up periodic cache cleanup (every 6 hours)
        this.setupPeriodicCacheCleanup();
        
        console.log('Language Learning Background Script loaded');
    }

    setupPeriodicCacheCleanup() {
        // Clean up expired cache entries every 6 hours (6 * 60 * 60 * 1000 ms)
        const cleanupInterval = 6 * 60 * 60 * 1000;
        
        setInterval(async () => {
            try {
                await this.translationCache.cleanupExpiredEntries();
            } catch (error) {
                console.error('Error during periodic cache cleanup:', error);
            }
        }, cleanupInterval);
        
        console.log('Periodic cache cleanup scheduled every 6 hours');
    }

    setupInstallHandler() {
        browser.runtime.onInstalled.addListener(async () => {
            console.log('Language Learning Extension installed');
            
            // Generate unique GUID for this extension install
            const extensionGuid = this.generateGUID();
            
            await browser.storage.local.set({
                extensionData: {
                    installDate: new Date().toISOString(),
                    version: '1.0',
                    extensionGuid: extensionGuid
                },
                languageLearningEnabled: false,
                targetLanguage: 'fr',
                difficulty: 'beginner',
                replacementPercentage: 10
            });
            
            console.log('Extension GUID generated:', extensionGuid);
        });
    }

    generateGUID() {
        // Use crypto.getRandomValues() for cryptographically secure random numbers
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        
        // Set version (4) and variant bits according to RFC 4122
        array[6] = (array[6] & 0x0f) | 0x40; // Version 4
        array[8] = (array[8] & 0x3f) | 0x80; // Variant 10
        
        // Convert to hex string with proper formatting
        const hex = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
        return [
            hex.slice(0, 8),
            hex.slice(8, 12),
            hex.slice(12, 16),
            hex.slice(16, 20),
            hex.slice(20, 32)
        ].join('-');
    }

    async loadSettings() {
        const settings = await browser.storage.local.get([
            'languageLearningEnabled',
            'targetLanguage', 
            'difficulty',
            'replacementPercentage'
        ]);
        
        this.settings = {
            languageLearningEnabled: settings.languageLearningEnabled || false,
            targetLanguage: settings.targetLanguage || 'fr',
            difficulty: settings.difficulty || 'beginner',
            replacementPercentage: settings.replacementPercentage || 10
        };
    }

    setupMessageListener() {
        browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
            (async () => {
                try {
                    switch (request.action) {
                    case 'processWords':
                        await this.processWordsFromTab(request.words, sender.tab.id, request.targetLanguage);
                        sendResponse({success: true});
                        break;
                        
                    case 'updateSettings':
                        await this.updateSettings(request.settings);
                        sendResponse({success: true});
                        break;
                        
                    case 'getStats':
                        const stats = await this.getStats();
                        sendResponse(stats);
                        break;
                        
                    case 'clearCache':
                        await this.clearCache();
                        sendResponse({success: true});
                        break;
                        
                    case 'checkServerStatus':
                        try {
                            const isAvailable = await this.serverAPI.isServerAvailable();
                            sendResponse({success: true, serverAvailable: isAvailable});
                        } catch (error) {
                            console.error('Error checking server status:', error);
                            sendResponse({success: false, error: error.message});
                        }
                        break;
                        
                    case 'markWordAsLearned':
                        await this.vocabularyTracker.markWordAsLearned(request.word);
                        sendResponse({success: true});
                        break;
                        
                    case 'markTranslationIncorrect':
                        await this.markTranslationIncorrect(request.word, request.translation);
                        // Also submit feedback to server
                        await this.serverAPI.submitFeedback(request.word, request.translation, 'incorrect');
                        sendResponse({success: true});
                        break;
                        
                    case 'setCustomTranslation':
                        await this.setCustomTranslation(request.word, request.translation, request.originalTranslation);
                        // Submit custom translation feedback to server
                        await this.serverAPI.submitFeedback(request.word, request.originalTranslation || 'unknown', 'custom', request.translation);
                        sendResponse({success: true});
                        break;
                        
                    case 'blacklistWord':
                        await this.blacklistWord(request.word);
                        sendResponse({success: true});
                        break;
                        
                    case 'ping':
                        sendResponse({success: true, message: 'Background script is running'});
                        break;
                        
                        default:
                            sendResponse({success: false, error: 'Unknown action'});
                            return;
                    }
                } catch (error) {
                    console.error('Background script error:', error);
                    sendResponse({success: false, error: error.message});
                }
            })();
            
            return true; // Indicates async response
        });
    }

    async processWordsFromTab(words, tabId, targetLanguage) {
        // A new request supersedes words still queued from an earlier page load or settings change
        this.translationQueue.set(tabId, {
            words: [...words],
            targetLanguage,
            total: words.length,
            processed: 0
        });
        
        // Start processing if not already active for this tab
        if (!this.activeProcessing.has(tabId)) {
            this.activeProcessing.add(tabId);
            try {
                await this.processQueueForTab(tabId);
            } finally {
                this.activeProcessing.delete(tabId);
                this.translationQueue.delete(tabId);
            }
        }
    }

    async processQueueForTab(tabId) {
        let job = this.translationQueue.get(tabId);
        if (!job || job.words.length === 0) return;

        // Send initial progress
        this.sendProgressToTab(tabId, 'Processing words...', 0, job.total);
        
        // Process words in batches using server API, picking up a replaced job between batches
        while ((job = this.translationQueue.get(tabId)) && job.words.length > 0) {
            const { targetLanguage } = job;
            const batch = job.words.splice(0, this.batchSize);
            
            // Get user overrides (blacklist and custom translations)
            const { wordBlacklist: blacklist = [], vocabulary = {} } =
                await browser.storage.local.get(['wordBlacklist', 'vocabulary']);
            const cachedTranslations = await this.translationCache.getTranslations(
                batch.map(wordObj => wordObj.text),
                'auto',
                targetLanguage
            );
            
            const readyWords = [];
            const wordsNeedingTranslation = [];
            const vocabularyUpdates = [];
            
            for (const wordObj of batch) {
                const wordLower = wordObj.text.toLowerCase();
                
                // Skip blacklisted words entirely
                if (blacklist.includes(wordLower)) continue;
                
                // Use a custom translation the user set for this language
                const vocabularyEntry = vocabulary[wordLower];
                if (vocabularyEntry && vocabularyEntry.custom && vocabularyEntry.targetLanguage === targetLanguage) {
                    readyWords.push({ ...wordObj, translation: vocabularyEntry.translation });
                    continue;
                }
                
                // Use cached translation (1-day expiry)
                const cachedTranslation = cachedTranslations.get(wordLower);
                if (cachedTranslation) {
                    readyWords.push({ ...wordObj, translation: cachedTranslation });
                    vocabularyUpdates.push([wordObj.text, cachedTranslation]);
                    continue;
                }
                
                wordsNeedingTranslation.push(wordObj);
            }
            
            // Show known words right away instead of waiting for the server
            await this.sendTranslationsToTab(tabId, readyWords);
            
            if (wordsNeedingTranslation.length > 0) {
                try {
                    const uniqueWordTexts = [...new Set(wordsNeedingTranslation.map(wordObj => wordObj.text))];
                    const translations = await this.serverAPI.translateWords(
                        uniqueWordTexts,
                        'auto', // Auto-detect source language
                        targetLanguage,
                        this.settings.difficulty
                    );
                    
                    const translatedWords = [];
                    const cacheEntries = [];
                    
                    for (const translation of translations) {
                        // Skip if translation is the same as original word
                        if (translation.translated_word.toLowerCase().trim() === translation.original_word.toLowerCase().trim()) continue;
                        
                        // Find every occurrence of this word in the batch
                        const matchingWordObjs = wordsNeedingTranslation.filter(w => w.text === translation.original_word);
                        if (matchingWordObjs.length === 0) continue;
                        
                        matchingWordObjs.forEach(wordObj =>
                            translatedWords.push({ ...wordObj, translation: translation.translated_word }));
                        cacheEntries.push([translation.original_word, translation.translated_word]);
                        vocabularyUpdates.push([translation.original_word, translation.translated_word]);
                    }
                    
                    await this.sendTranslationsToTab(tabId, translatedWords);
                    await this.translationCache.setTranslations(cacheEntries, 'auto', targetLanguage);
                } catch (error) {
                    console.error('Batch translation error:', error);
                    // Skip this batch and continue
                }
            }
            
            await this.vocabularyTracker.addWords(vocabularyUpdates);
            
            // Send progress updates
            job.processed += batch.length;
            this.sendProgressToTab(tabId, `Processing words... ${job.processed}/${job.total}`, job.processed, job.total);
        }

        // Send completion
        const total = this.translationQueue.get(tabId)?.total || 0;
        setTimeout(() => {
            this.sendProgressToTab(tabId, 'Ready', total, total);
        }, 100);
    }

    async sendTranslationsToTab(tabId, words) {
        if (words.length === 0) return;
        try {
            await browser.tabs.sendMessage(tabId, {
                action: 'translationsReady',
                words
            });
        } catch (error) {
            // Tab might be closed or navigated away, that's fine
        }
    }

    sendProgressToTab(tabId, message, current, total) {
        const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
        
        // Send to popup if it's listening
        try {
            browser.runtime.sendMessage({
                action: 'progressUpdate',
                message: message,
                current: current,
                total: total,
                percentage: percentage,
                tabId: tabId
            }).catch(() => {
                // Popup might not be open
            });
        } catch (error) {
            // Silently handle messaging errors
        }
    }

    async updateSettings(newSettings) {
        Object.assign(this.settings, newSettings);
        await browser.storage.local.set(this.settings);
    }

    async getStats() {
        const stats = await this.vocabularyTracker.getStats();
        return {
            ...stats,
            targetLanguage: this.settings.targetLanguage,
            difficulty: this.settings.difficulty,
            replacementPercentage: this.settings.replacementPercentage
        };
    }

    async clearCache() {
        await this.vocabularyTracker.clear();
        await this.translationCache.clear();
        // Also clear incorrect translations log
        await browser.storage.local.remove(['incorrectTranslations']);
    }
    
    async markTranslationIncorrect(word, translation) {
        // Track as incorrect translation locally
        const incorrectTranslations = await browser.storage.local.get('incorrectTranslations');
        const incorrect = incorrectTranslations.incorrectTranslations || [];
        incorrect.push({
            word: word,
            incorrectTranslation: translation,
            timestamp: Date.now(),
            targetLanguage: this.settings.targetLanguage
        });
        
        await browser.storage.local.set({ incorrectTranslations: incorrect });
    }
    
    async setCustomTranslation(word, translation) {
        // Update vocabulary with custom translation
        await this.vocabularyTracker.addWord(word, translation, this.settings.targetLanguage);
    }
    
    async blacklistWord(word) {
        // Add to blacklist
        const stored = await browser.storage.local.get('wordBlacklist');
        const blacklist = stored.wordBlacklist || [];
        if (!blacklist.includes(word.toLowerCase())) {
            blacklist.push(word.toLowerCase());
            await browser.storage.local.set({ wordBlacklist: blacklist });
        }
    }
}


class VocabularyTracker {
    constructor() {
        this.vocabulary = new Map();
        this.learnedWords = new Set();
        this.loadVocabulary();
    }

    async loadVocabulary() {
        const stored = await browser.storage.local.get(['vocabulary', 'learnedWords']);
        
        if (stored.vocabulary) {
            this.vocabulary = new Map(Object.entries(stored.vocabulary));
        }
        
        if (stored.learnedWords) {
            this.learnedWords = new Set(stored.learnedWords);
        }
    }

    // customLanguage marks the translation as the user's own correction for that language
    async addWords(pairs, customLanguage = null) {
        if (pairs.length === 0) return;
        await this.loadVocabulary(); // Pick up edits made from the popup so they aren't overwritten

        const now = Date.now();
        for (const [original, translation] of pairs) {
            const key = original.toLowerCase();
            const existing = this.vocabulary.get(key);
            const keepCustomTranslation = existing?.custom && !customLanguage;
            this.vocabulary.set(key, {
                ...existing,
                original,
                translation: keepCustomTranslation ? existing.translation : translation,
                encounters: (existing?.encounters || 0) + 1,
                firstSeen: existing?.firstSeen || now,
                lastSeen: now,
                ...(customLanguage && { custom: true, targetLanguage: customLanguage })
            });
        }

        await this.saveVocabulary();
    }

    async addWord(original, translation, customLanguage = null) {
        await this.addWords([[original, translation]], customLanguage);
    }

    async markWordAsLearned(word) {
        await this.loadVocabulary();
        this.learnedWords.add(word.toLowerCase());
        await this.saveVocabulary();
    }

    async saveVocabulary() {
        await browser.storage.local.set({
            vocabulary: Object.fromEntries(this.vocabulary),
            learnedWords: Array.from(this.learnedWords)
        });
    }

    async getStats() {
        return {
            vocabularySize: this.vocabulary.size,
            learnedWords: this.learnedWords.size
        };
    }

    async clear() {
        this.vocabulary.clear();
        this.learnedWords.clear();
        await browser.storage.local.remove(['vocabulary', 'learnedWords']);
    }
}

class TranslationCache {
    constructor() {
        this.CACHE_EXPIRY_DAYS = 1; // 1 day cache expiry
        this.CACHE_KEY = 'translationCache_v2'; // Versioned cache key
    }

    // Generate cache key for a translation
    getCacheKey(originalWord, sourceLanguage, targetLanguage) {
        return `${originalWord.toLowerCase().trim()}|${sourceLanguage}|${targetLanguage}`;
    }

    // Get unexpired cached translations for many words with a single storage read
    async getTranslations(originalWords, sourceLanguage, targetLanguage) {
        const translations = new Map();
        try {
            const stored = await browser.storage.local.get(this.CACHE_KEY);
            const cache = stored[this.CACHE_KEY] || {};
            
            const now = Date.now();
            const expiryThreshold = this.CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
            
            for (const originalWord of originalWords) {
                const entry = cache[this.getCacheKey(originalWord, sourceLanguage, targetLanguage)];
                if (entry && now - entry.timestamp <= expiryThreshold) {
                    translations.set(originalWord.toLowerCase(), entry.translation);
                }
            }
        } catch (error) {
            console.error('Error reading from translation cache:', error);
        }
        return translations;
    }

    // Save many [originalWord, translation] pairs with a single storage write
    async setTranslations(entries, sourceLanguage, targetLanguage) {
        if (entries.length === 0) return;
        try {
            const stored = await browser.storage.local.get(this.CACHE_KEY);
            const cache = stored[this.CACHE_KEY] || {};
            const timestamp = Date.now();
            
            for (const [originalWord, translation] of entries) {
                cache[this.getCacheKey(originalWord, sourceLanguage, targetLanguage)] = {
                    translation,
                    timestamp,
                    originalWord,
                    sourceLanguage,
                    targetLanguage
                };
            }
            
            await browser.storage.local.set({ [this.CACHE_KEY]: cache });
        } catch (error) {
            console.error('Error saving to translation cache:', error);
        }
    }

    // Clear all cached translations
    async clear() {
        try {
            await browser.storage.local.remove(this.CACHE_KEY);
            console.log('Translation cache cleared');
        } catch (error) {
            console.error('Error clearing translation cache:', error);
        }
    }

    // Clean up expired entries (can be called periodically)
    async cleanupExpiredEntries() {
        try {
            const stored = await browser.storage.local.get(this.CACHE_KEY);
            const cache = stored[this.CACHE_KEY] || {};
            
            const now = Date.now();
            const expiryThreshold = this.CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
            let removedCount = 0;
            
            // Remove expired entries
            for (const [key, entry] of Object.entries(cache)) {
                if (now - entry.timestamp > expiryThreshold) {
                    delete cache[key];
                    removedCount++;
                }
            }
            
            if (removedCount > 0) {
                await browser.storage.local.set({ [this.CACHE_KEY]: cache });
                console.log(`Cleaned up ${removedCount} expired cache entries`);
            }
            
        } catch (error) {
            console.error('Error cleaning up translation cache:', error);
        }
    }
}

// Initialize background script
new LanguageLearningBackground();