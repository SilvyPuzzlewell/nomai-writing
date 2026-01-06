/**
 * API client for backend communication.
 */
const API_BASE = 'http://localhost:5000/api';

const api = {
    /**
     * Get all threads.
     */
    async getThreads() {
        const response = await fetch(`${API_BASE}/threads`);
        if (!response.ok) throw new Error('Failed to fetch threads');
        return response.json();
    },

    /**
     * Get a thread with all its messages.
     */
    async getThread(id) {
        const response = await fetch(`${API_BASE}/threads/${id}`);
        if (!response.ok) throw new Error('Failed to fetch thread');
        return response.json();
    },

    /**
     * Create a new thread.
     */
    async createThread(title) {
        const response = await fetch(`${API_BASE}/threads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        if (!response.ok) throw new Error('Failed to create thread');
        return response.json();
    },

    /**
     * Delete a thread.
     */
    async deleteThread(id) {
        const response = await fetch(`${API_BASE}/threads/${id}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete thread');
        return response.json();
    },

    /**
     * Create a new message.
     */
    async createMessage(threadId, parentId, writerName, content) {
        const response = await fetch(`${API_BASE}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                thread_id: threadId,
                parent_id: parentId,
                writer_name: writerName,
                content: content
            })
        });
        if (!response.ok) throw new Error('Failed to create message');
        return response.json();
    },

    /**
     * Delete a message.
     */
    async deleteMessage(id) {
        const response = await fetch(`${API_BASE}/messages/${id}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete message');
        return response.json();
    }
};

// Export
window.api = api;
