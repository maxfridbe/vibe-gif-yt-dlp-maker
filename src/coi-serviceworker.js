/*! coi-serviceworker v0.1.7 - Guido Zuidhof, licensed under MIT */
if (typeof window !== 'undefined') {
    let coi = {
        shouldRegister: () => true,
        shouldDeregister: () => false,
        doReload: () => window.location.reload(),
        quiet: false,
        ...window.coi
    };

    const n = navigator;
    if (coi.shouldRegister() && n.serviceWorker) {
        n.serviceWorker.register(window.document.currentScript.src).then(
            (registration) => {
                if (registration.active && !n.serviceWorker.controller) {
                    coi.doReload();
                }
            },
            (err) => console.error('COI registration failed: ', err)
        );
    }
} else {
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

    self.addEventListener('fetch', (e) => {
        const r = e.request;
        if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;

        e.respondWith(
            fetch(r).then((response) => {
                if (response.status === 0) return response;

                const newHeaders = new Headers(response.headers);
                newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
                newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');

                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: newHeaders,
                });
            })
        );
    });
}
