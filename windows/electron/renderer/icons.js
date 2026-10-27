const icons={
  devices:'<rect x="2" y="3" width="14" height="11" rx="2"/><path d="M9 14v4M5 18h7"/><rect x="16" y="8" width="6" height="13" rx="1.5"/><path d="M18 18h2"/>',
  monitor:'<rect x="2.5" y="3" width="19" height="13" rx="2"/><path d="M12 16v5M7 21h10"/>',
  laptop:'<path d="M5 16V5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v11M2 17h20l-1.5 3h-17L2 17Z"/><path d="M10 17h4"/>',
  phone:'<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 5h4M10 19h4"/>',
  clipboard:'<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 11h6M9 15h6"/>',
  remote:'<rect x="2.5" y="3" width="19" height="13" rx="2"/><path d="M12 16v5M7 21h10M8 9h8m-3-3 3 3-3 3"/>',
  settings:'<path d="m9.5 3-.7 2-2 .9-2-.4-2.3 4 1.4 1.6v2.3l-1.4 1.5 2.3 4 2-.4 2 .9.7 2h4.8l.7-2 2-.9 2 .4 2.3-4-1.4-1.5v-2.3l1.4-1.6-2.3-4-2 .4-2-.9-.7-2Z"/><circle cx="12" cy="12" r="3"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  down:'<path d="m7 10 5 5 5-5"/>',back:'<path d="M19 12H5m5-5-5 5 5 5"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  text:'<path d="M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3"/>',
  send:'<path d="m21 3-6 18-4-8-8-4L21 3ZM11 13 21 3"/>',
  check:'<path d="m5 12 4 4L19 6"/>',checkCircle:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  screenshot:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/><rect x="7" y="7" width="10" height="10" rx="1"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',minus:'<path d="M5 12h14"/>',square:'<rect x="5" y="5" width="14" height="14"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2m-3-9-1 1M7 17l-1 1m0-12 1 1m10 10 1 1"/>',
  moon:'<path d="M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11Z"/>',
  shield:'<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 12 3 3 5-6"/>',
  wifi:'<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0"/><circle cx="12" cy="20" r=".7"/>',
  battery:'<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 10v4M5 10h10v4H5Z"/>',
  keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.1M10 9h.1M14 9h.1M18 9h.1M6 12h.1M10 12h.1M14 12h.1M18 12h.1M7 16h10"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-5 5 6"/>',
  terminal:'<path d="m4 6 6 6-6 6M13 18h7"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3v2M13 17h.01"/>',
};
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name]||icons.devices}</svg>`;
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export {icon,esc};
