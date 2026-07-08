/**
 * API client for backend communication.
 * Uses relative URL to work in both development and production.
 */
const API_BASE = '/api';

/**
 * Wrapper around fetch that handles 401 redirects.
 */
async function authFetch(url, options = {}) {
    const response = await fetch(url, options);

    if (response.status === 401) {
        window.location.href = '/login';
        throw new Error('Authentication required');
    }

    return response;
}

/**
 * Perform an authenticated API call, surfacing the backend's error
 * message when the request fails (falling back to a generic one).
 */
async function apiCall(url, options, fallbackMsg) {
    const response = await authFetch(url, options);
    if (!response.ok) {
        let msg = fallbackMsg;
        try {
            const data = await response.json();
            if (data && data.error) msg = data.error;
        } catch (e) {
            // Non-JSON error body - keep the fallback message
        }
        throw new Error(msg);
    }
    return response.json();
}

function jsonBody(method, body) {
    return {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };
}

const api = {
    /**
     * Get all threads.
     */
    async getThreads() {
        return apiCall(`${API_BASE}/threads`, undefined, 'Failed to fetch threads');
    },

    /**
     * Get a thread with all its messages.
     */
    async getThread(id) {
        return apiCall(`${API_BASE}/threads/${id}`, undefined, 'Failed to fetch thread');
    },

    /**
     * Create a new thread, optionally sharing with friends.
     */
    async createThread(title, friendIds = []) {
        const body = { title };
        if (friendIds.length > 0) body.friend_ids = friendIds;
        return apiCall(`${API_BASE}/threads`, jsonBody('POST', body), 'Failed to create thread');
    },

    /**
     * Delete a thread.
     */
    async deleteThread(id) {
        return apiCall(`${API_BASE}/threads/${id}`, { method: 'DELETE' }, 'Failed to delete thread');
    },

    /**
     * Create a new message.
     * @param {number} threadId - Thread ID
     * @param {number|null} parentId - Parent message ID (null for root)
     * @param {string} writerName - Writer name
     * @param {string} content - Message content
     * @param {Object|null} spiralPrefs - Optional spiral preferences (branchT, curvatureDir, curvatureTightness)
     */
    async createMessage(threadId, parentId, writerName, content, spiralPrefs = null) {
        const body = {
            thread_id: threadId,
            parent_id: parentId,
            writer_name: writerName,
            content: content
        };

        if (spiralPrefs) {
            body.spiral_prefs = spiralPrefs;
        }

        return apiCall(`${API_BASE}/messages`, jsonBody('POST', body), 'Failed to create message');
    },

    /**
     * Delete a message.
     */
    async deleteMessage(id) {
        return apiCall(`${API_BASE}/messages/${id}`, { method: 'DELETE' }, 'Failed to delete message');
    },

    /**
     * Save layout data for messages in a thread.
     * @param {number} threadId - Thread ID
     * @param {Object} layouts - Map of message ID to layout data JSON string
     */
    async saveLayouts(threadId, layouts) {
        return apiCall(`${API_BASE}/threads/${threadId}/layouts`, jsonBody('PUT', { layouts }), 'Failed to save layouts');
    },

    /**
     * Clear layout data for a thread (triggers regeneration).
     * @param {number} threadId - Thread ID
     */
    async clearLayouts(threadId) {
        return apiCall(`${API_BASE}/threads/${threadId}/layouts`, { method: 'DELETE' }, 'Failed to clear layouts');
    },

    /**
     * Export a thread with all messages and layout data.
     * @param {number} threadId - Thread ID
     */
    async exportThread(threadId) {
        return apiCall(`${API_BASE}/threads/${threadId}/export`, undefined, 'Failed to export thread');
    },

    /**
     * Send Discord notification for a thread.
     */
    async notifyDiscord(threadId) {
        return apiCall(`${API_BASE}/threads/${threadId}/notify-discord`, { method: 'POST' }, 'Failed to notify Discord');
    },

    /**
     * Import a thread from JSON data.
     */
    async importThread(data) {
        return apiCall(`${API_BASE}/threads/import`, jsonBody('POST', data), 'Failed to import thread');
    },

    // =====================================================================
    // Auth methods
    // =====================================================================

    async login(username, password) {
        const response = await fetch(`${API_BASE}/auth/login`, jsonBody('POST', { username, password }));
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Login failed');
        }
        return response.json();
    },

    async register(username, password) {
        const response = await fetch(`${API_BASE}/auth/register`, jsonBody('POST', { username, password }));
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Registration failed');
        }
        return response.json();
    },

    async logout() {
        const response = await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST'
        });
        return response.json();
    },

    async getMe() {
        const response = await authFetch(`${API_BASE}/auth/me`);
        if (!response.ok) return null;
        return response.json();
    },

    async setDiscordWebhook(url) {
        return apiCall(`${API_BASE}/auth/me/discord-webhook`, jsonBody('PUT', { webhook: url }), 'Failed to save Discord webhook');
    },

    // =====================================================================
    // Friend methods
    // =====================================================================

    async searchUsers(query) {
        return apiCall(`${API_BASE}/users/search?q=${encodeURIComponent(query)}`, undefined, 'Failed to search users');
    },

    async getFriends() {
        return apiCall(`${API_BASE}/friends`, undefined, 'Failed to get friends');
    },

    async getFriendRequests() {
        return apiCall(`${API_BASE}/friends/requests`, undefined, 'Failed to get friend requests');
    },

    async getPendingRequestCount() {
        const response = await authFetch(`${API_BASE}/friends/requests/count`);
        if (!response.ok) return { count: 0 };
        return response.json();
    },

    async sendFriendRequest(userId) {
        return apiCall(`${API_BASE}/friends/request`, jsonBody('POST', { user_id: userId }), 'Failed to send friend request');
    },

    async acceptFriendRequest(requestId) {
        return apiCall(`${API_BASE}/friends/requests/${requestId}/accept`, { method: 'POST' }, 'Failed to accept friend request');
    },

    async declineFriendRequest(requestId) {
        return apiCall(`${API_BASE}/friends/requests/${requestId}/decline`, { method: 'POST' }, 'Failed to decline friend request');
    },

    async removeFriend(friendUserId) {
        return apiCall(`${API_BASE}/friends/${friendUserId}`, { method: 'DELETE' }, 'Failed to remove friend');
    },

    // =====================================================================
    // Collaborator methods
    // =====================================================================

    async getThreadCollaborators(threadId) {
        return apiCall(`${API_BASE}/threads/${threadId}/collaborators`, undefined, 'Failed to get collaborators');
    },

    async addThreadCollaborator(threadId, userId) {
        return apiCall(`${API_BASE}/threads/${threadId}/collaborators`, jsonBody('POST', { user_id: userId }), 'Failed to add collaborator');
    },

    async removeThreadCollaborator(threadId, userId) {
        return apiCall(`${API_BASE}/threads/${threadId}/collaborators/${userId}`, { method: 'DELETE' }, 'Failed to remove collaborator');
    },

};

// Export
window.api = api;
