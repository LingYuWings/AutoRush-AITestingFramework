"""Visible DOM extraction by trusted code, never model-generated JavaScript."""
from autorush.agent.observers import AgentObserver,fingerprint


class WebObserver(AgentObserver):
    kind='web'


DOM_OBSERVATION=r"""() => {
  const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el);
    return r.width>0 && r.height>0 && r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth && s.visibility!=='hidden' && s.display!=='none'; };
  const cssPath = el => {
    if (el.id && document.querySelectorAll('#'+CSS.escape(el.id)).length===1) return '#'+CSS.escape(el.id);
    const parts=[];let node=el;
    while(node && node.nodeType===1) {
      const tag=node.tagName.toLowerCase();let index=1;
      for(let prev=node.previousElementSibling;prev;prev=prev.previousElementSibling) if(prev.tagName===node.tagName) index++;
      parts.unshift(tag+':nth-of-type('+index+')');node=node.parentElement;
    }
    return parts.join(' > ');
  };
  const nodes=Array.from(document.querySelectorAll('button,input,textarea,select,a[href],[role]')).filter(visible).slice(0,200);
  const elements=nodes.map((el,index) => {
    const tag=el.tagName.toLowerCase(), type=(el.getAttribute('type')||'').toLowerCase();
    const role=el.getAttribute('role') || ({button:'button',a:'link',select:'combobox',textarea:'textbox'}[tag]) || (tag==='input' ? (['checkbox','radio'].includes(type)?type:'textbox') : 'generic');
    const label=el.labels ? Array.from(el.labels).map(l=>l.innerText).join(' ').trim() : '';
    const name=(el.getAttribute('aria-label') || label || el.getAttribute('placeholder') || el.innerText || '').trim().slice(0,1000);
    const locator={css:cssPath(el)};
    const r=el.getBoundingClientRect();
    const options=tag==='select'?Array.from(el.options).slice(0,50).map(o=>({value:o.value.slice(0,200),label:o.text.slice(0,200)})):[];
    return {id:'e'+index,role,name,value:type==='password'?'':String(el.value||'').slice(0,1000),locator,
      bounds:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],options};
  });
  return {text:(document.body?.innerText||'').slice(0,12000),elements};
}"""


async def collect_web_state(driver):
    page=driver._page
    if page.is_closed():
        from autorush.drivers.base import DriverBlockedError
        raise DriverBlockedError('browser page is closed')
    if page.url=='about:blank':
        return {'target':{'url':page.url,'origin':driver._origin},'text':'Initial browser. Use web.open to navigate on the configured origin.',
                'elements':[],'fingerprint':'about:blank','startup':True}
    driver._assert_page_allowed()
    raw=await page.evaluate(DOM_OBSERVATION)
    driver._assert_page_allowed()
    target={'url':page.url,'origin':driver._origin}
    layout=[{k:v for k,v in e.items() if k!='value'} for e in raw['elements']]
    return {**raw,'target':target,'fingerprint':fingerprint([target,layout])}
