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
        // Create processing queue for this tab
        if (!this.translationQueue.has(tabId)) {
            this.translationQueue.set(tabId, []);
        }
        
        const queue = this.translationQueue.get(tabId);
        queue.push(...words);
        
        // Start processing if not already active for this tab
        if (!this.activeProcessing.has(tabId)) {
            this.activeProcessing.add(tabId);
            await this.processQueueForTab(tabId, targetLanguage);
            this.activeProcessing.delete(tabId);
        }
    }

    async processQueueForTab(tabId, targetLanguage) {
        const queue = this.translationQueue.get(tabId);
        if (!queue || queue.length === 0) return;

        const totalWords = queue.length;
        let processed = 0;

        // Send initial progress
        this.sendProgressToTab(tabId, 'Processing words...', 0, totalWords);

        // Get user overrides (blacklist and custom translations)
        const [blacklistData, vocabularyData] = await Promise.all([
            browser.storage.local.get('wordBlacklist'),
            browser.storage.local.get('vocabulary')
        ]);
        
        const blacklist = blacklistData.wordBlacklist || [];
        const vocabulary = vocabularyData.vocabulary || {};
        
        // Process words in batches using server API
        while (queue.length > 0) {
            // Take a batch of words (up to 50 per request)
            const batch = queue.splice(0, this.batchSize);
            const wordsNeedingTranslation = [];
            
            // Process each word in the batch
            for (const wordObj of batch) {
                const wordLower = wordObj.text.toLowerCase();
                
                // Check if word is blacklisted
                if (blacklist.includes(wordLower)) {
                    processed++;
                    continue; // Skip blacklisted words entirely
                }
                
                // Check if we have a custom translation
                if (vocabulary[wordLower] && vocabulary[wordLower].translation) {
                    // Use existing custom translation
                    await this.sendTranslationToTab(tabId, {
                        ...wordObj,
                        translation: vocabulary[wordLower].translation
                    });
                    processed++;
                    continue;
                }
                
                // Check cache for existing translation (1-day expiry)
                const cachedTranslation = await this.translationCache.getTranslation(
                    wordObj.text, 
                    'auto', 
                    targetLanguage
                );
                
                if (cachedTranslation) {
                    // Use cached translation
                    await this.sendTranslationToTab(tabId, {
                        ...wordObj,
                        translation: cachedTranslation
                    });
                    
                    // Also update vocabulary tracker
                    await this.vocabularyTracker.addWord(wordObj.text, cachedTranslation);
                    processed++;
                    continue;
                }
                
                // Word needs server translation
                wordsNeedingTranslation.push(wordObj);
            }
            
            // Only send words to server that need translation
            if (wordsNeedingTranslation.length > 0) {
                const wordTexts = wordsNeedingTranslation.map(word => word.text);
                
                try {
                    // Send batch to server for translation
                    const translations = await this.serverAPI.translateWords(
                        wordTexts,
                        'auto', // Auto-detect source language
                        targetLanguage,
                        this.settings.difficulty
                    );
                    
                    // Process each translation result
                    for (const translation of translations) {
                        // Find every occurrence of this word in the batch
                        const matchingWordObjs = wordsNeedingTranslation.filter(w => w.text === translation.original_word);
                        if (matchingWordObjs.length === 0) continue;
                        
                        // Skip if translation is the same as original word
                        if (translation.translated_word.toLowerCase().trim() !== translation.original_word.toLowerCase().trim()) {
                            // Cache the translation for 1 day
                            await this.translationCache.setTranslation(
                                translation.original_word,
                                'auto',
                                targetLanguage,
                                translation.translated_word
                            );
                            
                            // Send translation result to content script
                            for (const wordObj of matchingWordObjs) {
                                await this.sendTranslationToTab(tabId, {
                                    ...wordObj,
                                    translation: translation.translated_word
                                });
                            }
                            
                            // Track vocabulary locally
                            await this.vocabularyTracker.addWord(translation.original_word, translation.translated_word);
                        }
                    }
                    
                    processed += wordsNeedingTranslation.length;
                    
                } catch (error) {
                    console.error('Batch translation error:', error);
                    // Skip this batch and continue
                    processed += wordsNeedingTranslation.length;
                }
            }
            
            // Send progress updates
            this.sendProgressToTab(tabId, `Processing words... ${processed}/${totalWords}`, processed, totalWords);
        }

        // Send completion
        setTimeout(() => {
            this.sendProgressToTab(tabId, 'Ready', totalWords, totalWords);
        }, 100);
    }

    async sendTranslationToTab(tabId, wordData) {
        try {
            await browser.tabs.sendMessage(tabId, {
                action: 'translationReady',
                wordData: wordData
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
        await this.vocabularyTracker.addWord(word, translation);
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

    async addWord(original, translation) {
        const key = original.toLowerCase();
        this.vocabulary.set(key, {
            original,
            translation,
            encounters: (this.vocabulary.get(key)?.encounters || 0) + 1,
            firstSeen: this.vocabulary.get(key)?.firstSeen || Date.now(),
            lastSeen: Date.now()
        });
        
        await this.saveVocabulary();
    }

    async markWordAsLearned(word) {
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

    // Get translation from cache if not expired
    async getTranslation(originalWord, sourceLanguage, targetLanguage) {
        try {
            const stored = await browser.storage.local.get(this.CACHE_KEY);
            const cache = stored[this.CACHE_KEY] || {};
            
            const key = this.getCacheKey(originalWord, sourceLanguage, targetLanguage);
            const entry = cache[key];
            
            if (!entry) {
                return null; // No cached translation
            }
            
            // Check if cache entry has expired (1 day = 24 * 60 * 60 * 1000 ms)
            const now = Date.now();
            const expiryTime = entry.timestamp + (this.CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
            
            if (now > expiryTime) {
                // Cache entry expired, remove it
                delete cache[key];
                await browser.storage.local.set({ [this.CACHE_KEY]: cache });
                return null;
            }
            
            console.log(`Cache hit for "${originalWord}" -> "${entry.translation}"`);
            return entry.translation;
            
        } catch (error) {
            console.error('Error reading from translation cache:', error);
            return null;
        }
    }

    // Set translation in cache with current timestamp
    async setTranslation(originalWord, sourceLanguage, targetLanguage, translation) {
        try {
            const stored = await browser.storage.local.get(this.CACHE_KEY);
            const cache = stored[this.CACHE_KEY] || {};
            
            const key = this.getCacheKey(originalWord, sourceLanguage, targetLanguage);
            
            cache[key] = {
                translation: translation,
                timestamp: Date.now(),
                originalWord: originalWord,
                sourceLanguage: sourceLanguage,
                targetLanguage: targetLanguage
            };
            
            await browser.storage.local.set({ [this.CACHE_KEY]: cache });
            console.log(`Cached translation: "${originalWord}" -> "${translation}"`);
            
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