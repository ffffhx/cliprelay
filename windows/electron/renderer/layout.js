export function renderControl(node, parent) {
  const type = node.type;
  const element = document.createElement(type === 'RelayButton' ? 'button' : type === 'RelayToggle' ? 'button' : type === 'TextBox' ? 'input' : 'div');
  element.id = node.id;
  element.className = 'control ' + (type === 'RelayButton' ? 'button' : type === 'RelayToggle' ? 'toggle' : type === 'TextBox' ? 'input' : type === 'Label' ? 'label' : 'panel');
  Object.assign(element.style,{left:node.x+'px',top:node.y+'px',width:node.width+'px',height:node.height+'px',fontFamily:`'${node.font}',sans-serif`,fontSize:node.fontSize+'pt',fontWeight:node.bold?'700':'400',color:node.color,backgroundColor:node.background});
  if (node.BorderColor && type !== 'RelayButton') {
    element.style.setProperty('--panel-border',node.BorderColor);
    element.style.boxShadow=`inset 0 0 0 ${node.BorderWidth ?? 1}px var(--panel-border)`;
  }
  if (node.CornerRadius) element.style.borderRadius=node.CornerRadius+'px';
  if (type === 'RelayButton') {
    element.textContent=node.text;
    element.style.backgroundColor='';
    for(const [key,value] of Object.entries({'--fill':node.FillColor,'--hover':node.HoverColor,'--pressed':node.PressedColor,'--ink':node.TextColor,'--stroke':node.BorderColor,'--radius':node.CornerRadius+'px'}))element.style.setProperty(key,value);
    element.style.color='';
  } else if (type === 'RelayToggle') {
    element.setAttribute('role','switch');element.setAttribute('aria-checked',String(node.Checked));
    element.style.setProperty('--height',node.height+'px');element.style.setProperty('--on',node.OnColor);element.style.setProperty('--off',node.OffColor);
  } else if(type === 'TextBox') {
    element.value=node.text;element.type=node.UseSystemPasswordChar?'password':'text';
    element.readOnly=!!node.ReadOnly;if(node.MaxLength)element.maxLength=node.MaxLength;
  } else if(type === 'Label') {
    element.textContent=node.text;
    if(node.align?.includes('Right'))element.style.justifyContent='flex-end';
    if(node.align?.includes('Center'))element.style.justifyContent='center';
  }
  if(node.AutoScroll){element.classList.add('scroll');element.style.overflow='auto';}
  parent.append(element);
  for(const child of node.children || [])renderControl(child,element);
  return element;
}

export const byId = id => document.getElementById(id);
export const text = (id,value) => { const node=byId(id);if(node && node.textContent!==String(value ?? ''))node.textContent=value ?? ''; };
export const checked = (id,value) => byId(id)?.setAttribute('aria-checked',String(!!value));
export const click = (id,action) => { const node=byId(id);if(node)node.addEventListener('click',action); };
export function setValue(id,value) {const node=byId(id);if(node && document.activeElement!==node)node.value=value;}
