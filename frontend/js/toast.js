/**
 * Minimal toast notification system.
 * Usage: toast.info('...'), toast.success('...'), toast.error('...')
 */
(function () {
    const MAX_VISIBLE = 4;

    function getContainer() {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.setAttribute('role', 'status');
            container.setAttribute('aria-live', 'polite');
            document.body.appendChild(container);
        }
        return container;
    }

    function dismiss(el) {
        if (el.dataset.dismissing) return;
        el.dataset.dismissing = '1';
        el.classList.add('toast-out');
        el.addEventListener('animationend', () => el.remove(), { once: true });
        // Fallback in case animationend never fires
        setTimeout(() => el.remove(), 400);
    }

    function show(message, type = 'info', duration = 4000) {
        // Don't toast the 401 redirect - the page is already navigating to /login
        if (message === 'Authentication required') return null;

        const container = getContainer();

        // Cap the stack: drop the oldest
        while (container.children.length >= MAX_VISIBLE) {
            container.firstElementChild.remove();
        }

        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.textContent = message;
        el.title = 'Click to dismiss';
        el.addEventListener('click', () => dismiss(el));
        container.appendChild(el);

        if (duration > 0) {
            setTimeout(() => dismiss(el), duration);
        }
        return el;
    }

    window.toast = {
        show,
        info: (msg, duration) => show(msg, 'info', duration),
        success: (msg, duration) => show(msg, 'success', duration),
        error: (msg, duration) => show(msg, 'error', duration ?? 6000)
    };
})();
