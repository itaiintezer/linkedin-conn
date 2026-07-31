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

  /** Split a pipe-table row into trimmed cells, ignoring the leading/trailing pipes. */
  function cells(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  }
  const isTableRow = (l) => /^\s*\|/.test(l);
  /** The `|---|:--:|` separator that makes the line above it a header row. */
  const isTableDivider = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes('-');

  /** True for any line that must interrupt an open paragraph. */
  function startsBlock(l) {
    return l.trim() === '' || /^```/.test(l) || /^#{1,4}\s/.test(l)
      || /^[-*]\s/.test(l) || /^\d+\.\s/.test(l) || isTableRow(l);
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

      // Pipe tables. Consumed as a block so a header/divider pair never leaks out as text —
      // the API reference is mostly tables, and raw `|---|` rows made it unreadable.
      if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        closeList();
        const head = cells(line);
        i += 2; // header + divider
        const body = [];
        while (i < lines.length && isTableRow(lines[i])) { body.push(cells(lines[i])); i++; }
        const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
        const rows = body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('');
        out.push(`<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`);
        continue;
      }

      const ul = line.match(/^[-*]\s+(.*)$/);
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ul || ol) {
        const want = ul ? 'ul' : 'ol';
        if (inList && inList !== want) closeList();
        if (!inList) { inList = want; out.push(`<${want}>`); }
        // Absorb indented continuation lines so a wrapped bullet stays one <li> instead of
        // breaking into an orphan paragraph underneath the list.
        const parts = [(ul || ol)[1]];
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !startsBlock(lines[i].trim())) {
          parts.push(lines[i].trim()); i++;
        }
        out.push(`<li>${inline(parts.join(' '))}</li>`);
        continue;
      }

      if (line.trim() === '') { closeList(); i++; continue; }

      // Paragraph: absorb following lines until a blank line or another block starts.
      // Markdown treats a hard-wrapped run of lines as ONE paragraph; emitting a <p> per
      // source line turned every wrapped sentence in the docs into a stack of fragments.
      closeList();
      const para = [line.trim()];
      i++;
      while (i < lines.length && !startsBlock(lines[i])) { para.push(lines[i].trim()); i++; }
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
    closeList();
    return out.join('\n');
  }
  window.renderMarkdown = render;
})();
