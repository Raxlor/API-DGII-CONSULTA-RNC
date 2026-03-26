(function addHomeLink() {
    function injectButton() {
        const topbar = document.querySelector('.topbar .wrapper');
        if (!topbar || document.getElementById('home-link-swagger')) return;

        const link = document.createElement('a');
        link.id = 'home-link-swagger';
        link.href = '/';
        link.textContent = 'Volver al inicio';
        link.style.marginLeft = '12px';
        link.style.padding = '6px 10px';
        link.style.borderRadius = '6px';
        link.style.background = '#2563eb';
        link.style.color = '#fff';
        link.style.fontWeight = '700';
        link.style.textDecoration = 'none';

        topbar.appendChild(link);
    }

    const observer = new MutationObserver(injectButton);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    injectButton();
})();
