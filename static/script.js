document.addEventListener('DOMContentLoaded', () => {
    const tweetForm = document.getElementById('tweet-form');
    const tweetContent = document.getElementById('tweet-content');
    const charCount = document.getElementById('char-count');
    const submitBtn = document.getElementById('submit-btn');
    const postNowBtn = document.getElementById('post-now-btn');
    const queuedList = document.getElementById('queued-list');
    const postedList = document.getElementById('posted-list');
    const failedList = document.getElementById('failed-list');
    const failedSection = document.getElementById('failed-section');
    const queuedCount = document.getElementById('queued-count');
    const postedCount = document.getElementById('posted-count');
    const failedCount = document.getElementById('failed-count');
    const queuedEmpty = document.getElementById('queued-empty');
    const postedEmpty = document.getElementById('posted-empty');

    // Filters
    const searchPosted = document.getElementById('search-posted');
    const datePosted = document.getElementById('date-posted');
    let lastQueueData = { queued: [], posted: [], failed: [] };

    // Edit Modal
    const editModal = document.getElementById('edit-modal');
    const editForm = document.getElementById('edit-form');
    const editId = document.getElementById('edit-id');
    const editContent = document.getElementById('edit-content');
    const closeModal = document.getElementById('close-modal');

    // Settings Modal
    const settingsModal = document.getElementById('settings-modal');
    const openSettingsBtn = document.getElementById('open-settings-btn');
    const closeSettingsModalBtn = document.getElementById('close-settings-modal');
    const windowsList = document.getElementById('windows-list');
    const addWindowForm = document.getElementById('add-window-form');
    const newWindowTime = document.getElementById('new-window-time');
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    let currentWindows = [];

    // Help Modal
    const helpModal = document.getElementById('help-modal');
    const openHelpBtn = document.getElementById('open-help-btn');
    const closeHelpModalBtn = document.getElementById('close-help-modal');

    // Confirm Modal
    const confirmModal = document.getElementById('confirm-modal');
    const confirmMessage = document.getElementById('confirm-message');
    const confirmCancel = document.getElementById('confirm-cancel');
    const confirmOk = document.getElementById('confirm-ok');
    let confirmCallback = null;

    // Bot Status
    const botStatusBadge = document.getElementById('bot-status-badge');
    const botStatusMessage = document.getElementById('bot-status-message');
    const verifyBotBtn = document.getElementById('verify-bot-btn');

    if (!tweetForm) return;

    // ==================== Toast Notifications ====================

    function showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 4000);
    }

    // ==================== Confirm Dialog ====================

    function showConfirm(message) {
        return new Promise((resolve) => {
            confirmMessage.textContent = message;
            confirmModal.classList.add('active');
            confirmCallback = resolve;
        });
    }

    confirmCancel.addEventListener('click', () => {
        confirmModal.classList.remove('active');
        if (confirmCallback) confirmCallback(false);
        confirmCallback = null;
    });

    confirmOk.addEventListener('click', () => {
        confirmModal.classList.remove('active');
        if (confirmCallback) confirmCallback(true);
        confirmCallback = null;
    });

    // ==================== Auth Guard ====================

    async function apiFetch(url, options = {}) {
        const response = await fetch(url, options);
        if (response.status === 401) {
            showToast('Session expired. Redirecting to login...', 'error');
            setTimeout(() => { window.location.href = '/'; }, 1500);
            return null;
        }
        return response;
    }

    // ==================== Character Count ====================

    tweetContent.addEventListener('input', () => {
        const count = tweetContent.value.length;
        charCount.textContent = `${count} / 280`;
        if (count > 280) {
            charCount.classList.add('over-limit');
            submitBtn.disabled = true;
        } else {
            charCount.classList.remove('over-limit');
            submitBtn.disabled = false;
        }
    });

    // ==================== Bot Status ====================

    const loadBotStatus = async () => {
        try {
            const response = await apiFetch('/api/bot/status');
            if (response && response.ok) {
                const data = await response.json();
                renderBotStatus(data);
            }
        } catch (error) {
            console.error('Failed to load bot status', error);
        }
    };

    const renderBotStatus = (data) => {
        botStatusBadge.textContent = data.status;
        botStatusBadge.className = 'badge';

        if (data.status === 'Valid') {
            botStatusBadge.classList.add('badge-valid');
        } else if (data.status === 'Invalid' || data.status === 'Error') {
            botStatusBadge.classList.add('badge-invalid');
        } else {
            botStatusBadge.classList.add('badge-unknown');
        }

        let msg = data.last_message;
        if (data.last_checked) {
            const checkedTime = new Date(data.last_checked).toLocaleTimeString();
            msg += ` (Last checked: ${checkedTime})`;
        }
        botStatusMessage.textContent = msg;
        
        // Dynamically update greeting if x_username is known
        const navGreeting = document.getElementById('nav-greeting');
        if (navGreeting && data.x_username) {
            navGreeting.textContent = `Hello, ${data.x_username}`;
        }

        if (data.status === 'Checking...') {
            verifyBotBtn.disabled = true;
            verifyBotBtn.textContent = 'Checking...';
        } else {
            verifyBotBtn.disabled = false;
            verifyBotBtn.textContent = 'Check Connection';
        }
    };

    verifyBotBtn.addEventListener('click', async () => {
        verifyBotBtn.disabled = true;
        verifyBotBtn.textContent = 'Checking...';
        botStatusBadge.textContent = 'Checking...';
        botStatusBadge.className = 'badge badge-unknown';
        botStatusMessage.textContent = 'Launching browser to verify token...';

        try {
            const response = await apiFetch('/api/bot/verify', { method: 'POST' });
            if (response && response.ok) {
                const data = await response.json();
                renderBotStatus(data);
                if (data.status === 'Valid') {
                    showToast('Bot connection verified successfully!', 'success');
                } else {
                    showToast(data.last_message, 'error');
                }
            }
        } catch (error) {
            console.error('Failed to verify bot', error);
            showToast('Failed to verify bot connection.', 'error');
            verifyBotBtn.disabled = false;
            verifyBotBtn.textContent = 'Check Connection';
        }
    });

    // ==================== Queue CRUD ====================

    const loadQueue = async () => {
        try {
            const response = await apiFetch('/api/queue');
            if (response && response.ok) {
                const newData = await response.json();
                
                // Check if any new tweets were posted or failed since last check
                const oldPostedIds = lastQueueData.posted ? lastQueueData.posted.map(p => p.id) : [];
                const oldFailedIds = lastQueueData.failed ? lastQueueData.failed.map(p => p.id) : [];
                
                if (oldPostedIds.length > 0 || oldFailedIds.length > 0) {
                    const newPosted = (newData.posted || []).filter(p => !oldPostedIds.includes(p.id));
                    if (newPosted.length > 0) {
                        showToast(`Successfully posted ${newPosted.length} tweet(s)!`, 'success');
                    }
                    
                    const newFailed = (newData.failed || []).filter(p => !oldFailedIds.includes(p.id));
                    if (newFailed.length > 0) {
                        showToast(`${newFailed.length} tweet(s) failed to post.`, 'error');
                    }
                }
                
                lastQueueData = newData;
                renderQueue();
            }
        } catch (error) {
            console.error('Failed to load queue', error);
        }
    };

    const renderQueue = () => {
        queuedList.innerHTML = '';
        postedList.innerHTML = '';
        if (failedList) failedList.innerHTML = '';

        const queued = lastQueueData.queued || [];
        let posted = lastQueueData.posted || [];
        const failed = lastQueueData.failed || [];

        // Apply filters to posted
        const searchText = searchPosted ? searchPosted.value.trim().toLowerCase() : '';
        const filterDate = datePosted ? datePosted.value : '';
        
        if (searchText) {
            posted = posted.filter(item => item.content.toLowerCase().includes(searchText));
        }
        if (filterDate) {
            posted = posted.filter(item => {
                // Posted date is localized, but input date is YYYY-MM-DD
                // To be safe, compare local date strings
                const d = new Date(item.posted_at);
                const tzOffset = d.getTimezoneOffset() * 60000;
                const localISOTime = (new Date(d - tzOffset)).toISOString().split('T')[0];
                return localISOTime === filterDate;
            });
        }

        // Queued
        queuedCount.textContent = queued.length;
        queuedEmpty.style.display = queued.length === 0 ? 'block' : 'none';
        queued.forEach(item => {
            queuedList.appendChild(createTweetElement(item, 'queued'));
        });

        // Posted
        postedCount.textContent = posted.length;
        if (posted.length === 0) {
            postedEmpty.style.display = 'block';
            postedEmpty.textContent = (searchText || filterDate) ? 'No posted tweets match your filters.' : 'No tweets posted yet.';
        } else {
            postedEmpty.style.display = 'none';
        }
        // Show latest first
        [...posted].reverse().forEach(item => {
            postedList.appendChild(createTweetElement(item, 'posted'));
        });

        // Failed
        if (failedSection) {
            failedCount.textContent = failed.length;
            failedSection.style.display = failed.length > 0 ? 'block' : 'none';
            failed.forEach(item => {
                failedList.appendChild(createTweetElement(item, 'failed'));
            });
        }
    };

    const createTweetElement = (item, type) => {
        const li = document.createElement('li');
        li.className = 'tweet-item';
        if (type === 'failed') li.classList.add('failed');

        const content = document.createElement('div');
        content.className = 'tweet-content';
        content.textContent = item.content;

        const meta = document.createElement('div');
        meta.className = 'tweet-meta';

        const dateSpan = document.createElement('span');
        if (type === 'queued') {
            const d = new Date(item.scheduled_at);
            dateSpan.textContent = `Scheduled: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
        } else if (type === 'posted') {
            const d = new Date(item.posted_at);
            dateSpan.textContent = `Posted: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
        } else if (type === 'failed') {
            const d = new Date(item.failed_at);
            dateSpan.textContent = `Failed: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
        }
        meta.appendChild(dateSpan);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'tweet-actions';

        if (type === 'queued') {
            const editBtn = document.createElement('button');
            editBtn.className = 'btn-icon';
            editBtn.textContent = 'Edit';
            editBtn.onclick = () => openEditModal(item);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn-icon btn-delete';
            deleteBtn.textContent = 'Remove';
            deleteBtn.onclick = () => deleteTweet(item.id);

            actions.appendChild(editBtn);
            actions.appendChild(deleteBtn);
        } else if (type === 'failed') {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'btn-icon btn-retry';
            retryBtn.textContent = 'Retry';
            retryBtn.onclick = () => retryTweet(item.id);

            const dismissBtn = document.createElement('button');
            dismissBtn.className = 'btn-icon btn-delete';
            dismissBtn.textContent = 'Dismiss';
            dismissBtn.onclick = () => dismissFailed(item.id);

            actions.appendChild(retryBtn);
            actions.appendChild(dismissBtn);
        }

        if (actions.children.length > 0) {
            meta.appendChild(actions);
        }

        li.appendChild(content);

        // Show error message for failed items
        if (type === 'failed' && item.last_error) {
            const errDiv = document.createElement('div');
            errDiv.className = 'tweet-error';
            errDiv.textContent = `Error: ${item.last_error}`;
            li.appendChild(errDiv);
        }

        li.appendChild(meta);
        return li;
    };

    // --- Delete ---
    const deleteTweet = async (id) => {
        const confirmed = await showConfirm('Remove this tweet from the queue?');
        if (!confirmed) return;
        try {
            const response = await apiFetch(`/api/queue/${id}`, { method: 'DELETE' });
            if (response && response.ok) {
                showToast('Tweet removed from queue.', 'success');
                loadQueue();
            } else if (response) {
                const err = await response.json();
                showToast(err.detail || 'Failed to remove tweet.', 'error');
            }
        } catch (error) {
            showToast('Network error. Could not remove tweet.', 'error');
        }
    };

    // --- Retry Failed ---
    const retryTweet = async (id) => {
        const confirmed = await showConfirm('Move this tweet back to the queue for retry?');
        if (!confirmed) return;
        try {
            const response = await apiFetch(`/api/queue/${id}/retry`, { method: 'POST' });
            if (response && response.ok) {
                showToast('Tweet moved back to queue.', 'success');
                loadQueue();
            } else if (response) {
                const err = await response.json();
                showToast(err.detail || 'Failed to retry tweet.', 'error');
            }
        } catch (error) {
            showToast('Network error. Could not retry tweet.', 'error');
        }
    };

    // --- Dismiss Failed ---
    const dismissFailed = async (id) => {
        const confirmed = await showConfirm('Dismiss this failed tweet? It will be permanently deleted.');
        if (!confirmed) return;
        try {
            const response = await apiFetch(`/api/failed/${id}`, { method: 'DELETE' });
            if (response && response.ok) {
                showToast('Failed tweet dismissed.', 'success');
                loadQueue();
            } else if (response) {
                const err = await response.json();
                showToast(err.detail || 'Failed to dismiss tweet.', 'error');
            }
        } catch (error) {
            showToast('Network error. Could not dismiss tweet.', 'error');
        }
    };

    // --- Add to Queue or Post Now ---
    const submitTweet = async (content, postNow) => {
        submitBtn.disabled = true;
        if (postNowBtn) postNowBtn.disabled = true;
        
        const originalText = postNow ? postNowBtn.textContent : submitBtn.textContent;
        if (postNow) postNowBtn.textContent = 'Posting...';
        else submitBtn.textContent = 'Adding...';

        try {
            const response = await apiFetch('/api/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, post_now: postNow })
            });

            if (response && response.ok) {
                const data = await response.json();
                if (postNow) {
                    showToast('Tweet queued for immediate posting. It will appear in posted tweets shortly.', 'success');
                } else {
                    const scheduledDate = new Date(data.item.scheduled_at);
                    showToast(`Queued for ${scheduledDate.toLocaleDateString()} ${scheduledDate.toLocaleTimeString()}`, 'success');
                }
                tweetContent.value = '';
                charCount.textContent = '0 / 280';
                charCount.classList.remove('over-limit');
                loadQueue();
            } else if (response) {
                const err = await response.json();
                showToast(err.detail || 'Failed to add tweet.', 'error');
            }
        } catch (error) {
            showToast('Network error. Could not add tweet.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add to Queue';
            if (postNowBtn) {
                postNowBtn.disabled = false;
                postNowBtn.textContent = 'Post Now';
            }
        }
    };

    tweetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const content = tweetContent.value.trim();
        if (!content || content.length > 280) {
            showToast('Tweet must be between 1 and 280 characters.', 'warning');
            return;
        }
        await submitTweet(content, false);
    });

    if (postNowBtn) {
        postNowBtn.addEventListener('click', async () => {
            const content = tweetContent.value.trim();
            if (!content || content.length > 280) {
                showToast('Tweet must be between 1 and 280 characters.', 'warning');
                return;
            }
            await submitTweet(content, true);
        });
    }

    // Filter listeners
    if (searchPosted) searchPosted.addEventListener('input', renderQueue);
    if (datePosted) datePosted.addEventListener('input', renderQueue);

    // ==================== Edit Modal ====================

    const openEditModal = (item) => {
        editId.value = item.id;
        editContent.value = item.content;
        editModal.classList.add('active');
        editContent.focus();
    };

    closeModal.addEventListener('click', () => {
        editModal.classList.remove('active');
    });

    editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = editId.value;
        const content = editContent.value.trim();

        if (!content || content.length > 280) {
            showToast('Tweet must be between 1 and 280 characters.', 'warning');
            return;
        }

        try {
            const response = await apiFetch(`/api/queue/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });

            if (response && response.ok) {
                editModal.classList.remove('active');
                showToast('Tweet updated.', 'success');
                loadQueue();
            } else if (response) {
                const err = await response.json();
                showToast(err.detail || 'Failed to update tweet.', 'error');
            }
        } catch (error) {
            showToast('Network error. Could not update tweet.', 'error');
        }
    });

    // ==================== Settings Modal ====================
    
    const loadSettings = async () => {
        try {
            const response = await apiFetch('/api/settings');
            if (response && response.ok) {
                const data = await response.json();
                currentWindows = data.windows || [];
                renderWindows();
            }
        } catch (error) {
            console.error('Failed to load settings', error);
        }
    };

    const renderWindows = () => {
        windowsList.innerHTML = '';
        if (currentWindows.length === 0) {
            windowsList.innerHTML = '<p class="text-sm text-secondary text-center py-2">No posting windows configured.</p>';
            return;
        }

        // Sort just for display
        const sorted = [...currentWindows].sort((a, b) => {
            if (a[0] !== b[0]) return a[0] - b[0];
            return a[1] - b[1];
        });

        sorted.forEach((win, index) => {
            const h = win[0].toString().padStart(2, '0');
            const m = win[1].toString().padStart(2, '0');
            const timeStr = `${h}:${m}`;
            
            const div = document.createElement('div');
            div.className = 'time-window-item';
            
            const span = document.createElement('span');
            span.textContent = timeStr;
            
            const btn = document.createElement('button');
            btn.className = 'btn-icon btn-delete';
            btn.textContent = 'Remove';
            btn.type = 'button';
            btn.onclick = () => {
                currentWindows.splice(index, 1);
                renderWindows();
            };
            
            div.appendChild(span);
            div.appendChild(btn);
            windowsList.appendChild(div);
        });
    };

    if (openSettingsBtn) {
        openSettingsBtn.addEventListener('click', () => {
            loadSettings(); // Reload fresh every time opened
            settingsModal.classList.add('active');
        });
    }

    if (closeSettingsModalBtn) {
        closeSettingsModalBtn.addEventListener('click', () => {
            settingsModal.classList.remove('active');
        });
    }

    if (addWindowForm) {
        addWindowForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const timeVal = newWindowTime.value; // "HH:MM"
            if (!timeVal) return;
            
            const [h, m] = timeVal.split(':').map(Number);
            // Check for duplicates
            const exists = currentWindows.some(w => w[0] === h && w[1] === m);
            if (exists) {
                showToast('This time window already exists.', 'warning');
                return;
            }
            
            currentWindows.push([h, m]);
            renderWindows();
            newWindowTime.value = '';
        });
    }

    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async () => {
            if (currentWindows.length === 0) {
                showToast('You must have at least one posting window.', 'error');
                return;
            }
            saveSettingsBtn.disabled = true;
            saveSettingsBtn.textContent = 'Saving...';
            try {
                const response = await apiFetch('/api/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ windows: currentWindows })
                });

                if (response && response.ok) {
                    settingsModal.classList.remove('active');
                    showToast('Settings saved. Queued tweets have been rescheduled!', 'success');
                    loadQueue(); // Refresh queue view to see new schedules
                } else if (response) {
                    const err = await response.json();
                    showToast(err.detail || 'Failed to save settings.', 'error');
                }
            } catch (error) {
                showToast('Network error. Could not save settings.', 'error');
            } finally {
                saveSettingsBtn.disabled = false;
                saveSettingsBtn.textContent = 'Save Settings';
            }
        });
    }

    // ==================== Help Modal ====================
    if (openHelpBtn) {
        openHelpBtn.addEventListener('click', () => {
            helpModal.classList.add('active');
        });
    }

    if (closeHelpModalBtn) {
        closeHelpModalBtn.addEventListener('click', () => {
            helpModal.classList.remove('active');
        });
    }

    // Close modals on backdrop click
    [editModal, confirmModal, settingsModal, helpModal].forEach(modal => {
        if (!modal) return;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
                if (modal === confirmModal && confirmCallback) {
                    confirmCallback(false);
                    confirmCallback = null;
                }
            }
        });
    });

    // ==================== Initial Load ====================

    loadBotStatus();
    loadQueue();

    setInterval(() => {
        loadBotStatus();
        loadQueue();
    }, 10000);
});
