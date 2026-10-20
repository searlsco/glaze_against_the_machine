export function summarize(rows) {
  const completed = rows.filter((row) => row.status === 'completed');
  const sorted = completed.map((row) => row.seconds).sort((a, b) => a - b);
  const total = sorted.reduce((sum, seconds) => sum + seconds, 0);
  const middle = Math.floor(sorted.length / 2);
  return {
    attempted: rows.length, completed: completed.length, failed: rows.length - completed.length,
    medianSeconds: sorted.length ? (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null,
    meanSeconds: sorted.length ? total / sorted.length : null,
    totalSeconds: total,
    attemptedSeconds: rows.reduce((sum, row) => sum + row.seconds, 0),
  };
}

export function metrics(rows) {
  const groups = (key) => Object.fromEntries([...new Set(rows.map((row) => row[key]))]
    .map((value) => [value, summarize(rows.filter((row) => row[key] === value))]));
  return { overall: summarize(rows), byProvider: groups('provider'), byLength: groups('length'), bySentiment: groups('sentiment') };
}

const seconds = (value) => value === null ? 'n/a' : `${value.toFixed(3)} s`;
const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function summaryText(summary) {
  const line = (name, value) => `${name}: ${value.completed}/${value.attempted} completed, ${value.failed} failed; median ${seconds(value.medianSeconds)}, mean ${seconds(value.meanSeconds)}, total ${seconds(value.totalSeconds)}; all attempts ${seconds(value.attemptedSeconds)}`;
  return [line('Overall', summary.overall), ...Object.entries(summary.byProvider).map(([name, value]) => line(name, value))].join('\n');
}

export function renderReport(rows, verdict) {
  const table = (groups) => `<table><thead><tr><th>Group</th><th>Completed / attempted</th><th>Failed</th><th>Median</th><th>Mean</th><th>Total completed</th><th>All attempts</th></tr></thead><tbody>${Object.entries(groups).map(([name, value]) => `<tr><th>${escape(name)}</th><td>${value.completed} / ${value.attempted}</td><td>${value.failed}</td><td>${seconds(value.medianSeconds)}</td><td>${seconds(value.meanSeconds)}</td><td>${seconds(value.totalSeconds)}</td><td>${seconds(value.attemptedSeconds)}</td></tr>`).join('')}</tbody></table>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Rewrite timing and qualitative review</title>
<style>body{font:16px system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#202631;background:#fafafa}h1,h2,h3{line-height:1.2}table{border-collapse:collapse;display:block;overflow:auto;margin:1rem 0 2rem}th,td{padding:.65rem;text-align:left;border-bottom:1px solid #cbd0d8;white-space:nowrap}article{border:1px solid #cbd0d8;border-radius:8px;padding:1rem;margin:1.5rem 0;background:white}.texts{display:grid;grid-template-columns:1fr 1fr;gap:1rem;min-width:0}.texts>div{min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.6 ui-monospace,monospace}.error{color:#9b1725}nav a{display:inline-block;margin:.3rem .6rem .3rem 0}small{color:#505b6b}@media(max-width:700px){.texts{grid-template-columns:1fr}}</style></head>
<body><h1>Rewrite timing and qualitative review</h1>
<p><strong>${escape(verdict.status)}:</strong> ${escape(verdict.reason)}</p>
<p>Quality is ungraded. Review the before-and-after text below. A completed rewrite passed production response validation; it has no semantic or sentiment grade.</p>
<p>Models (configured identifiers): ${escape(verdict.models.join(', '))}. Timeout: ${verdict.timeoutMs} ms. Transport: standalone, one-shot for each request. Personal and ancestor GLAZES.md preferences apply.</p>
<p>Timing covers the complete strict glaze() call, including style lookup, provider startup, inference, validation, cleanup, and any corrective retry. Calls run serially with alternating provider order. Median, mean, and total use completed rewrites only. All attempts includes failures and timeouts. Whole experiment wall time: ${seconds(verdict.seconds)}.</p>
<small>Started ${escape(verdict.startedAt)}. Source ${escape(verdict.gitRef)}${verdict.dirty ? ' (working tree changes present)' : ''}. ${escape(verdict.machine)}; ${escape(verdict.os)}; Node ${escape(verdict.node)}. Starting load average: ${escape(verdict.metrics.loadAvg.join(', '))}. Model aliases and local styles can change between runs.</small>
<h2>Timing</h2>${table({ overall: verdict.metrics.overall, ...verdict.metrics.byProvider })}
<h3>By input length</h3>${table(verdict.metrics.byLength)}<h3>By sentiment</h3>${table(verdict.metrics.bySentiment)}
<h2>Before and after</h2><nav>${rows.map((row, index) => `<a href="#run-${index}">${escape(row.id)}</a>`).join('')}</nav>
${rows.map((row, index) => `<article id="run-${index}"><h3>${escape(row.id)}</h3><p>${escape(row.model)} · ${escape(row.length)} · ${escape(row.sentiment)} · ${row.inputWords} input words · ${row.inputChars} input characters · ${seconds(row.seconds)} · <strong>${escape(row.status)}</strong></p>
<div class="texts"><div><h4>Before</h4><pre>${escape(row.input)}</pre></div><div><h4>After</h4>${row.output === null ? `<p class="error">No accepted rewrite: ${escape(row.error)}. The host integration would forward the original.</p>` : `<pre>${escape(row.output)}</pre>`}</div></div></article>`).join('\n')}
</body></html>\n`;
}
