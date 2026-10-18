// Common utilities for all tool pages
// Theme management and navigation toggle

(function() {
    'use strict';

    // ============= Theme Management =============
    const themeSwitcher = document.getElementById('theme-switcher');
    const themeButtons = themeSwitcher?.querySelectorAll('.theme-btn');
    
    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        
        themeButtons?.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === theme);
        });
    }
    
    // Load saved theme or default to light
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
    
    // Add click handlers to theme buttons
    themeButtons?.forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            setTheme(this.dataset.theme);
        });
    });
    
    // Fade theme switcher on scroll
    let scrollFadeTimer = null;
    
    window.addEventListener('scroll', () => {
        if (!themeSwitcher) {
            return;
        }
        
        themeSwitcher.classList.add('scrolling');
        if (scrollFadeTimer !== null) {
            clearTimeout(scrollFadeTimer);
        }
        
        scrollFadeTimer = setTimeout(() => {
            themeSwitcher.classList.remove('scrolling');
            scrollFadeTimer = null;
        }, 180);
    }, { passive: true });

    // ============= Navigation Toggle =============
    const navToggle = document.getElementById("nav-toggle");
    const sideNav = document.getElementById("side-nav");
    
    if (navToggle && sideNav) {
        const mobileMedia = window.matchMedia('(max-width: 700px)');

        function getStorageKey() {
            return mobileMedia.matches ? 'nav-collapsed-mobile' : 'nav-collapsed-desktop';
        }

        function applyNavState() {
            const stored = localStorage.getItem(getStorageKey());
            const shouldCollapse = stored === null ? true : stored === 'true';

            sideNav.classList.toggle('collapsed', shouldCollapse);
            document.body.classList.toggle('nav-collapsed', shouldCollapse);
            navToggle.setAttribute('aria-expanded', shouldCollapse ? 'false' : 'true');
            navToggle.textContent = shouldCollapse ? '+' : '×';
        }

        navToggle.addEventListener('click', () => {
            const isCollapsed = sideNav.classList.toggle('collapsed');
            document.body.classList.toggle('nav-collapsed', isCollapsed);
            navToggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
            navToggle.textContent = isCollapsed ? '+' : '×';
            localStorage.setItem(getStorageKey(), isCollapsed ? 'true' : 'false');
        });

        sideNav.querySelectorAll('.nav-tab').forEach((link) => {
            link.addEventListener('click', () => {
                if (!mobileMedia.matches) {
                    return;
                }

                sideNav.classList.add('collapsed');
                document.body.classList.add('nav-collapsed');
                navToggle.setAttribute('aria-expanded', 'false');
                navToggle.textContent = '+';
                localStorage.setItem(getStorageKey(), 'true');
            });
        });

        if (typeof mobileMedia.addEventListener === 'function') {
            mobileMedia.addEventListener('change', applyNavState);
        } else if (typeof mobileMedia.addListener === 'function') {
            mobileMedia.addListener(applyNavState);
        }

        applyNavState();
    }
})();
