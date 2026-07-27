const POLL_INTERVAL_MS = 1500;
const RECONNECT_GRACE_MS = 90_000;
const ACTIVE_STATES = new Set(['running', 'restarting']);

export function createUpdateSettings({ $, dashboardApiFetch, showToast }) {
    const button = $('settingsUpdateBtn');
    const status = $('settingsUpdateStatus');
    if (!button || !status) return;

    let pollTimer = null;
    let updateInProgress = false;
    let disconnectStartedAt = 0;
    let lastState = 'idle';
    let hasRendered = false;

    function render(update) {
        const state = typeof update?.state === 'string' ? update.state : 'idle';
        const message = typeof update?.message === 'string'
            ? update.message
            : 'Ready to check for updates.';
        const available = update?.available !== false;
        status.textContent = message;
        status.dataset.state = state;
        updateInProgress = ACTIVE_STATES.has(state);
        disconnectStartedAt = 0;
        button.disabled = !available || ACTIVE_STATES.has(state);
        button.textContent = !available
            ? 'Unavailable'
            : state === 'running'
            ? 'Updating…'
            : state === 'restarting'
                ? 'Restarting…'
                : 'Update now';

        if (hasRendered && lastState !== state && state === 'complete') {
            showToast(message, 'success', 5000);
        } else if (hasRendered && lastState !== state && state === 'failed') {
            showToast(message, 'error', 6000);
        }
        lastState = state;
        hasRendered = true;
        return state;
    }

    function stopPolling() {
        if (pollTimer !== null) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    }

    async function refresh() {
        try {
            const response = await dashboardApiFetch('/api/update', { cache: 'no-store' });
            if (!response.ok) throw new Error(`Update status failed (${response.status})`);
            const state = render(await response.json());
            if (ACTIVE_STATES.has(state)) {
                schedulePoll();
            } else {
                stopPolling();
            }
        } catch {
            if (updateInProgress) disconnectStartedAt ||= Date.now();
            if (disconnectStartedAt && Date.now() - disconnectStartedAt < RECONNECT_GRACE_MS) {
                status.textContent = 'Waiting for the updated server to restart…';
                status.dataset.state = 'restarting';
                button.disabled = true;
                button.textContent = 'Restarting…';
                schedulePoll();
                return;
            }
            stopPolling();
            status.textContent = 'Could not reach the update service.';
            status.dataset.state = 'failed';
            button.disabled = false;
            button.textContent = 'Try again';
        }
    }

    function schedulePoll() {
        stopPolling();
        pollTimer = setTimeout(() => {
            pollTimer = null;
            void refresh();
        }, POLL_INTERVAL_MS);
    }

    button.addEventListener('click', async () => {
        button.disabled = true;
        status.textContent = 'Starting the automatic update…';
        status.dataset.state = 'running';
        updateInProgress = true;
        disconnectStartedAt = 0;
        try {
            const response = await dashboardApiFetch('/api/update', { method: 'POST' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Update could not be started.');
            render(data);
            schedulePoll();
        } catch (error) {
            updateInProgress = false;
            disconnectStartedAt = 0;
            render({
                state: 'failed',
                message: error instanceof Error ? error.message : 'Update could not be started.',
            });
        }
    });

    window.addEventListener('beforeunload', stopPolling, { once: true });
    void refresh();
}
