// Small, local stroke icons. Keep the <i> hosts so existing sort indicators
// can change class without depending on a network font or a renderer framework.
(() => {
  const file = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>';
  const paths = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    'arrow-left': '<path d="m12 5-7 7 7 7M5 12h15"/>',
    'arrow-up': '<path d="m5 12 7-7 7 7M12 5v15"/>',
    'chevron-right': '<path d="m9 5 7 7-7 7"/>',
    'folder': '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'folder-open': '<path d="M3 11V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 11h19l-3 10H5z"/>',
    'folder-plus': '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v7M8.5 13.5h7"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
    cloud: '<path d="M6 19h12a4 4 0 0 0 0-8h-1a6 6 0 0 0-12-1 4.5 4.5 0 0 0 1 9z"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    rotate: '<path d="M20 9a8 8 0 1 0 0 6M20 3v6h-6"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    link: '<path d="m10 13 4-4m-5 7-3 3a4 4 0 0 1-5-5l5-5a4 4 0 0 1 6 0m0-1 3-3a4 4 0 0 1 6 5l-5 5a4 4 0 0 1-6 0"/>',
    'xmark': '<path d="m6 6 12 12M6 18 18 6"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    'circle-info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    'triangle-exclamation': '<path d="M12 3 2 21h20zM12 9v5m0 3h.01"/>',
    'desktop': '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11z"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
    command: '<path d="M8 8H5a3 3 0 1 1 3-3v14a3 3 0 1 1-3-3h14a3 3 0 1 1-3 3V5a3 3 0 1 1 3 3z"/>',
    list: '<path d="M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01"/>',
    'sort': '<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',
    'sort-up': '<path d="m7 14 5-5 5 5"/>',
    'sort-down': '<path d="m7 10 5 5 5-5"/>',
    'external-link-alt': '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
    file,
    'file-lines': file + '<path d="M8 13h8m-8 4h6"/>',
    'file-code': file + '<path d="m9 12-2 3 2 3m6-6 2 3-2 3"/>',
    'file-pdf': file + '<path d="M8 17v-5h3v3H8m6-3v5h3"/>',
    'file-image': file + '<circle cx="9" cy="12" r="1"/><path d="m6 19 5-5 3 3 2-2 2 4"/>',
    'file-video': file + '<path d="m10 12 5 3-5 3z"/>',
    'file-audio': file + '<path d="M14 12v6m0-6 3 1"/><circle cx="11.5" cy="18" r="2.5"/>',
    'file-archive': file + '<path d="M10 3v8m0 3v4"/>'
  };
  function hydrate(root) {
    const icons = root.matches?.('i.fa-solid, i.fas, i.far') ? [root] : root.querySelectorAll?.('i.fa-solid, i.fas, i.far') || [];
    for (const icon of icons) {
      const name = [...icon.classList].find(c => c.startsWith('fa-') && !['fa-solid', 'fa-spin'].includes(c))?.slice(3);
      if (!name || icon.dataset.drawn === name) continue;
      icon.dataset.drawn = name;
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || file}</svg>`;
    }
  }
  hydrate(document);
  new MutationObserver(records => records.forEach(record => {
    if (record.type === 'attributes') hydrate(record.target);
    else record.addedNodes.forEach(node => { if (node.nodeType === 1) hydrate(node); });
  })).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
})();
