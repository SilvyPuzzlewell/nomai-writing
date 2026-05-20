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

const api = {
    /**
     * Get all threads.
     */
    async getThreads() {
        const response = await authFetch(`${API_BASE}/threads`);
        if (!response.ok) throw new Error('Failed to fetch threads');
        return response.json();
    },

    /**
     * Get a thread with all its messages.
     */
    async getThread(id) {
        const response = await authFetch(`${API_BASE}/threads/${id}`);
        if (!response.ok) throw new Error('Failed to fetch thread');
        return response.json();
    },

    /**
     * Create a new thread, optionally sharing with friends.
     */
    async createThread(title, friendIds = []) {
        const body = { title };
        if (friendIds.length > 0) body.friend_ids = friendIds;
        const response = await authFetch(`${API_BASE}/threads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error('Failed to create thread');
        return response.json();
    },

    /**
     * Delete a thread.
     */
    async deleteThread(id) {
        const response = await authFetch(`${API_BASE}/threads/${id}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete thread');
        return response.json();
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

        const response = await authFetch(`${API_BASE}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error('Failed to create message');
        return response.json();
    },

    /**
     * Delete a message.
     */
    async deleteMessage(id) {
        const response = await authFetch(`${API_BASE}/messages/${id}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete message');
        return response.json();
    },

    /**
     * Save layout data for messages in a thread.
     * @param {number} threadId - Thread ID
     * @param {Object} layouts - Map of message ID to layout data JSON string
     */
    async saveLayouts(threadId, layouts) {
        const response = await authFetch(`${API_BASE}/threads/${threadId}/layouts`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ layouts })
        });
        if (!response.ok) throw new Error('Failed to save layouts');
        return response.json();
    },

    /**
     * Clear layout data for a thread (triggers regeneration).
     * @param {number} threadId - Thread ID
     */
    async clearLayouts(threadId) {
        const response = await authFetch(`${API_BASE}/threads/${threadId}/layouts`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to clear layouts');
        return response.json();
    },

    /**
     * Export a thread with all messages and layout data.
     * @param {number} threadId - Thread ID
     */
    async exportThread(threadId) {
        const response = await authFetch(`${API_BASE}/threads/${threadId}/export`);
        if (!response.ok) throw new Error('Failed to export thread');
        return response.json();
    },

    /**
     * Send Discord notification for a thread.
     */
    async notifyDiscord(threadId) {
        const response = await authFetch(`${API_BASE}/threads/${threadId}/notify-discord`, {
            method: 'POST'
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to notify Discord');
        }
        return response.json();
    },

    /**
     * Import a thread from JSON data.
     */
    async importThread(data) {
        const response = await authFetch(`${API_BASE}/threads/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) throw new Error('Failed to import thread');
        return response.json();
    },

    // =====================================================================
    // Auth methods
    // =====================================================================

    async login(username, password) {
        const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Login failed');
        }
        return response.json();
    },

    async register(username, password) {
        const response = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
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
        const response = await authFetch(`${API_BASE}/auth/me/discord-webhook`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ webhook: url })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to save Discord webhook');
        }
        return response.json();
    },

    // =====================================================================
    // Friend methods
    // =====================================================================

    async searchUsers(query) {
        const response = await authFetch(`${API_BASE}/users/search?q=${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error('Failed to search users');
        return response.json();
    },

    async getFriends() {
        const response = await authFetch(`${API_BASE}/friends`);
        if (!response.ok) throw new Error('Failed to get friends');
        return response.json();
    },

    async getFriendRequests() {
        const response = await authFetch(`${API_BASE}/friends/requests`);
        if (!response.ok) throw new Error('Failed to get friend requests');
        return response.json();
    },

    async getPendingRequestCount() {
        const response = await authFetch(`${API_BASE}/friends/requests/count`);
        if (!response.ok) return { count: 0 };
        return response.json();
    },

    async sendFriendRequest(userId) {
        const response = await authFetch(`${API_BASE}/friends/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to send friend request');
        }
        return response.json();
    },

    async acceptFriendRequest(requestId) {
        const response = await authFetch(`${API_BASE}/friends/requests/${requestId}/accept`, {
            method: 'POST'
        });
        if (!response.ok) throw new Error('Failed to accept friend request');
        return response.json();
    },

    async declineFriendRequest(requestId) {
        const response = await authFetch(`${API_BASE}/friends/requests/${requestId}/decline`, {
            method: 'POST'
        });
        if (!response.ok) throw new Error('Failed to decline friend request');
        return response.json();
    },

    async removeFriend(friendUserId) {
        const response = await authFetch(`${API_BASE}/friends/${friendUserId}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to remove friend');
        return response.json();
    },

    // =====================================================================
    // Collaborator methods
    // =====================================================================

    async getThreadCollaborators(threadId) {
        const response = await authFetch(`${API_BASE}/threads/${threadId}/collaborators`);
        if (!response.ok) throw new Error('Failed to get collaborators');
        return response.json();
    },

    async addThreadCollaborator(threadId, userId) {
        const response = await authFetch(`${API_BASE}/threads/${threadId}/collaborators`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to add collaborator');
        }
        return response.json();
    },

    async removeThreadCollaborator(threadId, userId) {
        const response = await authFetch(`${API_BASE}/threads/${threadId}/collaborators/${userId}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to remove collaborator');
        return response.json();
    },

};

// Export
window.api = api;
