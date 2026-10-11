export function element(parent,tag,text,x,y,width,height,style=''){
  const node=document.createElement(tag);if(text!==null)node.textContent=text;
  node.style.cssText=`position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;${style}`;parent.append(node);return node;
}
export function listOptions(select,items,key,label){
  const signature=JSON.stringify(items);if(select.dataset.signature===signature)return;
  const previous=select.value;select.replaceChildren();
  for(const item of items){const option=document.createElement('option');option.value=item[key];option.textContent=label(item);select.append(option);}
  if(items.some(item=>String(item[key])===previous))select.value=previous;
  select.dataset.signature=signature;
}
