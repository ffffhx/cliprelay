'use strict';

const menuButton = document.querySelector('.menu-button');
const navigation = document.getElementById('navigation');
function closeMenu() {
  navigation.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', '打开导航');
}
menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  navigation.classList.toggle('open', open);
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
});
navigation.addEventListener('click', (event) => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
    closeMenu(); menuButton.focus();
  }
});
document.addEventListener('click', (event) => { if (!event.target.closest('.site-header')) closeMenu(); });

const tabs = [...document.querySelectorAll('[role="tab"]')];
const tablist = document.querySelector('[role="tablist"]');
const horizontalTabs = window.matchMedia('(max-width: 850px)');
function updateOrientation() { tablist.setAttribute('aria-orientation', horizontalTabs.matches ? 'horizontal' : 'vertical'); }
updateOrientation();
horizontalTabs.addEventListener('change', updateOrientation);
function selectTab(selected) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
  }
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    const previousKey = horizontalTabs.matches ? 'ArrowLeft' : 'ArrowUp';
    const nextKey = horizontalTabs.matches ? 'ArrowRight' : 'ArrowDown';
    if (event.key === nextKey) next = (index + 1) % tabs.length;
    if (event.key === previousKey) next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(tabs[next]); tabs[next].focus(); }
  });
});

let toastTimer;
const copyStatus = document.getElementById('copy-status');
function showToast(message) {
  clearTimeout(toastTimer);
  copyStatus.textContent = message;
  copyStatus.classList.add('visible');
  toastTimer = setTimeout(() => copyStatus.classList.remove('visible'), 3500);
}
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(button.dataset.copy);
      showToast('命令已复制');
    } catch {
      showToast('无法自动复制，请选中上方命令手动复制');
    }
  });
});
