class LanguageLearningContent {
    constructor() {
        this.isEnabled = false;
        this.targetLanguage = 'fr';
        this.difficulty = 'beginner';
        this.replacementPercentage = 10;
        this.processedWords = new Set();
        this.tooltip = null;
        this.pendingReplacements = new Map(); // Store nodes waiting for translations
        this.nodeSegments = new WeakMap(); // Original text node -> text pieces left after earlier replacements
        this.isTooltipHovered = false; // Track tooltip hover state
        this.hideTooltipTimeout = null; // Track hide timeout
        this.dictionary = new EnglishDictionary(); // English word dictionary for filtering
        
        this.init();
    }

    // Custom Modal System for Content Script
    createModal() {
        if (document.getElementById('fluent-tab-modal')) return;
        
        const modal = document.createElement('div');
        modal.id = 'fluent-tab-modal';
        modal.className = 'fluent-modal-fixed fluent-modal-inset-0 fluent-modal-bg-black/50 fluent-modal-flex fluent-modal-items-center fluent-modal-justify-center fluent-modal-z-50 fluent-modal-hidden fluent-modal-font-sans';
        
        const modalContent = document.createElement('div');
        modalContent.className = 'fluent-modal-bg-white fluent-modal-rounded-lg fluent-modal-p-6 fluent-modal-w-80 fluent-modal-max-w-sm fluent-modal-mx-4 fluent-modal-shadow-lg';
        
        const modalTitle = document.createElement('div');
        modalTitle.id = 'fluent-tab-modal-title';
        modalTitle.className = 'fluent-modal-text-lg fluent-modal-font-semibold fluent-modal-text-gray-800 fluent-modal-mb-3';
        
        const modalMessage = document.createElement('div');
        modalMessage.id = 'fluent-tab-modal-message';
        modalMessage.className = 'fluent-modal-text-gray-600 fluent-modal-mb-4 fluent-modal-whitespace-pre-line';
        
        const modalInput = document.createElement('div');
        modalInput.id = 'fluent-tab-modal-input';
        modalInput.className = 'fluent-modal-mb-4 fluent-modal-hidden';
        
        const inputField = document.createElement('input');
        inputField.id = 'fluent-tab-modal-input-field';
        inputField.type = 'text';
        inputField.className = 'fluent-modal-w-full fluent-modal-py-2 fluent-modal-px-3 fluent-modal-border fluent-modal-border-gray-300 fluent-modal-rounded fluent-modal-text-sm fluent-modal-focus:outline-none fluent-modal-focus:ring-2 fluent-modal-focus:ring-blue-500';
        
        const modalButtons = document.createElement('div');
        modalButtons.className = 'fluent-modal-flex fluent-modal-justify-end fluent-modal-space-x-2';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'fluent-tab-modal-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'fluent-modal-button fluent-modal-px-3 fluent-modal-py-2 fluent-modal-text-sm fluent-modal-rounded fluent-modal-transition-colors fluent-modal-mr-2 fluent-modal-button fluent-modal-bg-gray-100 fluent-modal-text-gray-600 fluent-modal-hover:bg-gray-200';
        
        const confirmBtn = document.createElement('button');
        confirmBtn.id = 'fluent-tab-modal-confirm';
        confirmBtn.textContent = 'OK';
        confirmBtn.className = 'fluent-modal-px-4 fluent-modal-py-2 fluent-modal-bg-blue-500 fluent-modal-text-white fluent-modal-rounded fluent-modal-text-sm fluent-modal-hover:bg-blue-600 fluent-modal-transition-colors';
        
        modalInput.appendChild(inputField);
        modalButtons.appendChild(cancelBtn);
        modalButtons.appendChild(confirmBtn);
        modalContent.appendChild(modalTitle);
        modalContent.appendChild(modalMessage);
        modalContent.appendChild(modalInput);
        modalContent.appendChild(modalButtons);
        modal.appendChild(modalContent);
        
        document.body.appendChild(modal);
    }

