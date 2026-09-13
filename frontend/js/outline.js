/** Native lists and buttons keep the revealed conversation usable without a canvas. */
class ConversationOutline {
    constructor(element, onSelect) {
        this.element = element;
        element.addEventListener('click', event => {
            const button = event.target.closest('button[data-message-id]');
            if (button) onSelect(Number(button.dataset.messageId));
        });
        element.addEventListener('keydown', event => {
            const buttons = [...element.querySelectorAll('button[data-message-id]')];
            const index = buttons.indexOf(document.activeElement);
            if (index < 0) return;
            let next;
            if (event.key === 'ArrowDown') next = Math.min(index + 1, buttons.length - 1);
            if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = buttons.length - 1;
            if (next !== undefined) {
                event.preventDefault();
                buttons[next].focus();
            }
        });
    }

    render(canvas) {
        const focused = this.element.contains(document.activeElement)
            ? document.activeElement.dataset.messageId : null;
        const scroll = this.element.scrollTop;
        const visible = canvas.messages.filter(m => canvas.visibleMessageIds.has(m.id));
        const byId = new Map(visible.map(m => [m.id, m]));
        const children = new Map();
        for (const message of visible) {
            const parent = byId.has(message.parent_id) ? message.parent_id : null;
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(message);
        }
        const visited = new Set();
        const build = parent => {
            const list = document.createElement('ol');
            for (const message of children.get(parent) || []) {
                if (visited.has(message.id)) continue;
                visited.add(message.id);
                const item = document.createElement('li');
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'outline-message';
                button.dataset.messageId = message.id;
                if (message.id === canvas.selectedId) button.setAttribute('aria-current', 'true');
                if (canvas.selectedPath.has(message.id)) button.classList.add('on-path');
                const translated = canvas.translatedIds.has(message.id);
                button.classList.toggle('is-translated', translated);
                const writer = document.createElement('span');
                writer.className = 'outline-writer';
                writer.textContent = message.writer_name;
                const preview = document.createElement('span');
                preview.className = 'outline-preview';
                preview.textContent = translated
                    ? (message.content.replace(/\s+/g, ' ').slice(0, 100) || 'Empty message')
                    : 'Untranslated message';
                button.setAttribute('aria-label', message.writer_name + ': ' +
                    (translated ? 'Translated. ' + preview.textContent : 'Untranslated message'));
                button.append(writer, preview);
                item.append(button);
                if (children.has(message.id)) item.append(build(message.id));
                list.append(item);
            }
            return list;
        };
        if (visible.length) {
            this.element.replaceChildren(build(null));
        } else {
            const hint = document.createElement('p');
            hint.className = 'hint';
            hint.textContent = 'Write a message to start this conversation.';
            this.element.replaceChildren(hint);
        }
        if (focused) {
            const button = [...this.element.querySelectorAll('button')]
                .find(b => b.dataset.messageId === focused);
            if (button) button.focus({ preventScroll: true });
            else document.getElementById('outline-summary').focus({ preventScroll: true });
        }
        this.element.scrollTop = scroll;
    }
}
window.ConversationOutline = ConversationOutline;
