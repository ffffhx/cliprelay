const view = new URLSearchParams(location.search).get('view') || 'control-center';
if (['control-center','remote-home','remote-desktop','remote-network','peer-editor','updates'].includes(view)) {
  document.querySelector('link[rel="stylesheet"]').href = './center.css';
  const {mount} = await import('./center.js');
  await mount(document.getElementById('app'), window.cliprelay, view);
} else {
  await import('./legacy-app.js');
}