    showModal(title, message, type = 'alert', defaultValue = '') {
        return new Promise((resolve) => {
            this.createModal();
            
            const modal = document.getElementById('fluent-tab-modal');
            const modalTitle = document.getElementById('fluent-tab-modal-title');
            const modalMessage = document.getElementById('fluent-tab-modal-message');
            const modalInput = document.getElementById('fluent-tab-modal-input');
            const inputField = document.getElementById('fluent-tab-modal-input-field');
            const cancelBtn = document.getElementById('fluent-tab-modal-cancel');
            const confirmBtn = document.getElementById('fluent-tab-modal-confirm');
            
            modalTitle.textContent = title;
            modalMessage.textContent = message;
            
            if (type === 'prompt') {
                modalInput.classList.remove('fluent-modal-hidden');
                inputField.value = defaultValue;
                if (cancelBtn) cancelBtn.classList.remove('fluent-modal-hidden');
                setTimeout(() => inputField.focus(), 100);
            } else {
                modalInput.classList.add('fluent-modal-hidden');
                if (type === 'alert') {
                    if (cancelBtn) cancelBtn.classList.add('fluent-modal-hidden');
                } else {
                    if (cancelBtn) cancelBtn.classList.remove('fluent-modal-hidden');
                }
            }
            
            modal.classList.remove('fluent-modal-hidden');
            
            const handleConfirm = () => {
                const result = type === 'prompt' ? inputField.value : true;
                cleanup();
                resolve(result);
            };
            
            const handleCancel = () => {
                cleanup();
                resolve(type === 'prompt' ? null : false);
            };
            
            const cleanup = () => {
                modal.classList.add('fluent-modal-hidden');
                if (confirmBtn) confirmBtn.removeEventListener('click', handleConfirm);
                if (cancelBtn) cancelBtn.removeEventListener('click', handleCancel);
                modal.removeEventListener('click', handleBackdropClick);
                document.removeEventListener('keydown', handleKeyDown);
            };
            
            const handleBackdropClick = (e) => {
                if (e.target === modal) {
                    handleCancel();
                }
            };
            
            const handleKeyDown = (e) => {
                if (e.key === 'Enter') {
                    handleConfirm();
                } else if (e.key === 'Escape') {
                    handleCancel();
                }
            };
            
            confirmBtn.addEventListener('click', handleConfirm);
            if (cancelBtn) cancelBtn.addEventListener('click', handleCancel);
            modal.addEventListener('click', handleBackdropClick);
            document.addEventListener('keydown', handleKeyDown);
        });
    }

    customPrompt(message, title = 'Input', defaultValue = '') {
        return this.showModal(title, message, 'prompt', defaultValue);
    }

    async init() {
        // Check if extension is disabled via meta tag
        if (this.isExtensionDisabled()) {
            console.log('Fluent Tab disabled by meta tag');
            return;
        }
        
        await this.loadSettings();
        this.createTooltip();
        
        if (this.isEnabled) {
            this.processPage();
        }
        
        this.setupMessageListener();
    }

    isExtensionDisabled() {
        // Check for meta tag that disables the extension
        const disableMeta = document.querySelector('meta[name="fluent-tab"][content="disabled"]');
        return disableMeta !== null;
    }

    async loadSettings() {
        const settings = await browser.storage.local.get([
            'languageLearningEnabled',
            'targetLanguage',
            'difficulty',
            'replacementPercentage'
        ]);
        
        this.isEnabled = settings.languageLearningEnabled || false;
        this.targetLanguage = settings.targetLanguage || 'fr';
        this.difficulty = settings.difficulty || 'beginner';
        this.replacementPercentage = settings.replacementPercentage || 10;
    }

