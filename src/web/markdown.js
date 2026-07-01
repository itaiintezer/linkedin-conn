// src/web/markdown.js — tiny, trusted-input markdown -> HTML (our own docs only)
'use strict';
(function () {
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}" target="_blank" rel="noopener">${t}</a>`);
  }
  function render(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0, inList = null;
    const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^```/);
      if (fence) {
        closeList();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
        i++; // skip closing fence
        out.push(`<pre class="md-pre"><code>${buf.join('\n')}</code></pre>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      const ul = line.match(/^[-*]\s+(.*)$/);
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ul || ol) {
        const want = ul ? 'ul' : 'ol';
        if (inList && inList !== want) closeList();
        if (!inList) { inList = want; out.push(`<${want}>`); }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
        i++; continue;
      }
      if (line.trim() === '') { closeList(); i++; continue; }
      closeList();
      out.push(`<p>${inline(line)}</p>`);
      i++;
    }
    closeList();
    return out.join('\n');
  }
  window.renderMarkdown = render;
})();
