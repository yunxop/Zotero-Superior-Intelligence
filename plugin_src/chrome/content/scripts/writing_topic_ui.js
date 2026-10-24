// Dedicated topic workspace. All text from the database is rendered with textContent.
var SIWritingTopicUI = function (win, api, choose, changed) {
  const doc=win.document, root=doc.getElementById('writing-manager');
  const el=(tag,text)=>{const e=doc.createElementNS('http://www.w3.org/1999/xhtml',tag);if(text!=null)e.textContent=text;return e;};
  const button=(text,fn)=>{const b=el('button',text);b.addEventListener('click',async()=>{b.disabled=true;try{await fn();}catch(e){message.textContent=e.message;}finally{b.disabled=false;}});return b;};
  const field=(label,tag='input')=>{const l=el('label',label),e=el(tag);l.append(e);return [l,e];};
  const select=values=>{const s=el('select');for(const [v,label] of values){const o=el('option',label);o.value=v;s.append(o);}return s;};
  let offset=0,editing=null,batchOffset=0,disposed=false,generation=0;
  win.addEventListener('unload',()=>{disposed=true;generation++;},{once:true});
  const message=el('p');message.setAttribute('role','status');
  root.append(button('返回提取页面',()=>{root.hidden=true;doc.getElementById('writing-workspace').hidden=false;}),el('h2','主题管理'),message);
  const toolbar=el('div');toolbar.className='card';
  const [ql,q]=field('搜索名称、别名、说明或标签');q.id='topic-manager-query';
  const state=select([['active','使用中'],['archived','已归档'],['all','全部未删除'],['trash','主题回收站']]);state.id='topic-manager-state';state.setAttribute('aria-label','主题状态');
  const sort=select([['recent','最近使用'],['updated','最近更新'],['name','名称'],['count','句子数']]);sort.setAttribute('aria-label','主题排序');
  const [fl,folder]=field('文件夹（包含下级）');folder.setAttribute('list','topic-folders'); const folderHints=el('datalist');folderHints.id='topic-folders';
  const [tl,tag]=field('标签筛选');tag.setAttribute('list','topic-tags');const tagHints=el('datalist');tagHints.id='topic-tags';
  toolbar.append(ql,state,sort,fl,folderHints,tl,tagHints,button('搜索主题',async()=>{offset=0;await refresh();}),button('新建主题',()=>edit(null)),button('记录回收站',()=>trash(0)));
  root.append(toolbar);
  const layout=el('div');layout.className='layout topic-layout';
  const list=el('div'),editor=el('section');editor.className='card';layout.append(list,editor);root.append(layout);
  const pager=el('p'),prev=button('上一页',async()=>{offset=Math.max(0,offset-30);await refresh();}),next=button('下一页',async()=>{offset+=30;await refresh();});
  root.append(pager,prev,next);
  const history=el('section');history.className='card';history.hidden=true;root.append(history);
  const edit=topic=>{
    editing=topic;editor.replaceChildren(el('h2',topic?'编辑主题':'新建主题'));history.hidden=true;
    const fields={};
    for(const [key,label,type] of [['name','主题名称','input'],['description','主题说明','textarea'],['instruction','默认提取指令','textarea'],['folder','文件夹路径（最多三层，用 / 分隔）','input'],['tags','标签（逗号分隔）','input']]){
      const [l,e]=field(label,type); e.id='topic-editor-'+key; e.value=key==='tags'?(topic?.tags||[]).join(', '):topic?.[key]||'';fields[key]=e;editor.append(l);
    }
    const checks={};for(const [key,label] of [['pinned','置顶'],['archived','归档']]){const l=el('label',label),c=el('input');c.type='checkbox';c.checked=!!topic?.[key];c.id='topic-editor-'+key;l.prepend(c);editor.append(l);checks[key]=c;}
    editor.append(button('保存主题',async()=>{
      const saved=await api.topicSave({id:topic?.id,...Object.fromEntries(Object.entries(fields).map(([k,e])=>[k,k==='tags'?e.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean):e.value])),pinned:checks.pinned.checked,archived:checks.archived.checked});
      edit(saved);await refresh();await changed();message.textContent='主题已保存，已有记录关联保持不变。';
    }));
    if(topic){
      editor.append(el('p',`别名：${(topic.aliases||[]).join('、')||'无'} · ID：${topic.id}`));
      if(topic.deletedAt){editor.append(button('恢复主题',async()=>{await api.topicSave({id:topic.id,deletedAt:null});await refresh();await changed();edit(null);message.textContent='主题已恢复。';}));}
      else {
        editor.append(button('查看语料 / 用此主题提取',async()=>{await choose(topic);root.hidden=true;doc.getElementById('writing-workspace').hidden=false;}),button('查看提取历史',async()=>{batchOffset=0;await batches(topic.id);}),button('移入主题回收站',async()=>{await api.topicDelete(topic.id);await refresh();await changed();edit(null);message.textContent='主题已移入回收站；共享记录和原始文献保留。';}));
        const [l,input]=field('查找合并目标主题');const target=el('select');target.setAttribute('aria-label','合并目标');
        editor.append(l,button('搜索合并目标',async()=>{const result=await api.topicList({state:'all',query:input.value,limit:30});target.replaceChildren();for(const t of result.topics.filter(t=>t.id!==topic.id)){const o=el('option',t.name);o.value=t.id;target.append(o);}}),target,
          button('合并到目标主题',async()=>{if(!target.value)throw Error('请先查找并选择目标主题。');if(!win.confirm('将当前主题的记录与历史合并到所选主题，原名保留为别名。合并不能一键撤销，是否继续？'))return;await api.topicMerge(topic.id,target.value);await refresh();await changed();edit(null);message.textContent='主题已合并。';}));
      }
    }
  };
  const refresh=async()=>{
    const token=++generation;
    const result=await api.topicList({query:q.value,state:state.value,folder:folder.value,tag:tag.value,sort:sort.value,offset,limit:30});
    if(disposed||token!==generation)return;
    if(offset && !result.topics.length){offset=Math.max(0,offset-30);return refresh();}
    list.replaceChildren();
    for(const t of result.topics){const card=el('article');card.className='card';card.append(el('h2',(t.pinned?'★ ':'')+t.name),el('p',`${t.papers} 篇论文 · ${t.count} 条语料 · ${t.pending} 条待审核`),el('p',`${t.folder||'未分类'} · 标签：${t.tags.join('、')||'无'}`),el('p',`最近使用：${t.lastUsedAt||'尚未提取'} · 更新：${t.updatedAt}`),button('编辑 / 管理',()=>edit(t)));if(!t.deletedAt)card.append(button('查看语料',()=>choose(t)));list.append(card);}
    if(!result.topics.length)list.append(el('p','没有匹配的主题。可以新建主题或更换筛选。'));
    for(const [node,values] of [[folderHints,result.folders],[tagHints,result.tags]]){node.replaceChildren();for(const v of values){const o=el('option');o.value=v;node.append(o);}}
    pager.textContent=`共 ${result.total} 个主题，第 ${Math.floor(offset/30)+1} 页`;prev.disabled=offset===0;next.disabled=offset+30>=result.total;
  };
  const batches=async id=>{
    const result=await api.batchHistory(id,batchOffset);if(disposed)return;history.hidden=false;history.replaceChildren(el('h2','提取历史（当时的参数快照）'));
    const labels={completed:'完成',partial:'部分失败',failed:'失败',cancelled:'已取消',interrupted:'退出中断',running:'运行中'};
    for(const b of result.batches){const d=el('details');d.append(el('summary',`${b.startedAt} · ${b.topicName} · ${labels[b.status]||b.status} · ${b.completed}/${b.itemIDs.length} 篇`),el('p',`范围：${b.scope}；模型：${b.model}；保存记录：${b.recordIDs.length}`),el('pre',b.instruction),el('p',`PDF 条目 ID：${b.itemIDs.join(', ')}`),el('p',`错误：${b.error||b.failures.map(f=>`${f.itemID}: ${f.error}`).join('；')||'无'}`));history.append(d);}
    if(!result.total)history.append(el('p','尚无提取历史；升级前的提取无法补全当时的参数。'));
    if(batchOffset>0)history.append(button('上一批历史',async()=>{batchOffset=Math.max(0,batchOffset-20);await batches(id);}));
    if(batchOffset+20<result.total)history.append(button('下一批历史',async()=>{batchOffset+=20;await batches(id);}));
  };
  const trash=async page=>{
    const rows=await api.recordTrash();if(disposed)return;history.hidden=false;history.replaceChildren(el('h2',`记录回收站（${rows.length} 条）`));
    for(const r of rows.slice(page*30,page*30+30)){const card=el('div');card.append(el('blockquote',r.quote),el('p',r.source.title),button('恢复这条记录',async()=>{await api.restore([r.id]);await trash(page);await refresh();await changed();}));history.append(card);}
    if(page>0)history.append(button('上一页记录',()=>trash(page-1)));
    if((page+1)*30<rows.length)history.append(button('下一页记录',()=>trash(page+1)));
  };
  edit(null);
  return {open:async()=>{root.hidden=false;doc.getElementById('writing-workspace').hidden=true;offset=0;await refresh();}};
};