    setupMessageListener() {
        browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
            switch (request.action) {
                case 'toggleLearning':
                    this.toggleLearning();
                    sendResponse({success: true});
                    break;
                case 'updateSettings':
                    this.updateSettings(request.settings);
                    sendResponse({success: true});
                    break;
                case 'getStats':
                    sendResponse(this.getStats());
                    break;
                case 'translationReady':
                    this.handleTranslationReady(request.wordData);
                    sendResponse({success: true});
                    break;
                default:
                    return false;
            }
            return true;
        });
    }

    async toggleLearning() {
        this.isEnabled = !this.isEnabled;
        await browser.storage.local.set({ languageLearningEnabled: this.isEnabled });
        
        if (this.isEnabled) {
            this.processPage();
        } else {
            this.clearReplacements();
        }
    }

    async updateSettings(settings) {
        Object.assign(this, settings);
        await browser.storage.local.set(settings);
        
        if (this.isEnabled) {
            this.clearReplacements();
            this.processPage();
        }
    }

    async processPage() {
        const textNodes = this.getTextNodes();
        const wordsToProcess = await this.selectWordsForReplacement(textNodes);
        
        if (wordsToProcess.length === 0) {
            return;
        }
        
        // Store pending replacements under the same id the background echoes back
        const wordsData = wordsToProcess.map(({ node, word, index }) => {
            const id = `${word.toLowerCase()}_${Date.now()}_${Math.random()}`;
            this.pendingReplacements.set(id, { node, word, index });
            return { text: word, index, id };
        });
        
        try {
            await browser.runtime.sendMessage({
                action: 'processWords',
                words: wordsData,
                targetLanguage: this.targetLanguage
            });
        } catch (error) {
            console.error('Error sending words to background:', error);
        }
    }

    getTextNodes() {
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    const parent = node.parentNode;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    
                    const tagName = parent.tagName.toLowerCase();
                    if (['script', 'style', 'noscript', 'textarea', 'input'].includes(tagName)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    
                    if (parent.isContentEditable) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    // Never translate the extension's own tooltip or modal
                    if (parent.closest('.language-learning-tooltip, #fluent-tab-modal')) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    return node.textContent.trim().length > 0 ? 
                        NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                }
            }
        );
        
        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }
        
        return textNodes;
    }

    async selectWordsForReplacement(textNodes) {
        const wordsToProcess = [];
        const { wordBlacklist = [], learnedWords = [] } = await browser.storage.local.get(['wordBlacklist', 'learnedWords']);
        const excludedWords = new Set([...wordBlacklist, ...learnedWords]);
        
        for (const node of textNodes) {
            const text = node.textContent;
            
            // For intermediate/advanced, also look for multi-word phrases
            if (this.difficulty === 'intermediate' || this.difficulty === 'advanced') {
                const phrases = this.extractPhrases(text);
                phrases.forEach(phrase => {
                    if (this.shouldReplacePhrase(phrase.text)) {
                        wordsToProcess.push({ node, word: phrase.text, index: phrase.index });
                    }
                });
            }
            
            // Always include single words (including contractions)
            // Find all word matches with their positions
            // Unicode-aware boundaries so "Zürich" or "résumé" never yield partial matches like "rich" or "sum"
            let match;
            const wordRegex = /(?<![\p{L}\p{M}\p{N}_])[a-zA-Z]+(?:'[a-zA-Z]+)?(?![\p{L}\p{M}\p{N}_])/gu;
            while ((match = wordRegex.exec(text)) !== null) {
                const word = match[0];
                if (this.shouldReplaceWord(word, excludedWords)) {
                    const index = match.index;
                    wordsToProcess.push({ node, word, index });
                }
            }
        }
        
        const targetCount = Math.ceil(wordsToProcess.length * (this.replacementPercentage / 100));
        return this.shuffleArray(wordsToProcess).slice(0, targetCount);
    }

    extractPhrases(text) {
        const phrases = [];
        
        // Common 2-3 word phrases for intermediate/advanced
        const phrasePatterns = {
            intermediate: [
                /\b(?:in order to|as well as|more than|less than|such as|rather than|along with|instead of)\b/gi,
                /\b(?:due to|according to|apart from|because of|in spite of|on behalf of)\b/gi,
                /\b(?:make sure|take place|find out|carry out|look forward|break down)\b/gi
            ],
            advanced: [
                /\b(?:in addition to|with regard to|in accordance with|on the other hand|as a result of|in contrast to)\b/gi,
                /\b(?:take into account|bring to light|come to terms with|get rid of|make use of|put up with)\b/gi,
                /\b(?:for the sake of|by means of|in the course of|at the expense of|in the face of)\b/gi
            ]
        };
        
        const patterns = phrasePatterns[this.difficulty] || [];
        
        patterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                phrases.push({
                    text: match[0],
                    index: match.index
                });
            }
        });
        
        return phrases;
    }
    
    shouldReplacePhrase(phrase) {
        if (phrase.length < 5 || phrase.length > 30) return false;
        return !this.processedWords.has(phrase.toLowerCase());
    }
    
    shouldReplaceWord(word, excludedWords) {
        if (word.length < 3 || word.length > 20) return false; // Increased length limit for contractions
        if (this.processedWords.has(word.toLowerCase())) return false;
        
        // Check if word exists in English dictionary
        if (!this.dictionary.isValidWord(word)) {
            return false; // Filter out words not in dictionary
        }
        
        // Skip blacklisted or learned words
        if (excludedWords.has(word.toLowerCase())) return false;
        
        // Skip very common words that shouldn't be translated for learning
        const commonWords = {
            beginner: ['the', 'and', 'you', 'are', 'have', 'this', 'that', 'with', 'they', 'from', "don't", "won't", "can't", "it's", "i'm", "you're", "they're", "we're"],
            intermediate: ['because', 'through', 'during', 'before', 'after', 'above', 'below', 'between', "couldn't", "wouldn't", "shouldn't", "haven't", "hasn't", "hadn't"],
            advanced: ['nevertheless', 'consequently', 'furthermore', 'moreover', 'therefore', 'however', "wouldn't've", "shouldn't've", "couldn't've"]
        };
        
        return !commonWords[this.difficulty].includes(word.toLowerCase());
    }

    handleTranslationReady(wordData) {
        const pending = this.pendingReplacements.get(wordData.id);
        if (!pending) {
            return; // No matching pending replacement
        }
        
        const { node, word, index } = pending;
        this.pendingReplacements.delete(wordData.id);
        
        // Create the word replacement
        this.createWordReplacement(node, word, { text: wordData.translation }, index);
        this.processedWords.add(word.toLowerCase());
    }

    createWordReplacement(node, originalWord, translation, index) {
        // A text node is split on every replacement, so find the remaining piece that still holds this word
        const segments = this.nodeSegments.get(node) || [{ node, start: 0 }];
        const end = index + originalWord.length;
        const segmentIndex = segments.findIndex(segment =>
            index >= segment.start && end <= segment.start + segment.node.length);
        
        if (segmentIndex === -1) {
            return; // Overlaps a word that was already replaced
        }
        
        const segment = segments[segmentIndex];
        const offset = index - segment.start;
        if (!segment.node.parentNode || !document.contains(segment.node) ||
            segment.node.data.slice(offset, offset + originalWord.length) !== originalWord) {
            return; // Node removed or its text changed since it was scanned
        }
        
        // Create the translated span
        const translatedSpan = document.createElement('span');
        translatedSpan.className = `language-learning-word ${this.difficulty}`;
        
        // Apply capitalization matching
        translatedSpan.textContent = this.matchCapitalization(originalWord, translation.text);
        translatedSpan.setAttribute('data-original', originalWord);
        translatedSpan.setAttribute('data-translation', translation.text);
        translatedSpan.setAttribute('data-difficulty', this.difficulty);
        
        this.setupWordEvents(translatedSpan, originalWord, translation.text);
        
        try {
            const wordNode = segment.node.splitText(offset);
            const afterNode = wordNode.splitText(originalWord.length);
            wordNode.parentNode.replaceChild(translatedSpan, wordNode);
            segments.splice(segmentIndex, 1,
                { node: segment.node, start: segment.start },
                { node: afterNode, start: end });
            this.nodeSegments.set(node, segments);
        } catch (error) {
            // Silently handle DOM manipulation errors
        }
    }

    setupWordEvents(element, originalWord, translation) {
        const language = this.targetLanguage; // Language the word was translated into
        
        element.addEventListener('mouseenter', (e) => {
            // Only show hover tooltip if no tooltip is currently pinned
            if (!this.tooltip.classList.contains('pinned')) {
                this.showTooltip(e, originalWord, translation, language, false);
            }
        });
        
        element.addEventListener('mouseleave', () => {
            // Only hide if tooltip is not pinned
            if (!this.tooltip.classList.contains('pinned')) {
                this.hideTooltipTimeout = setTimeout(() => {
                    if (!this.isTooltipHovered && !this.tooltip.classList.contains('pinned')) {
                        this.hideTooltip();
                    }
                }, 150); // Longer delay for easier hover transition
            }
        });
        
        element.addEventListener('click', (e) => {
            // Check if this translated word is inside a link
            const link = e.target.closest('a');
            if (link) {
                // Allow the link to work normally - don't preventDefault
                return;
            }
            
            // Prevent default and show pinned tooltip
            e.preventDefault();
            e.stopPropagation();
            this.showTooltip(e, originalWord, translation, language, true);
        });
    }

    createTooltip() {
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'language-learning-tooltip';
        document.body.appendChild(this.tooltip);
        
        // Add hover events to tooltip itself for better UX
        this.tooltip.addEventListener('mouseenter', () => {
            this.isTooltipHovered = true;
            // Cancel any pending hide timeout
            if (this.hideTooltipTimeout) {
                clearTimeout(this.hideTooltipTimeout);
                this.hideTooltipTimeout = null;
            }
        });
        
        this.tooltip.addEventListener('mouseleave', () => {
            this.isTooltipHovered = false;
            // Hide tooltip when leaving it (unless pinned)
            if (!this.tooltip.classList.contains('pinned')) {
                this.hideTooltip();
            }
        });
        
        // Add global click listener to close pinned tooltips
        document.addEventListener('click', (e) => {
            if (this.tooltip.classList.contains('pinned') && 
                !this.tooltip.contains(e.target) && 
                !e.target.classList.contains('language-learning-word')) {
                this.hideTooltip();
            }
        });
    }

    createCheckmarkSVG() {
        // Font Awesome Free v7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc.
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svg.setAttribute('viewBox', '0 0 640 640');
        svg.setAttribute('width', '18');
        svg.setAttribute('height', '18');

        // Create the path element
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M530.8 134.1C545.1 144.5 548.3 164.5 537.9 178.8L281.9 530.8C276.4 538.4 267.9 543.1 258.5 543.9C249.1 544.7 240 541.2 233.4 534.6L105.4 406.6C92.9 394.1 92.9 373.8 105.4 361.3C117.9 348.8 138.2 348.8 150.7 361.3L252.2 462.8L486.2 141.1C496.6 126.8 516.6 123.6 530.9 134z');
        path.setAttribute('fill', 'white');

        // Append the path to the SVG
        svg.appendChild(path);

        return svg;
    }

    createCloseSVG() {
        // Font Awesome Free v7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc.
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svg.setAttribute('viewBox', '0 0 640 640');
        svg.setAttribute('width', '18');
        svg.setAttribute('height', '18');

        // Create the path element
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M183.1 137.4C170.6 124.9 150.3 124.9 137.8 137.4C125.3 149.9 125.3 170.2 137.8 182.7L275.2 320L137.9 457.4C125.4 469.9 125.4 490.2 137.9 502.7C150.4 515.2 170.7 515.2 183.2 502.7L320.5 365.3L457.9 502.6C470.4 515.1 490.7 515.1 503.2 502.6C515.7 490.1 515.7 469.8 503.2 457.3L365.8 320L503.1 182.6C515.6 170.1 515.6 149.8 503.1 137.3C490.6 124.8 470.3 124.8 457.8 137.3L320.5 274.7L183.1 137.4z');
        path.setAttribute('fill', 'white');

        // Append the path to the SVG
        svg.appendChild(path);

        return svg;
    }

    createSpeakerSVG() {
        // Lucide "volume-2" icon - https://lucide.dev License - ISC
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('xmlns', svgNS);
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '18');
        svg.setAttribute('height', '18');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'white');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');

        const speaker = document.createElementNS(svgNS, 'polygon');
        speaker.setAttribute('points', '11 5 6 9 2 9 2 15 6 15 11 19 11 5');
        svg.appendChild(speaker);

        ['M15.54 8.46a5 5 0 0 1 0 7.07', 'M19.07 4.93a10 10 0 0 1 0 14.14'].forEach(d => {
            const wave = document.createElementNS(svgNS, 'path');
            wave.setAttribute('d', d);
            svg.appendChild(wave);
        });

        return svg;
    }

    speakTranslation(text, language) {
        const synth = window.speechSynthesis;
        synth.cancel(); // Stop any word still being spoken

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = language;
        const voice = synth.getVoices().find(v => v.lang.toLowerCase().startsWith(language.toLowerCase()));
        if (voice) utterance.voice = voice;

        synth.speak(utterance);
    }

    showTooltip(event, originalWord, translation, language, pinned = false) {
        const rect = event.target.getBoundingClientRect();
        
        // Clear tooltip content
        this.tooltip.textContent = '';

        /*const btnTopHolder = document.createElement('div');
        btnTopHolder.className = 'language-learning-tooltip-top';
        this.tooltip.appendChild(btnTopHolder);*/

        // Create original text element
        const originalTextDiv = document.createElement('div');
        originalTextDiv.className = 'original-text';
        originalTextDiv.textContent = originalWord;
        this.tooltip.appendChild(originalTextDiv);

        // Create actions container
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'tooltip-actions';

        // Add extension icon next to incorrect button
        const extensionIcon = document.createElement('img');
        extensionIcon.src = browser.runtime.getURL('icons/icon-128.png');
        extensionIcon.className = 'fluent-extension-icon';
        extensionIcon.style.width = '22px';
        extensionIcon.style.height = '22px';
        extensionIcon.style.alignSelf = 'center';
        actionsDiv.appendChild(extensionIcon);

        // Create listen button (only where the browser supports speech synthesis)
        if ('speechSynthesis' in window) {
            const speakBtn = document.createElement('button');
            speakBtn.className = 'tooltip-btn speak-btn';
            speakBtn.appendChild(this.createSpeakerSVG());
            speakBtn.setAttribute('aria-label', 'Listen');
            speakBtn.setAttribute('data-action', 'speak');
            speakBtn.setAttribute('data-translation', translation);
            speakBtn.setAttribute('data-language', language);
            actionsDiv.appendChild(speakBtn);
        }

        // Create learned button
        const learnedBtn = document.createElement('button');
        learnedBtn.className = 'tooltip-btn learned-btn';
        learnedBtn.appendChild(this.createCheckmarkSVG());
        learnedBtn.setAttribute('data-action', 'learned');
        learnedBtn.setAttribute('data-word', originalWord);
        actionsDiv.appendChild(learnedBtn);

        // Create incorrect button
        const incorrectBtn = document.createElement('button');
        incorrectBtn.className = 'tooltip-btn incorrect-btn';
        incorrectBtn.appendChild(this.createCloseSVG());
        incorrectBtn.setAttribute('data-action', 'incorrect');
        incorrectBtn.setAttribute('data-word', originalWord);
        incorrectBtn.setAttribute('data-translation', translation);
        actionsDiv.appendChild(incorrectBtn);

        this.tooltip.appendChild(actionsDiv);
        
        // Add hint if pinned
        if (pinned) {
            const hintDiv = document.createElement('div');
            hintDiv.className = 'tooltip-hint';
            hintDiv.textContent = 'Click outside to close';
            this.tooltip.appendChild(hintDiv);
        }
        
        // Add event listeners to the buttons
        this.tooltip.querySelectorAll('.tooltip-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                const word = btn.dataset.word;
                const trans = btn.dataset.translation;
                
                if (action === 'learned') {
                    this.markWordAsLearned(word);
                    this.hideTooltip();
                } else if (action === 'incorrect') {
                    this.handleIncorrectTranslation(word, trans);
                    this.hideTooltip();
                } else if (action === 'speak') {
                    this.speakTranslation(trans, btn.dataset.language);
                }
            });
        });
        
        // Reset base classes but preserve pinned state
        this.tooltip.className = 'language-learning-tooltip';
        
        // Set pinned state after resetting classes
        if (pinned) {
            this.tooltip.classList.add('pinned');
        }
        
        // Show tooltip to get its dimensions
        this.tooltip.style.visibility = 'hidden';
        this.tooltip.style.display = 'block';
        
        const tooltipRect = this.tooltip.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        // const viewportHeight = window.innerHeight;

        // Calculate horizontal position
        let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
        
        // Keep tooltip within viewport bounds
        if (left < 10) left = 10;
        if (left + tooltipRect.width > viewportWidth - 10) {
            left = viewportWidth - tooltipRect.width - 10;
        }
        
        // Calculate vertical position and determine arrow direction
        let top = rect.top - tooltipRect.height - 10;
        let isAbove = true;
        
        // If tooltip would go above viewport, show it below the word
        if (top < 10) {
            top = rect.bottom + 10;
            isAbove = false;
        }
        
        // Add appropriate class for arrow direction
        this.tooltip.classList.add(isAbove ? 'above' : 'below');
        
        this.tooltip.style.left = `${left}px`;
        this.tooltip.style.top = `${top}px`;
        this.tooltip.style.visibility = 'visible';
        this.tooltip.classList.add('show');
    }

    hideTooltip() {
        this.tooltip.classList.remove('show', 'pinned');
        this.isTooltipHovered = false;
        // Clear any pending timeout
        if (this.hideTooltipTimeout) {
            clearTimeout(this.hideTooltipTimeout);
            this.hideTooltipTimeout = null;
        }
    }


    clearReplacements() {
        const replacedWords = document.querySelectorAll('.language-learning-word');
        replacedWords.forEach(word => {
            try {
                // Check if the word still has a parent node
                if (word.parentNode && document.contains(word)) {
                    const originalText = word.getAttribute('data-original');
                    const textNode = document.createTextNode(originalText);
                    word.parentNode.replaceChild(textNode, word);
                }
            } catch (error) {
                // Silently handle DOM manipulation errors
            }
        });
        
        this.processedWords.clear();
        this.pendingReplacements.clear(); // Drop translations still in flight so they don't land after disabling
        this.nodeSegments = new WeakMap();
    }

    shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    matchCapitalization(originalWord, translatedWord) {
        if (!originalWord || !translatedWord) return translatedWord;
        
        // Handle multi-word phrases
        if (originalWord.includes(' ')) {
            const originalWords = originalWord.split(' ');
            const translatedWords = translatedWord.split(' ');
            
            // Match capitalization word by word if possible
            if (originalWords.length === translatedWords.length) {
                return translatedWords.map((word, i) => {
                    const original = originalWords[i] || originalWords[0];
                    return this.matchSingleWordCapitalization(original, word);
                }).join(' ');
            }
            
            // If word counts don't match, just match the first word's capitalization
            const firstOriginal = originalWords[0];
            return this.matchSingleWordCapitalization(firstOriginal, translatedWord);
        }
        
        return this.matchSingleWordCapitalization(originalWord, translatedWord);
    }
    
    matchSingleWordCapitalization(originalWord, translatedWord) {
        if (!originalWord || !translatedWord) return translatedWord;
        
        // All uppercase
        if (originalWord === originalWord.toUpperCase()) {
            return translatedWord.toUpperCase();
        }
        
        // First letter uppercase, rest lowercase
        if (originalWord[0] === originalWord[0].toUpperCase() && 
            originalWord.slice(1) === originalWord.slice(1).toLowerCase()) {
            return translatedWord.charAt(0).toUpperCase() + translatedWord.slice(1).toLowerCase();
        }
        
        // All lowercase (or mixed case - default to lowercase)
        return translatedWord.toLowerCase();
    }

    async markWordAsLearned(word) {
        try {
            await browser.runtime.sendMessage({
                action: 'markWordAsLearned',
                word: word
            });
        } catch (error) {
            console.error('Error marking word as learned:', error);
        }
    }
    
    async handleIncorrectTranslation(word, translation) {
        // Show dialog with options
        const options = [
            "Cancel",
            "Never translate this word",
            "Provide correct translation",
            "Just mark as incorrect"
        ];
        
        const choice = await this.showCustomDialog(
            `"${word}" → "${translation}"\n\nWhat would you like to do?`,
            options
        );
        
        if (choice === 1) {
            // Never translate
            await this.blacklistWord(word);
        } else if (choice === 2) {
            // Provide correct translation
            const correctTranslation = await this.customPrompt(`What should "${word}" translate to?`, 'Correct Translation');
            if (correctTranslation && correctTranslation.trim()) {
                await this.setCustomTranslation(word, correctTranslation.trim(), translation);
            }
        } else if (choice === 3) {
            // Just mark as incorrect
            await this.markTranslationIncorrect(word, translation);
        }
        // Choice 0 = Cancel, do nothing
    }
    
    showCustomDialog(message, options) {
        return new Promise((resolve) => {
            this.createModal();
            
            const modal = document.getElementById('fluent-tab-modal');
            const modalTitle = document.getElementById('fluent-tab-modal-title');
            const modalMessage = document.getElementById('fluent-tab-modal-message');
            const modalInput = document.getElementById('fluent-tab-modal-input');
            const modalButtons = modal.querySelector('.fluent-modal-flex.fluent-modal-justify-end');
            
            modalTitle.textContent = 'Choose Action';
            modalMessage.textContent = message;
            modalInput.classList.add('fluent-modal-hidden');
            
            // Clear existing buttons and create choice buttons
            modalButtons.textContent = '';
            
            options.forEach((option, index) => {
                const btn = document.createElement('button');
                btn.textContent = option;
                btn.className = `fluent-modal-button fluent-modal-px-3 fluent-modal-py-2 fluent-modal-text-sm fluent-modal-rounded fluent-modal-transition-colors fluent-modal-mr-2 ${
                    index === 0 ? 'fluent-modal-button fluent-modal-bg-gray-100 fluent-modal-text-gray-600 fluent-modal-hover:bg-gray-200' :
                    index === 1 ? 'fluent-modal-button fluent-modal-bg-red-500 fluent-modal-text-white fluent-modal-hover:bg-red-600' :
                    'fluent-modal-button fluent-modal-bg-blue-500 fluent-modal-text-white fluent-modal-hover:bg-blue-600'
                }`;
                
                btn.addEventListener('click', () => {
                    cleanup();
                    resolve(index);
                });
                
                modalButtons.appendChild(btn);
            });
            
            modal.classList.remove('fluent-modal-hidden');
            
            const cleanup = () => {
                modal.classList.add('fluent-modal-hidden');
                modal.removeEventListener('click', handleBackdropClick);
                document.removeEventListener('keydown', handleKeyDown);
                
                // Restore original button structure for future use
                modalButtons.textContent = '';
                
                // Ensure the button container has the correct classes for spacing
                modalButtons.className = 'fluent-modal-flex fluent-modal-justify-end fluent-modal-space-x-2';
                
                // Recreate cancel button with exact same styling as original
                const cancelBtn = document.createElement('button');
                cancelBtn.id = 'fluent-tab-modal-cancel';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.className = 'fluent-modal-button fluent-modal-px-3 fluent-modal-py-2 fluent-modal-text-sm fluent-modal-rounded fluent-modal-transition-colors fluent-modal-mr-2 fluent-modal-button fluent-modal-bg-gray-100 fluent-modal-text-gray-600 fluent-modal-hover:bg-gray-200';
                
                // Recreate confirm button with exact same styling as original
                const confirmBtn = document.createElement('button');
                confirmBtn.id = 'fluent-tab-modal-confirm';
                confirmBtn.textContent = 'OK';
                confirmBtn.className = 'fluent-modal-button fluent-modal-px-3 fluent-modal-py-2 fluent-modal-text-sm fluent-modal-rounded fluent-modal-transition-colors fluent-modal-mr-2 fluent-modal-button fluent-modal-bg-blue-500 fluent-modal-text-white fluent-modal-hover:bg-blue-600';
                
                modalButtons.appendChild(cancelBtn);
                modalButtons.appendChild(confirmBtn);
            };
            
            const handleBackdropClick = (e) => {
                if (e.target === modal) {
                    cleanup();
                    resolve(0); // Return cancel
                }
            };
            
            const handleKeyDown = (e) => {
                if (e.key === 'Escape') {
                    cleanup();
                    resolve(0); // Return cancel
                }
            };
            
            modal.addEventListener('click', handleBackdropClick);
            document.addEventListener('keydown', handleKeyDown);
        });
    }
    
    async markTranslationIncorrect(word, translation) {
        try {
            await browser.runtime.sendMessage({
                action: 'markTranslationIncorrect',
                word: word,
                translation: translation
            });
        } catch (error) {
            console.error('Error marking translation as incorrect:', error);
        }
    }
    
    async setCustomTranslation(word, translation, originalTranslation) {
        try {
            await browser.runtime.sendMessage({
                action: 'setCustomTranslation',
                word: word,
                translation: translation,
                originalTranslation: originalTranslation
            });
        } catch (error) {
            console.error('Error setting custom translation:', error);
        }
    }
    
    async blacklistWord(word) {
        try {
            await browser.runtime.sendMessage({
                action: 'blacklistWord',
                word: word
            });
        } catch (error) {
            console.error('Error blacklisting word:', error);
        }
    }

    async getStats() {
        try {
            const stats = await browser.runtime.sendMessage({
                action: 'getStats'
            });
            return {
                processedWords: this.processedWords.size,
                vocabularySize: stats.vocabularySize || 0,
                learnedWords: stats.learnedWords || 0,
                targetLanguage: this.targetLanguage,
                difficulty: this.difficulty,
                replacementPercentage: this.replacementPercentage
            };
        } catch (error) {
            return {
                processedWords: this.processedWords.size,
                vocabularySize: 0,
                learnedWords: 0,
                targetLanguage: this.targetLanguage,
                difficulty: this.difficulty,
                replacementPercentage: this.replacementPercentage
            };
        }
    }
}

console.log('Language Learning Content Script loaded');

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new LanguageLearningContent();
    });
} else {
    new LanguageLearningContent();
}